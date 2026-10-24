/**
 * Gateway routes for custom charters: the catalog the charter editor maps lines against, and the eval runner.
 *   GET  /charters/catalog            templates, scenarios, and each role's built-in charter with its default mapping
 *   POST /charters/:versionId/eval    start an eval of a saved version ({mode?: 'dry_run' | 'snapshot'}); 202, 409 while
 *                                     one runs or when the version is already published, 404 when there is no such version
 *   GET  /charters/:versionId/eval    {versionId, status: idle | running | done | error, steps[], error?}
 * The result arrives as a charter_eval row (recordCharterEval). Only a passing dry run lets the CFO publish; a snapshot
 * run is a quick check (`publishable` says which). charterEvalStatus() is merged into GET /status.
 * POST changes state, so the gateway lets it through only from this machine or with the gateway API key (src/http.ts).
 */
import { labelOfRuleId, loadScenarios, scenariosDir } from '@cafoo/eval-harness';
import { HARNESSES, type Role } from '../harness';
import { BadRequest, json, readJson, type Route } from '../http';
import type { Cast } from '../stdb';
import { builtinCharter } from './active';
import { defaultMapping } from './build';
import { evaluateCharterVersion, type EvalMode, type EvaluateOptions } from './evaluate';
import { allTemplates } from './library';

export interface EvalStatus {
  versionId?: string;
  status: 'idle' | 'running' | 'done' | 'error';
  mode?: EvalMode;
  passed?: boolean;
  /** A passing dry run: the CFO can publish the version. A passing snapshot check is not enough. */
  publishable?: boolean;
  steps: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** What a charter line can map to, and each role's built-in charter with its default mapping. */
export function charterCatalog() {
  const roles = Object.keys(HARNESSES) as Role[];
  return {
    // tightensLine: the shipped line a template may stand on (it then runs on top of that line's rule); other
    // templates go on new lines only, and builtin:<ruleId> stays on its own line.
    templates: allTemplates().map(t => {
      const ruleId = t.tightens?.rule(t.role === '*' ? 'bookkeeper' : t.role);
      return { id: t.id, role: t.role, titlePlain: t.titlePlain, params: t.params, ...(ruleId ? { tightensLine: labelOfRuleId(ruleId) } : {}) };
    }),
    scenarios: loadScenarios(scenariosDir)
      .filter(s => s.suite === 'charters')
      .map(s => ({ id: s.id, agent: s.agent, charterLine: s.charter_line })),
    builtin: Object.fromEntries(roles.map(role => [role, { bodyMd: builtinCharter(role).bodyMd, mapping: defaultMapping(role) }])),
  };
}

let current: EvalStatus = { status: 'idle', steps: [] };

/** The latest eval run, for GET /status (key charterEval). */
export function charterEvalStatus(): EvalStatus {
  return current;
}

/** Test seam: forget the last run. */
export function resetCharterEvalStatus() {
  current = { status: 'idle', steps: [] };
}

export interface CharterRouteOptions {
  /** Test seam: the runner (default evaluateCharterVersion), and options passed to it. */
  evaluate?: typeof evaluateCharterVersion;
  evalOptions?: EvaluateOptions;
}

export function charterRoutes(cast: Cast, opts: CharterRouteOptions = {}): Route[] {
  const evaluate = opts.evaluate ?? evaluateCharterVersion;
  return [
    { method: 'GET', pattern: /^\/charters\/catalog$/, handle: ({ res }) => json(res, 200, charterCatalog()) },
    {
      method: 'POST',
      pattern: /^\/charters\/(\d+)\/eval$/,
      handle: async ({ req, res, params }) => {
        const body = await readJson(req);
        const mode = body.mode ?? 'dry_run';
        if (mode !== 'dry_run' && mode !== 'snapshot') throw new BadRequest('mode must be dry_run or snapshot');
        const versionId = BigInt(params[0]!);
        if (current.status === 'running') return json(res, 409, { error: `an eval of charter version ${current.versionId} is still running`, ...current });
        const row = cast.advisor.db.charterVersion.id.find(versionId);
        if (!row) return json(res, 404, { error: `no charter version ${versionId}` });
        if (row.status.tag === 'Live') return json(res, 409, { error: `charter version ${versionId} is already published` });
        const state: EvalStatus = { versionId: versionId.toString(), status: 'running', mode, steps: [], startedAt: new Date().toISOString() };
        current = state;
        void evaluate(cast, versionId, { ...opts.evalOptions, mode, onStep: m => state.steps.push(m) })
          .then(r => {
            state.status = 'done';
            state.passed = r.passed;
            state.publishable = r.publishable;
          })
          .catch((e: unknown) => {
            state.status = 'error';
            state.error = (e as Error)?.message ?? String(e);
            console.error('charter eval failed:', e);
          })
          .finally(() => {
            state.finishedAt = new Date().toISOString();
          });
        return json(res, 202, state);
      },
    },
    {
      method: 'GET',
      pattern: /^\/charters\/(\d+)\/eval$/,
      handle: ({ res, params }) => json(res, 200, current.versionId === params[0] ? current : { versionId: params[0], status: 'idle', steps: [] }),
    },
  ];
}
