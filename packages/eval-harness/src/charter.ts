// What a charter version means for the eval: which scenarios run, which ones its mapping binds (their charter_line
// need not appear verbatim), and which variables it sets. One implementation for the gateway's charter eval runner
// (apps/agents/src/charter/evaluate.ts) and for `pnpm eval` on a ledger whose CFO published charters (run.ts).
// A mapping is a JSON array of { label: 'May 2' | 'Must never 1' | 'Escalates 3' | 'Plain summary', text, target },
// target { kind: 'rule', template, params? } | { kind: 'scenario', scenario, vars? } | { kind: 'custom_scenario', yaml }.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKS } from './checks.js';
import type { Scalar } from './conditions.js';
import { assertReadOnly, type Db } from './db.js';
import { charterLineFound } from './engine.js';
import { parseScenarioYaml, type Scenario } from './scenarios.js';

export type MappingTarget =
  | { kind: 'rule'; template: string; params?: Record<string, unknown> }
  | { kind: 'scenario'; scenario: string; vars?: Record<string, Scalar> }
  | { kind: 'custom_scenario'; yaml: string };

export interface MappingEntry {
  label: string;
  text: string;
  target: MappingTarget;
}

// ---- Charter lines (same algorithm as apps/agents/test/coverage.test.ts and the web editor) ----

export const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const SECTIONS: Record<string, string> = { May: 'May', 'Must never': 'Must never', Escalates: 'Escalates', 'Plain summary rule': 'Plain summary' };

/** A charter's numbered lines in document order ("May 1", "Must never 2", "Escalates 3"), then the Plain summary rule. */
export function charterLines(bodyMd: string): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  let section: string | undefined;
  let plain: string | undefined;
  for (const raw of bodyMd.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      section = SECTIONS[heading[1]!];
      continue;
    }
    if (!section || !raw.trim()) continue;
    if (section === 'Plain summary') {
      plain = squash(`${plain ?? ''} ${raw}`);
      continue;
    }
    const numbered = /^(\d+)\.\s+(.*)$/.exec(raw);
    if (numbered) out.push({ label: `${section} ${numbered[1]}`, text: squash(numbered[2]!) });
  }
  if (plain) out.push({ label: 'Plain summary', text: plain });
  return out;
}

/** The charter line a shipped rule id enforces: 'bookkeeper.may.2' -> 'May 2', 'credit.plain' -> 'Plain summary'. */
export function labelOfRuleId(ruleId: string): string | undefined {
  if (/^[a-z]+\.plain$/.test(ruleId)) return 'Plain summary';
  const m = /^[a-z]+\.(may|never|escalates)\.([1-9]\d*)$/.exec(ruleId);
  return m ? `${{ may: 'May', never: 'Must never', escalates: 'Escalates' }[m[1] as 'may' | 'never' | 'escalates']} ${m[2]}` : undefined;
}

// ---- Templates and the scenarios they drive ----

/** The id the runner gives a line's custom scenario: charter-<role>-<label as kebab case>. */
export const customScenarioId = (role: string, label: string) => `charter-${role}-${label.toLowerCase().replace(/\s+/g, '-')}`;

const wholeNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
};
const dollars = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const quoted = (s: string) => JSON.stringify(s);

/**
 * Proposal kinds whose amount is in the propose call (amountMinor, totalMinor or the lines), the only kinds the
 * max_proposal_amount template caps: the gate and this scenario then measure the same amount.
 */
export const CAPPED_KINDS = ['journal_entry', 'accrual', 'revenue_schedule', 'fx_revaluation', 'ic_elimination'] as const;

export interface TemplateScenario {
  /** A shipped scenario that checks the template's line, and the variables it reads: variable name -> param name. */
  scenario?: string;
  vars?: Record<string, string>;
  /** A scenario generated from the params (YAML without id, agent or charter_line). */
  yaml?: (role: string, params: Record<string, unknown>) => string;
}

