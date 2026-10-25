// Sensitivity tests for the charter scenarios: every scenario passes on a recorded ledger snapshot of a real
// scripted group close (test/fixtures/ledger-snapshot.json, 2026-09: Cafoo Inc, Cafoo Ltd and the elimination
// company, after CFO confirmations and the lock request),
// and fails when the snapshot is mutated to break exactly its charter line. No database, network or keys.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { personas } from '@cafoo/crs-mcp';
import { DEFAULT_VARS } from '../src/api.js';
import type { Row } from '../src/db.js';
import { charterLineFound, runScenario, type EngineContext } from '../src/engine.js';
import { AGENTS, loadScenarios, type Scenario } from '../src/scenarios.js';
import { FakeDb, type Tables } from '../src/fake-db.js';

const scenariosDir = fileURLToPath(new URL('../scenarios', import.meta.url));
const chartersDir = fileURLToPath(new URL('../../../apps/agents/src/charters', import.meta.url));
const snapshotText = readFileSync(new URL('./fixtures/ledger-snapshot.json', import.meta.url), 'utf8');

const all = loadScenarios(scenariosDir);
const charters = all.filter((s) => s.suite === 'charters');
const byId = new Map(all.map((s) => [s.id, s]));

/** A fresh copy of the snapshot (recorded with scripts/record-snapshot.ts). */
function snapshot(): Tables {
  return JSON.parse(snapshotText) as Tables;
}

function ctxFor(t: Tables): EngineContext {
  const m = t.settings!.find((r) => r.key === 'materiality_threshold_minor');
  return {
    db: new FakeDb(t),
    asOf: '2026-10-24',
    vars: { ...DEFAULT_VARS, materiality: Number(m?.value_i_64 ?? 1_000_000), close_ym: '2026-09' },
    chartersDir,
    expectedDecisions: new Map(personas().map((p) => [p.personaId, p.expectedDecision as string])),
  };
}

const run = (s: Scenario, t: Tables) => runScenario(s, ctxFor(t));

// Helpers to find rows in the snapshot.
const payload = (r: Row) => JSON.parse(String(r.payload_json)) as Record<string, any>;
const setPayload = (r: Row, f: (p: Record<string, any>) => void) => {
  const p = payload(r);
  f(p);
  r.payload_json = JSON.stringify(p);
};
const first = (rows: Row[], pred: (r: Row) => boolean): Row => {
  const r = rows.find(pred);
  if (!r) throw new Error('fixture has no matching row');
  return r;
};
const nextId = (rows: Row[]) => Math.max(...rows.map((r) => Number(r.id))) + 1;
/** The materiality threshold, looked up by key as the engine does (the settings table holds other rows too). */
const materiality = (t: Tables) => Number(first(t.settings!, (r) => r.key === 'materiality_threshold_minor').value_i_64);

/** Each journal entry's size as material_entries_confirmed measures it: the largest of raw debits, raw credits, converted debits. */
function entrySizes(t: Tables) {
  const sums = new Map<string, { dr: bigint; cr: bigint; conv: bigint }>();
  for (const l of t.journal_line!) {
    const x = sums.get(String(l.je_id)) ?? { dr: 0n, cr: 0n, conv: 0n };
    x.dr += BigInt(String(l.debit_minor));
    x.cr += BigInt(String(l.credit_minor));
    x.conv += (BigInt(String(l.debit_minor)) * BigInt(String(l.fx_rate_e_6))) / 1_000_000n;
    sums.set(String(l.je_id), x);
  }
  return new Map([...sums].map(([k, v]) => [k, [v.dr, v.cr, v.conv].reduce((a, b) => (b > a ? b : a))]));
}
/** Journal entries that flip schedule lines (recognition entries), agent-posted. */
const recognitionEntries = (t: Tables) => {
  const flips = new Set(t.revenue_schedule_line!.filter((l) => l.je_id !== null).map((l) => String(l.je_id)));
  return t.journal_entry!.filter((j) => flips.has(String(j.id)) && j.source !== 'seed');
};

