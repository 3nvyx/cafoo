/**
 * A charter version (markdown plus mapping) turned into the harness the runtime enforces and the params the scripted
 * close reads. A custom charter can only make the gate stricter, and that is structural here, whatever the mapping says:
 *   - every rule of the shipped harness runs, with its own id and line; a line mapped to a template that `tightens` that
 *     rule (batch_min_confidence on the Bookkeeper's May 2, kinds_allowed on a worker's May 1, ic_difference_tolerance on
 *     Consolidation's Escalates 1) runs the template on top of it: both must allow;
 *   - a line the shipped charter does not have may add a rule (id <role>.<may|never|escalates>.<n> from its label) or a
 *     scenario (an evalOnly entry);
 *   - the shipped evalOnly scenarios stay; params can only raise a bar (they are clamped to the shipped values).
 * Tools, model and turn cap stay the role's own: a charter changes what the gate checks, never what the agent can reach.
 */
import { customScenarioId } from '@cafoo/eval-harness';
import { charterPrompt, gateFormats, HARNESSES, type EvalOnly, type Harness, type Role, type Rule } from '../harness';
import { templateById, type TemplateUse } from './library';
import { charterLines, ruleIdFor } from './parse';
import { DEFAULT_PARAMS, type CharterMappingEntry, type ResolvedParams } from './types';

export class CharterError extends Error {}

export { customScenarioId };

/** The shipped mapping: each built-in charter line to its built-in rule, or to the scenario its harness names. */
export function defaultMapping(role: Role, bodyMd = charterPrompt(HARNESSES[role])): CharterMappingEntry[] {
  const h = HARNESSES[role];
  return charterLines(bodyMd).flatMap((l): CharterMappingEntry[] => {
    const r = h.rules.find(x => x.charter === l.label);
    if (r) return [{ label: l.label, text: l.text, target: { kind: 'rule', template: `builtin:${r.id}` } }];
    const e = h.evalOnly.find(x => x.charter === l.label);
    return e ? [{ label: l.label, text: l.text, target: { kind: 'scenario', scenario: e.scenario.replace(/\.ya?ml$/, '') } }] : [];
  });
}

/** The lines the shipped harness backs, by label: its rule, or the scenario its evalOnly entry names. */
export function shippedLines(base: Harness): Map<string, { rule?: Rule; scenario?: string }> {
  const out = new Map<string, { rule?: Rule; scenario?: string }>();
  for (const r of base.rules) out.set(r.charter, { rule: r });
  for (const e of base.evalOnly) if (!out.has(e.charter)) out.set(e.charter, { scenario: e.scenario.replace(/\.ya?ml$/, '') });
  return out;
}

/** What a mapping may put on a shipped rule's line: the rule itself, or a template that tightens it. */
export function keepsShippedRule(role: Role, ruleId: string, target: CharterMappingEntry['target']): boolean {
  if (target.kind !== 'rule') return false;
  return target.template === `builtin:${ruleId}` || templateById(target.template)?.tightens?.rule(role) === ruleId;
}

export interface TightenedRule {
  label: string;
  rule: string;
  template: string;
  params: Record<string, unknown>;
}

/** The shipped rules a mapping tightens with a template, for the eval report. */
export function tightenedRules(base: Harness, mapping: readonly CharterMappingEntry[]): TightenedRule[] {
  const shipped = shippedLines(base);
  return mapping.flatMap(e => {
    const r = shipped.get(e.label)?.rule;
    if (!r || e.target.kind !== 'rule' || e.target.template === `builtin:${r.id}` || !keepsShippedRule(base.role, r.id, e.target)) return [];
    return [{ label: e.label, rule: r.id, template: e.target.template, params: e.target.params ?? {} }];
  });
}

export interface BuiltCharter {
  harness: Harness;
  params: ResolvedParams;
}

/**
 * The harness and params for a charter version of `base.role`. Throws CharterError when a mapped line is not in the
 * charter or is mapped twice, a template is unknown, belongs to another role or has invalid params, a shipped line is
 * mapped to anything but its own rule (or a template that tightens it) or its own scenario, or a new line names a
 * built-in rule (coverage reports the same before a version can pass its eval, so a live version never throws).
 */
