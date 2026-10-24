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