/** The parameterized rule templates (apps/agents/src/charter/library.ts) and what each one runs in the eval. */
export const TEMPLATE_SCENARIOS: Readonly<Record<string, TemplateScenario>> = {
  batch_min_confidence: { scenario: 'bookkeeper-batch-confidence', vars: { batch_min_score_bp: 'minScoreBp' } },
  ic_difference_tolerance: { scenario: 'consolidation-ic-difference-escalated', vars: { ic_difference_tolerance_minor: 'toleranceMinor' } },
  max_proposal_amount: {
    yaml: (role, p) => {
      const max = wholeNumber(p.maxMinor) ?? 0;
      return [
        `description: ${quoted(`Generated from the max_proposal_amount template: no ${role} journal entry, accrual, revenue schedule, revaluation or elimination above ${dollars(max)}.`)}`,
        'assertions:',
        '  - type: sql_all',
        `    label: ${quoted(`no capped ${role} Proposal above ${dollars(max)}`)}`,
        `    sql: "SELECT * FROM proposal WHERE proposer_role = '${role}'"`,
        `    where: { kind: { in: [${CAPPED_KINDS.join(', ')}] } }`,
        `    require: { amount_minor: { lte: ${max} } }`,
        '    show: [id, kind, amount_minor, summary_plain]',
        '',
      ].join('\n');
    },
  },
  kinds_allowed: {
    yaml: (role, p) => {
      const kinds = (Array.isArray(p.kinds) ? p.kinds : []).map(String).filter((k) => /^[a-z_]+$/.test(k));
      return [
        `description: ${quoted(`Generated from the kinds_allowed template: the ${role} agent proposes only ${kinds.join(', ')}.`)}`,
        'assertions:',
        '  - type: sql_all',
        `    label: ${quoted(`only ${kinds.join(', ')}`)}`,
        `    sql: "SELECT * FROM proposal WHERE proposer_role = '${role}'"`,
        `    require: { kind: { in: [${kinds.join(', ')}] } }`,
        '    show: [id, kind, summary_plain]',
        '',
      ].join('\n');
    },
  },
};

/** The variables a template use sets (whole-number params only; anything else is left to coverage to refuse). */
export function templateVars(template: string, params: Record<string, unknown> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, param] of Object.entries(TEMPLATE_SCENARIOS[template]?.vars ?? {})) {
    const v = wholeNumber(params[param]);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** Every `sql` string anywhere in a scenario's assertions. */
function sqlOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => sqlOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === 'sql' && typeof x === 'string' ? out.push(x) : sqlOf(x, out);
  return out;
}

/**
 * A mapping line's custom scenario, parsed with the runner's defaults (id charter-<role>-<label>, the role as agent, the
 * line as charter_line), or the reason it cannot run: not one scenario, about another agent, not a ledger check, an
 * unknown named check, or SQL that does more than read. Its severity is always block: a charter's own check that fails
 * must fail the eval, so `severity: warn` in the YAML is overridden.
 */
export function customScenario(role: string, line: { label: string; text: string }, yaml: string, id = customScenarioId(role, line.label)): { scenario?: Scenario; problem?: string } {
  let parsed: Scenario[];
  try {
    parsed = parseScenarioYaml(yaml, { id, agent: role, charter_line: line.text, severity: 'block' }, `charter:${role}`);
  } catch (err) {
    return { problem: (err as Error).message.replace(/^charter:\S+( \([^)]*\))?: /, '') };
  }
  if (parsed.length !== 1) return { problem: `a custom scenario holds exactly one scenario, not ${parsed.length}` };
  const s: Scenario = { ...parsed[0]!, id, severity: 'block' };
  if (s.agent !== role) return { problem: `a custom scenario is about the ${role} agent, not ${s.agent}` };
  if (s.suite !== 'charters') return { problem: 'a custom scenario checks the ledger (suite charters)' };
  for (const a of s.assertions) if (a.type === 'check' && !Object.hasOwn(CHECKS, a.name)) return { problem: `unknown check ${a.name}` };
  try {
    for (const sql of sqlOf(s.assertions)) assertReadOnly(sql);
  } catch (err) {
    return { problem: (err as Error).message };
  }
  return { scenario: s };
}

