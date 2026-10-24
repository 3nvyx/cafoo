// Named checks: charter rules that need joins across several tables, JSON payload arithmetic, ordering in
// time, or the in-process credit cascade. Referenced from YAML as { type: check, name: <key>, params }.
import { cascade } from './cascade.js';
import { matchRow, type CondMap, type Scalar } from './conditions.js';
import type { Db, Row } from './db.js';

export interface CheckContext {
  /** Fixed reference date for persona cascades (YYYY-MM-DD). */
  asOf: string;
  vars: Record<string, Scalar>;
}

export interface CheckResult {
  checked: number;
  unit: string;
  offenders: Row[];
}

export type CheckFn = (db: Db, params: Record<string, unknown>, ctx: CheckContext) => CheckResult | Promise<CheckResult>;

const json = <T>(s: unknown): T | null => {
  try {
    return JSON.parse(String(s)) as T;
  } catch {
    return null;
  }
};
const byId = (rows: Row[], key = 'id') => new Map(rows.map((r) => [String(r[key]), r]));
const big = (v: unknown): bigint => BigInt(String(v ?? '0'));
const RULING_ACTIONS = new Set(['approve_approve', 'approve_amend', 'approve_awaiting_cfo', 'reject']);
/** Owner checks a vendor check (vendor_verify) must cite, as the module requires. */
const VENDOR_CHECK_PRODUCTS = ['tu_identity_verification', 'fraud_finder'];
const cleanCheck = (c: Row) => String(c.decision).toUpperCase() === 'APPROVE' && (c.tier === 'A' || c.tier === 'B');

type ScheduleLine = { contractItemId: string; customerId: string; ym: string; amountMinor: string };

function scheduleProposals(db: Db, params: Record<string, unknown>): Row[] {
  return db.query('SELECT * FROM proposal').filter((p) => p.kind === 'revenue_schedule' && matchRow(p, params.where as CondMap | undefined));
}

/** Months from a to b inclusive, both YYYY-MM. */
function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am) + 1;
}

