// Scenario files: scenarios/*.yaml. A file holds one scenario (a mapping) or a list under `scenarios:`.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import type { CondMap } from './conditions.js';

export const AGENTS = ['advisor', 'bookkeeper', 'revenue', 'credit', 'redteam', 'consolidation'] as const;
export type Agent = (typeof AGENTS)[number];
/**
 * Cross-cutting ledger-integrity scenarios (FX rates, bank-match payment entries) that belong to no single agent's
 * charter: `agent: ledger`, no `charter_line`. Everything else about them is a normal charters-suite scenario.
 */
export const LEDGER = 'ledger' as const;
export type ScenarioAgent = Agent | typeof LEDGER;
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
  agent: ScenarioAgent;
  /** Verbatim charter text; empty for ledger scenarios. */
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
  const ledger = s.agent === LEDGER;
  for (const k of ['id', 'agent', ...(ledger ? [] : ['charter_line']), 'severity', 'assertions']) {
    if (s[k] === undefined || s[k] === '') throw new ScenarioError(`${where}: missing \`${k}\``);
  }
  if (!ledger && !AGENTS.includes(s.agent as Agent)) throw new ScenarioError(`${where}: agent must be one of ${AGENTS.join(', ')}, or ${LEDGER}`);
  if (ledger && s.charter_line) throw new ScenarioError(`${where}: a ${LEDGER} scenario quotes no charter line`);
  if (s.severity !== 'block' && s.severity !== 'warn') throw new ScenarioError(`${where}: severity must be block or warn`);
  const suite = (s.suite ?? 'charters') as Suite;
  if (suite !== 'charters' && suite !== 'personas') throw new ScenarioError(`${where}: suite must be charters or personas`);
  if (!Array.isArray(s.assertions) || s.assertions.length === 0) throw new ScenarioError(`${where}: assertions must be a non-empty list`);
  for (const a of s.assertions as { type?: string }[]) {
    if (!a || !ASSERTION_TYPES.has(String(a.type))) throw new ScenarioError(`${where}: unknown assertion type ${String(a?.type)}`);
  }
  return {
    id: String(s.id),
    agent: s.agent as ScenarioAgent,
    charter_line: ledger ? '' : String(s.charter_line).trim(),
    severity: s.severity as Severity,
    suite,
    description: s.description ? String(s.description) : undefined,
    assertions: s.assertions as Assertion[],
    file,
  };
}

/**
 * Scenarios from YAML text: one scenario (a mapping) or a list under `scenarios:` with shared top-level defaults.
 * `defaults` fill keys the text leaves out (a charter draft's custom scenario gets its id, agent and charter line this
 * way); `file` names the source in errors and reports. Throws ScenarioError on anything invalid.
 */
export function parseScenarioYaml(yaml: string, defaults: Record<string, unknown> = {}, file = '<inline>'): Scenario[] {
  let doc: unknown;
  try {
    doc = parse(yaml);
  } catch (e) {
    throw new ScenarioError(`${basename(file)}: not valid YAML (${(e as Error).message.split('\n')[0]})`);
  }
  if (doc === null || doc === undefined) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new ScenarioError(`${basename(file)}: a scenario file is a mapping`);
  const d = doc as Record<string, unknown>;
  if (Array.isArray(d.scenarios)) {
    const { scenarios, ...shared } = d;
    return (scenarios as Record<string, unknown>[]).map((s) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new ScenarioError(`${basename(file)}: every entry under scenarios is a mapping`);
      return validate(s, file, { ...defaults, ...shared });
    });
  }
  return [validate(d, file, defaults)];
}

export function loadScenarios(dir: string): Scenario[] {
  const out: Scenario[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  for (const f of files) {
    const path = join(dir, f);
    out.push(...parseScenarioYaml(readFileSync(path, 'utf8'), {}, path));
  }
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.id)) throw new ScenarioError(`duplicate scenario id ${s.id} (${basename(s.file)})`);
    seen.add(s.id);
  }
  return out;
}
