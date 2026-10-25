/**
 * The charter eval runner. evaluateCharterVersion judges one saved charter version and records the result with
 * recordCharterEval; publishCharter requires the latest eval of that exact version to be a passing dry run.
 *   1. coverage: every line mapped exactly once to a real target, and the version only ever makes the gate stricter
 *      (src/charter/coverage.ts);
 *   2. probes: each parameterized rule's known allow/deny calls against the rule the gate will run, so a changed number
 *      provably reached the gate;
 *   3. scenarios: the eval scenarios the mapping binds (with the variables it sets), every other scenario of the role
 *      whose charter line the draft still quotes verbatim, and, in a dry run, every other agent's scenarios too (by its
 *      published charter where the CFO published one, else its shipped file).
 * Two modes: `snapshot` judges the recorded close (eval-harness test/fixtures/ledger-snapshot.json: seconds, no server,
 * a quick check that cannot publish), `dry_run` reseeds a scratch database (CHARTER_EVAL_DB, default luyten-eval), runs
 * the scripted close there with CHARTER_OVERRIDE_JSON forcing the draft and the other roles' published charters, and
 * judges that ledger (about a minute; the gateway runs one at a time).
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { charterPlan, combinePlans, findSpacetimeBin, loadScenarios, runScenarios, scenariosDir, snapshotDb, SpacetimeCli, type CharterPlan, type Db, type Scenario, type ScenarioResult } from '@luyten/eval-harness';
import { STDB_DB } from '../env';
import { closePeriod } from '../close-period';
import { HARNESSES, type Role, type Rule } from '../harness';
import { repoRoot, ROLE_DISPLAY, type Cast } from '../stdb';
import { builtinCharter, type CharterOverride } from './active';
import { harnessFromCharter, tightenedRules, type TightenedRule } from './build';
import { charterCoverage, readMapping, type CoverageResult } from './coverage';
import { runProbe, templateById, type TemplateUse } from './library';
import type { CharterMappingEntry } from './types';

export type EvalMode = 'dry_run' | 'snapshot';

export interface EvalReport {
  versionId: string;
  role: string;
  mode: EvalMode;
  coverage: CoverageResult;
  /** Shipped rules this version tightens with a template (they still run; the template runs on top). */
  tightened: TightenedRule[];
  /** Other roles' published charters the dry run closed under, by role: version. */
  published: Record<string, number>;
  probes: { label: string; template: string; pass: boolean; detail: string }[];
  scenarios: { label: string; id: string; status: ScenarioResult['status'] | 'SKIPPED'; detail: string }[];
  passed: boolean;
  /** Whether this result lets the CFO publish the version: a passing dry run (a snapshot check never does). */
  publishable: boolean;
  startedAt: string;
  finishedAt: string;
}

export type EvalPlan = CharterPlan;

/** Another role's published charter, which a dry run of a draft also closes under. */
export interface PublishedCharter {
  role: Role;
  version: number;
  bodyMd: string;
  mapping: CharterMappingEntry[];
}

export const DEFAULT_EVAL_DB = 'luyten-eval';
export const evalDbName = (env: NodeJS.ProcessEnv = process.env) => env.CHARTER_EVAL_DB?.trim() || DEFAULT_EVAL_DB;

/** The server every dry-run step talks to: SPACETIMEDB_URI (default the local server), as a CLI URL and an SDK URL. */
export function evalServer(env: NodeJS.ProcessEnv = process.env): { http: string; ws: string } {
  const uri = env.SPACETIMEDB_URI?.trim() || 'ws://127.0.0.1:3000';
  return { http: uri.replace(/^ws/, 'http'), ws: uri.replace(/^http/, 'ws') };
}

/**
 * What a charter version's eval runs (charterPlan in the eval harness): the scenarios its mapping binds, the role's
 * scenarios whose line it still quotes, and in a dry run every other agent's scenarios, by its published charter when
 * one is given. Custom and generated scenarios that do not parse are left out here; coverage fails the version for them.
 */
export function evalPlan(role: Role, bodyMd: string, entries: readonly CharterMappingEntry[], all: readonly Scenario[], mode: EvalMode, published: readonly PublishedCharter[] = []): EvalPlan {
  const own = charterPlan({ role, bodyMd, mapping: entries, all, shippedBodyMd: builtinCharter(role).bodyMd, others: mode === 'dry_run' && !published.length });
  if (mode !== 'dry_run' || !published.length) return own;
  const others = published.map(p => charterPlan({ role: p.role, bodyMd: p.bodyMd, mapping: p.mapping, all, shippedBodyMd: builtinCharter(p.role).bodyMd, others: false }));
  return combinePlans([own, ...others], all, new Set([role, ...published.map(p => p.role)]));
}