export const CHECKS: Record<string, CheckFn> = {
  /** Every annual contract's subscription items have schedule lines on file or a revenue schedule proposal. */
  annual_contracts_scheduled(db) {
    const contracts = db.query('SELECT * FROM contract').filter((c) => c.plan === 'annual');
    const items = db.query('SELECT * FROM contract_item').filter((i) => i.kind === 'subscription');
    const scheduled = new Set(db.query('SELECT * FROM revenue_schedule_line').map((l) => String(l.contract_item_id)));
    for (const p of db.query('SELECT * FROM proposal')) {
      if (p.kind !== 'revenue_schedule') continue;
      for (const l of json<{ lines: ScheduleLine[] }>(p.payload_json)?.lines ?? []) scheduled.add(String(l.contractItemId));
    }
    const offenders: Row[] = [];
    let checked = 0;
    for (const c of contracts) {
      for (const i of items.filter((x) => String(x.contract_id) === String(c.id))) {
        checked++;
        if (!scheduled.has(String(i.id))) offenders.push({ contract: c.code, contract_item_id: i.id, problem: 'no schedule lines and no schedule proposal' });
      }
    }
    return { checked, unit: 'annual subscription items', offenders };
  },

  /** Revenue schedule proposals: lines sum to the proposal amount and to the contract total. */
  revenue_schedule_sums(db, params) {
    const items = byId(db.query('SELECT * FROM contract_item'));
    const contracts = byId(db.query('SELECT * FROM contract'));
    const props = scheduleProposals(db, params);
    const offenders: Row[] = [];
    for (const p of props) {
      const lines = json<{ lines: ScheduleLine[] }>(p.payload_json)?.lines ?? [];
      const sum = lines.reduce((a, l) => a + big(l.amountMinor), 0n);
      const itemIds = [...new Set(lines.map((l) => l.contractItemId))];
      const contractTotals = itemIds.map((i) => contracts.get(String(items.get(i)?.contract_id))?.total_minor);
      const problems: string[] = [];
      if (lines.length === 0) problems.push('no lines');
      if (sum !== big(p.amount_minor)) problems.push(`lines sum ${sum} != proposal amount ${String(p.amount_minor)}`);
      if (itemIds.length === 1 && contractTotals[0] !== undefined && big(contractTotals[0]) > 0n && sum !== big(contractTotals[0])) {
        problems.push(`lines sum ${sum} != contract total ${String(contractTotals[0])}`);
      }
      if (contractTotals.some((t) => t === undefined)) problems.push('a line names an unknown contract item');
      if (problems.length) offenders.push({ proposal_id: p.id, lines: lines.length, problem: problems.join('; ') });
    }
    return { checked: props.length, unit: 'revenue schedule proposals', offenders };
  },

  /** Revenue schedule proposals: every month is inside the contract term, once, and belongs to the contract's customer. */
  revenue_schedule_within_term(db, params) {
    const items = byId(db.query('SELECT * FROM contract_item'));
    const contracts = byId(db.query('SELECT * FROM contract'));
    const props = scheduleProposals(db, params);
    const offenders: Row[] = [];
    for (const p of props) {
      const lines = json<{ lines: ScheduleLine[] }>(p.payload_json)?.lines ?? [];
      const seen = new Set<string>();
      for (const l of lines) {
        const c = contracts.get(String(items.get(l.contractItemId)?.contract_id));
        const problems: string[] = [];
        if (!c) problems.push('unknown contract item');
        else {
          if (l.ym < String(c.start_ym) || l.ym > String(c.end_ym)) problems.push(`month outside term ${String(c.start_ym)}..${String(c.end_ym)}`);
          if (String(c.customer_id) !== String(l.customerId)) problems.push(`customer ${l.customerId} is not the contract's customer ${String(c.customer_id)}`);
        }
        const k = `${l.contractItemId}|${l.ym}`;
        if (seen.has(k)) problems.push('month scheduled twice');
        seen.add(k);
        if (problems.length) offenders.push({ proposal_id: p.id, contract_item_id: l.contractItemId, ym: l.ym, problem: problems.join('; ') });
      }
      const first = lines[0];
      const c = first ? contracts.get(String(items.get(first.contractItemId)?.contract_id)) : undefined;
      if (c && lines.length !== monthsBetween(String(c.start_ym), String(c.end_ym))) {
        offenders.push({ proposal_id: p.id, problem: `${lines.length} lines for a ${monthsBetween(String(c.start_ym), String(c.end_ym))}-month term` });
      }
    }
    return { checked: props.length, unit: 'revenue schedule proposals', offenders };
  },

  /**
   * No revenue is recognized before its service month:
   * a recognized schedule line's entry sits in the line's month or later, and a recognition proposal only
   * flips schedule lines of its own period.
   */
  no_early_recognition(db) {
    const jes = byId(db.query('SELECT * FROM journal_entry'));
    const periods = byId(db.query('SELECT * FROM period'));
    const lines = db.query('SELECT * FROM revenue_schedule_line WHERE recognized = true').filter((l) => l.je_id !== null);
    const offenders: Row[] = [];
    for (const l of lines) {
      const je = jes.get(String(l.je_id));
      const ym = je ? String(periods.get(String(je.period_id))?.ym ?? '') : '';
      if (!je) offenders.push({ schedule_line: l.id, ym: l.ym, problem: `linked entry ${String(l.je_id)} does not exist` });
      else if (ym < String(l.ym)) offenders.push({ schedule_line: l.id, ym: l.ym, je_id: je.id, je_period: ym, problem: 'recognized in an earlier month' });
    }
    const props = db.query('SELECT * FROM proposal').filter((p) => p.kind === 'journal_entry');
    let recog = 0;
    for (const p of props) {
      const pay = json<{ periodYm?: string; recognizeScheduleYm?: string }>(p.payload_json);
      if (!pay?.recognizeScheduleYm) continue;
      recog++;
      if (pay.recognizeScheduleYm > (pay.periodYm ?? '')) {
        offenders.push({ proposal_id: p.id, period: pay.periodYm, recognizes: pay.recognizeScheduleYm, problem: 'recognizes a later month' });
      }
    }
    return { checked: lines.length + recog, unit: 'recognized schedule lines and recognition proposals', offenders };
  },

  /** Every tiered subject has the full cascade on file; only a BLOCK may stop after identity and fraud. */
  credit_full_cascade(db, params) {
    const gate = (params.gate_products as string[] | undefined) ?? ['tu_identity_verification', 'fraud_finder'];
    const full = (params.full_products as string[] | undefined) ?? [
      ...gate, 'credit_report:tu', 'credit_report:efx', 'credit_report:exp', 'pitchpoint_blj', 'criminal', 'eviction',
    ];
    const checks = db.query('SELECT * FROM credit_check');
    const groups = new Map<string, Row[]>();
    for (const c of checks) {
      const k = `${String(c.subject_kind)}:${String(c.subject_id)}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const offenders: Row[] = [];
    for (const [k, rows] of groups) {
      const latest = rows.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
      const tier = String(latest.tier);
      const have = new Set(rows.map((r) => String(r.product)));
      const need = tier === 'BLOCK' && !full.slice(gate.length).some((p) => have.has(p)) ? gate : full;
      const missing = need.filter((p) => !have.has(p));
      if (missing.length) offenders.push({ subject: k, tier, missing: missing.join(', ') });
    }
    const decisions = db.query('SELECT * FROM proposal').filter((p) => p.kind === 'credit_decision');
    for (const p of decisions) {
      const pay = json<{ customerId?: string; tier?: string }>(p.payload_json);
      if (!groups.has(`customer:${pay?.customerId}`)) offenders.push({ proposal_id: p.id, subject: `customer:${pay?.customerId}`, tier: pay?.tier, missing: 'no credit check at all' });
    }
    return { checked: groups.size + decisions.length, unit: 'checked subjects and credit decisions', offenders };
  },

  /** Every credit decision cites the request ids of its own credit checks, and every check has a request id. */
  credit_request_ids_cited(db) {
    const checks = db.query('SELECT * FROM credit_check');
    const offenders: Row[] = [];
    for (const c of checks) {
      if (!String(c.request_id ?? '').trim()) offenders.push({ credit_check: c.id, persona_id: c.persona_id, product: c.product, problem: 'empty request id' });
    }
    const decisions = db.query('SELECT * FROM proposal').filter((p) => p.kind === 'credit_decision');
    for (const p of decisions) {
      const pay = json<{ customerId?: string; creditCheckIds?: (string | null)[] }>(p.payload_json);
      const own = new Set(checks.filter((c) => c.subject_kind === 'customer' && String(c.subject_id) === String(pay?.customerId)).map((c) => String(c.request_id)));
      const ids = pay?.creditCheckIds ?? [];
      if (ids.length === 0) offenders.push({ proposal_id: p.id, customer_id: pay?.customerId, problem: 'cites no request ids' });
      for (const id of ids) {
        if (!id) offenders.push({ proposal_id: p.id, customer_id: pay?.customerId, problem: 'cites a null request id' });
        else if (!own.has(id)) offenders.push({ proposal_id: p.id, customer_id: pay?.customerId, request_id: id, problem: "request id is not one of this customer's credit checks" });
      }
    }
    return { checked: checks.length + decisions.length, unit: 'credit checks and credit decisions', offenders };
  },

  /**
   * Every vendor check (vendor_verify proposal) cites request ids of credit checks recorded for that same vendor, every
   * cited check is a clean APPROVE at tier A or B, and the owner's identity and fraud checks are among them.
   */
  vendor_check_cites_clean_checks(db) {
    const checks = db.query('SELECT * FROM credit_check').filter((c) => c.subject_kind === 'vendor');
    const props = db.query('SELECT * FROM proposal').filter((p) => p.kind === 'vendor_verify');
    const offenders: Row[] = [];
    for (const p of props) {
      const pay = json<{ vendorId?: string; creditCheckIds?: (string | null)[] }>(p.payload_json);
      const vendorId = String(pay?.vendorId);
      const own = checks.filter((c) => String(c.subject_id) === vendorId);
      const ids = pay?.creditCheckIds ?? [];
      const cited: Row[] = [];
      const problems: string[] = [];
      if (ids.length === 0) problems.push('cites no request ids');
      for (const id of ids) {
        const row = id ? own.find((c) => String(c.request_id) === String(id)) : undefined;
        if (!row) problems.push(`request id ${String(id)} is not a credit check of vendor ${vendorId}`);
        else {
          cited.push(row);
          if (!cleanCheck(row)) problems.push(`${String(row.product)} ${String(id)} is ${String(row.decision)} at tier ${String(row.tier)}, not a clean APPROVE at tier A or B`);
        }
      }
      if (ids.length > 0) for (const prod of VENDOR_CHECK_PRODUCTS) if (!cited.some((c) => c.product === prod)) problems.push(`cites no ${prod} check`);
      if (problems.length) offenders.push({ proposal_id: p.id, vendor_id: vendorId, problem: problems.join('; ') });
    }
    return { checked: props.length, unit: 'vendor checks', offenders };
  },

  /** The tier on file (credit checks and credit decision proposals) equals the replayed cascade for that persona. */
  async credit_tier_matches_cascade(db) {
    const checks = db.query('SELECT * FROM credit_check');
    const latest = new Map<string, Row>();
    for (const c of checks) {
      const k = `${String(c.subject_kind)}:${String(c.subject_id)}`;
      const cur = latest.get(k);
      if (!cur || Number(c.id) > Number(cur.id)) latest.set(k, c);
    }
    const offenders: Row[] = [];
    for (const [k, c] of latest) {
      const asOf = new Date(Number(c.created_at) / 1000).toISOString().slice(0, 10);
      const kind = c.subject_kind === 'vendor' ? 'vendor_owner' : 'customer_guarantor';
      const r = await cascade(String(c.persona_id), kind, asOf);
      if (r.tier !== c.tier || r.decision !== c.decision) {
        offenders.push({ subject: k, persona_id: c.persona_id, on_file: `${String(c.tier)}/${String(c.decision)}`, cascade: `${r.tier}/${r.decision}`, as_of: asOf });
      }
    }
    const decisions = db.query('SELECT * FROM proposal').filter((p) => p.kind === 'credit_decision');
    for (const p of decisions) {
      const pay = json<{ customerId?: string; tier?: string; paymentTermsDays?: number }>(p.payload_json);
      const c = latest.get(`customer:${pay?.customerId}`);
      if (c && pay?.tier !== c.tier) offenders.push({ proposal_id: p.id, subject: `customer:${pay?.customerId}`, proposed: pay?.tier, on_file: c.tier });
    }
    return { checked: latest.size + decisions.length, unit: 'checked subjects and credit decisions', offenders };
  },

  /** No critique lands after a ruling on the same proposal unless the CFO sent it back in between. */
  critique_before_ruling(db) {
    const msgs = db.query('SELECT * FROM agent_message').filter((m) => m.proposal_id !== null);
    const byProposal = new Map<string, Row[]>();
    for (const m of msgs) byProposal.set(String(m.proposal_id), [...(byProposal.get(String(m.proposal_id)) ?? []), m]);
    const offenders: Row[] = [];
    let critiques = 0;
    for (const [pid, list] of byProposal) {
      const sorted = [...list].sort((a, b) => Number(a.created_at) - Number(b.created_at) || Number(a.id) - Number(b.id));
      let ruled = false;
      for (const m of sorted) {
        if (m.kind === 'ruling') ruled = true;
        else if (m.sender_role === 'cfo' && m.kind === 'question') ruled = false;
        else if (m.kind === 'critique') {
          critiques++;
          if (ruled) offenders.push({ proposal_id: pid, message_id: m.id, sender_role: m.sender_role, summary_plain: m.summary_plain, problem: 'critique after the ruling' });
        }
      }
    }
    return { checked: critiques, unit: 'critiques', offenders };
  },

  /**
   * Plain summaries: at least 10 characters, one sentence, no account codes, no bookkeeping or bureau jargon,
   * no machine reason codes, and no raw minor-unit numbers.
   */
  plain_summary_clean(db, params) {
    const sql = String(params.sql ?? 'SELECT * FROM proposal');
    const column = String(params.column ?? 'summary_plain');
    const rows = db.query(sql).filter((r) => matchRow(r, params.where as CondMap | undefined));
    const codes = db.query('SELECT * FROM account').map((a) => String(a.code));
    const codeRe = codes.length ? new RegExp(`(?<![\\d,.$])\\b(${codes.join('|')})\\b(?![,.]\\d)`) : null;
    const rules: [string, RegExp][] = [
      ['bookkeeping jargon', /\b(debit|debits|debited|accrual|accruals|accrue|accrued)\b|\b(Dr|Cr|GL|JE|ECL|AR|AP)\b|\bASC ?606\b/i],
      ['bureau jargon', /\b(tradelines?|FICO|KBA|BLJ|PitchPoint|risk\.score)\b/i],
      ['machine reason code', /\b[a-z]+_[a-z0-9_]+\b/],
      ['raw minor-unit number', /(?<![\d,.$])\b\d{5,}\b/],
      ['more than one sentence', /[.!?]\s+[A-Z]/],
    ];
    const offenders: Row[] = [];
    for (const r of rows) {
      const text = String(r[column] ?? '');
      const problems: string[] = [];
      if (text.trim().length < 10) problems.push('shorter than 10 characters');
      if (codeRe?.test(text)) problems.push(`account code ${codeRe.exec(text)![1]}`);
      for (const [name, re] of rules) {
        const m = re.exec(text);
        if (m) problems.push(`${name} "${m[0].trim()}"`);
      }
      if (problems.length) offenders.push({ id: r.id, problem: problems.join('; '), [column]: text });
    }
    return { checked: rows.length, unit: 'summaries', offenders };
  },

  /**
   * A month whose lock was requested or granted (period closing or closed) has every subscription schedule line through
   * that month recognized: no revenue the contracts earned by then is left in deferred revenue.
   */
  lock_revenue_recognized(db) {
    const items = byId(db.query('SELECT * FROM contract_item'));
    const months = db.query('SELECT * FROM period').filter((p) => p.status === 'closing' || p.status === 'closed').map((p) => String(p.ym));
    const latest = months.sort().pop();
    const lines = db.query('SELECT * FROM revenue_schedule_line').filter((l) => items.get(String(l.contract_item_id))?.kind === 'subscription');
    const offenders: Row[] = [];
    if (latest) {
      for (const l of lines) {
        if (String(l.ym) <= latest && l.recognized !== true) offenders.push({ schedule_line: l.id, customer_id: l.customer_id, ym: l.ym, amount_minor: l.amount_minor, problem: `unrecognized, but ${latest} is locked or waiting for its lock` });
      }
    }
    return { checked: latest ? lines.filter((l) => String(l.ym) <= latest).length : 0, unit: 'subscription schedule lines through a locked month', offenders };
  },

  /**
   * Subscription revenue (4000) is credited only by entries that flip schedule lines, and every 4000 line in such an
   * entry names its customer. Seed history and reversals are exempt (a reversal undoes an entry that already passed).
   */
  revenue_credits_only_in_recognition(db) {
    const flips = new Set(db.query('SELECT * FROM revenue_schedule_line').filter((l) => l.je_id !== null).map((l) => String(l.je_id)));
    const jes = byId(db.query('SELECT * FROM journal_entry'));
    const byJe = new Map<string, Row[]>();
    for (const l of db.query('SELECT * FROM journal_line')) {
      if (String(l.account_code) !== '4000') continue;
      byJe.set(String(l.je_id), [...(byJe.get(String(l.je_id)) ?? []), l]);
    }
    const offenders: Row[] = [];
    for (const [jeId, lines] of byJe) {
      const je = jes.get(jeId);
      if (!je || je.source === 'seed' || je.reversal_of !== null) continue;
      if (flips.has(jeId)) {
        for (const l of lines) if (l.customer_id === null) offenders.push({ je_id: jeId, line: l.id, problem: 'a 4000 line in a recognition entry names no customer' });
      } else {
        const net = lines.reduce((a, l) => a + big(l.credit_minor) - big(l.debit_minor), 0n);
        if (net > 0n) offenders.push({ je_id: jeId, memo: je.memo, net_credit_minor: net.toString(), problem: 'credits 4000 without flipping any schedule line' });
      }
    }
    return { checked: byJe.size, unit: 'entries on 4000', offenders };
  },

  /**
   * Journal lines in the subsidiary's own currency are at FX rate 1.0 (1000000); a foreign-currency line uses a rate
   * recorded for its currency pair and its entry's month.
   */
  fx_rates_recorded(db) {
    const functional = new Map(db.query('SELECT * FROM subsidiary').map((x) => [String(x.id), String(x.functional_ccy)]));
    const periods = byId(db.query('SELECT * FROM period'));
    const jes = byId(db.query('SELECT * FROM journal_entry'));
    const rates = new Set(db.query('SELECT * FROM fx_rate').map((r) => `${String(r.from_ccy)}|${String(r.to_ccy)}|${String(r.ym)}|${String(r.rate_e_6)}`));
    const lines = db.query('SELECT * FROM journal_line');
    const offenders: Row[] = [];
    for (const l of lines) {
      const je = jes.get(String(l.je_id));
      const own = functional.get(String(je?.subsidiary_id));
      const ym = String(periods.get(String(je?.period_id))?.ym ?? '');
      if (!je || !own) offenders.push({ line: l.id, je_id: l.je_id, problem: 'line of an unknown entry or subsidiary' });
      else if (String(l.ccy) === own) {
        if (big(l.fx_rate_e_6) !== 1_000_000n) offenders.push({ line: l.id, je_id: l.je_id, ccy: l.ccy, fx_rate_e_6: l.fx_rate_e_6, problem: `own currency ${own} must be at 1000000` });
      } else if (!rates.has(`${String(l.ccy)}|${own}|${ym}|${String(l.fx_rate_e_6)}`)) {
        offenders.push({ line: l.id, je_id: l.je_id, ccy: l.ccy, fx_rate_e_6: l.fx_rate_e_6, ym, problem: `no recorded ${String(l.ccy)}/${own} rate ${String(l.fx_rate_e_6)} for ${ym}` });
      }
    }
    return { checked: lines.length, unit: 'journal lines', offenders };
  },

  /**
   * An agent-proposed entry at or above materiality (by its raw debits, raw credits, or debits converted at their FX
   * rates, whichever is largest) posted only with the CFO's confirmation on its Approval.
   */
  material_entries_confirmed(db, _params, ctx) {
    const materiality = big(ctx.vars.materiality ?? 1_000_000);
    const approvals = new Map(db.query('SELECT * FROM approval').map((a) => [String(a.proposal_id), a]));
    const sums = new Map<string, { dr: bigint; cr: bigint; conv: bigint }>();
    for (const l of db.query('SELECT * FROM journal_line')) {
      const t = sums.get(String(l.je_id)) ?? { dr: 0n, cr: 0n, conv: 0n };
      t.dr += big(l.debit_minor);
      t.cr += big(l.credit_minor);
      t.conv += (big(l.debit_minor) * big(l.fx_rate_e_6)) / 1_000_000n;
      sums.set(String(l.je_id), t);
    }
    const jes = db.query('SELECT * FROM journal_entry').filter((j) => j.proposal_id !== null && j.source !== 'seed');
    const offenders: Row[] = [];
    let material = 0;
    for (const j of jes) {
      const t = sums.get(String(j.id)) ?? { dr: 0n, cr: 0n, conv: 0n };
      const size = [t.dr, t.cr, t.conv].reduce((a, b) => (b > a ? b : a), 0n);
      if (size < materiality) continue;
      material++;
      const a = approvals.get(String(j.proposal_id));
      if (!a || a.cfo_confirmed_at === null) offenders.push({ je_id: j.id, proposal_id: j.proposal_id, size_minor: size.toString(), memo: j.memo, problem: 'material entry posted without a CFO confirmation' });
    }
    return { checked: material, unit: 'material entries', offenders };
  },

  /**
   * Every invoice or bill bank match carries the payment entry it posted (payment_je_id), and no match outlives the
   * reversal of its payment entry (for a match to an entry, that entry).
   */
  bank_match_payment_entries(db) {
    const reversed = new Set(db.query('SELECT * FROM journal_entry').filter((j) => j.reversal_of !== null).map((j) => String(j.reversal_of)));
    const matches = db.query('SELECT * FROM bank_match');
    const offenders: Row[] = [];
    for (const m of matches) {
      const payment = m.target_kind === 'je' ? m.target_id : m.payment_je_id;
      if (m.target_kind !== 'je' && payment === null) offenders.push({ bank_match: m.id, target: `${String(m.target_kind)} ${String(m.target_id)}`, problem: 'no payment entry (payment_je_id)' });
      else if (payment !== null && reversed.has(String(payment))) offenders.push({ bank_match: m.id, payment_je_id: payment, problem: 'its payment entry was reversed but the match survives' });
    }
    return { checked: matches.length, unit: 'bank matches', offenders };
  },

  /** At most one ruling per proposal, plus one more for each time the CFO sent it back. */
  single_ruling_per_proposal(db) {
    const audit = db.query("SELECT * FROM audit_event WHERE target_table = 'proposal'");
    const rulings = new Map<string, number>();
    const sendBacks = new Map<string, number>();
    for (const e of audit) {
      const k = String(e.target_id);
      if (RULING_ACTIONS.has(String(e.action))) rulings.set(k, (rulings.get(k) ?? 0) + 1);
      if (e.action === 'cfo_send_back') sendBacks.set(k, (sendBacks.get(k) ?? 0) + 1);
    }
    const offenders: Row[] = [];
    for (const [k, n] of rulings) {
      const allowed = 1 + (sendBacks.get(k) ?? 0);
      if (n > allowed) offenders.push({ proposal_id: k, rulings: n, cfo_send_backs: sendBacks.get(k) ?? 0 });
    }
    return { checked: rulings.size, unit: 'ruled proposals', offenders };
  },

  /** A close task marked done has no evidence proposal still open or sent back. */
  done_tasks_ruled(db) {
    const tasks = db.query('SELECT * FROM close_task').filter((t) => t.status === 'done');
    const props = byId(db.query('SELECT * FROM proposal'));
    const offenders: Row[] = [];
    for (const t of tasks) {
      const ids = String(t.evidence_proposal_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const pending = ids.filter((id) => {
        const st = props.get(id)?.status;
        return st === 'open' || st === 'sent_back';
      });
      if (pending.length) offenders.push({ task_id: t.id, title: t.title, unruled: pending.join(',') });
    }
    return { checked: tasks.length, unit: 'done close tasks', offenders };
  },
};
