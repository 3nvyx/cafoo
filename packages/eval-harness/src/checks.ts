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

// ---- Consolidation (payload wire form: packages/ledger-core proposals, module validation in spacetimedb) ----

type PayloadLine = { accountCode: string; debitMinor: string; creditMinor: string; ccy: string; fxRateE6: string };
type FxRevaluationPayload = {
  subsidiaryId: string;
  periodYm: string;
  rateYm?: string;
  items: { accountCode: string; ccy: string; txnBalanceMinor: string; closingRateE6: string; bookedFunctionalMinor: string; targetFunctionalMinor: string; deltaMinor: string }[];
  lines: PayloadLine[];
};
type IcEliminationPayload = {
  subsidiaryId: string;
  periodYm: string;
  basis: string;
  reversesInYm?: string;
  pairs: { label: string; sourceSubsidiaryId: string; sourceAccountCode: string; counterSubsidiaryId: string; counterAccountCode: string; amountMinor: string; counterTranslatedMinor: string; differenceMinor: string }[];
  lines: PayloadLine[];
};

const E6 = 1_000_000n;
const abs = (n: bigint) => (n < 0n ? -n : n);
/** a / b rounded half away from zero, as ledger-core rounds. */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  if (r === 0n || abs(r) * 2n < abs(b)) return q;
  return (a < 0n) !== (b < 0n) ? q - 1n : q + 1n;
}
/** An amount converted at a rate ×1e6, rounded half away from zero (ledger-core applyFx). */
const applyFx = (amount: bigint, rateE6: bigint) => divRound(amount * rateE6, E6);
/** The group account code, the text before the first '-': '2950-UK' -> '2950'; a root subsidiary's bare code is its own. */
const groupCode = (code: string) => code.split('-')[0]!;

/** One journal line with what consolidation checks need from its entry and period. */
type LedgerLine = { code: string; subsidiaryId: string; ym: string; ccy: string; txn: bigint; functional: bigint; proposalId: string | null };

function ledgerLines(db: Db): LedgerLine[] {
  const jes = byId(db.query('SELECT * FROM journal_entry'));
  const periods = byId(db.query('SELECT * FROM period'));
  return db.query('SELECT * FROM journal_line').flatMap((l) => {
    const je = jes.get(String(l.je_id));
    if (!je) return [];
    const rate = big(l.fx_rate_e_6);
    return [{
      code: String(l.account_code),
      subsidiaryId: String(je.subsidiary_id),
      ym: String(periods.get(String(je.period_id))?.ym ?? ''),
      ccy: String(l.ccy),
      txn: big(l.debit_minor) - big(l.credit_minor),
      // Per line, each side converted on its own, as the module books it.
      functional: applyFx(big(l.debit_minor), rate) - applyFx(big(l.credit_minor), rate),
      proposalId: je.proposal_id === null || je.proposal_id === undefined ? null : String(je.proposal_id),
    }];
  });
}

/**
 * The books a Proposal was computed from: entries posted from it or from any later Proposal are left out, so a
 * Proposal that has since been applied is judged against the ledger it saw.
 */
const before = (lines: LedgerLine[], proposalId: unknown) => lines.filter((l) => l.proposalId === null || big(l.proposalId) < big(proposalId));

/** Closing rate ×1e6 from one currency into another for a month: 1e6 for the same currency, direct, else 1e12 / inverse. */
function closingRate(rates: Row[], from: string, to: string, ym: string): bigint | undefined {
  if (from === to) return E6;
  const find = (f: string, t: string) => rates.find((r) => r.kind === 'closing' && r.from_ccy === f && r.to_ccy === t && String(r.ym) === ym);
  const direct = find(from, to);
  if (direct) return big(direct.rate_e_6);
  const inverse = find(to, from);
  return inverse && big(inverse.rate_e_6) !== 0n ? divRound(E6 * E6, big(inverse.rate_e_6)) : undefined;
}

/** Net debit-positive effect of payload lines per account code. */
function netByCode(lines: PayloadLine[], key: (code: string) => string = (c) => c): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const l of lines) out.set(key(l.accountCode), (out.get(key(l.accountCode)) ?? 0n) + big(l.debitMinor) - big(l.creditMinor));
  return out;
}
const sumOf = (lines: PayloadLine[], f: 'debitMinor' | 'creditMinor') => lines.reduce((a, l) => a + big(l[f]), 0n);