/**
 * One child process (and everything it starts) to completion, without blocking the gateway. On timeout the whole
 * process group gets SIGTERM, then SIGKILL after a grace period, and the promise rejects; the error carries the
 * output's last lines.
 */
export function runCommand(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 10 * 60_000, graceMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const tail: string[] = [];
    const keep = (b: Buffer) => {
      tail.push(...b.toString('utf8').split('\n').filter(l => l.trim()));
      tail.splice(0, Math.max(0, tail.length - 12));
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* the group is gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      killer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
      killer.unref();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      if (killer && !timedOut) clearTimeout(killer);
    };
    child.on('error', e => {
      done();
      reject(e);
    });
    // 'exit', not 'close': a grandchild that keeps the pipes open must not hold the eval.
    child.on('exit', (code, signal) => {
      done();
      if (timedOut) {
        signalGroup('SIGKILL');
        reject(new Error(`${cmd} ${args.join(' ')} timed out after ${Math.round(timeoutMs / 1000)} s: ${tail.slice(-4).join(' | ')}`));
      } else if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${signal ?? `exit ${code}`}): ${tail.slice(-4).join(' | ')}`));
    });
  });
}

export interface DryRunOptions {
  db: string;
  /** The server's URL (evalServer().http); the CLI publishes there and the loader and close connect there. */
  server: string;
  ym: string;
  role: Role;
  bodyMd: string;
  mapping: unknown;
  version: number;
  /** Other roles' published charters, closed under too. */
  published?: readonly PublishedCharter[];
  onStep: (m: string) => void;
}

/**
 * Reseed the scratch database and run the scripted close there under the draft: publish the module with
 * --delete-data=always, seed generate, seed load (SEED_RESET=1, SEED_NO_BOOTSTRAP=1), cli-close with
 * CHARTER_OVERRIDE_JSON (the draft and the other roles' published charters) and CHARTER_OVERRIDE_DB (the override
 * applies only in a process connected to this database), CLOSE_NO_WAIT=1, DEMO_STEP_MS=0 and DEMO_MODE=1 (fixtures
 * only, whatever keys are set). Every step talks to the same server.
 */
export async function prepareDryRun(o: DryRunOptions): Promise<void> {
  const ws = o.server.replace(/^http/, 'ws');
  const base: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(findSpacetimeBin())}:${process.env.PATH ?? ''}`, SPACETIMEDB_URI: ws, SPACETIMEDB_DB_NAME: o.db, CLOSE_PERIOD: o.ym, DEMO_MODE: '1' };
  delete base.CHARTER_OVERRIDE_JSON;
  delete base.CHARTER_OVERRIDE_DB;
  o.onStep(`Publishing a fresh ledger to ${o.db}`);
  await runCommand(findSpacetimeBin(), ['publish', o.db, '--server', o.server, '--delete-data=always', '--yes'], join(repoRoot, 'spacetimedb'), base);
  o.onStep('Loading the demo company');
  await runCommand('pnpm', ['-F', '@luyten/seed', 'generate'], repoRoot, base);
  await runCommand('pnpm', ['-F', '@luyten/seed', 'load'], repoRoot, { ...base, SEED_RESET: '1', SEED_NO_BOOTSTRAP: '1' });
  const others = o.published ?? [];
  o.onStep(`Running the ${o.ym} close with the draft ${o.role} charter${others.length ? ` and the published ${others.map(p => `${p.role} v${p.version}`).join(', ')}` : ''}`);
  const charters: CharterOverride[] = [{ role: o.role, bodyMd: o.bodyMd, mapping: o.mapping, version: o.version }, ...others.map(p => ({ role: p.role, bodyMd: p.bodyMd, mapping: p.mapping, version: p.version }))];
  await runCommand('node', ['--import', 'tsx', 'src/cli-close.ts', o.ym], join(repoRoot, 'apps', 'agents'), { ...base, CHARTER_OVERRIDE_JSON: JSON.stringify({ charters }), CHARTER_OVERRIDE_DB: o.db, CLOSE_NO_WAIT: '1', DEMO_STEP_MS: '0' });
}

export interface CharterUnderEval {
  versionId: bigint;
  role: string;
  version: number;
  bodyMd: string;
  mappingJson: string;
}

