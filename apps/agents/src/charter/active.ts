/**
 * The charter each agent runs under right now. Three sources, strongest first:
 *   1. CHARTER_OVERRIDE_JSON ({charters: [{role, bodyMd, mapping, version?}]}, or one such object), honoured only when
 *      CHARTER_OVERRIDE_DB names this process's database: the eval dry run sets both for the scratch close, so a value
 *      left in .env is not a back door. Each override must pass charter coverage (stricter-only included);
 *   2. the CFO-published charter version for the role (a charter_version row with status live);
 *   3. the built-in charter, version 0: apps/agents/src/charters/<role>.md and its harness in src/harness.
 * Callers read the harness (tool gate), the prompt (live agents) and the params (scripted close thresholds) from here,
 * never from the files directly, so a published charter changes all three at once. Whatever the source, every shipped
 * rule runs (src/charter/build.ts): a custom charter can only make the gate stricter.
 */
import { loadScenarios, scenariosDir, type Scenario } from '@luyten/eval-harness';
import { STDB_DB } from '../env';
import { agentPrompt, charterPrompt, harnessFor, HARNESSES, type Harness, type Role } from '../harness';
import type { RoleConn } from '../stdb';
import { CharterError, harnessFromCharter, promptFor } from './build';
import { charterCoverage, readMapping } from './coverage';
import { DEFAULT_PARAMS, type ResolvedParams } from './types';

export { DEFAULT_PARAMS, type CharterParams, type ResolvedParams } from './types';

export interface ActiveCharter {
  role: Role;
  /** The charter_version row id; undefined for the built-in charter and for an override. */
  versionId?: bigint;
  /** 0 for the built-in charter. */
  version: number;
  bodyMd: string;
  harness: Harness;
  /** The full system prompt: charter body, then the formats the gate checks (Red Team: operating instructions first). */
  prompt: string;
  params: ResolvedParams;
}

/** Where an active charter came from: built-in, published vN, or dry-run override vN. */
export const charterSource = (c: ActiveCharter) => (c.versionId !== undefined ? `published v${c.version}` : c.version === 0 ? 'built-in' : `dry-run override v${c.version}`);

const builtinCache = new Map<Role, ActiveCharter>();

/** The role's built-in charter: the shipped file and harness, version 0 (read once per process). */
export function builtinCharter(role: Role): ActiveCharter {
  let c = builtinCache.get(role);
  if (!c) {
    const harness = HARNESSES[role];
    c = { role, version: 0, bodyMd: charterPrompt(harness), harness, prompt: agentPrompt(harness, { withInstructions: role === 'redteam' }), params: { ...DEFAULT_PARAMS } };
    builtinCache.set(role, c);
  }
  return c;
}

/** A charter body and mapping built into an ActiveCharter; throws CharterError when the mapping does not build. */
export function customCharter(role: Role, bodyMd: string, mapping: unknown, meta: { version: number; versionId?: bigint }): ActiveCharter {
  const { entries, problems } = readMapping(mapping);
  if (problems.length) throw new CharterError(problems.join('; '));
  const { harness, params } = harnessFromCharter(HARNESSES[role], bodyMd, entries);
  return { role, ...meta, bodyMd, harness, prompt: promptFor(harness, bodyMd), params };
}

export interface CharterOverride {
  role: Role;
  bodyMd: string;
  mapping: unknown;
  /** The version number, for logs; defaults to -1 (an unsaved draft). */
  version?: number;
}

let shippedScenarios: Scenario[] | undefined;
let overrideCache: { raw: string; charters: Map<Role, ActiveCharter> } | undefined;
let ignoredOverride: string | undefined;

/**
 * The override for `role`, or undefined when none applies to it. Ignored, with a warning once, unless
 * CHARTER_OVERRIDE_DB is this process's database. A broken override, or one that fails coverage, throws: a dry run must
 * never fall back to the built-in charter and pass a draft it did not run.
 */
