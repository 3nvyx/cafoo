/**
 * Charter smoke test, end to end through the module, on two scratch databases that it resets: CHARTER_SMOKE_DB
 * (default luyten-charter-smoke) holds the books and the charter versions, CHARTER_EVAL_DB (default luyten-eval) takes
 * the dry run. Needs the local SpacetimeDB server and the spacetime CLI (the CLI publishes, so it owns the database and
 * can arm the CFO bootstrap). With zero API keys:
 *   1. a draft with a line nobody mapped fails coverage, and publishCharter refuses it;
 *   2. publishCharter refuses a draft that has no eval at all;
 *   3. the Bookkeeper at ninety percent (May 2 -> batch_min_confidence 9000) fails on the recorded close, where the
 *      batch held matches at 80 to 85.71 percent, and publishing it is refused;
 *   4. the same version passes its dry run and the CFO publishes it;
 *   5. the next close batches no match under ninety percent: the 75 to 90 percent matches the shipped charter batched
 *      are each proposed on their own;
 *   6. the eval of that ledger (pnpm eval's view: published charters) passes the batch line at ninety percent;
 *   7. retiring the version restores the built-in charter.
 * Usage: pnpm -F @luyten/agents smoke:charter   (CHARTER_SMOKE_DB=..., CHARTER_EVAL_DB=..., CLOSE_PERIOD=2026-09)
 */
import { createHash, randomBytes } from 'node:crypto';
import { closePeriod } from '../close-period';

const smokeDb = process.env.CHARTER_SMOKE_DB?.trim() || 'luyten-charter-smoke';
const evalDb = process.env.CHARTER_EVAL_DB?.trim() || 'luyten-eval';
const ym = closePeriod();
if (smokeDb === evalDb || smokeDb === 'luyten' || evalDb === 'luyten') {
  console.error(`[smoke:charter] refusing to reset ${smokeDb === evalDb ? `one database for both roles (${smokeDb})` : 'the default database luyten'}; set CHARTER_SMOKE_DB and CHARTER_EVAL_DB to two scratch databases`);
  process.exit(2);
}
// Before anything reads the environment: the smoke database is this process's database, fixtures only, no pauses.
process.env.SPACETIMEDB_DB_NAME = smokeDb;
process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '0';
delete process.env.CHARTER_OVERRIDE_JSON;

const { dirname, join } = await import('node:path');
const { findSpacetimeBin, liveCharters, loadScenarios, runScenarios, scenariosDir, chartersDir, SpacetimeCli } = await import('@luyten/eval-harness');
const { Cast, RoleConn, repoRoot, waitFor } = await import('../stdb');
const { activeCharter } = await import('./active');
const { evaluateCharterVersion, runCommand } = await import('./evaluate');
const { ninetyPercentDraft } = await import('./examples');