export interface EvaluateOptions {
  mode?: EvalMode;
  /** Scratch database for a dry run; never the gateway's own. Default CHARTER_EVAL_DB or luyten-eval. */
  evalDb?: string;
  /** Server URL for a dry run. Default evalServer().http (SPACETIMEDB_URI, else the local server). */
  server?: string;
  /** Other roles' published charters for a dry run (evaluateCharterVersion reads them from the gateway's ledger). */
  published?: readonly PublishedCharter[];
  /** Close month for the dry run and ${close_ym}. Default CLOSE_PERIOD or 2026-09. */
  ym?: string;
  onStep?: (m: string) => void;
  /** Test seams: the scenarios to plan from, and the dry run itself (reseed and close). */
  scenarios?: Scenario[];
  prepare?: (o: DryRunOptions) => Promise<void>;
  /** Test seam: the ledger a dry run judges once prepared. Default SpacetimeCli on evalDb. */
  dryRunDb?: (name: string, server: string) => Db;
}

/** Judges a charter version without recording anything. A dry run that cannot run fails the eval with the reason. */
export async function evaluateCharter(c: CharterUnderEval, opts: EvaluateOptions = {}): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const mode = opts.mode ?? 'dry_run';
  const step = opts.onStep ?? (() => {});
  const ym = opts.ym ?? closePeriod();
  const published = mode === 'dry_run' ? (opts.published ?? []).filter(p => p.role !== c.role) : [];
  const report: EvalReport = {
    versionId: c.versionId.toString(),
    role: c.role,
    mode,
    coverage: { ok: false, problems: [] },
    tightened: [],
    published: Object.fromEntries(published.map(p => [p.role, p.version])),
    probes: [],
    scenarios: [],
    passed: false,
    publishable: false,
    startedAt,
    finishedAt: startedAt,
  };
  const finish = () => {
    const blocking = report.scenarios.filter(s => s.status === 'FAIL' || s.status === 'ERROR');
    report.passed = report.coverage.ok && report.probes.every(p => p.pass) && report.scenarios.length > 0 && blocking.length === 0;
    report.publishable = report.passed && mode === 'dry_run';
    report.finishedAt = new Date().toISOString();
    return report;
  };
  if (!Object.hasOwn(HARNESSES, c.role)) {
    report.coverage = { ok: false, problems: [`${c.role} is not an agent with a charter`] };
    return finish();
  }
  const role = c.role as Role;
  let mapping: unknown;
  try {
    mapping = JSON.parse(c.mappingJson);
  } catch {
    mapping = undefined;
  }
  step('Checking that every line is mapped to a rule or a scenario');
  const all = opts.scenarios ?? loadScenarios(scenariosDir);
  report.coverage = mapping === undefined ? { ok: false, problems: ['the mapping is not valid JSON'] } : charterCoverage(role, c.bodyMd, mapping, all);
  const { entries } = readMapping(mapping);
  report.tightened = tightenedRules(HARNESSES[role], entries);
  // Probe the rule the gate will run for each line (a tightened shipped rule runs together with its template).
  let built: readonly Rule[] = [];
  try {
    built = harnessFromCharter(HARNESSES[role], c.bodyMd, entries).harness.rules;
  } catch {
    /* coverage reports why; probe the template rules alone */
  }
  for (const e of entries) {
    if (e.target.kind !== 'rule') continue;
    const tpl = templateById(e.target.template);
    const use: TemplateUse = { role, base: HARNESSES[role], label: e.label, text: e.text, params: e.target.params ?? {} };
    if (!tpl?.probes || tpl.problems(use).length) continue;
    const rule = built.find(r => r.charter === e.label) ?? tpl.rule(use);
    for (const p of tpl.probes(use)) report.probes.push({ label: `${e.label}: ${p.label}`, template: tpl.id, ...runProbe(rule, p) });
  }
  if (report.probes.length) step(`Probed the gate: ${report.probes.filter(p => p.pass).length} of ${report.probes.length} calls got the expected verdict`);
  if (!report.coverage.ok) {
    step('Coverage failed; scenarios not run');
    return finish();
  }

  const plan = evalPlan(role, c.bodyMd, entries, all, mode, published);
  let db: Db;
  if (mode === 'snapshot') db = snapshotDb();
  else {
    const name = opts.evalDb ?? evalDbName();
    const server = opts.server ?? evalServer().http;
    if (name === STDB_DB) {
      report.scenarios.push({ label: 'dry run', id: 'dry-run', status: 'ERROR', detail: `the eval database ${name} is the gateway's own; set CHARTER_EVAL_DB to a scratch database` });
      return finish();
    }
    try {
      await (opts.prepare ?? prepareDryRun)({ db: name, server, ym, role, bodyMd: c.bodyMd, mapping, version: c.version, published, onStep: step });
    } catch (e) {
      report.scenarios.push({ label: 'dry run', id: 'dry-run', status: 'ERROR', detail: `the close with this charter did not finish: ${(e as Error).message}` });
      return finish();
    }
    db = opts.dryRunDb?.(name, server) ?? new SpacetimeCli({ db: name, server });
  }
  step(`Running ${plan.scenarios.length} eval scenarios on ${mode === 'snapshot' ? 'the recorded close' : 'the dry-run close'}`);
  const charterText = { ...Object.fromEntries(published.map(p => [p.role, p.bodyMd])), [role]: c.bodyMd };
  const { results } = await runScenarios({ scenarios: plan.scenarios, db, vars: { ...plan.vars, close_ym: ym }, charterText, bound: plan.bound });
  report.scenarios = [
    ...results.map(r => ({ label: plan.labels.get(r.id) ?? r.agent, id: r.id, status: r.status, detail: r.detail })),
    ...plan.skipped.map(s => ({ ...s, status: 'SKIPPED' as const })),
  ];
  return finish();
}

