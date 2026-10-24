// Runs one scenario: charter-line verification, variable substitution, assertions, scoring.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, type AssertionResult, type EvalContext } from './assertions.js';
import { substitute } from './conditions.js';
import type { Scenario, Suite } from './scenarios.js';

export type Status = 'PASS' | 'FAIL' | 'WARN' | 'ERROR';

export interface ScenarioResult {
  id: string;
  agent: string;
  suite: Suite;
  severity: 'block' | 'warn';
  charter_line: string;
  file: string;
  status: Status;
  detail: string;
  assertions: AssertionResult[];
  error?: string;
}

export interface EngineContext extends EvalContext {
  chartersDir: string;
  /** Dataset expected decision per persona id, to catch a persona scenario drifting from crs-sandbox-dataset.csv. */
  expectedDecisions?: Map<string, string>;
  /** Set when the charters suite cannot reach the database. */
  dbError?: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const charterCache = new Map<string, string | null>();

/** The charter file as one normalized string with list numbering removed. */
export function charterText(chartersDir: string, agent: string): string | null {
  const k = `${chartersDir}|${agent}`;
  if (!charterCache.has(k)) {
    try {
      charterCache.set(k, norm(readFileSync(join(chartersDir, `${agent}.md`), 'utf8').replace(/^\s*\d+\.\s+/gm, '')));
    } catch {
      charterCache.set(k, null);
    }
  }
  return charterCache.get(k) ?? null;
}

export function charterLineFound(chartersDir: string, s: Pick<Scenario, 'agent' | 'charter_line'>): boolean {
  const text = charterText(chartersDir, s.agent);
  return text !== null && text.includes(norm(s.charter_line));
}

export async function runScenario(s: Scenario, ctx: EngineContext): Promise<ScenarioResult> {
  const base = { id: s.id, agent: s.agent, suite: s.suite, severity: s.severity, charter_line: s.charter_line, file: s.file };
  if (!charterLineFound(ctx.chartersDir, s)) {
    return { ...base, status: 'ERROR', detail: `charter_line not found verbatim in charters/${s.agent}.md`, assertions: [], error: 'charter_line not found' };
  }
  if (s.suite === 'charters' && !ctx.db) {
    const why = ctx.dbError ?? 'no database';
    return { ...base, status: 'ERROR', detail: `database unavailable: ${why}`, assertions: [], error: why };
  }
  const results: AssertionResult[] = [];
  let error: string | undefined;
  for (const raw of s.assertions) {
    try {
      const a = substitute(raw, ctx.vars);
      const r = await evaluate(a, ctx);
      if (a.type === 'cascade_decision' && ctx.expectedDecisions) {
        const want = ctx.expectedDecisions.get(a.persona);
        if (want === undefined) {
          r.pass = false;
          r.detail = `${a.persona} is not a dataset persona; ${r.detail}`;
        } else if (want !== a.expect) {
          r.pass = false;
          r.detail = `scenario expects ${a.expect} but the dataset says ${want}; ${r.detail}`;
        }
      }
      results.push(r);
    } catch (e) {
      error = (e as Error).message;
      results.push({ type: raw.type, label: raw.label ?? raw.type, pass: false, detail: `error: ${error}` });
    }
  }
  const failed = results.filter((a) => !a.pass);
  const status: Status = error ? 'ERROR' : failed.length === 0 ? 'PASS' : s.severity === 'block' ? 'FAIL' : 'WARN';
  const detail = failed.length
    ? failed.map((a) => `${a.label}: ${a.detail}`).join(' / ')
    : results.length === 1
      ? results[0]!.detail
      : `${results.length} assertions hold`;
  return { ...base, status, detail, assertions: results, error };
}

export function scoreOf(results: ScenarioResult[]) {
  const n = (s: Status) => results.filter((r) => r.status === s).length;
  const blockBad = results.filter((r) => r.severity === 'block' && (r.status === 'FAIL' || r.status === 'ERROR')).length;
  const bySuite = (['charters', 'personas'] as Suite[])
    .map((s) => {
      const rs = results.filter((r) => r.suite === s);
      return rs.length ? `${s} ${rs.filter((r) => r.status === 'PASS').length}/${rs.length}` : '';
    })
    .filter(Boolean)
    .join(', ');
  return {
    pass: n('PASS'),
    fail: n('FAIL'),
    warn: n('WARN'),
    error: n('ERROR'),
    total: results.length,
    blockFailures: blockBad,
    verdict: blockBad ? 'FAIL' : 'PASS',
    line: `${n('PASS')}/${results.length} scenarios pass (${bySuite}); ${n('FAIL')} blocking failures, ${n('WARN')} warnings, ${n('ERROR')} errors.`,
  };
}