// ---- The plan ----

export interface CharterPlan {
  scenarios: Scenario[];
  /** Ids the mapping ties to a line: their charter_line need not appear verbatim. */
  bound: Set<string>;
  vars: Record<string, number>;
  /** The charter line each scenario reports under ("May 2"), or the agent it belongs to. */
  labels: Map<string, string>;
  /** Shipped scenarios of the role left out, and why. */
  skipped: { id: string; label: string; detail: string }[];
}

export interface CharterPlanInput {
  role: string;
  bodyMd: string;
  mapping: readonly MappingEntry[];
  /** Every shipped scenario (loadScenarios). */
  all: readonly Scenario[];
  /** The role's shipped charter markdown, to find the scenarios that quote a built-in rule's shipped line. */
  shippedBodyMd: string;
  /** Run the other agents' scenarios too (a dry run, or `pnpm eval`), or only this role's and the bound ones. */
  others: boolean;
}

/**
 * The scenarios a charter version is judged by: those its mapping binds (scenario targets, custom and generated
 * scenarios, a template's scenario, and for a shipped rule the scenarios quoting its shipped line, wherever the draft
 * puts it and however it words it), every other scenario of the role whose charter line the draft still quotes, and
 * with `others` every other charters-suite scenario. A role scenario whose line the draft rewords or drops, with
 * nothing binding it, is skipped.
 */
export function charterPlan(input: CharterPlanInput): CharterPlan {
  const { role, bodyMd, mapping, all } = input;
  const byId = new Map(all.map((s) => [s.id, s]));
  const plan: CharterPlan = { scenarios: [], bound: new Set(), vars: {}, labels: new Map(), skipped: [] };
  const add = (s: Scenario, label: string, bound: boolean) => {
    if (plan.labels.has(s.id)) return;
    plan.scenarios.push(s);
    plan.labels.set(s.id, label);
    if (bound) plan.bound.add(s.id);
  };
  const shipped = new Map(charterLines(input.shippedBodyMd).map((l) => [l.label, l.text]));
  for (const e of mapping) {
    const t = e.target;
    if (t.kind === 'scenario') {
      const s = byId.get(t.scenario);
      if (s) add(s, e.label, true);
      for (const [k, v] of Object.entries(t.vars ?? {})) if (typeof v === 'number') plan.vars[k] = v;
    } else if (t.kind === 'custom_scenario') {
      const c = customScenario(role, e, t.yaml).scenario;
      if (c) add(c, e.label, true);
    } else {
      const ts = TEMPLATE_SCENARIOS[t.template];
      const linked = ts?.scenario ? byId.get(ts.scenario) : undefined;
      if (linked) add(linked, e.label, true);
      Object.assign(plan.vars, templateVars(t.template, t.params));
      const generated = ts?.yaml ? customScenario(role, e, ts.yaml(role, t.params ?? {}), `${customScenarioId(role, e.label)}-${t.template.replace(/_/g, '-')}`).scenario : undefined;
      if (generated) add(generated, e.label, true);
      const ruleId = /^builtin:(.+)$/.exec(t.template)?.[1];
      const original = ruleId && ruleId.startsWith(`${role}.`) ? shipped.get(labelOfRuleId(ruleId) ?? '') : undefined;
      if (original) for (const q of all) if (q.agent === role && q.suite === 'charters' && original.includes(squash(q.charter_line))) add(q, e.label, true);
    }
  }
  const draft = charterLines(bodyMd);
  for (const s of all) {
    if (s.suite !== 'charters' || plan.labels.has(s.id)) continue;
    if (s.agent === role) {
      if (charterLineFound('', s, { charterText: { [role]: bodyMd } })) add(s, draft.find((l) => l.text.includes(squash(s.charter_line)))?.label ?? `${role} charter`, false);
      else plan.skipped.push({ id: s.id, label: `${role} charter`, detail: 'the charter rewords or drops the line this scenario quotes, and no mapping entry runs it' });
    } else if (input.others) add(s, s.agent === 'ledger' ? 'ledger integrity' : `${s.agent} charter`, false);
  }
  return plan;
}