const MODE_WORDS: Record<EvalMode, string> = { dry_run: 'dry run', snapshot: 'check against the recorded close' };

/** One plain sentence for the CFO: what was judged and, on a failure, which lines broke. */
export function evalSummary(report: EvalReport, version: number): string {
  const who = `The ${ROLE_DISPLAY[report.role as keyof typeof ROLE_DISPLAY] ?? report.role} charter, version ${version},`;
  const checks = report.probes.length + report.scenarios.filter(s => s.status !== 'SKIPPED').length;
  if (report.passed && report.mode === 'dry_run') return `${who} passed its dry run: every line is mapped and all ${checks} checks held, so the CFO can publish it.`;
  if (report.passed) return `${who} passed its check against the recorded close (all ${checks} checks held); it needs a passing dry run before the CFO can publish it.`;
  if (!report.coverage.ok) return `${who} failed its ${MODE_WORDS[report.mode]}: ${report.coverage.problems.length === 1 ? 'one mapping problem' : `${report.coverage.problems.length} mapping problems`} must be fixed first.`;
  if (report.scenarios.some(s => s.id === 'dry-run')) return `${who} failed its dry run: the close could not run under it.`;
  const broken = [...new Set([...report.probes.filter(p => !p.pass).map(p => p.label.split(':')[0]!), ...report.scenarios.filter(s => s.status === 'FAIL' || s.status === 'ERROR').map(s => s.label)])];
  const names = broken.length > 3 ? `${broken.slice(0, 3).join(', ')} and ${broken.length - 3} more` : broken.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return `${who} failed its ${MODE_WORDS[report.mode]}: ${names || 'nothing could be checked'} did not hold.`;
}

/** The published charters of every role but `except` on a ledger, as a dry run closes under them. */
export function publishedCharters(cast: Cast, except: string): PublishedCharter[] {
  const live = new Map<string, { role: string; version: number; bodyMd: string; mappingJson: string }>();
  for (const r of cast.advisor.db.charterVersion.iter()) {
    if (r.status.tag !== 'Live' || r.role === except || !Object.hasOwn(HARNESSES, r.role)) continue;
    if ((live.get(r.role)?.version ?? -1) < r.version) live.set(r.role, r);
  }
  return [...live.values()].flatMap(r => {
    try {
      const { entries, problems } = readMapping(JSON.parse(r.mappingJson) as unknown);
      return problems.length ? [] : [{ role: r.role as Role, version: r.version, bodyMd: r.bodyMd, mapping: entries }];
    } catch {
      return [];
    }
  });
}

/**
 * Judges a saved version through the gateway's Advisor connection and records the result for publishCharter. A dry run
 * closes under the draft together with the other roles' currently published charters, the combination that will run.
 */
export async function evaluateCharterVersion(cast: Cast, versionId: bigint, opts: EvaluateOptions = {}): Promise<EvalReport> {
  const row = cast.advisor.db.charterVersion.id.find(versionId);
  if (!row) throw new Error(`no charter version ${versionId}`);
  if (row.status.tag === 'Live') throw new Error(`charter version ${versionId} is already published`);
  const report = await evaluateCharter({ versionId, role: row.role, version: row.version, bodyMd: row.bodyMd, mappingJson: row.mappingJson }, { published: publishedCharters(cast, row.role), ...opts });
  await cast.advisor.reducers.recordCharterEval({ charterVersionId: versionId, passed: report.passed, mode: report.mode, resultsJson: JSON.stringify(report), summaryPlain: evalSummary(report, row.version) });
  opts.onStep?.(report.publishable ? 'Recorded a passing dry run: the CFO can publish this version' : report.passed ? 'Recorded a passing quick check; a dry run must pass before the CFO can publish' : 'Recorded a failing eval');
  return report;
}