const bin = findSpacetimeBin();
const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH ?? ''}`, CLOSE_PERIOD: ym };
const log = (m: string) => console.log(`[smoke:charter] ${m}`);
let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
async function refused(p: Promise<unknown>, pattern: RegExp, what: string) {
  try {
    await p;
    check(false, `${what}: was accepted`);
  } catch (e) {
    const msg = (e as Error).message;
    check(pattern.test(msg), `${what}: refused (${msg.slice(0, 140)})`);
  }
}

log(`books on ${smokeDb}, dry runs on ${evalDb}, close month ${ym}`);
await runCommand(bin, ['publish', smokeDb, '--server', 'local', '--delete-data=always', '--yes'], join(repoRoot, 'spacetimedb'), env);
await runCommand('pnpm', ['-F', '@luyten/seed', 'generate'], repoRoot, env);
await runCommand('pnpm', ['-F', '@luyten/seed', 'load'], repoRoot, { ...env, SEED_RESET: '1', SEED_NO_BOOTSTRAP: '1' });
log('seeded; arming a one-time CFO claim through the CLI (the publisher owns the database)');
const secret = randomBytes(18).toString('base64url');
await runCommand(bin, ['call', smokeDb, 'arm_cfo_bootstrap', JSON.stringify(createHash('sha256').update(secret).digest('hex')), '30', '--server', 'local', '--no-config', '--yes'], repoRoot, env);

const cast = await Cast.connectAll();
const cfo = await RoleConn.connect('cfo');
await cfo.reducers.claimCfo({ secret, displayName: 'Charter smoke CFO' });
await waitFor(() => [...cast.advisor.db.agentRoster.iter()].some(r => r.role === 'cfo'), 'the CFO seat');
log('CFO seat claimed');

const versions = () => [...cast.advisor.db.charterVersion.iter()].filter(v => v.role === 'bookkeeper');
async function saveDraft(bodyMd: string, mapping: unknown, summaryPlain: string) {
  const before = versions().length;
  await cfo.reducers.saveCharterDraft({ role: 'bookkeeper', bodyMd, mappingJson: JSON.stringify(mapping), summaryPlain, basedOnVersionId: undefined });
  await waitFor(() => versions().length > before, 'the saved draft');
  return versions().sort((a, b) => b.version - a.version)[0]!;
}
const publish = (id: bigint) => cfo.reducers.publishCharter({ charterVersionId: id, notePlain: 'Smoke test.' });

try {
  const draft = ninetyPercentDraft();

  // 1. A line nobody mapped.
  const extra = await saveDraft(draft.bodyMd.replace('## Must never', '4. You may ask the CFO a question in the close thread.\n\n## Must never'), draft.mapping, 'Adds a line about questions without mapping it.');
  const r1 = await evaluateCharterVersion(cast, extra.id, { mode: 'snapshot', onStep: log });
  check(!r1.passed && r1.coverage.problems.includes('May 4 is not mapped to a rule or a scenario'), `v${extra.version} with an unmapped line fails coverage`);
  await refused(publish(extra.id), /latest eval .* failed/, `publishing v${extra.version}`);

  // 2. No eval yet.
  const ninety = await saveDraft(draft.bodyMd, draft.mapping, draft.summaryPlain);
  await refused(publish(ninety.id), /Run an eval .* first/, `publishing v${ninety.version} before any eval`);

  // 3. The recorded close batched matches under ninety percent.
  const r2 = await evaluateCharterVersion(cast, ninety.id, { mode: 'snapshot', onStep: log });
  const batchSnap = r2.scenarios.find(s => s.id === 'bookkeeper-batch-confidence');
  check(!r2.passed && batchSnap?.status === 'FAIL' && r2.probes.length === 3 && r2.probes.every(p => p.pass), `v${ninety.version} fails on the recorded close (${batchSnap?.detail})`);
  await refused(publish(ninety.id), /latest eval .* failed/, `publishing v${ninety.version} after a failing eval`);

  // 4. The dry run closes the month under the draft.
  const r3 = await evaluateCharterVersion(cast, ninety.id, { mode: 'dry_run', evalDb, ym, onStep: log });
  const bad = r3.scenarios.filter(s => s.status === 'FAIL' || s.status === 'ERROR');
  check(r3.passed, `v${ninety.version} passes its dry run (${r3.scenarios.length} scenarios${bad.length ? `; failing: ${bad.map(s => `${s.id} ${s.detail}`).join(' / ')}` : ''})`);
  if (r3.passed) {
    await publish(ninety.id);
    await waitFor(() => cast.advisor.db.charterVersion.id.find(ninety.id)?.status.tag === 'Live', 'the published version');
    const active = activeCharter(cast.advisor, 'bookkeeper');
    check(active.versionId === ninety.id && active.params.batchMinScoreBp === 9000, `v${ninety.version} is live: the Bookkeeper batches at ${active.params.batchMinScoreBp / 100}%`);

    // 5. The next close follows it.
    log(`running the ${ym} close under the published charter`);
    await runCommand('node', ['--import', 'tsx', 'src/cli-close.ts', ym], join(repoRoot, 'apps', 'agents'), { ...env, CLOSE_NO_WAIT: '1' });
    const periodId = [...cast.advisor.db.period.iter()].find(p => p.ym === ym)?.id;
    const matches = [...cast.advisor.db.proposal.iter()]
      .filter(p => p.periodId === periodId && p.proposerRole === 'bookkeeper' && p.kind.tag === 'BankMatch')
      .map(p => (JSON.parse(p.payloadJson) as { matches: { scoreBp: number }[] }).matches.map(m => m.scoreBp));
    const batches = matches.filter(m => m.length > 1);
    const singles = matches.filter(m => m.length === 1).map(m => m[0]!);
    // The seeded matches score at most 85.71%, so at ninety percent nothing batches: each is proposed on its own.
    check(batches.every(b => b.every(s => s >= 9000)), `no batch holds a match under 90% (${batches.map(b => b.join(',')).join(' | ') || 'no batch at all'})`);
    check(singles.filter(s => s >= 7500 && s < 9000).length >= 9, `the matches between 75% and 90% that the shipped charter batched are proposed one by one (${singles.join(', ')})`);

    // 6. pnpm eval on that ledger judges the Bookkeeper by the published charter.
    const db = new SpacetimeCli({ db: smokeDb, server: 'local' });
    const live = liveCharters(db, loadScenarios(scenariosDir), chartersDir);
    const batchScenario = live?.plan.scenarios.filter(s => s.id === 'bookkeeper-batch-confidence') ?? [];
    const { results } = await runScenarios({ scenarios: batchScenario, db, vars: { ...live?.plan.vars, close_ym: ym }, charterText: live?.charterText, bound: live?.plan.bound });
    check(live?.versions.bookkeeper === ninety.version && live.plan.vars.batch_min_score_bp === 9000 && results[0]?.status === 'PASS', `the ledger's eval follows the published charter (${results[0]?.status}: ${results[0]?.detail})`);

    // 7. Back to the built-in charter.
    await cfo.reducers.retireLiveCharter({ role: 'bookkeeper', notePlain: 'Smoke test done.' });
    await waitFor(() => cast.advisor.db.charterVersion.id.find(ninety.id)?.status.tag === 'Retired', 'the retired version');
    check(activeCharter(cast.advisor, 'bookkeeper').version === 0, 'retiring it restores the built-in charter');
  }
} catch (e) {
  check(false, `stopped: ${(e as Error).stack ?? (e as Error).message}`);
} finally {
  cfo.disconnect();
  cast.disconnectAll();
}
log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