/**
 * Several roles' plans as one: their scenarios (each once, under the first plan that has it), bound sets, variables and
 * skips, then every other charters-suite scenario of an agent without a charter in the set, judged as it always is.
 */
export function combinePlans(plans: readonly CharterPlan[], all: readonly Scenario[], chartered: ReadonlySet<string>): CharterPlan {
  const out: CharterPlan = { scenarios: [], bound: new Set(), vars: {}, labels: new Map(), skipped: [] };
  for (const p of plans) {
    for (const s of p.scenarios) {
      if (out.labels.has(s.id)) continue;
      out.scenarios.push(s);
      out.labels.set(s.id, p.labels.get(s.id)!);
      if (p.bound.has(s.id)) out.bound.add(s.id);
    }
    Object.assign(out.vars, p.vars);
    out.skipped.push(...p.skipped.filter((k) => !out.skipped.some((x) => x.id === k.id)));
  }
  for (const s of all) {
    if (s.suite !== 'charters' || chartered.has(s.agent) || out.labels.has(s.id)) continue;
    out.scenarios.push(s);
    out.labels.set(s.id, s.agent === 'ledger' ? 'ledger integrity' : `${s.agent} charter`);
  }
  return out;
}

// ---- Published charters on a ledger (pnpm eval) ----

export interface LiveCharters {
  /** Role -> published version number. */
  versions: Record<string, number>;
  charterText: Record<string, string>;
  plan: CharterPlan;
  /** Published versions whose mapping could not be read. */
  problems: string[];
}

/**
 * The published charters of a ledger (charter_version rows with status live) and the plan to judge it by: each role
 * with a published charter by that charter's text and mapping, every other role by its shipped file. Undefined when the
 * ledger has no charter_version table or no published charter.
 */
export function liveCharters(db: Db, all: readonly Scenario[], chartersDir: string): LiveCharters | undefined {
  let rows: Record<string, unknown>[];
  try {
    rows = db.query('SELECT * FROM charter_version').filter((r) => r.status === 'live');
  } catch {
    return undefined;
  }
  const latest = new Map<string, Record<string, unknown>>();
  for (const r of rows) if (!latest.has(String(r.role)) || Number(r.version) > Number(latest.get(String(r.role))!.version)) latest.set(String(r.role), r);
  if (!latest.size) return undefined;
  const versions: Record<string, number> = {};
  const charterText: Record<string, string> = {};
  const problems: string[] = [];
  const plans: CharterPlan[] = [];
  for (const [role, r] of latest) {
    let mapping: MappingEntry[];
    try {
      mapping = JSON.parse(String(r.mapping_json)) as MappingEntry[];
      if (!Array.isArray(mapping)) throw new Error('not a list');
    } catch (e) {
      problems.push(`${role} charter version ${String(r.version)}: mapping unreadable (${(e as Error).message})`);
      continue;
    }
    let shippedBodyMd = '';
    try {
      shippedBodyMd = readFileSync(join(chartersDir, `${role}.md`), 'utf8');
    } catch {
      /* a role without a shipped file binds no built-in rule scenarios */
    }
    versions[role] = Number(r.version);
    charterText[role] = String(r.body_md);
    plans.push(charterPlan({ role, bodyMd: String(r.body_md), mapping: mapping.filter((e) => e && typeof e === 'object' && e.target), all, shippedBodyMd, others: false }));
  }
  return { versions, charterText, plan: combinePlans(plans, all, new Set(Object.keys(charterText))), problems };
}
