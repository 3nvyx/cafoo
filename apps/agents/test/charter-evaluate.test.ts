// The charter eval runner: what it plans to run, how it judges a version in snapshot mode and in a dry run (with the
// reseed-and-close step replaced by a seam that hands back the recorded close), what it records, and the plain
// sentence it writes for the CFO.
import { describe, expect, it, vi } from 'vitest';
import { loadScenarios, scenariosDir, snapshotDb } from '@cafoo/eval-harness';
import { builtinCharter } from '../src/charter/active';
import { defaultMapping } from '../src/charter/build';
import { evalPlan, evalServer, evalSummary, evaluateCharter, evaluateCharterVersion, runCommand, type CharterUnderEval, type DryRunOptions } from '../src/charter/evaluate';
import { ninetyPercentDraft } from '../src/charter/examples';
import { HARNESSES, type Role } from '../src/harness';
import { plainSummaryProblems } from '../src/harness/rules';
import type { Cast } from '../src/stdb';

const all = loadScenarios(scenariosDir);
/** Every shipped scenario: the recorded close is a group close, so consolidation's scenarios run on it too. */
const shippedScenarios = all;
const original = Object.keys(HARNESSES) as Role[];
const draft = ninetyPercentDraft();
const version = (role: Role, bodyMd: string, mapping: unknown, v = 1): CharterUnderEval => ({ versionId: 7n, role, version: v, bodyMd, mappingJson: JSON.stringify(mapping) });
const shipped = (role: Role) => version(role, builtinCharter(role).bodyMd, defaultMapping(role));

describe('evalPlan', () => {
  it("runs every scenario of the role for the shipped mapping, binding the ones the mapping names, and no other agent's in snapshot mode", () => {
    const plan = evalPlan('bookkeeper', builtinCharter('bookkeeper').bodyMd, defaultMapping('bookkeeper'), all, 'snapshot');
    const own = all.filter(s => s.agent === 'bookkeeper').map(s => s.id).sort();
    expect(plan.scenarios.filter(s => s.agent === 'bookkeeper').map(s => s.id).sort()).toEqual(own);
    expect(plan.scenarios.map(s => s.id)).toContain('advisor-material-waits');
    expect(plan.scenarios.every(s => s.agent === 'bookkeeper' || plan.bound.has(s.id))).toBe(true);
    expect(plan.skipped).toEqual([]);
    expect(plan.labels.get('bookkeeper-batch-confidence')).toBe('May 2');
    expect(plan.labels.get('bookkeeper-duplicate-payments')).toBe('Escalates 2');
    expect(plan.vars).toEqual({});
  });

  it('adds every other agent and the ledger scenarios in a dry run', () => {
    const plan = evalPlan('bookkeeper', builtinCharter('bookkeeper').bodyMd, defaultMapping('bookkeeper'), all, 'dry_run');
    expect(plan.scenarios.length).toBe(all.filter(s => s.suite === 'charters').length);
    expect(plan.labels.get('ledger-fx-rates')).toBe('ledger integrity');
    expect(plan.labels.get('credit-never-posts')).toBe('credit charter');
  });

  it('binds the batch scenario at ninety percent for the draft', () => {
    const plan = evalPlan('bookkeeper', draft.bodyMd, draft.mapping, all, 'snapshot');
    expect(plan.bound.has('bookkeeper-batch-confidence')).toBe(true);
    expect(plan.vars).toEqual({ batch_min_score_bp: 9000 });
  });

  it('skips a scenario whose line the draft rewords when nothing binds it, and keeps one a shipped rule still enforces', () => {
    const reworded = builtinCharter('bookkeeper').bodyMd
      .replace(/^3\. You may look up.*$/m, '3. You may search the web for a payee you do not know and report it in the close thread.')
      .replace(/^1\. Never post a journal entry.*$/m, '1. Do not post entries yourself.');
    const plan = evalPlan('bookkeeper', reworded, defaultMapping('bookkeeper', reworded), all, 'snapshot');
    expect(plan.labels.get('bookkeeper-never-posts')).toBe('Must never 1');
    expect(plan.bound.has('bookkeeper-never-posts')).toBe(true);
    // May 3's rule is partial: its rest-of-line scenario stays bound through the shipped rule.
    expect(plan.bound.has('bookkeeper-counterparty-lookup')).toBe(true);
    const dropped = builtinCharter('bookkeeper').bodyMd.replace(/^3\. You may look up.*\n/m, '');
    const p2 = evalPlan('bookkeeper', dropped, defaultMapping('bookkeeper', dropped), all, 'snapshot');
    expect(p2.skipped.map(s => s.id)).toEqual(['bookkeeper-counterparty-lookup']);
  });

  it('runs custom and generated scenarios under the line they come from', () => {
    const cap = draft.mapping.map(e => (e.label === 'Must never 4' ? { ...e, target: { kind: 'rule' as const, template: 'max_proposal_amount', params: { maxMinor: '5000000' } } } : e));
    const plan = evalPlan('bookkeeper', draft.bodyMd, cap, all, 'snapshot');
    expect(plan.labels.get('charter-bookkeeper-must-never-4-max-proposal-amount')).toBe('Must never 4');
  });
});

