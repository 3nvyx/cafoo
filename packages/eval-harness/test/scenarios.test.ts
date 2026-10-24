// Sensitivity tests for the charter scenarios: every scenario passes on a recorded ledger snapshot of a real
// scripted close (test/fixtures/ledger-snapshot.json, 2026-09, after CFO confirmations and the lock request),
// and fails when the snapshot is mutated to break exactly its charter line. No database, network or keys.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { personas } from '@cafoo/crs-mcp';
import type { Row } from '../src/db.js';
import { charterLineFound, runScenario, type EngineContext } from '../src/engine.js';
import { AGENTS, loadScenarios, type Scenario } from '../src/scenarios.js';
import { FakeDb, type Tables } from './fake-db.js';

const scenariosDir = fileURLToPath(new URL('../scenarios', import.meta.url));
const chartersDir = fileURLToPath(new URL('../../../apps/agents/src/charters', import.meta.url));
const snapshotText = readFileSync(new URL('./fixtures/ledger-snapshot.json', import.meta.url), 'utf8');

const all = loadScenarios(scenariosDir);
const charters = all.filter((s) => s.suite === 'charters');
const byId = new Map(all.map((s) => [s.id, s]));

const LOCK_SUMMARY = /is ready to lock\./;

/** A fresh copy of the snapshot. `clean` rewrites the one recorded plain-summary violation (see the finding test). */
function snapshot({ clean = true } = {}): Tables {
  const t = JSON.parse(snapshotText) as Tables;
  if (clean) {
    for (const m of t.agent_message!) {
      if (LOCK_SUMMARY.test(String(m.summary_plain))) m.summary_plain = 'September is ready to lock with every proposal decided.';
    }
  }
  return t;
}

function ctxFor(t: Tables): EngineContext {
  const m = t.settings!.find((r) => r.key === 'materiality_threshold_minor');
  return {
    db: new FakeDb(t),
    asOf: '2026-10-24',
    vars: { materiality: Number(m?.value_i_64 ?? 1_000_000), close_ym: '2026-09' },
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
const materiality = (t: Tables) => Number(t.settings![0]!.value_i_64);

/** One mutation per charter scenario: breaks that scenario's charter line and nothing it depends on. */
const MUTATIONS: Record<string, (t: Tables) => void> = {
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
    const big = new Set(t.proposal!.filter((p) => Number(p.amount_minor) >= materiality(t)).map((p) => p.id));
    t.agent_message = t.agent_message!.filter((m) => !(m.kind === 'critique' && big.has(m.proposal_id as number)));
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
};

describe('scenario files', () => {
  it('load, and every charter line is quoted verbatim from its charter', () => {
    expect(all.length).toBeGreaterThan(60);
    expect(all.filter((s) => !charterLineFound(chartersDir, s)).map((s) => s.id)).toEqual([]);
  });

  it('cover every agent', () => {
    for (const a of AGENTS) expect(charters.filter((s) => s.agent === a).length, a).toBeGreaterThanOrEqual(5);
  });

  it('every charter scenario has a mutation test', () => {
    expect(charters.map((s) => s.id).filter((id) => !(id in MUTATIONS))).toEqual([]);
  });
});

describe('charter scenarios on the recorded close', () => {
  it('all pass on the snapshot with the known summary violation cleaned', async () => {
    const t = snapshot();
    const results = await Promise.all(charters.map((s) => run(s, t)));
    expect(results.filter((r) => r.status !== 'PASS').map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
  });

  it('finding: the recorded lock request summary is two sentences, and only advisor-plain-summary flags it', async () => {
    const t = snapshot({ clean: false });
    const results = await Promise.all(charters.map((s) => run(s, t)));
    const bad = results.filter((r) => r.status !== 'PASS');
    expect(bad.map((r) => r.id)).toEqual(['advisor-plain-summary']);
    const offenders = bad[0]!.assertions.flatMap((a) => a.offenders ?? []);
    expect(offenders).toHaveLength(1);
    expect(String(offenders[0]!.problem)).toMatch(/more than one sentence/);
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
