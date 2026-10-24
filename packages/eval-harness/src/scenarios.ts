// Scenario files: scenarios/*.yaml. A file holds one scenario (a mapping) or a list under `scenarios:`.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import type { CondMap } from './conditions.js';

export const AGENTS = ['advisor', 'bookkeeper', 'revenue', 'credit', 'redteam'] as const;
export type Agent = (typeof AGENTS)[number];
export type Severity = 'block' | 'warn';
export type Suite = 'charters' | 'personas';

export interface Side {
  sql: string;
  where?: CondMap;
  /** One path or a list of paths; values are compared as strings. */
  key: string | string[];
}

export type Assertion =
  | { type: 'sql_count'; sql: string; where?: CondMap; expect?: number; min?: number; max?: number; label?: string }
  | { type: 'sql_all'; sql: string; where?: CondMap; require?: CondMap; expect_rows?: number; show?: string[]; label?: string }
  | { type: 'sql_covers'; sql: string; where?: CondMap; column: string; values: (string | number)[]; min?: number; label?: string }
  | { type: 'sql_unique'; sql: string; where?: CondMap; key: string | string[]; label?: string }
  | { type: 'sql_anti_join'; left: Side; right: Side | Side[]; expect_rows?: number; show?: string[]; label?: string }
  | { type: 'sql_semi_join'; left: Side; right: Side | Side[]; expect_rows?: number; show?: string[]; label?: string }
  | { type: 'cascade_decision'; persona: string; expect: string; expect_tier?: string; subject_kind?: 'customer_guarantor' | 'vendor_owner'; as_of?: string; label?: string }
  | { type: 'check'; name: string; params?: Record<string, unknown>; label?: string };

export interface Scenario {
  id: string;
  agent: Agent;
  charter_line: string;
  severity: Severity;
  suite: Suite;
  description?: string;
  assertions: Assertion[];
  file: string;
}

const ASSERTION_TYPES = new Set([
  'sql_count', 'sql_all', 'sql_covers', 'sql_unique', 'sql_anti_join', 'sql_semi_join', 'cascade_decision', 'check',
]);

export class ScenarioError extends Error {}

function validate(raw: Record<string, unknown>, file: string, defaults: Record<string, unknown>): Scenario {
  const s = { ...defaults, ...raw } as Record<string, unknown>;
  const where = `${basename(file)}${s.id ? ` (${String(s.id)})` : ''}`;
  for (const k of ['id', 'agent', 'charter_line', 'severity', 'assertions']) {
    if (s[k] === undefined || s[k] === '') throw new ScenarioError(`${where}: missing \`${k}\``);
  }
  if (!AGENTS.includes(s.agent as Agent)) throw new ScenarioError(`${where}: agent must be one of ${AGENTS.join(', ')}`);
  if (s.severity !== 'block' && s.severity !== 'warn') throw new ScenarioError(`${where}: severity must be block or warn`);
  const suite = (s.suite ?? 'charters') as Suite;
  if (suite !== 'charters' && suite !== 'personas') throw new ScenarioError(`${where}: suite must be charters or personas`);
  if (!Array.isArray(s.assertions) || s.assertions.length === 0) throw new ScenarioError(`${where}: assertions must be a non-empty list`);
  for (const a of s.assertions as { type?: string }[]) {
    if (!a || !ASSERTION_TYPES.has(String(a.type))) throw new ScenarioError(`${where}: unknown assertion type ${String(a?.type)}`);
  }
  return {
    id: String(s.id),
    agent: s.agent as Agent,
    charter_line: String(s.charter_line).trim(),
    severity: s.severity as Severity,
    suite,
    description: s.description ? String(s.description) : undefined,
    assertions: s.assertions as Assertion[],
    file,
  };
}

export function loadScenarios(dir: string): Scenario[] {
  const out: Scenario[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  for (const f of files) {
    const path = join(dir, f);
    const doc = parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    if (!doc) continue;
    if (Array.isArray(doc.scenarios)) {
      const { scenarios, ...defaults } = doc;
      for (const s of scenarios as Record<string, unknown>[]) out.push(validate(s, path, defaults));
    } else out.push(validate(doc, path, {}));
  }
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.id)) throw new ScenarioError(`duplicate scenario id ${s.id} (${basename(s.file)})`);
    seen.add(s.id);
  }
  return out;
}