describe('evaluateCharter, snapshot mode', () => {
  it.each(original)('passes the shipped %s charter on the recorded close', async role => {
    const r = await evaluateCharter(shipped(role), { mode: 'snapshot' });
    expect(r.coverage).toEqual({ ok: true, problems: [] });
    expect(r.scenarios.filter(s => s.status !== 'PASS').map(s => `${s.id}: ${s.detail}`)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r).toMatchObject({ versionId: '7', role, mode: 'snapshot', publishable: false, tightened: [], published: {} });
    expect(evalSummary(r, 1)).toMatch(/passed its check against the recorded close \(all \d+ checks held\); it needs a passing dry run before the CFO can publish it\.$/);
  });

  it('fails the ninety percent draft on the recorded close, where the batch held an 85.71% match, with every probe passing', async () => {
    const r = await evaluateCharter(version('bookkeeper', draft.bodyMd, draft.mapping, 2), { mode: 'snapshot' });
    expect(r.coverage.ok).toBe(true);
    expect(r.probes.length).toBe(3);
    expect(r.probes.every(p => p.pass && p.template === 'batch_min_confidence' && p.label.startsWith('May 2: '))).toBe(true);
    expect(r.scenarios.filter(s => s.status !== 'PASS')).toEqual([{ label: 'May 2', id: 'bookkeeper-batch-confidence', status: 'FAIL', detail: expect.stringMatching(/1 of 1 rows break the rule/) }]);
    expect(r.passed).toBe(false);
    expect(r.tightened).toEqual([{ label: 'May 2', rule: 'bookkeeper.may.2', template: 'batch_min_confidence', params: { minScoreBp: 9000 } }]);
    expect(evalSummary(r, 2)).toBe('The Bookkeeper charter, version 2, failed its check against the recorded close: May 2 did not hold.');
  });

  it('fails a draft that drops a shipped line on coverage, whatever the ledger shows', async () => {
    const dropped = builtinCharter('bookkeeper').bodyMd.replace(/^3\. Never propose without citing evidence.*\n/m, '');
    const r = await evaluateCharter(version('bookkeeper', dropped, defaultMapping('bookkeeper', dropped)), { mode: 'snapshot' });
    expect(r.coverage.problems).toEqual(['Must never 3 is a shipped line (rule bookkeeper.never.3); a charter may reword it but not remove it, because a charter can only make the gate stricter']);
    expect(r.passed).toBe(false);
  });

  it('fails on coverage before running anything', async () => {
    const steps: string[] = [];
    const r = await evaluateCharter(version('bookkeeper', draft.bodyMd, draft.mapping.slice(1)), { mode: 'snapshot', onStep: m => steps.push(m) });
    expect(r.coverage.problems).toEqual(['May 1 is not mapped to a rule or a scenario']);
    expect(r.scenarios).toEqual([]);
    expect(r.passed).toBe(false);
    expect(steps.at(-1)).toBe('Coverage failed; scenarios not run');
    expect(evalSummary(r, 1)).toBe('The Bookkeeper charter, version 1, failed its check against the recorded close: one mapping problem must be fixed first.');
    expect((await evaluateCharter({ ...shipped('bookkeeper'), mappingJson: '{oops' }, { mode: 'snapshot' })).coverage.problems).toEqual(['the mapping is not valid JSON']);
    expect((await evaluateCharter({ ...shipped('bookkeeper'), role: 'cfo' }, { mode: 'snapshot' })).coverage.problems).toEqual(['cfo is not an agent with a charter']);
  });
});

