// Luyten eval harness. Usage: pnpm -F @luyten/eval-harness run [--suite charters|personas|all] [--rerun] [--db luyten]
// [--server local] [--ym 2026-09] [--as-of 2026-10-24] [--only <id substring>]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { personas } from '@luyten/crs-mcp';
import { DEFAULT_VARS, chartersDir, dbVars, liveCharters, scenariosDir, type LiveCharters } from './api.js';
import type { Scalar } from './conditions.js';
import { SpacetimeCli, findSpacetimeBin } from './db.js';
import { runScenario, scoreOf, type EngineContext, type ScenarioResult } from './engine.js';
import { loadScenarios, type Scenario, type Suite } from './scenarios.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const reportsDir = join(pkgRoot, 'reports');

function parseArgs(argv: string[]) {
  const opts = { suite: 'all' as 'all' | Suite, rerun: false, db: 'luyten', server: 'local', ym: '', asOf: '2026-10-24', only: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v!;
    };
    if (a === '--') continue;
    else if (a === '--suite') {
      const v = next();
      if (v !== 'all' && v !== 'charters' && v !== 'personas') usage(`--suite must be charters, personas or all`);
      opts.suite = v as typeof opts.suite;
    } else if (a === '--rerun') opts.rerun = true;
    else if (a === '--db') opts.db = next();
    else if (a === '--server') opts.server = next();
    else if (a === '--ym') opts.ym = next();
    else if (a === '--as-of') opts.asOf = next();
    else if (a === '--only') opts.only = next();
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument ${a}`);
  }
  return opts;
}

function usage(err?: string): never {
  if (err) console.error(`error: ${err}`);
  console.error('usage: pnpm -F @luyten/eval-harness run [--suite charters|personas|all] [--rerun] [--db <name>] [--server <name>] [--ym YYYY-MM] [--as-of YYYY-MM-DD] [--only <id substring>]');
  process.exit(err ? 2 : 0);
}

/**
 * Reseed and run the scripted close in demo mode (no keys): seed generate, SEED_RESET=1 seed load, cli-close.
 * Destructive: it resets the shared database named by --db. Targets SPACETIMEDB_URI or ws://localhost:3000.
 * SEED_NO_BOOTSTRAP=1: the loader arms no CFO bootstrap secret for this throwaway run.
 */
function rerun(ym: string, db: string) {
  console.log(`[eval] --rerun: regenerating seed, resetting the database and running the scripted close for ${ym} (about 30 s)`);
  const env = { ...process.env, SPACETIMEDB_DB_NAME: db, CLOSE_NO_WAIT: '1', DEMO_STEP_MS: '0', PATH: `${dirname(findSpacetimeBin())}:${process.env.PATH ?? ''}` };
  const steps: [string, string[], string, Record<string, string>][] = [
    ['pnpm', ['-F', '@luyten/seed', 'generate'], repoRoot, {}],
    ['pnpm', ['-F', '@luyten/seed', 'load'], repoRoot, { SEED_RESET: '1', SEED_NO_BOOTSTRAP: '1' }],
    ['node', ['--import', 'tsx', 'src/cli-close.ts', ym], join(repoRoot, 'apps', 'agents'), {}],
  ];
  for (const [cmd, args, cwd, extra] of steps) {
    const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`[eval] --rerun failed at: ${cmd} ${args.join(' ')} (exit ${r.status})`);
      process.exit(2);
    }
  }
}

function cell(s: string, w: number) {
  const t = s.length > w ? `${s.slice(0, w - 3)}...` : s;
  return t.padEnd(w);
}

function printTable(results: ScenarioResult[]) {
  const w = { id: Math.max(8, ...results.map((r) => r.id.length)), agent: 10, status: 6 };
  const cols = process.stdout.columns && process.stdout.columns > 80 ? process.stdout.columns : 160;
  const dw = Math.max(30, cols - w.id - w.agent - w.status - 9);
  console.log(`${cell('scenario', w.id)} | ${cell('agent', w.agent)} | ${cell('result', w.status)} | detail`);
  console.log(`${'-'.repeat(w.id)}-+-${'-'.repeat(w.agent)}-+-${'-'.repeat(w.status)}-+-${'-'.repeat(Math.min(dw, 60))}`);
  for (const r of results) console.log(`${cell(r.id, w.id)} | ${cell(r.agent, w.agent)} | ${cell(r.status, w.status)} | ${cell(r.detail, dw)}`);
}

const mdEscape = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderMarkdown(results: ScenarioResult[], meta: Record<string, unknown>, score: ReturnType<typeof scoreOf>): string {
  const out: string[] = [];
  out.push(`# Luyten eval report ${String(meta.startedAt)}`, '');
  out.push(`Suite \`${String(meta.suite)}\`, database \`${String(meta.db)}\` on \`${String(meta.server)}\`, close month \`${String(meta.close_ym || 'n/a')}\`, materiality ${String(meta.materiality ?? 'n/a')} minor units, persona as-of ${String(meta.asOf)}.`, '');
  const published = Object.entries((meta.charters ?? {}) as Record<string, number>);
  if (published.length) out.push(`Published charters: ${published.map(([r, v]) => `${r} v${v}`).join(', ')}; every other agent by its shipped charter.`, '');
  for (const k of (meta.skipped ?? []) as { id: string; detail: string }[]) out.push(`Skipped ${k.id}: ${k.detail}.`, '');
  out.push(`Result: **${score.verdict}**. ${score.line}`, '');
  out.push('| scenario | agent | severity | result | detail |', '|---|---|---|---|---|');
  for (const r of results) out.push(`| ${r.id} | ${r.agent} | ${r.severity} | ${r.status} | ${mdEscape(r.detail)} |`);
  const bad = results.filter((r) => r.status !== 'PASS');
  if (bad.length) {
    out.push('', '## Failures', '');
    for (const r of bad) {
      out.push(`### ${r.id} (${r.status})`, '', r.charter_line ? `Charter line (${r.agent}): "${r.charter_line}"` : 'Ledger integrity (no single charter line)', '', `File: \`${relative(repoRoot, r.file)}\``, '');
      if (r.error) out.push(`Error: ${r.error}`, '');
      for (const a of r.assertions.filter((x) => !x.pass)) {
        out.push(`- **${a.label}**: ${a.detail}`);
        if (a.offenders?.length) {
          out.push('', '```json', ...a.offenders.map((o) => JSON.stringify(o)), '```');
          if ((a.offenderCount ?? 0) > a.offenders.length) out.push(`(${(a.offenderCount ?? 0) - a.offenders.length} more)`);
        }
      }
      out.push('');
    }
  }
  return `${out.join('\n')}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const loaded = loadScenarios(scenariosDir);
  const wanted = (s: Scenario) => (opts.suite === 'all' || s.suite === opts.suite) && (!opts.only || s.id.includes(opts.only));
  let scenarios: Scenario[] = loaded.filter(wanted);

  const results: ScenarioResult[] = [];
  const needDb = scenarios.some((s) => s.suite === 'charters');
  let db: SpacetimeCli | null = null;
  let vars: Record<string, Scalar> = { ...DEFAULT_VARS };
  let dbError = '';
  if (opts.rerun) rerun(opts.ym || '2026-09', opts.db);
  let live: LiveCharters | undefined;
  if (needDb) {
    db = new SpacetimeCli({ db: opts.db, server: opts.server });
    try {
      vars = { ...DEFAULT_VARS, ...dbVars(db, opts.ym) };
      live = liveCharters(db, loaded, chartersDir);
    } catch (e) {
      dbError = (e as Error).message;
      db = null;
    }
  }
  // Charters a CFO published replace the shipped files: their text, the scenarios their mapping binds, their variables.
  if (live) {
    scenarios = [...live.plan.scenarios.filter(wanted), ...scenarios.filter((s) => s.suite !== 'charters')];
    vars = { ...vars, ...live.plan.vars };
    console.log(`[eval] published charters: ${Object.entries(live.versions).map(([r, v]) => `${r} v${v}`).join(', ')}`);
    for (const k of live.plan.skipped.filter((x) => !opts.only || x.id.includes(opts.only))) console.log(`[eval] skipped ${k.id}: ${k.detail}`);
    for (const p of live.problems) console.log(`[eval] ${p}`);
  }
  const expected = new Map(personas().map((p) => [p.personaId, p.expectedDecision as string]));
  const ctx: EngineContext = { db, asOf: opts.asOf, vars, chartersDir, charterText: live?.charterText, bound: live?.plan.bound, expectedDecisions: expected, dbError: dbError || undefined };

  // Persona suite integrity: every dataset persona has a scenario.
  const personaSuite = scenarios.filter((s) => s.suite === 'personas');
  const personaIntegrity: string[] = [];
  if (personaSuite.length && !opts.only) {
    const covered = new Set(personaSuite.flatMap((s) => s.assertions.filter((a) => a.type === 'cascade_decision').map((a) => (a as { persona: string }).persona)));
    for (const id of expected.keys()) if (!covered.has(id)) personaIntegrity.push(`persona ${id} has no cascade_decision scenario`);
  }

  for (const s of scenarios) results.push(await runScenario(s, ctx));
  for (const msg of personaIntegrity) {
    results.push({ id: 'personas-coverage', agent: 'credit', suite: 'personas', severity: 'block', charter_line: '', file: join(scenariosDir, 'personas.yaml'), status: 'FAIL', detail: msg, assertions: [] });
  }

  printTable(results);
  const score = scoreOf(results);
  console.log('');
  console.log(`${score.verdict}: ${score.line}`);

  const meta = { startedAt, suite: opts.suite, db: opts.db, server: opts.server, asOf: opts.asOf, rerun: opts.rerun, ...vars, charters: live?.versions ?? {}, skipped: live?.plan.skipped ?? [], sqlQueries: db?.calls.length ?? 0 };
  mkdirSync(reportsDir, { recursive: true });
  const stamp = startedAt.replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z');
  const jsonPath = join(reportsDir, `${stamp}.json`);
  const mdPath = join(reportsDir, `${stamp}.md`);
  const strip = (r: ScenarioResult) => ({ ...r, file: relative(repoRoot, r.file) });
  writeFileSync(jsonPath, `${JSON.stringify({ meta, score, results: results.map(strip) }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(results, meta, score));
  console.log(`report: ${relative(process.cwd(), mdPath)} and .json`);
  process.exit(score.blockFailures ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(2);
});