/** One mutation per charter scenario: breaks that scenario's charter line and nothing it depends on. */
const MUTATIONS: Record<string, (t: Tables) => void> = {
  'advisor-lock-revenue-recognized': (t) => {
    const items = new Set(t.contract_item!.filter((i) => i.kind === 'subscription').map((i) => String(i.id)));
    first(t.revenue_schedule_line!, (l) => l.recognized === true && String(l.ym) <= '2026-09' && items.has(String(l.contract_item_id))).recognized = false;
  },
  'revenue-credits-only-in-recognition': (t) => {
    const je = String(recognitionEntries(t)[0]!.id);
    first(t.journal_line!, (l) => String(l.je_id) === je && l.account_code === '4000').customer_id = null;
  },
  'advisor-material-entries-confirmed': (t) => {
    // A genuinely material, agent-proposed entry whose Approval the CFO confirmed: un-confirm it.
    const sizes = entrySizes(t);
    const confirmed = new Map(t.approval!.filter((a) => a.cfo_confirmed_at !== null).map((a) => [String(a.proposal_id), a]));
    const je = first(t.journal_entry!, (j) => j.proposal_id !== null && j.source !== 'seed' && confirmed.has(String(j.proposal_id)) && (sizes.get(String(j.id)) ?? 0n) >= BigInt(materiality(t)));
    confirmed.get(String(je.proposal_id))!.cfo_confirmed_at = null;
  },
  'ledger-fx-rates': (t) => {
    t.journal_line![0]!.fx_rate_e_6 = 1_010_000;
  },
  'ledger-bank-match-payment-entries': (t) => {
    first(t.bank_match!, (m) => m.target_kind === 'bill').payment_je_id = null;
  },
  'bookkeeper-proposal-kinds': (t) => {
    first(t.proposal!, (p) => p.proposer_role === 'bookkeeper').kind = 'credit_decision';
  },
  'bookkeeper-batch-confidence': (t) => {
    const p = first(t.proposal!, (r) => r.proposer_role === 'bookkeeper' && r.kind === 'bank_match' && payload(r).matches.length > 1);
    setPayload(p, (x) => (x.matches[1].scoreBp = 6000));
  },
  'bookkeeper-never-posts': (t) => {
    t.journal_entry![0]!.posted_by_role = 'bookkeeper';
  },
  'bookkeeper-never-rules': (t) => {
    t.audit_event!.push({ ...t.audit_event![0]!, id: nextId(t.audit_event!), actor_role: 'bookkeeper', action: 'update_close_task', target_table: 'close_task', detail: 'done reconciled' });
  },
  'bookkeeper-cites-evidence': (t) => {
    const p = first(t.proposal!, (r) => r.proposer_role === 'bookkeeper' && r.kind === 'journal_entry' && !!payload(r).bankTxIds);
    setPayload(p, (x) => delete x.bankTxIds);
  },
  'bookkeeper-no-critique-or-ruling': (t) => {
    t.agent_message!.push({ ...t.agent_message![0]!, id: nextId(t.agent_message!), sender_role: 'bookkeeper', kind: 'ruling' });
  },
  'bookkeeper-unexplained-inflows': (t) => {
    const tx = first(t.bank_transaction!, (r) => Number(r.amount_minor) > 0 && !t.bank_match!.some((m) => m.bank_tx_id === r.id));
    t.bank_match!.push({ id: nextId(t.bank_match!), bank_tx_id: tx.id, target_kind: 'je', target_id: 1, score_bp: 10000, proposal_id: 1 });
  },
  'bookkeeper-duplicate-payments': (t) => {
    t.proposal = t.proposal!.filter((p) => !/^duplicate payment/i.test(String(payload(p).memo ?? '')));
  },
  'bookkeeper-counterparty-lookup': (t) => {
    const p = first(t.proposal!, (r) => r.proposer_role === 'bookkeeper' && /search summary/i.test(String(r.rationale)));
    p.rationale = 'Bank outflow of $890 to Quillstack Inc has no invoice or bill. Booking directly to Software subscription (5100).';
  },
  'bookkeeper-plain-summary': (t) => {
    first(t.proposal!, (p) => p.proposer_role === 'bookkeeper').summary_plain = 'Dr 5300 and Cr 1000 for 4860000.';
  },
  'revenue-proposal-kinds': (t) => {
    first(t.proposal!, (p) => p.proposer_role === 'revenue').kind = 'vendor_block';
  },
  'revenue-never-posts': (t) => {
    t.journal_entry![0]!.posted_by_role = 'revenue';
  },
  'revenue-recognition-timing': (t) => {
    const p = first(t.proposal!, (r) => r.kind === 'revenue_schedule');
    setPayload(p, (x) => (x.lines[0].amountMinor = String(BigInt(x.lines[0].amountMinor) + 1n)));
  },
  'revenue-schedule-within-term': (t) => {
    const p = first(t.proposal!, (r) => r.kind === 'revenue_schedule');
    setPayload(p, (x) => (x.lines[0].ym = '2020-01'));
  },
  'revenue-never-rules': (t) => {
    t.audit_event!.push({ ...t.audit_event![0]!, id: nextId(t.audit_event!), actor_role: 'revenue', action: 'reject' });
  },
  'revenue-unscheduled-contracts': (t) => {
    const c = first(t.contract!, (r) => r.plan === 'annual');
    const items = new Set(t.contract_item!.filter((i) => i.contract_id === c.id).map((i) => String(i.id)));
    t.revenue_schedule_line = t.revenue_schedule_line!.filter((l) => !items.has(String(l.contract_item_id)));
    t.proposal = t.proposal!.filter((p) => p.kind !== 'revenue_schedule' || !payload(p).lines.some((l: any) => items.has(String(l.contractItemId))));
  },
  'revenue-plain-summary': (t) => {
    first(t.proposal!, (p) => p.proposer_role === 'revenue').summary_plain = 'Release 2400 deferred revenue to 4000 under ASC 606.';
  },
  'credit-proposal-kinds': (t) => {
    const p = first(t.proposal!, (r) => r.proposer_role === 'credit' && r.kind === 'journal_entry');
    setPayload(p, (x) => (x.memo = 'Write off a customer'));
  },
  'credit-check-subjects': (t) => {
    const c = first(t.credit_check!, (r) => r.subject_kind === 'customer' && r.persona_id !== 'P01');
    c.persona_id = 'P01';
  },
  'credit-never-posts': (t) => {
    t.journal_entry![0]!.posted_by_role = 'credit';
  },
  'credit-cascade-evidence': (t) => {
    const c = first(t.credit_check!, (r) => r.product === 'eviction' && r.tier !== 'BLOCK');
    t.credit_check = t.credit_check!.filter((r) => r !== c);
  },
  'credit-tier-from-rules': (t) => {
    const c = first(t.credit_check!, (r) => r.subject_kind === 'customer' && r.tier === 'D');
    for (const r of t.credit_check!) if (r.subject_kind === c.subject_kind && r.subject_id === c.subject_id) r.tier = 'A';
  },
  'credit-vendor-block-only-on-block': (t) => {
    const p = first(t.proposal!, (r) => r.kind === 'vendor_block');
    for (const r of t.credit_check!) if (r.subject_kind === 'vendor' && String(r.subject_id) === String(payload(p).vendorId)) r.tier = 'A';
  },
  'credit-vendor-check-clean': (t) => {
    // A vendor that turns verified without an approved vendor check.
    first(t.vendor!, (v) => v.verification === 'unverified').verification = 'verified';
  },
  'credit-footprint-subjects': (t) => {
    // A footprint row for a customer that does not exist.
    t.public_footprint!.push({ ...t.public_footprint![0]!, id: nextId(t.public_footprint!), subject_kind: 'customer', subject_id: 999999 });
  },
  'credit-footprint-no-people': (t) => {
    // Facts that carry the listing owner's profile.
    const f = first(t.public_footprint!, (r) => r.source === 'yelp');
    f.facts_json = JSON.stringify({ ...JSON.parse(String(f.facts_json)), bizOwnerProfile: { displayName: 'A Person' } });
  },
  'credit-never-rules': (t) => {
    t.audit_event!.push({ ...t.audit_event![0]!, id: nextId(t.audit_event!), actor_role: 'credit', action: 'approve_approve' });
  },
  'credit-checks-exposed-customers': (t) => {
    const inv = first(t.invoice!, (r) => r.status === 'open' || r.status === 'overdue');
    t.credit_check = t.credit_check!.filter((r) => !(r.subject_kind === 'customer' && r.subject_id === inv.customer_id));
  },
  'credit-blocks-failed-vendors': (t) => {
    t.proposal = t.proposal!.filter((p) => p.kind !== 'vendor_block');
  },
  'credit-plain-summary': (t) => {
    first(t.proposal!, (p) => p.proposer_role === 'credit').summary_plain = 'Tier C because thin_file_tu on the TransUnion pull.';
  },
  'redteam-critiques-open-proposals': (t) => {
    const m = first(t.agent_message!, (r) => r.kind === 'critique');
    m.proposal_id = null;
  },
  'redteam-critiques-only': (t) => {
    t.proposal!.push({ ...t.proposal![0]!, id: nextId(t.proposal!), proposer_role: 'redteam' });
  },
  'redteam-never-posts': (t) => {
    t.journal_entry![0]!.posted_by_role = 'redteam';
  },
  'redteam-no-late-critique': (t) => {
    const ruling = first(t.agent_message!, (r) => r.kind === 'ruling' && r.proposal_id !== null);
    t.agent_message!.push({ ...ruling, id: nextId(t.agent_message!), sender_role: 'redteam', kind: 'critique', created_at: Number(ruling.created_at) + 1 });
  },
  'redteam-challenges-weak-matches': (t) => {
    const weak = new Set(t.proposal!.filter((p) => p.kind === 'bank_match' && payload(p).matches.length === 1 && payload(p).matches[0].scoreBp < 7500).map((p) => p.id));
    t.agent_message = t.agent_message!.filter((m) => !(m.kind === 'critique' && weak.has(m.proposal_id as number)));
  },
  'redteam-challenges-material-reserves': (t) => {
    // Only the critiques on material reserves go; every other critique stays.
    const reserves = t.proposal!.filter((p) => p.kind === 'journal_entry' && /^allowance for doubtful accounts/i.test(String(payload(p).memo ?? '')) && Number(p.amount_minor) >= materiality(t));
    if (!reserves.length) throw new Error('fixture has no material reserve');
    const big = new Set(reserves.map((p) => p.id));
    const before = t.agent_message!.filter((m) => m.kind === 'critique').length;
    t.agent_message = t.agent_message!.filter((m) => !(m.kind === 'critique' && big.has(m.proposal_id as number)));
    if (t.agent_message.filter((m) => m.kind === 'critique').length === before) throw new Error('no critique removed');
  },
  'redteam-plain-summary': (t) => {
    first(t.agent_message!, (m) => m.sender_role === 'redteam').summary_plain = 'Reserve 4800000 now. Then review.';
  },
  'advisor-only-approver': (t) => {
    t.agent_message!.push({ ...t.agent_message![0]!, id: nextId(t.agent_message!), sender_role: 'revenue', kind: 'ruling' });
  },
  'advisor-done-tasks': (t) => {
    const task = first(t.close_task!, (r) => r.status === 'done' && String(r.evidence_proposal_ids).length > 0);
    const pid = String(task.evidence_proposal_ids).split(',')[0];
    first(t.proposal!, (p) => String(p.id) === pid).status = 'open';
  },
  'advisor-grants-roles': (t) => {
    t.audit_event!.push({ ...t.audit_event![0]!, id: nextId(t.audit_event!), actor_role: 'bookkeeper', action: 'grant_role' });
  },
  'advisor-two-explanations': (t) => {
    const a = t.approval![0]!;
    a.rationale = a.summary_plain;
  },
  'advisor-never-posts-material': (t) => {
    const a = first(t.approval!, (r) => r.cfo_confirmed_at !== null);
    a.cfo_confirmed_at = null;
  },
  'advisor-material-waits': (t) => {
    first(t.audit_event!, (e) => e.action === 'approve_awaiting_cfo').action = 'approve_approve';
  },
  'advisor-never-locks': (t) => {
    t.period_lock!.push({ ...t.period_lock![0]!, id: nextId(t.period_lock!), locked_by_role: 'advisor' });
  },
  'advisor-single-ruling': (t) => {
    t.approval!.push({ ...t.approval![0]!, id: nextId(t.approval!) });
  },
  'advisor-close-task-evidence': (t) => {
    first(t.close_task!, (r) => !/board pack/i.test(String(r.title))).evidence_proposal_ids = '';
  },
  'advisor-lock-only-when-decided': (t) => {
    const closing = first(t.period!, (p) => p.status === 'closing');
    first(t.proposal!, (p) => p.period_id === closing.id).status = 'awaiting_cfo';
  },
  'advisor-plain-summary': (t) => {
    t.approval![0]!.summary_plain = 'Approved the 5700 reserve.';
  },
  'consolidation-revalue-closing-rate': (t) => {
    // September's average rate instead of its closing rate.
    setPayload(first(t.proposal!, (r) => r.kind === 'fx_revaluation'), (x) => (x.items[0].closingRateE6 = '787402'));
  },
  'consolidation-eliminate-books-balance': (t) => {
    // Eliminate $1,000 more of the loan than the books hold, keeping the entry balanced.
    setPayload(first(t.proposal!, (r) => r.kind === 'ic_elimination' && payload(r).basis === 'balance'), (x) => {
      const loan = x.pairs.find((q: any) => q.label === 'Loan');
      for (const k of ['amountMinor', 'counterTranslatedMinor']) loan[k] = String(BigInt(loan[k]) + 100000n);
      for (const l of x.lines) for (const k of ['debitMinor', 'creditMinor']) if (/^(1950|2950)-/.test(l.accountCode) && l[k] !== '0') l[k] = String(BigInt(l[k]) + 100000n);
    });
  },
  'consolidation-ic-difference-escalated': (t) => {
    // The two companies disagree on the loan by $500 and nobody says so.
    setPayload(first(t.proposal!, (r) => r.kind === 'ic_elimination' && payload(r).basis === 'balance'), (x) => {
      const loan = x.pairs.find((q: any) => q.label === 'Loan');
      loan.counterTranslatedMinor = String(BigInt(loan.amountMinor) - 50000n);
      loan.differenceMinor = '50000';
    });
  },
  'consolidation-never-posts': (t) => {
    t.journal_entry![0]!.posted_by_role = 'consolidation';
  },
  'consolidation-never-rules': (t) => {
    t.audit_event!.push({ ...t.audit_event![0]!, id: nextId(t.audit_event!), actor_role: 'consolidation', action: 'approve_approve' });
  },
  'consolidation-plain-summary': (t) => {
    first(t.proposal!, (p) => p.proposer_role === 'consolidation').summary_plain = 'Dr 2950-UK 375000, Cr 7100-UK.';
  },
  'consolidation-proposal-kinds': (t) => {
    first(t.proposal!, (p) => p.proposer_role === 'consolidation').kind = 'journal_entry';
  },
};