describe('evaluateCharter, dry run', () => {
  it('reseeds and closes under the draft, then judges that ledger', async () => {
    const prepare = vi.fn(async (_o: DryRunOptions) => {});
    const steps: string[] = [];
    const r = await evaluateCharter(shipped('bookkeeper'), { mode: 'dry_run', evalDb: 'cafoo-eval', scenarios: shippedScenarios, prepare, dryRunDb: () => snapshotDb(), onStep: m => steps.push(m), ym: '2026-09' });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toMatchObject({ db: 'cafoo-eval', server: evalServer().http, ym: '2026-09', role: 'bookkeeper', version: 1, mapping: defaultMapping('bookkeeper'), published: [] });
    expect(r.scenarios.length).toBe(shippedScenarios.filter(s => s.suite === 'charters').length);
    expect(r.scenarios.filter(s => s.status !== 'PASS').map(s => `${s.id}: ${s.detail}`)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(steps).toContain(`Running ${r.scenarios.length} eval scenarios on the dry-run close`);
    expect(r.publishable).toBe(true);
    expect(evalSummary(r, 1)).toBe(`The Bookkeeper charter, version 1, passed its dry run: every line is mapped and all ${r.scenarios.length} checks held, so the CFO can publish it.`);
  });

  it('fails when the close under the draft does not finish', async () => {
    const r = await evaluateCharter(shipped('bookkeeper'), { mode: 'dry_run', evalDb: 'cafoo-eval', scenarios: shippedScenarios, prepare: async () => { throw new Error('seed load failed'); } });
    expect(r.scenarios).toEqual([{ label: 'dry run', id: 'dry-run', status: 'ERROR', detail: 'the close with this charter did not finish: seed load failed' }]);
    expect(r.passed).toBe(false);
    expect(evalSummary(r, 1)).toBe('The Bookkeeper charter, version 1, failed its dry run: the close could not run under it.');
  });

  it("closes under the other roles' published charters too, and judges their scenarios by them", async () => {
    const prepare = vi.fn(async (_o: DryRunOptions) => {});
    const revenueBody = builtinCharter('revenue').bodyMd.replace('1. You may propose revenue schedules and revenue journal entries, and nothing else.', '1. You may propose revenue schedules and revenue journal entries, nothing more.');
    const published = [{ role: 'revenue' as const, version: 4, bodyMd: revenueBody, mapping: defaultMapping('revenue', revenueBody) }];
    const r = await evaluateCharter(shipped('bookkeeper'), { mode: 'dry_run', evalDb: 'cafoo-eval', scenarios: shippedScenarios, prepare, dryRunDb: () => snapshotDb(), published });
    expect(prepare.mock.calls[0]![0].published).toEqual(published);
    expect(r.published).toEqual({ revenue: 4 });
    // The reworded revenue line is checked through its shipped rule's binding, not skipped and not an error.
    expect(r.scenarios.find(s => s.id === 'revenue-proposal-kinds')).toMatchObject({ label: 'May 1', status: 'PASS' });
    expect(r.passed).toBe(true);
    const plan = evalPlan('bookkeeper', builtinCharter('bookkeeper').bodyMd, defaultMapping('bookkeeper'), shippedScenarios, 'dry_run', published);
    expect(plan.scenarios.length).toBe(shippedScenarios.filter(s => s.suite === 'charters').length);
    expect(plan.bound.has('revenue-proposal-kinds')).toBe(true);
  });

  it("never reseeds the gateway's own database", async () => {
    const prepare = vi.fn(async () => {});
    const r = await evaluateCharter(shipped('bookkeeper'), { mode: 'dry_run', evalDb: process.env.SPACETIMEDB_DB_NAME ?? 'cafoo', scenarios: shippedScenarios, prepare });
    expect(prepare).not.toHaveBeenCalled();
    expect(r.scenarios[0]!.detail).toMatch(/is the gateway's own; set CHARTER_EVAL_DB/);
    expect(r.passed).toBe(false);
  });
});

describe('evalSummary', () => {
  it('is one plain sentence the Plain summary rule accepts', async () => {
    const pass = await evaluateCharter(shipped('redteam'), { mode: 'snapshot' });
    const fail = await evaluateCharter(version('bookkeeper', draft.bodyMd, draft.mapping, 2), { mode: 'snapshot' });
    for (const s of [evalSummary(pass, 3), evalSummary(fail, 2)]) expect(plainSummaryProblems(s), s).toEqual([]);
  });
});

describe('evaluateCharterVersion', () => {
  const row = (status: string) => ({ id: 7n, role: 'bookkeeper', version: 2, status: { tag: status }, bodyMd: draft.bodyMd, mappingJson: JSON.stringify(draft.mapping) });
  const castWith = (r: ReturnType<typeof row> | undefined, record = vi.fn(async (_a: unknown) => {})) =>
    ({ advisor: { db: { charterVersion: { id: { find: (id: bigint) => (id === 7n ? r : undefined) }, iter: () => [r, liveRevenue].filter(Boolean)[Symbol.iterator]() } }, reducers: { recordCharterEval: record } } }) as unknown as Cast;
  const liveRevenue = { id: 9n, role: 'revenue', version: 3, status: { tag: 'Live' }, bodyMd: builtinCharter('revenue').bodyMd, mappingJson: JSON.stringify(defaultMapping('revenue')) };

  it('judges the saved version and records the report and the summary through the Advisor', async () => {
    const record = vi.fn(async (_a: unknown) => {});
    const r = await evaluateCharterVersion(castWith(row('Draft'), record), 7n, { mode: 'snapshot' });
    expect(record).toHaveBeenCalledOnce();
    const args = record.mock.calls[0]![0] as { charterVersionId: bigint; passed: boolean; mode: string; resultsJson: string; summaryPlain: string };
    expect(args).toMatchObject({ charterVersionId: 7n, passed: false, mode: 'snapshot', summaryPlain: 'The Bookkeeper charter, version 2, failed its check against the recorded close: May 2 did not hold.' });
    expect(r.publishable).toBe(false);
    expect(JSON.parse(args.resultsJson)).toEqual(JSON.parse(JSON.stringify(r)));
  });

  it("hands a dry run the other roles' published charters from the ledger", async () => {
    const prepare = vi.fn(async (_o: DryRunOptions) => {});
    const r = await evaluateCharterVersion(castWith(row('Draft')), 7n, { mode: 'dry_run', evalDb: 'cafoo-eval', scenarios: shippedScenarios, prepare, dryRunDb: () => snapshotDb() });
    expect(prepare.mock.calls[0]![0].published!.map(p => [p.role, p.version])).toEqual([['revenue', 3]]);
    expect(r.published).toEqual({ revenue: 3 });
  });

  it('refuses a missing or already published version', async () => {
    await expect(evaluateCharterVersion(castWith(undefined), 7n, { mode: 'snapshot' })).rejects.toThrow('no charter version 7');
    await expect(evaluateCharterVersion(castWith(row('Live')), 7n, { mode: 'snapshot' })).rejects.toThrow('already published');
  });

  it('has a harness for every role it may judge', () => {
    expect(Object.keys(HARNESSES).sort()).toEqual(['advisor', 'bookkeeper', 'consolidation', 'credit', 'redteam', 'revenue']);
  });
});

describe('runCommand and the dry-run server', () => {
  it('rejects on timeout and kills the whole process group, even a child that ignores SIGTERM and a grandchild holding the pipes', async () => {
    const t0 = Date.now();
    await expect(runCommand('sh', ['-c', 'sleep 30 & sleep 30'], process.cwd(), process.env, 300, 200)).rejects.toThrow(/timed out after 0 s/);
    await expect(runCommand('node', ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], process.cwd(), process.env, 300, 200)).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('resolves on success and rejects with the output tail on failure', async () => {
    await expect(runCommand('sh', ['-c', 'echo fine'], process.cwd(), process.env)).resolves.toBeUndefined();
    await expect(runCommand('sh', ['-c', 'echo broken >&2; exit 3'], process.cwd(), process.env)).rejects.toThrow(/failed \(exit 3\): broken/);
  });

  it('pins every dry-run step to one server: the CLI URL and the SDK URL of SPACETIMEDB_URI', () => {
    expect(evalServer({})).toEqual({ http: 'http://127.0.0.1:3000', ws: 'ws://127.0.0.1:3000' });
    expect(evalServer({ SPACETIMEDB_URI: 'http://10.0.0.5:3000' })).toEqual({ http: 'http://10.0.0.5:3000', ws: 'ws://10.0.0.5:3000' });
    expect(evalServer({ SPACETIMEDB_URI: 'wss://db.example' })).toEqual({ http: 'https://db.example', ws: 'wss://db.example' });
  });
});
