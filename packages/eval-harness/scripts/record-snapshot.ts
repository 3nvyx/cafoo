// Re-record test/fixtures/ledger-snapshot.json from a fresh scripted close (README: "Refresh the snapshot only from a
// clean scripted close"). Destructive: it reseeds the database named by --db, which is required so a shared database
// is never reset by accident.
//   1. seed generate, then SEED_RESET=1 seed load (with the CFO bootstrap armed, never SEED_NO_BOOTSTRAP);
//   2. the scripted close for --ym (default 2026-09) in waiting mode, with apps/agents/src/demo-cfo.ts confirming every
//      material ruling the way the CFO's OK button would, until the Advisor requests the lock (the month is not locked);
//   3. every table the scenarios read, dumped through the same `spacetime sql` decoding the eval uses.
// The demo CFO claims the CFO seat of that database with the bootstrap secret the loader armed (see demo-cfo.ts).
// Usage, from packages/eval-harness: node --conditions=source --import tsx scripts/record-snapshot.ts --db <name> [--ym 2026-09]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpacetimeCli, findSpacetimeBin } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const agentsDir = join(repoRoot, 'apps', 'agents');
const out = join(here, '..', 'test', 'fixtures', 'ledger-snapshot.json');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ym = arg('--ym') ?? '2026-09';
const dbName = arg('--db');
if (!dbName) {
  console.error('usage: record-snapshot --db <database> [--ym YYYY-MM]  (the database is reseeded; name it explicitly)');
  process.exit(2);
}

/** The tables the snapshot holds: the ledger, the governance trail, and what the integrity scenarios read. */
const TABLES = [
  'proposal', 'journal_entry', 'journal_line', 'audit_event', 'agent_message', 'bank_transaction', 'bank_match', 'credit_check', 'customer', 'vendor',
  'invoice', 'contract', 'contract_item', 'revenue_schedule_line', 'period', 'period_lock', 'approval', 'close_task', 'agent_identity', 'account',
  'settings', 'subsidiary', 'fx_rate', 'charter_version', 'feed_event',
];

const env: NodeJS.ProcessEnv = { ...process.env, SPACETIMEDB_DB_NAME: dbName, DEMO_STEP_MS: '0', PATH: `${dirname(findSpacetimeBin())}:${process.env.PATH ?? ''}` };
delete env.CLOSE_NO_WAIT;
// The seed loader arms the CFO bootstrap secret (.secrets/cfo-bootstrap.<db>.txt) unless SEED_NO_BOOTSTRAP=1; the demo
// CFO claims the seat with it, so the bootstrap stays on here whatever the caller's environment says. A recording
// follows the shipped charters, never a draft under eval.
delete env.SEED_NO_BOOTSTRAP;
delete env.CHARTER_OVERRIDE_JSON;

/** Run a step to completion; throws (never exits) so the demo CFO is always stopped. */
function run(cmd: string, args: string[], cwd: string, extra: Record<string, string> = {}, timeoutMs = 10 * 60_000) {
  console.log(`[record] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit', timeout: timeoutMs });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.signal})`);
}

/**
 * A snapshot records the shipped charters at work: refuse a database where the CFO published a charter (the close would
 * run under it). A database that has no charter_version table yet, or does not exist yet, has none.
 */
function publishedCharters(): string[] {
  try {
    return new SpacetimeCli({ db: dbName!, server: 'local' }).query('SELECT * FROM charter_version').filter((r) => r.status === 'live').map((r) => `${String(r.role)} v${String(r.version)}`);
  } catch {
    return [];
  }
}

let cfo: ChildProcess | undefined;
let exitCode = 0;
const live = publishedCharters();
if (live.length) {
  console.error(`[record] ${dbName} has published charters (${live.join(', ')}); a snapshot records the shipped charters. Retire them, or record from another database.`);
  process.exit(2);
}
try {
  run('pnpm', ['-F', '@luyten/seed', 'generate'], repoRoot);
  run('pnpm', ['-F', '@luyten/seed', 'load'], repoRoot, { SEED_RESET: '1' });
  cfo = spawn('node', ['--import', 'tsx', 'src/demo-cfo.ts', ym, '--timeout-s', '900'], { cwd: agentsDir, env, stdio: 'inherit' });
  run('node', ['--import', 'tsx', 'src/cli-close.ts', ym], agentsDir);
  const db = new SpacetimeCli({ db: dbName, server: 'local' });
  const snapshot = Object.fromEntries(TABLES.map((t) => [t, db.query(`SELECT * FROM ${t}`)]));
  writeFileSync(out, JSON.stringify(snapshot));
  console.log(`[record] wrote ${out}: ${TABLES.map((t) => `${t} ${snapshot[t]?.length ?? 0}`).join(', ')}`);
} catch (e) {
  console.error(`[record] ${(e as Error).message}`);
  exitCode = 2;
} finally {
  cfo?.kill();
}
process.exit(exitCode);