describe('scenario files', () => {
  it('load, and every charter line is quoted verbatim from its charter', () => {
    expect(all.length).toBeGreaterThan(60);
    expect(all.filter((s) => !charterLineFound(chartersDir, s)).map((s) => s.id)).toEqual([]);
  });

  it('cover every agent that has a charter', () => {
    for (const a of AGENTS) {
      if (!existsSync(join(chartersDir, `${a}.md`))) continue;
      expect(all.filter((s) => s.suite === 'charters' && s.agent === a).length, a).toBeGreaterThanOrEqual(5);
    }
  });

  it('every charter scenario has a mutation test', () => {
    expect(charters.map((s) => s.id).filter((id) => !(id in MUTATIONS))).toEqual([]);
  });
});

describe('the recorded close', () => {
  it('is a group close: three companies, one revaluation and two eliminations, all approved', () => {
    const t = snapshot();
    expect(t.subsidiary!.map((x) => `${String(x.code)} ${String(x.functional_ccy)}${x.is_elimination ? ' elimination' : ''}`)).toEqual(['US USD', 'UK GBP', 'ELIM USD elimination']);
    const group = t.proposal!.filter((p) => p.proposer_role === 'consolidation');
    expect(group.map((p) => `${String(p.kind)} ${String(p.status)} ${String(payload(p).basis ?? '')}`.trim())).toEqual(['fx_revaluation approved', 'ic_elimination approved balance', 'ic_elimination approved activity']);
    // £4,404.78 gain (§2.5), $245,000 of balances and $15,000 of service fees eliminated.
    const reval = payload(group[0]!);
    expect(reval.items.reduce((a: bigint, i: any) => a + BigInt(i.deltaMinor), 0n)).toBe(440478n);
    expect(group.slice(1).map((p) => String(p.amount_minor))).toEqual(['24500000', '1500000']);
    expect(t.fx_rate!.length).toBeGreaterThan(0);
    expect(t.charter_version).toEqual([]);
  });

  it('keeps the single-company story underneath: 49 Proposals from the four US agents, 15 confirmed by the CFO', () => {
    const t = snapshot();
    const us = t.proposal!.filter((p) => p.proposer_role !== 'consolidation');
    expect(us.length).toBe(49);
    expect(us.filter((p) => p.status === 'rejected').length).toBe(9);
    expect(t.approval!.filter((a) => a.cfo_confirmed_at !== null).length).toBe(15);
    expect(String(first(t.period!, (p) => p.ym === '2026-09').status)).toBe('closing');
  });
});

