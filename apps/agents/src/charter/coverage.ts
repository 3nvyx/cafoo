/**
 * Charter coverage, the custom-charter form of test/coverage.test.ts: every line of the charter is mapped exactly
 * once, the mapped text is the line's text, and every target is real: a template of this role (or a '*' template)
 * with valid params, a shipped charters-suite scenario with known variables, or custom scenario YAML that parses, is
 * about this role, and only reads. On top of that a custom charter can only make the gate stricter (see
 * charterCoverage). Problems are plain sentences for the CFO's editor and the eval report.
 */
import { customScenario, DEFAULT_VARS, templateVars, VAR_LIMITS, type Scenario } from '@cafoo/eval-harness';
import { HARNESSES, type Role } from '../harness';
import { keepsShippedRule, shippedLines } from './build';
import { PARAM_TEMPLATES, templateById } from './library';
import { charterLines, isLabel, squash, strayLines } from './parse';
import type { CharterMappingEntry } from './types';

export interface CoverageResult {
  ok: boolean;
  problems: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The mapping's entries when it has the right shape, with a problem for each malformed entry. */
export function readMapping(mapping: unknown): { entries: CharterMappingEntry[]; problems: string[] } {
  if (!Array.isArray(mapping)) return { entries: [], problems: ['the mapping is not a list'] };
  const entries: CharterMappingEntry[] = [];
  const problems: string[] = [];
  mapping.forEach((e, i) => {
    const where = isObj(e) && typeof e.label === 'string' ? e.label : `entry ${i + 1}`;
    if (!isObj(e) || !isLabel(e.label)) return problems.push(`${where}: a mapping entry needs a line label such as "May 2", "Must never 1" or "Plain summary"`);
    if (typeof e.text !== 'string') return problems.push(`${where}: the mapping entry has no line text`);
    const t = e.target;
    const ok =
      isObj(t) &&
      ((t.kind === 'rule' && typeof t.template === 'string' && (t.params === undefined || isObj(t.params))) ||
        (t.kind === 'scenario' && typeof t.scenario === 'string' && (t.vars === undefined || isObj(t.vars))) ||
        (t.kind === 'custom_scenario' && typeof t.yaml === 'string'));
    if (!ok) return problems.push(`${where}: the target must be a rule template, a scenario, or a custom scenario`);
    entries.push(e as unknown as CharterMappingEntry);
  });
  return { entries, problems };
}

export { customScenario };

/** Variables a mapping sets, by name, from scenario targets and from templates that drive a scenario. */
export function mappingVars(entries: readonly CharterMappingEntry[]): { vars: Record<string, number>; problems: string[] } {
  const vars: Record<string, number> = {};
  const problems: string[] = [];
  /** A template's own params bound its variables (its problems say so); a scenario target's vars are bounded here. */
  const set = (label: string, name: string, value: unknown, fromTemplate = false) => {
    if (!Object.hasOwn(DEFAULT_VARS, name)) return problems.push(`${label}: unknown scenario variable ${name}; known: ${Object.keys(DEFAULT_VARS).join(', ')}`);
    if (typeof value !== 'number' || !Number.isFinite(value)) return problems.push(`${label}: variable ${name} must be a number`);
    const limit = VAR_LIMITS[name];
    if (limit && !fromTemplate && (value < limit.min || value > limit.max)) return problems.push(`${label}: variable ${name} must be from ${limit.min} to ${limit.max} (the shipped ${String(DEFAULT_VARS[name])} or stricter); got ${value}`);
    if (name in vars && vars[name] !== value) return problems.push(`${label}: variable ${name} is set to both ${vars[name]} and ${value}`);
    vars[name] = value;
  };
  for (const e of entries) {
    if (e.target.kind === 'scenario') for (const [k, v] of Object.entries(e.target.vars ?? {})) set(e.label, k, v);
    if (e.target.kind === 'rule') for (const [k, v] of Object.entries(templateVars(e.target.template, e.target.params))) set(e.label, k, v, true);
  }
  return { vars, problems };
}

/**
 * Coverage of a role's charter by a mapping, against the shipped scenarios. Besides every line mapped once to a real
 * target, a custom charter can only make the gate stricter: every shipped line stays (reworded if the CFO likes), mapped
 * to its shipped rule or a template that tightens it, or to its shipped scenario; new lines add rules or scenarios but
 * never name a built-in rule; and nothing but the intro and the Plain summary rule is unnumbered prose.
 */
export function charterCoverage(role: Role, bodyMd: string, mapping: unknown, scenarios: readonly Scenario[]): CoverageResult {
  const lines = charterLines(bodyMd);
  const { entries, problems } = readMapping(mapping);
  const byId = new Map(scenarios.map(s => [s.id, s]));
  const base = HARNESSES[role];
  const shipped = shippedLines(base);
  const seen = new Map<string, number>();
  for (const l of lines) seen.set(l.label, (seen.get(l.label) ?? 0) + 1);
  for (const [label, n] of seen) if (n > 1) problems.push(`the charter has ${n} lines labelled ${label}; number each section's lines once`);
  for (const x of strayLines(bodyMd)) problems.push(`line ${x.line} ("${x.text.slice(0, 60)}") ${x.problem}: the agent would read it with no rule or scenario behind it; write it as its own numbered line`);
  const keepWith = (ruleId: string) => {
    const tighter = PARAM_TEMPLATES.filter(t => t.tightens?.rule(role) === ruleId).map(t => t.id);
    return `builtin:${ruleId}${tighter.length ? ` (or tighten it with ${tighter.join(' or ')})` : ''}`;
  };
  for (const [label, sh] of shipped) {
    if (!seen.has(label)) problems.push(`${label} is a shipped line (${sh.rule ? `rule ${sh.rule.id}` : `scenario ${sh.scenario}`}); a charter may reword it but not remove it, because a charter can only make the gate stricter`);
  }
  const text = new Map(lines.map(l => [l.label as string, l.text]));
  const mapped = new Map<string, number>();
  for (const e of entries) mapped.set(e.label, (mapped.get(e.label) ?? 0) + 1);
  for (const l of seen.keys()) if (!mapped.has(l)) problems.push(`${l} is not mapped to a rule or a scenario`);
  for (const [l, n] of mapped) {
    if (n > 1) problems.push(`${l} is mapped ${n} times; map each line once`);
    if (!seen.has(l)) problems.push(`${l} is mapped, but the charter has no such line`);
  }
  for (const e of entries) {
    const line = text.get(e.label);
    if (line !== undefined && squash(e.text) !== line) problems.push(`${e.label}: the mapped text is not the line's text ("${squash(e.text).slice(0, 60)}" vs "${line.slice(0, 60)}")`);
    const t = e.target;
    const sh = shipped.get(e.label);
    if (sh?.rule && !keepsShippedRule(role, sh.rule.id, t)) problems.push(`${e.label} keeps its shipped rule: map it to ${keepWith(sh.rule.id)}; a charter can only make the gate stricter`);
    if (sh?.scenario && !(t.kind === 'scenario' && t.scenario === sh.scenario && !Object.keys(t.vars ?? {}).length)) problems.push(`${e.label} keeps its shipped scenario: map it to ${sh.scenario}; a charter can only make the gate stricter`);
    if (!sh && seen.has(e.label) && t.kind === 'rule' && t.template.startsWith('builtin:')) problems.push(`${e.label} is a new line and ${t.template} is a shipped rule, which stays on its own line; map the new line to a template or a scenario`);
    if (t.kind === 'rule') {
      const tpl = templateById(t.template);
      if (!tpl) problems.push(`${e.label} maps to a rule template that does not exist (${t.template})`);
      else if (tpl.role !== role && tpl.role !== '*') problems.push(`${e.label} maps to ${tpl.id}, which is for the ${tpl.role} agent`);
      else problems.push(...tpl.problems({ role, base, label: e.label, text: e.text, params: t.params ?? {} }).map(p => `${e.label} (${tpl.id}): ${p}`));
    } else if (t.kind === 'scenario') {
      const s = byId.get(t.scenario);
      if (!s) problems.push(`${e.label} maps to a scenario that does not exist (${t.scenario})`);
      else if (s.suite !== 'charters') problems.push(`${e.label} maps to ${t.scenario}, which checks no ledger (suite ${s.suite})`);
    } else {
      const c = customScenario(role, e, t.yaml);
      if (c.problem) problems.push(`${e.label}: custom scenario: ${c.problem}`);
    }
  }
  problems.push(...mappingVars(entries).problems);
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