function overrideFor(role: Role, env: NodeJS.ProcessEnv): ActiveCharter | undefined {
  const raw = env.CHARTER_OVERRIDE_JSON;
  if (!raw?.trim()) return undefined;
  if (env.CHARTER_OVERRIDE_DB !== STDB_DB) {
    if (ignoredOverride !== raw) {
      ignoredOverride = raw;
      console.warn(`[charter] CHARTER_OVERRIDE_JSON is set but CHARTER_OVERRIDE_DB is ${env.CHARTER_OVERRIDE_DB ? `"${env.CHARTER_OVERRIDE_DB}"` : 'unset'}, not this process's database "${STDB_DB}"; ignored (only an eval dry run sets it)`);
    }
    return undefined;
  }
  if (overrideCache?.raw !== raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CharterError('CHARTER_OVERRIDE_JSON is not JSON');
    }
    const p = parsed as { charters?: unknown } | null;
    const list = (p && Array.isArray(p.charters) ? p.charters : [parsed]) as CharterOverride[];
    const charters = new Map<Role, ActiveCharter>();
    const seen = new Set<string>();
    for (const o of list) {
      if (!o || typeof o !== 'object' || !Object.hasOwn(HARNESSES, String(o.role)) || typeof o.bodyMd !== 'string') throw new CharterError('CHARTER_OVERRIDE_JSON needs {role, bodyMd, mapping} for a known role');
      if (seen.has(o.role)) throw new CharterError(`CHARTER_OVERRIDE_JSON holds two ${o.role} charters`);
      seen.add(o.role);
    }
    for (const o of list) {
      shippedScenarios ??= loadScenarios(scenariosDir);
      const coverage = charterCoverage(o.role, o.bodyMd, o.mapping, shippedScenarios);
      if (!coverage.ok) throw new CharterError(`the ${o.role} charter in CHARTER_OVERRIDE_JSON fails coverage: ${coverage.problems.join('; ')}`);
      charters.set(o.role, customCharter(o.role, o.bodyMd, o.mapping, { version: typeof o.version === 'number' ? o.version : -1 }));
    }
    overrideCache = { raw, charters };
  }
  return overrideCache.charters.get(role);
}

/** Built charters of published versions by row id; a version row never changes once written. */
const liveCache = new Map<bigint, ActiveCharter | null>();

/** The role's published version, built; null when it fails to build (the built-in charter applies, with a warning). */
function liveFor(conn: RoleConn, role: Role): ActiveCharter | undefined {
  const rows = [...conn.db.charterVersion.iter()].filter(r => r.role === role && r.status.tag === 'Live').sort((a, b) => b.version - a.version);
  const row = rows[0];
  if (!row) return undefined;
  if (!liveCache.has(row.id)) {
    try {
      liveCache.set(row.id, customCharter(role, row.bodyMd, JSON.parse(row.mappingJson) as unknown, { version: row.version, versionId: row.id }));
    } catch (e) {
      console.warn(`[charter] published ${role} charter v${row.version} does not build (${(e as Error).message}); the built-in charter applies`);
      liveCache.set(row.id, null);
    }
  }
  return liveCache.get(row.id) ?? undefined;
}

/** The source each role last ran under, so a close logs it once at start and again whenever it changes. */
const announced = new Map<Role, string>();
function announce(c: ActiveCharter, env: NodeJS.ProcessEnv) {
  if (env.VITEST) return;
  const source = charterSource(c);
  if (announced.get(c.role) === source) return;
  announced.set(c.role, source);
  console.log(`[charter] ${c.role}: ${source}`);
}

/**
 * The charter `role` runs under. `conn` is any role connection subscribed to charter_version (the Advisor's);
 * without one only the override and the built-in charter apply.
 */
export function activeCharter(conn: RoleConn | undefined, role: Role, env: NodeJS.ProcessEnv = process.env): ActiveCharter {
  const c = overrideFor(role, env) ?? (conn ? liveFor(conn, role) : undefined) ?? builtinCharter(role);
  announce(c, env);
  return c;
}

/**
 * A harnessGate `resolve` that follows the active charters: no agent type is the root query (the Advisor), a known
 * role gets its active harness, anything else gets none (the gate denies it).
 */
export function activeHarnessResolver(conn: RoleConn | undefined, env: NodeJS.ProcessEnv = process.env): (agentType?: string) => Harness | undefined {
  return agentType => {
    const base = harnessFor(agentType);
    return base ? activeCharter(conn, base.role, env).harness : undefined;
  };
}
