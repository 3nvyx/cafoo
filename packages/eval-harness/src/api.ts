// The eval harness as a library (package entry): load or parse scenarios, run them against the live ledger
// (SpacetimeCli) or the recorded snapshot (snapshotDb), with a charter text under eval in place of the shipped file.
// The CLI (run.ts) and the gateway's charter eval runner (apps/agents/src/charter/evaluate.ts) both go through here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { personas } from '@luyten/crs-mcp';
import type { Scalar } from './conditions.js';
import type { Db } from './db.js';
import { runScenario, scoreOf, type EngineContext, type ScenarioResult } from './engine.js';
import { FakeDb, type Tables } from './fake-db.js';
import type { Scenario } from './scenarios.js';

export {
  CAPPED_KINDS,
  TEMPLATE_SCENARIOS,
  charterLines,
  charterPlan,
  combinePlans,
  customScenario,
  customScenarioId,
  labelOfRuleId,
  liveCharters,
  squash,
  templateVars,
  type CharterPlan,
  type CharterPlanInput,
  type LiveCharters,
  type MappingEntry,
  type MappingTarget,
  type TemplateScenario,
} from './charter.js';
export { CHECKS } from './checks.js';
export type { Scalar } from './conditions.js';
export { SpacetimeCli, SqlError, assertReadOnly, findSpacetimeBin, type Db, type Row } from './db.js';
export { charterLineFound, runScenario, scoreOf, type EngineContext, type ScenarioResult, type Status } from './engine.js';
export { FakeDb, type Tables } from './fake-db.js';
export { AGENTS, LEDGER, ScenarioError, loadScenarios, parseScenarioYaml, type Agent, type Assertion, type Scenario, type ScenarioAgent, type Severity, type Suite } from './scenarios.js';

/** The shipped scenarios and charters, and the recorded close the harness's tests and snapshot-mode evals run on. */
export const scenariosDir = fileURLToPath(new URL('../scenarios/', import.meta.url));
export const chartersDir = fileURLToPath(new URL('../../../apps/agents/src/charters/', import.meta.url));
export const snapshotPath = fileURLToPath(new URL('../test/fixtures/ledger-snapshot.json', import.meta.url));

/**
 * Variables a charter can set through its mapping, at the values the built-in charters state. A scenario reads them as
 * `${name}`; a charter line mapped to that scenario (or to the rule template behind it) overrides them.
 */
export const DEFAULT_VARS: Readonly<Record<string, Scalar>> = { batch_min_score_bp: 7500, ic_difference_tolerance_minor: 100 };

/** The values a charter may set each variable to: only ever a stricter check than the shipped value. */
export const VAR_LIMITS: Readonly<Record<string, { min: number; max: number }>> = {
  batch_min_score_bp: { min: 7500, max: 10000 },
  ic_difference_tolerance_minor: { min: 0, max: 100 },
};

const MATERIALITY_KEY = 'materiality_threshold_minor';
export const DEFAULT_MATERIALITY_MINOR = 1_000_000;

/**
 * `${materiality}` (settings materiality_threshold_minor) and `${close_ym}` from a database: `ym` when given, else
 * the month of the newest Proposal. Throws when the database cannot be read.
 */
export function dbVars(db: Db, ym = ''): { materiality: number; close_ym: string } {
  const m = db.query('SELECT * FROM settings').find((r) => r.key === MATERIALITY_KEY);
  const materiality = typeof m?.value_i_64 === 'number' ? m.value_i_64 : typeof m?.value_i64 === 'number' ? (m.value_i64 as number) : DEFAULT_MATERIALITY_MINOR;
  let closeYm = ym;
  if (!closeYm) {
    const periods = new Map(db.query('SELECT * FROM period').map((p) => [String(p.id), String(p.ym)]));
    const latest = db.query('SELECT * FROM proposal').filter((p) => p.period_id !== null).sort((a, b) => Number(b.id) - Number(a.id))[0];
    closeYm = latest ? (periods.get(String(latest.period_id)) ?? '') : '';
  }
  return { materiality, close_ym: closeYm };
}

/** The recorded scripted close (test/fixtures/ledger-snapshot.json, re-recorded by scripts/record-snapshot.ts) as a Db. */
export function snapshotDb(path = snapshotPath): FakeDb {
  return new FakeDb(JSON.parse(readFileSync(path, 'utf8')) as Tables);
}

export interface RunOptions {
  scenarios: Scenario[];
  /** The ledger to judge; null runs only DB-free scenarios (the rest are ERROR). */
  db: Db | null;
  /** Merged over DEFAULT_VARS and, for keys still missing, materiality and close_ym read from `db`. */
  vars?: Record<string, Scalar>;
  chartersDir?: string;
  /** Charter markdown by agent that replaces the shipped file for the verbatim charter_line check. */
  charterText?: EngineContext['charterText'];
  /** Scenario ids a charter mapping binds; their charter_line need not appear verbatim. */
  bound?: EngineContext['bound'];
  /** Persona cascade date, YYYY-MM-DD. Default 2026-10-24. */
  asOf?: string;
}

/** Runs scenarios in order and scores them. A database that cannot be read turns every charters-suite scenario into ERROR. */
export async function runScenarios(opts: RunOptions): Promise<{ results: ScenarioResult[]; score: ReturnType<typeof scoreOf>; vars: Record<string, Scalar> }> {
  let db = opts.db;
  let dbError: string | undefined;
  const given = opts.vars ?? {};
  let fromDb: Record<string, Scalar> = {};
  if (db && (!('materiality' in given) || !('close_ym' in given))) {
    try {
      fromDb = dbVars(db, typeof given.close_ym === 'string' ? given.close_ym : '');
    } catch (e) {
      dbError = (e as Error).message;
      db = null;
    }
  }
  const vars = { ...DEFAULT_VARS, ...fromDb, ...given };
  const ctx: EngineContext = {
    db,
    dbError,
    vars,
    asOf: opts.asOf ?? '2026-10-24',
    chartersDir: opts.chartersDir ?? chartersDir,
    charterText: opts.charterText,
    bound: opts.bound,
    expectedDecisions: new Map(personas().map((p) => [p.personaId, p.expectedDecision as string])),
  };
  const results: ScenarioResult[] = [];
  for (const s of opts.scenarios) results.push(await runScenario(s, ctx));
  return { results, score: scoreOf(results), vars };
}