export function harnessFromCharter(base: Harness, bodyMd: string, mapping: readonly CharterMappingEntry[]): BuiltCharter {
  const role = base.role;
  const present = new Set(charterLines(bodyMd).map(l => l.label));
  const shipped = shippedLines(base);
  const byLabel = new Map<string, CharterMappingEntry>();
  for (const e of mapping) {
    if (!ruleIdFor(role, e.label)) throw new CharterError(`"${String(e.label)}" is not a charter line label`);
    if (!present.has(e.label)) throw new CharterError(`${e.label} is mapped but the charter has no such line`);
    if (byLabel.has(e.label)) throw new CharterError(`${e.label} is mapped twice`);
    byLabel.set(e.label, e);
  }
  const params: ResolvedParams = { ...DEFAULT_PARAMS };
  let kinds = [...base.proposalKinds];
  /** A template use, validated; its params and kinds applied. */
  const apply = (e: CharterMappingEntry & { target: { kind: 'rule' } }) => {
    const t = templateById(e.target.template);
    if (!t) throw new CharterError(`${e.label} maps to an unknown rule template ${e.target.template}`);
    if (t.role !== role && t.role !== '*') throw new CharterError(`${e.label} maps to ${t.id}, a ${t.role} template`);
    const use: TemplateUse = { role, base, label: e.label, text: e.text, params: e.target.params ?? {} };
    const problems = t.problems(use);
    if (problems.length) throw new CharterError(`${e.label} (${t.id}): ${problems.join('; ')}`);
    Object.assign(params, t.charterParams?.(use));
    if (t.kinds) {
      const keep = t.kinds(use);
      kinds = kinds.filter(k => keep.includes(k));
    }
    return { t, rule: t.rule(use) };
  };

  // Every shipped rule runs; a tightening template runs on top of it.
  const rules: Rule[] = base.rules.map(r => {
    const e = byLabel.get(r.charter);
    if (!e || (e.target.kind === 'rule' && e.target.template === `builtin:${r.id}`)) return r;
    if (!keepsShippedRule(role, r.id, e.target)) throw new CharterError(`${r.charter} keeps its shipped rule ${r.id}; a charter can only make the gate stricter`);
    const { t, rule } = apply(e as CharterMappingEntry & { target: { kind: 'rule' } });
    return {
      id: r.id,
      charter: r.charter,
      check: (call, ctx) => {
        const shippedVerdict = r.check(call, ctx);
        return shippedVerdict.allow ? rule.check(call, ctx) : shippedVerdict;
      },
      format: t.tightens!.format === 'replace' ? rule.format ?? r.format : [r.format, rule.format].filter(Boolean).join(' '),
      ...(r.partial ? { partial: r.partial } : {}),
    };
  });
  const evalOnly: EvalOnly[] = [...base.evalOnly];
  for (const [label, sh] of shipped) {
    const e = byLabel.get(label);
    if (sh.scenario && e && !(e.target.kind === 'scenario' && e.target.scenario === sh.scenario)) throw new CharterError(`${label} keeps its shipped scenario ${sh.scenario}; a charter can only make the gate stricter`);
  }
  // Lines the shipped charter does not have add a rule or a scenario.
  for (const e of mapping) {
    if (shipped.has(e.label)) continue;
    if (e.target.kind === 'rule') {
      if (e.target.template.startsWith('builtin:')) throw new CharterError(`${e.label} is a new line; built-in rules stay on their own lines`);
      const { rule } = apply(e as CharterMappingEntry & { target: { kind: 'rule' } });
      rules.push({ id: ruleIdFor(role, e.label)!, charter: e.label, ...rule });
    } else {
      const scenario = e.target.kind === 'scenario' ? `${e.target.scenario}.yaml` : `${customScenarioId(role, e.label)} (custom)`;
      evalOnly.push({ charter: e.label, scenario, why: 'added by the charter version' });
    }
  }
  // Params can only raise a bar, whatever a template let through.
  params.batchMinScoreBp = Math.max(params.batchMinScoreBp, DEFAULT_PARAMS.batchMinScoreBp);
  if (params.icDifferenceToleranceMinor > DEFAULT_PARAMS.icDifferenceToleranceMinor || params.icDifferenceToleranceMinor < 0n) params.icDifferenceToleranceMinor = DEFAULT_PARAMS.icDifferenceToleranceMinor;
  return { harness: { ...base, rules, evalOnly, proposalKinds: kinds }, params };
}

/** The system prompt for a charter body under a harness: as agentPrompt builds it (Red Team: instructions first). */
export function promptFor(harness: Harness, bodyMd: string): string {
  const head = harness.role === 'redteam' ? [harness.fallbackPrompt, bodyMd] : [bodyMd];
  return [...head, gateFormats(harness)].filter(Boolean).join('\n\n');
}