/** Settings value_text by key (reporting_ccy), or undefined. */
const settingText = (db: Db, key: string) => {
  const v = db.query('SELECT * FROM settings').find((r) => r.key === key)?.value_text;
  return typeof v === 'string' && v ? v : undefined;
};

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

  /**
   * Every revaluation (fx_revaluation proposal) restates only foreign-currency balances, at the recorded closing rate
   * of its own month, by the right amount: per item the account is an asset or liability of the subsidiary, the item
   * currency is not the subsidiary's own, the rate is fx_rate's closing rate (item currency into the subsidiary's) for
   * periodYm, and the transaction balance, booked balance, target and delta agree with the journal lines through
   * periodYm. Its lines are in the subsidiary's currency at 1.0, move each item account by exactly its delta, put the
   * offset on the subsidiary's 7100 account, and balance. A foreign balance it leaves out is an offender too.
   */
  fx_revaluation_rates(db, params) {
    const props = db.query('SELECT * FROM proposal').filter((p) => p.kind === 'fx_revaluation' && matchRow(p, params.where as CondMap | undefined));
    const subs = byId(db.query('SELECT * FROM subsidiary'));
    const accounts = byId(db.query('SELECT * FROM account'), 'code');
    const rates = db.query('SELECT * FROM fx_rate');
    const all = ledgerLines(db);
    const offenders: Row[] = [];
    let checked = 0;
    for (const p of props) {
      const pay = json<FxRevaluationPayload>(p.payload_json);
      const flag = (problem: string, account_code?: string) => offenders.push({ proposal_id: p.id, ...(account_code ? { account_code } : {}), problem });
      const sub = pay ? subs.get(String(pay.subsidiaryId)) : undefined;
      if (!pay || !sub) {
        flag(pay ? `unknown subsidiary ${String(pay.subsidiaryId)}` : 'payload is not JSON');
        continue;
      }
      const subId = String(sub.id);
      const functional = String(sub.functional_ccy);
      const ym = String(pay.periodYm);
      if (pay.rateYm !== undefined && String(pay.rateYm) !== ym) flag(`rates of ${String(pay.rateYm)} used for a ${ym} revaluation`);
      const books = before(all, p.id).filter((l) => l.subsidiaryId === subId && l.ym <= ym);
      const items = pay.items ?? [];
      const lines = pay.lines ?? [];
      for (const it of items) {
        checked++;
        const code = String(it.accountCode);
        const acct = accounts.get(code);
        if (!acct || String(acct.subsidiary_id) !== subId) {
          flag(`account is not one of ${String(sub.code)}'s`, code);
          continue;
        }
        if (acct.account_type !== 'asset' && acct.account_type !== 'liability') flag(`revalues a ${String(acct.account_type)} account; only assets and liabilities are restated`, code);
        if (it.ccy === functional) flag(`revalues a ${functional} balance, the subsidiary's own currency`, code);
        const rate = closingRate(rates, String(it.ccy), functional, ym);
        if (rate === undefined) flag(`no closing ${String(it.ccy)}/${functional} rate recorded for ${ym}`, code);
        else if (big(it.closingRateE6) !== rate) flag(`rate ${String(it.closingRateE6)} is not the ${ym} closing rate ${rate}`, code);
        const onAccount = books.filter((l) => l.code === code);
        const txn = onAccount.filter((l) => l.ccy === it.ccy).reduce((a, l) => a + l.txn, 0n);
        const booked = onAccount.reduce((a, l) => a + l.functional, 0n);
        const target = applyFx(txn, rate ?? big(it.closingRateE6));
        if (big(it.txnBalanceMinor) !== txn) flag(`${String(it.ccy)} balance ${String(it.txnBalanceMinor)} but the books hold ${txn}`, code);
        if (big(it.bookedFunctionalMinor) !== booked) flag(`booked ${functional} balance ${String(it.bookedFunctionalMinor)} but the books hold ${booked}`, code);
        if (big(it.targetFunctionalMinor) !== target) flag(`target ${String(it.targetFunctionalMinor)} but the balance at the closing rate is ${target}`, code);
        if (big(it.deltaMinor) !== target - booked) flag(`delta ${String(it.deltaMinor)} but target minus booked is ${target - booked}`, code);
      }
      // Every foreign balance on an asset or liability of the subsidiary is restated.
      const foreign = new Map<string, bigint>();
      for (const l of books) {
        const t = accounts.get(l.code)?.account_type;
        if (l.ccy === functional || (t !== 'asset' && t !== 'liability')) continue;
        foreign.set(`${l.code}|${l.ccy}`, (foreign.get(`${l.code}|${l.ccy}`) ?? 0n) + l.txn);
      }
      for (const [k, bal] of foreign) {
        const [code, ccy] = k.split('|') as [string, string];
        if (bal !== 0n && !items.some((it) => it.accountCode === code && it.ccy === ccy)) flag(`${ccy} balance ${bal} is not revalued`, code);
      }
      // The entry: functional currency at 1.0, each item account moved by its delta, the offset on 7100, balanced.
      for (const l of lines) {
        if (l.ccy !== functional || big(l.fxRateE6) !== E6) flag(`line in ${String(l.ccy)} at ${String(l.fxRateE6)}; revaluation lines are in ${functional} at 1000000`, String(l.accountCode));
      }
      const net = netByCode(lines);
      const deltas = new Map<string, bigint>();
      for (const it of items) deltas.set(String(it.accountCode), (deltas.get(String(it.accountCode)) ?? 0n) + big(it.deltaMinor));
      for (const [code, d] of deltas) if ((net.get(code) ?? 0n) !== d) flag(`lines move the account by ${net.get(code) ?? 0n}, not its delta ${d}`, code);
      for (const [code, n] of net) {
        if (deltas.has(code) || n === 0n) continue;
        const acct = accounts.get(code);
        if (groupCode(code) !== '7100' || String(acct?.subsidiary_id) !== subId) flag(`offset line on ${code}; the gain or loss goes to ${String(sub.code)}'s 7100 account`, code);
      }
      if (sumOf(lines, 'debitMinor') !== sumOf(lines, 'creditMinor')) flag('the entry does not balance');
    }
    return { checked: checked + props.length, unit: 'revaluations and their items', offenders };
  },

  /**
   * Every elimination (ic_elimination proposal) removes exactly the intercompany balance the books hold: it posts to
   * the elimination subsidiary on its intercompany accounts in the reporting currency at 1.0 and balances; basis
   * `balance` reverses in a later month and `activity` never does; per pair the amount is the source account's
   * balance through periodYm (`balance`) or its periodYm activity (`activity`) in the source subsidiary, which keeps its
   * books in the reporting currency; and the lines take that amount off the source group code and the counter group
   * code (source side by the opposite of the source balance, counter side by the source balance).
   */
  ic_elimination_amounts(db, params) {
    const props = db.query('SELECT * FROM proposal').filter((p) => p.kind === 'ic_elimination' && matchRow(p, params.where as CondMap | undefined));
    const subs = byId(db.query('SELECT * FROM subsidiary'));
    const accounts = byId(db.query('SELECT * FROM account'), 'code');
    const reporting = String(params.reporting_ccy ?? settingText(db, 'reporting_ccy') ?? 'USD');
    const all = ledgerLines(db);
    const offenders: Row[] = [];
    let checked = 0;
    for (const p of props) {
      const pay = json<IcEliminationPayload>(p.payload_json);
      const flag = (problem: string, extra: Row = {}) => offenders.push({ proposal_id: p.id, ...extra, problem });
      const sub = pay ? subs.get(String(pay.subsidiaryId)) : undefined;
      if (!pay || !sub) {
        flag(pay ? `unknown subsidiary ${String(pay.subsidiaryId)}` : 'payload is not JSON');
        continue;
      }
      const subId = String(sub.id);
      const ym = String(pay.periodYm);
      if (sub.is_elimination !== true) flag(`posts to ${String(sub.code)}, which is not the elimination subsidiary`);
      if (pay.basis === 'balance') {
        if (!pay.reversesInYm || !(String(pay.reversesInYm) > ym)) flag(`a balance elimination reverses in a later month than ${ym}; reversesInYm is "${String(pay.reversesInYm ?? '')}"`);
      } else if (pay.basis === 'activity') {
        if (pay.reversesInYm) flag("an activity elimination covers one month's results and never reverses");
      } else flag(`basis "${String(pay.basis)}" is neither balance nor activity`);
      const lines = pay.lines ?? [];
      for (const l of lines) {
        const acct = accounts.get(String(l.accountCode));
        if (!acct || String(acct.subsidiary_id) !== subId || acct.is_intercompany !== true) flag(`line on ${String(l.accountCode)}, not an intercompany account of ${String(sub.code)}`, { account_code: l.accountCode });
        if (l.ccy !== reporting || big(l.fxRateE6) !== E6) flag(`line in ${String(l.ccy)} at ${String(l.fxRateE6)}; eliminations are in ${reporting} at 1000000`, { account_code: l.accountCode });
      }
      if (sumOf(lines, 'debitMinor') !== sumOf(lines, 'creditMinor')) flag('the entry does not balance');
      const books = before(all, p.id);
      const want = new Map<string, bigint>();
      for (const pair of pay.pairs ?? []) {
        checked++;
        const at = { pair: pair.label, account_code: pair.sourceAccountCode };
        const src = accounts.get(String(pair.sourceAccountCode));
        const srcSub = subs.get(String(pair.sourceSubsidiaryId));
        if (!src || !srcSub || String(src.subsidiary_id) !== String(srcSub.id)) {
          flag(`source account is not one of subsidiary ${String(pair.sourceSubsidiaryId)}'s`, at);
          continue;
        }
        const wantTypes = pay.basis === 'activity' ? ['revenue', 'expense'] : ['asset', 'liability'];
        if (!wantTypes.includes(String(src.account_type))) flag(`a ${String(pay.basis)} elimination's source is ${wantTypes.join(' or ')}, not ${String(src.account_type)}`, at);
        if (String(srcSub.functional_ccy) !== reporting) flag(`source subsidiary ${String(srcSub.code)} keeps its books in ${String(srcSub.functional_ccy)}, not the reporting currency ${reporting}`, at);
        const counter = accounts.get(String(pair.counterAccountCode));
        if (!counter || String(counter.subsidiary_id) !== String(pair.counterSubsidiaryId)) flag(`counter account ${String(pair.counterAccountCode)} is not one of subsidiary ${String(pair.counterSubsidiaryId)}'s`, at);
        const onSource = books.filter((l) => l.code === src.code && l.subsidiaryId === String(srcSub.id) && (pay.basis === 'activity' ? l.ym === ym : l.ym <= ym));
        const signed = onSource.reduce((a, l) => a + l.functional, 0n);
        if (big(pair.amountMinor) !== abs(signed)) flag(`eliminates ${String(pair.amountMinor)} but the books hold ${abs(signed)}${pay.basis === 'activity' ? ` of ${ym} activity` : ` through ${ym}`}`, at);
        if (abs(big(pair.differenceMinor)) !== abs(big(pair.amountMinor) - big(pair.counterTranslatedMinor))) flag(`difference ${String(pair.differenceMinor)} is not the amount less the counter side`, at);
        const s = groupCode(String(src.code));
        const c = groupCode(String(pair.counterAccountCode));
        want.set(s, (want.get(s) ?? 0n) - signed);
        want.set(c, (want.get(c) ?? 0n) + signed);
      }
      const have = netByCode(lines, groupCode);
      for (const code of new Set([...want.keys(), ...have.keys()])) {
        if ((want.get(code) ?? 0n) !== (have.get(code) ?? 0n)) flag(`lines move group account ${code} by ${have.get(code) ?? 0n}; the books call for ${want.get(code) ?? 0n}`, { account_code: code });
      }
    }
    return { checked: checked + props.length, unit: 'eliminations and their pairs', offenders };
  },

  /**
   * Every intercompany pair whose two sides differ by more than the tolerance (params.tolerance_minor, default the
   * ic_difference_tolerance_minor variable, else 100 = $1) is raised in the close thread: a message from the
   * consolidation agent (params.sender_role) in close:<periodYm> that names the pair label and says the books differ
   * (differ, difference, disagree or mismatch, as the consolidation harness's Escalates 1 rule asks).
   */
  ic_difference_escalated(db, params, ctx) {
    const tolerance = big(params.tolerance_minor ?? ctx.vars.ic_difference_tolerance_minor ?? 100);
    const role = String(params.sender_role ?? 'consolidation');
    const props = db.query('SELECT * FROM proposal').filter((p) => p.kind === 'ic_elimination' && matchRow(p, params.where as CondMap | undefined));
    const msgs = db.query('SELECT * FROM agent_message').filter((m) => m.sender_role === role);
    const offenders: Row[] = [];
    let checked = 0;
    for (const p of props) {
      const pay = json<IcEliminationPayload>(p.payload_json);
      for (const pair of pay?.pairs ?? []) {
        const diff = [abs(big(pair.differenceMinor)), abs(big(pair.amountMinor) - big(pair.counterTranslatedMinor))].reduce((a, b) => (b > a ? b : a));
        if (diff <= tolerance) continue;
        checked++;
        const label = String(pair.label).toLowerCase();
        const raised = msgs.some((m) => {
          const text = `${String(m.body ?? '')} ${String(m.summary_plain ?? '')}`.toLowerCase();
          return m.thread_id === `close:${String(pay!.periodYm)}` && text.includes(label) && /\b(differ|disagree|mismatch)/.test(text);
        });
        if (!raised) offenders.push({ proposal_id: p.id, pair: pair.label, difference_minor: diff.toString(), problem: `a ${diff} difference is not raised by ${role} in close:${String(pay!.periodYm)}` });
      }
    }
    return { checked, unit: 'intercompany differences over the tolerance', offenders };
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