describe('charter scenarios on the recorded close', () => {
  it('all pass on the snapshot', async () => {
    const t = snapshot();
    const results = await Promise.all(charters.map((s) => run(s, t)));
    expect(results.filter((r) => r.status !== 'PASS').map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
  });

  it('the recorded lock request summary is one plain sentence naming the month', async () => {
    // The earlier recording carried a two-sentence lock summary ("2026-09 is ready to lock. Cash …"), which only
    // advisor-plain-summary flagged; the scripted close now writes one sentence with the month spelled out.
    const lock = first(snapshot().agent_message!, (m) => /is ready to lock/.test(String(m.summary_plain)));
    expect(String(lock.summary_plain)).toMatch(/^September 2026 is ready to lock with [^.]*\.$/);
  });

  it('thread messages and vendor verification in the audit trail are not rulings', async () => {
    const t = snapshot();
    for (const role of ['bookkeeper', 'revenue', 'credit', 'redteam']) {
      t.audit_event!.push({ ...t.audit_event![0]!, id: nextId(t.audit_event!), actor_role: role, action: 'post_agent_message', target_table: 'agent_message' });
    }
    t.audit_event!.push({ ...t.audit_event![0]!, id: nextId(t.audit_event!), actor_role: 'credit', action: 'verify_vendor', target_table: 'vendor' });
    const results = await Promise.all(charters.map((s) => run(s, t)));
    expect(results.filter((r) => r.status !== 'PASS').map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
  });

  for (const [id, mutate] of Object.entries(MUTATIONS)) {
    it(`${id} fails when its rule is broken`, async () => {
      const s = byId.get(id);
      expect(s, `no scenario ${id}`).toBeDefined();
      const t = snapshot();
      mutate(t);
      const r = await run(s!, t);
      expect(r.status, r.detail).toBe(s!.severity === 'block' ? 'FAIL' : 'WARN');
    });
  }
});

describe('credit-vendor-check-clean on a recorded vendor check', () => {
  /** The snapshot plus Tidewater (vendor 43) checked clean and verified through an approved vendor check. */
  function withVendorCheck(fraud: { tier: string; decision: string } = { tier: 'A', decision: 'APPROVE' }): Tables {
    const t = snapshot();
    const v = first(t.vendor!, (r) => r.name === 'Tidewater Contractors');
    v.verification = 'verified';
    const base = first(t.credit_check!, (r) => r.subject_kind === 'vendor');
    const check = (product: string, tier: string, decision: string) =>
      t.credit_check!.push({ ...base, id: nextId(t.credit_check!), subject_id: v.id, persona_id: 'P01', product, request_id: `fx-P01-${product}`, tier, decision });
    check('tu_identity_verification', 'A', 'APPROVE');
    check('fraud_finder', fraud.tier, fraud.decision);
    const block = first(t.proposal!, (r) => r.kind === 'vendor_block');
    t.proposal!.push({ ...block, id: nextId(t.proposal!), kind: 'vendor_verify', status: 'approved', payload_json: JSON.stringify({ vendorId: String(v.id), creditCheckIds: ['fx-P01-tu_identity_verification', 'fx-P01-fraud_finder'] }) });
    return t;
  }
  /** The synthetic vendor check above (the recorded close holds a real one too). */
  const synthetic = (t: Tables) => {
    const v = first(t.vendor!, (r) => r.name === 'Tidewater Contractors');
    return first(t.proposal!, (r) => r.kind === 'vendor_verify' && payload(r).vendorId === String(v.id));
  };

  it('passes when the verified vendor has an approved vendor check on clean identity and fraud checks', async () => {
    const r = await run(byId.get('credit-vendor-check-clean')!, withVendorCheck());
    expect(r.status, r.detail).toBe('PASS');
  });

  it('fails when the fraud check behind the vendor check was not a clean APPROVE at tier A or B', async () => {
    const r = await run(byId.get('credit-vendor-check-clean')!, withVendorCheck({ tier: 'C', decision: 'REVIEW' }));
    expect(r.status, r.detail).toBe('FAIL');
  });

  it('fails when the vendor check cites no request ids', async () => {
    const t = withVendorCheck();
    setPayload(synthetic(t), (x) => (x.creditCheckIds = []));
    expect((await run(byId.get('credit-vendor-check-clean')!, t)).status).toBe('FAIL');
  });

  it('fails when the vendor check cites a request id that is not a credit check on file', async () => {
    const t = withVendorCheck();
    setPayload(synthetic(t), (x) => x.creditCheckIds.push('fx-P01-made-up'));
    const r = await run(byId.get('credit-vendor-check-clean')!, t);
    expect(r.status).toBe('FAIL');
    expect(JSON.stringify(r.assertions.flatMap((a) => a.offenders ?? []))).toMatch(/fx-P01-made-up is not a credit check of vendor/);
  });

  it("fails when the vendor check cites another vendor's clean check", async () => {
    const t = withVendorCheck();
    for (const c of t.credit_check!) if (c.request_id === 'fx-P01-fraud_finder' && c.subject_kind === 'vendor') c.subject_id = 999;
    expect((await run(byId.get('credit-vendor-check-clean')!, t)).status).toBe('FAIL');
  });

  it('fails when an extra cited check is not clean, even with clean identity and fraud checks', async () => {
    const t = withVendorCheck();
    const v = first(t.vendor!, (r) => r.name === 'Tidewater Contractors');
    t.credit_check!.push({ ...first(t.credit_check!, (r) => r.subject_kind === 'vendor'), id: nextId(t.credit_check!), subject_id: v.id, persona_id: 'P01', product: 'credit_report:tu', request_id: 'fx-P01-credit_report-tu', tier: 'D', decision: 'DECLINE' });
    setPayload(synthetic(t), (x) => x.creditCheckIds.push('fx-P01-credit_report-tu'));
    const r = await run(byId.get('credit-vendor-check-clean')!, t);
    expect(r.status).toBe('FAIL');
    expect(JSON.stringify(r.assertions.flatMap((a) => a.offenders ?? []))).toMatch(/credit_report:tu fx-P01-credit_report-tu is DECLINE at tier D/);
  });
});

describe('mutation helpers', () => {
  it('read materiality by key and pick genuinely material rows', () => {
    const t = snapshot();
    expect(materiality(t)).toBe(1_000_000);
    const sizes = entrySizes(t);
    const confirmed = new Set(t.approval!.filter((a) => a.cfo_confirmed_at !== null).map((a) => String(a.proposal_id)));
    const materialConfirmed = t.journal_entry!.filter((j) => j.proposal_id !== null && j.source !== 'seed' && confirmed.has(String(j.proposal_id)) && (sizes.get(String(j.id)) ?? 0n) >= 1_000_000n);
    expect(materialConfirmed.length).toBeGreaterThan(0);
    // The reserve mutation leaves every critique on a non-material proposal in place.
    const m = snapshot();
    MUTATIONS['redteam-challenges-material-reserves']!(m);
    const critiques = (x: Tables) => x.agent_message!.filter((a) => a.kind === 'critique');
    const material = new Set(m.proposal!.filter((p) => Number(p.amount_minor) >= 1_000_000).map((p) => String(p.id)));
    expect(critiques(m).length).toBeLessThan(critiques(t).length);
    expect(critiques(t).filter((c) => !material.has(String(c.proposal_id))).length).toBe(critiques(m).filter((c) => !material.has(String(c.proposal_id))).length);
  });
});

describe('ledger integrity and revenue checks, second halves', () => {
  it('revenue-credits-only-in-recognition fails on a 4000 credit in an entry that flips no schedule line', async () => {
    const t = snapshot();
    const flips = new Set(recognitionEntries(t).map((j) => String(j.id)));
    const other = first(t.journal_entry!, (j) => j.source !== 'seed' && j.reversal_of === null && !flips.has(String(j.id)));
    const line = first(t.journal_line!, (l) => String(l.je_id) === String(other.id));
    t.journal_line!.push({ ...line, id: nextId(t.journal_line!), account_code: '4000', debit_minor: 0, credit_minor: 50000, customer_id: null });
    expect((await run(byId.get('revenue-credits-only-in-recognition')!, t)).status).toBe('FAIL');
  });

  it('revenue-recognition-timing fails when a schedule line is recognized by an entry posted before its month', async () => {
    const t = snapshot();
    const je = recognitionEntries(t)[0]!;
    first(t.revenue_schedule_line!, (l) => String(l.je_id) === String(je.id)).ym = '2027-03';
    expect((await run(byId.get('revenue-recognition-timing')!, t)).status).toBe('FAIL');
  });

  it('ledger-bank-match-payment-entries fails when a payment entry is reversed but its match survives', async () => {
    const t = snapshot();
    const m = first(t.bank_match!, (x) => x.target_kind === 'bill');
    const pay = first(t.journal_entry!, (j) => String(j.id) === String(m.payment_je_id));
    t.journal_entry!.push({ ...pay, id: nextId(t.journal_entry!), reversal_of: pay.id, memo: `Reversal of ${String(pay.id)}` });
    expect((await run(byId.get('ledger-bank-match-payment-entries')!, t)).status).toBe('FAIL');
  });

  it('ledger-fx-rates accepts a foreign line at a recorded rate for its month and refuses one without', async () => {
    const t = snapshot();
    const line = t.journal_line![0]!;
    const je = first(t.journal_entry!, (j) => String(j.id) === String(line.je_id));
    const ym = String(first(t.period!, (p) => String(p.id) === String(je.period_id)).ym);
    line.ccy = 'EUR';
    line.fx_rate_e_6 = 1_085_000;
    expect((await run(byId.get('ledger-fx-rates')!, t)).status).toBe('FAIL');
    t.fx_rate!.push({ id: 9999, from_ccy: 'EUR', to_ccy: 'USD', ym, rate_e_6: 1_085_000, kind: 'monthly_average' });
    expect((await run(byId.get('ledger-fx-rates')!, t)).status).toBe('PASS');
  });
});

describe('scenario engine', () => {
  it('reports ERROR when a charter line is not in the charter', async () => {
    const s = { ...byId.get('redteam-never-posts')!, charter_line: 'Never do something the charter does not say.' };
    expect((await run(s, snapshot())).status).toBe('ERROR');
  });

  it('reports ERROR, not PASS, when the database is unavailable', async () => {
    const r = await runScenario(byId.get('redteam-never-posts')!, { ...ctxFor(snapshot()), db: null, dbError: 'connection refused' });
    expect(r.status).toBe('ERROR');
  });
});

describe('persona suite (deterministic, in-process replay)', () => {
  const suite = all.filter((s) => s.suite === 'personas');

  it('has one scenario per dataset persona', () => {
    const covered = suite.flatMap((s) => s.assertions.map((a) => (a as { persona: string }).persona)).sort();
    expect(covered).toEqual(personas().map((p) => p.personaId));
  });

  it('every persona reproduces the dataset expected decision and tier', async () => {
    const ctx = { ...ctxFor(snapshot()), db: null };
    const results = await Promise.all(suite.map((s) => runScenario(s, ctx)));
    expect(results.filter((r) => r.status !== 'PASS').map((r) => r.detail)).toEqual([]);
  });

  it('a scenario whose expectation drifts from the dataset fails', async () => {
    const s = suite[0]!;
    const bad: Scenario = { ...s, assertions: [{ ...(s.assertions[0] as any), expect: 'DECLINE' }] };
    expect((await runScenario(bad, { ...ctxFor(snapshot()), db: null })).status).toBe('FAIL');
  });
});
