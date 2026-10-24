/**
 * Rule templates a charter line can map to. `builtin:<ruleId>` is each shipped harness rule exactly as it is; the
 * parameterized templates let the CFO raise a bar or add a rule without code: each builds the gate rule from its params,
 * says which probes (tool calls with a known verdict) prove the params took effect, which eval scenario checks the same
 * line on the ledger (with the variables it sets), and which CharterParams the scripted close reads.
 * A custom charter can only make the gate stricter: every shipped rule always runs, a template mapped onto a shipped
 * rule's line runs on top of it (`tightens`), and template params can only raise a bar, never lower it.
 */
import { CAPPED_KINDS as SHARED_CAPPED_KINDS, TEMPLATE_SCENARIOS, templateVars } from '@cafoo/eval-harness';
import { formatMinor } from '@cafoo/ledger-core';
import { charterPrompt, HARNESSES, type CharterLine, type Harness, type ProposalKind, type Role, type Rule, type RuleContext, type ToolCall } from '../harness';
import { BATCH_MIN_SCORE_BP } from '../harness/bookkeeper';
import { IC_DIFFERENCE_TOLERANCE_MINOR } from '../harness/consolidation';
import { allow, arr, baseName, deny, kindAllowed, kindWords, obj, PROPOSE_TOOLS, proposalKindOf, str } from '../harness/rules';
import { charterLines } from './parse';
import type { CharterParams, ParamSpec } from './types';

/** A tool call whose verdict under the template's rule is known in advance. */
export interface Probe {
  label: string;
  call: ToolCall;
  ctx?: RuleContext;
  expect: 'allow' | 'deny';
}

/** One use of a template: the charter's role and built-in harness, the line it is mapped from, and the params. */
export interface TemplateUse {
  role: Role;
  base: Harness;
  label: CharterLine;
  text: string;
  params: Record<string, unknown>;
}

export interface RuleTemplate {
  id: string;
  /** The role whose charter may use it, or '*' for any worker agent (a role that proposes). */
  role: Role | '*';
  titlePlain: string;
  params: ParamSpec[];
  /** Problems with this use (params out of range, wrong role); empty when it is valid. */
  problems(use: TemplateUse): string[];
  /** The gate rule; the builder gives it the id and charter line of the line it is mapped from. */
  rule(use: TemplateUse): Pick<Rule, 'check' | 'format' | 'partial'>;
  probes?(use: TemplateUse): Probe[];
  /** A shipped scenario that checks the same line on the ledger, with the variables this use sets. */
  scenario?(use: TemplateUse): { id: string; vars?: Record<string, number> };
  /** A generated scenario (YAML without id, agent or charter_line; the runner fills those from the mapping). */
  scenarioYaml?(use: TemplateUse): string;
  charterParams?(use: TemplateUse): CharterParams;
  /** Narrows the harness's Proposal kinds. */
  kinds?(use: TemplateUse): ProposalKind[];
  /**
   * The shipped rule whose line this template may be mapped onto, for a role (undefined: none for that role). It then
   * runs together with that rule (both must allow), so it can only tighten it; `format` says whether its format line
   * replaces the shipped one in the prompt (a restatement with a higher bar) or is added to it.
   */
  tightens?: { rule(role: Role): string | undefined; format: 'replace' | 'append' };
}

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });
const pct = (bp: number) => `${bp / 100}%`;
/** A whole number from a number or a decimal string; undefined otherwise. */
const intOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : undefined);
/** Minor units from a safe integer or a decimal string; undefined otherwise. */
const minorOf = (v: unknown): bigint | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? BigInt(v.trim()) : undefined);
const unknownParams = (use: TemplateUse, names: string[]) => Object.keys(use.params).filter(k => !names.includes(k)).map(k => `unknown param ${k}`);
const workerOnly = (use: TemplateUse) => (use.base.proposalKinds.length ? [] : [`the ${use.role} agent proposes nothing, so this template does not apply`]);
/** The role's tool for proposing a kind, by its full name; undefined when the role has none. */
const proposeTool = (base: Harness, kind: ProposalKind) => base.tools.find(t => PROPOSE_TOOLS[baseName(t)] === kind);
/** The largest amount a propose call carries: amountMinor, totalMinor, exposureMinor or the sum of its debits. */
function callAmount(call: ToolCall): bigint {
  const debits = arr(call.input.lines).map(obj).reduce((a, l) => a + (minorOf(l.debitMinor) ?? 0n), 0n);
  return [minorOf(call.input.amountMinor), minorOf(call.input.totalMinor), minorOf(call.input.exposureMinor), debits].reduce<bigint>((a, b) => (b !== undefined && b > a ? b : a), 0n);
}
/** The shipped scenario a template drives, with the variables this use sets (TEMPLATE_SCENARIOS in the eval harness). */
const linkedScenario = (id: string) => (use: TemplateUse) => ({ id: TEMPLATE_SCENARIOS[id]!.scenario!, vars: templateVars(id, use.params) });
/** The scenario a template generates from its params (TEMPLATE_SCENARIOS in the eval harness). */
const generatedYaml = (id: string) => (use: TemplateUse) => TEMPLATE_SCENARIOS[id]!.yaml!(use.role, use.params);

// ---- Parameterized templates ----

const batchMinConfidence: RuleTemplate = {
  id: 'batch_min_confidence',
  role: 'bookkeeper',
  titlePlain: 'Batch bank matches only when every match is at least this confident (seventy-five percent or higher)',
  params: [{ name: 'minScoreBp', labelPlain: 'Lowest confidence allowed in a batch', type: 'bp', default: BATCH_MIN_SCORE_BP, min: BATCH_MIN_SCORE_BP, max: 10000 }],
  problems: use => {
    const v = intOf(use.params.minScoreBp);
    return [
      ...unknownParams(use, ['minScoreBp']),
      ...(v === undefined || v < BATCH_MIN_SCORE_BP || v > 10000 ? [`minScoreBp must be a whole number of basis points from ${BATCH_MIN_SCORE_BP} (the shipped ${pct(BATCH_MIN_SCORE_BP)}) to 10000: a charter can only raise the bar; got ${JSON.stringify(use.params.minScoreBp)}`] : []),
    ];
  },
  rule: use => {
    const min = intOf(use.params.minScoreBp)!;
    return {
      check: call => {
        if (baseName(call.tool) !== 'propose_bank_match') return allow;
        const matches = arr(call.input.matches).map(obj);
        if (matches.length < 2) return allow;
        const weak = matches.filter(m => !(Number(m.scoreBp) >= min));
        return weak.length ? deny(`a batch of ${matches.length} matches holds ${weak.length} below ${pct(min)} confidence (${weak.map(m => `${str(m.bankTxId)} at ${Number(m.scoreBp) / 100}%`).join(', ')}); propose each of those on its own`) : allow;
      },
      format: `propose_bank_match with two or more matches: every scoreBp is at least ${min}; propose each weaker match in its own propose_bank_match. A bank transaction in another currency is matched only once a rate for its month is recorded.`,
    };
  },
  probes: use => {
    const min = intOf(use.params.minScoreBp)!;
    const tool = 'mcp__bookkeeper__propose_bank_match';
    const match = (id: string, scoreBp: number) => ({ bankTxId: id, targetKind: 'invoice', targetId: id, scoreBp });
    return [
      { label: `a batch with one match just under ${pct(min)} is refused`, call: { tool, input: { matches: [match('1', min), match('2', min - 1)] } }, expect: 'deny' },
      { label: `a batch with every match at ${pct(min)} is allowed`, call: { tool, input: { matches: [match('1', min), match('2', min)] } }, expect: 'allow' },
      { label: 'a weaker match proposed on its own is allowed', call: { tool, input: { matches: [match('3', Math.max(0, min - 2500))] } }, expect: 'allow' },
    ];
  },
  scenario: linkedScenario('batch_min_confidence'),
  charterParams: use => ({ batchMinScoreBp: intOf(use.params.minScoreBp)! }),
  tightens: { rule: role => (role === 'bookkeeper' ? 'bookkeeper.may.2' : undefined), format: 'replace' },
};

/**
 * Kinds whose amount is in the propose call itself (amountMinor, totalMinor or the lines), so the gate and the eval
 * measure the same thing. A bank match, credit decision, vendor block or vendor check carries no such amount: the module
 * computes it (a bank match's total of what it settles), so a cap cannot be checked on the call.
 */
export const CAPPED_KINDS: readonly ProposalKind[] = SHARED_CAPPED_KINDS;

const maxProposalAmount: RuleTemplate = {
  id: 'max_proposal_amount',
  role: '*',
  titlePlain: 'Never propose a journal entry, accrual, revenue schedule, currency revaluation or elimination larger than this amount; leave it for a person',
  params: [{ name: 'maxMinor', labelPlain: 'Largest amount one such Proposal may carry', type: 'minor', min: 1 }],
  problems: use => {
    const v = minorOf(use.params.maxMinor);
    const capped = use.base.proposalKinds.some(k => CAPPED_KINDS.includes(k));
    return [
      ...unknownParams(use, ['maxMinor']),
      ...workerOnly(use),
      ...(use.base.proposalKinds.length && !capped ? [`the ${use.role} agent proposes none of ${CAPPED_KINDS.map(k => kindWords[k]).join(', ')}, the kinds a cap applies to`] : []),
      ...(v === undefined || v < 1n ? [`maxMinor must be a positive whole number of minor units; got ${JSON.stringify(use.params.maxMinor)}`] : []),
    ];
  },
  rule: use => {
    const max = minorOf(use.params.maxMinor)!;
    return {
      check: call => {
        const kind = proposalKindOf(call);
        if (!kind || !CAPPED_KINDS.includes(kind)) return allow;
        const amount = callAmount(call);
        return amount > max ? deny(`this Proposal carries ${money(amount)}; the charter caps ${kindWords[kind]} at ${money(max)}, so leave it for a person and say so in the close thread`) : allow;
      },
      format: `Never propose a journal entry, accrual, revenue schedule, currency revaluation or elimination of more than ${money(max)} (${max} minor units: amountMinor, totalMinor or the sum of debits); leave anything larger for a person and say so in the close thread.`,
    };
  },
  probes: use => {
    const max = minorOf(use.params.maxMinor)!;
    const kind = use.base.proposalKinds.find(k => CAPPED_KINDS.includes(k));
    const tool = kind && proposeTool(use.base, kind);
    if (!tool) return [];
    const input = (n: bigint) => ({ amountMinor: n.toString(), totalMinor: n.toString(), lines: [{ accountCode: '1000', debitMinor: n.toString(), creditMinor: '0' }, { accountCode: '2000', debitMinor: '0', creditMinor: n.toString() }] });
    const out: Probe[] = [
      { label: `${kindWords[kind!]} one cent over ${money(max)} is refused`, call: { tool, input: input(max + 1n) }, expect: 'deny' },
      { label: `${kindWords[kind!]} of exactly ${money(max)} is allowed`, call: { tool, input: input(max) }, expect: 'allow' },
    ];
    const uncapped = use.base.proposalKinds.find(k => !CAPPED_KINDS.includes(k));
    const other = uncapped && proposeTool(use.base, uncapped);
    if (other) out.push({ label: `${kindWords[uncapped!]} carry no amount of their own and are not capped`, call: { tool: other, input: { exposureMinor: (max + 1n).toString() } }, expect: 'allow' });
    return out;
  },
  scenarioYaml: generatedYaml('max_proposal_amount'),
  charterParams: use => ({ maxProposalMinor: minorOf(use.params.maxMinor)! }),
};

const kindsAllowed: RuleTemplate = {
  id: 'kinds_allowed',
  role: '*',
  titlePlain: 'Propose only these kinds (a narrower list than the agent ships with)',
  params: [{ name: 'kinds', labelPlain: 'Proposal kinds allowed', type: 'kinds', options: Object.keys(kindWords) }],
  problems: use => {
    const kinds = use.params.kinds;
    if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(k => typeof k === 'string')) return [...unknownParams(use, ['kinds']), ...workerOnly(use), 'kinds must be a non-empty list of Proposal kinds'];
    const extra = kinds.filter(k => !use.base.proposalKinds.includes(k as ProposalKind));
    return [...unknownParams(use, ['kinds']), ...workerOnly(use), ...(extra.length ? [`kinds can only narrow what the ${use.role} agent may propose (${use.base.proposalKinds.join(', ')}); not ${extra.join(', ')}`] : [])];
  },
  rule: use => {
    const kinds = use.params.kinds as ProposalKind[];
    return { check: call => kindAllowed(call, kinds), format: `Propose only ${kinds.map(k => kindWords[k]).join(', ')}; any other propose tool is refused.` };
  },
  probes: use => {
    const kinds = use.params.kinds as ProposalKind[];
    const out: Probe[] = [];
    const left = use.base.proposalKinds.find(k => !kinds.includes(k));
    const leftTool = left && proposeTool(use.base, left);
    if (leftTool) out.push({ label: `proposing ${kindWords[left!]} is refused`, call: { tool: leftTool, input: {} }, expect: 'deny' });
    const kept = proposeTool(use.base, kinds[0]!);
    if (kept) out.push({ label: `proposing ${kindWords[kinds[0]!]} is allowed`, call: { tool: kept, input: {} }, expect: 'allow' });
    return out;
  },
  scenarioYaml: generatedYaml('kinds_allowed'),
  kinds: use => use.params.kinds as ProposalKind[],
  tightens: { rule: role => (HARNESSES[role].rules.some(r => r.id === `${role}.may.1`) && HARNESSES[role].proposalKinds.length ? `${role}.may.1` : undefined), format: 'append' },
};

const DIFFERENCE = /\b(differ|difference|disagree|mismatch)/i;

const icDifferenceTolerance: RuleTemplate = {
  id: 'ic_difference_tolerance',
  role: 'consolidation',
  titlePlain: 'Raise an intercompany difference in the close thread when it is larger than this (one dollar or less)',
  params: [{ name: 'toleranceMinor', labelPlain: 'Largest difference left unmentioned', type: 'minor', default: String(IC_DIFFERENCE_TOLERANCE_MINOR), min: 0, max: Number(IC_DIFFERENCE_TOLERANCE_MINOR) }],
  problems: use => {
    const v = minorOf(use.params.toleranceMinor);
    return [
      ...unknownParams(use, ['toleranceMinor']),
      ...(v === undefined || v < 0n || v > IC_DIFFERENCE_TOLERANCE_MINOR ? [`toleranceMinor must be a whole number of minor units from 0 to ${IC_DIFFERENCE_TOLERANCE_MINOR} (the shipped ${money(IC_DIFFERENCE_TOLERANCE_MINOR)}): a charter can only lower the tolerance; got ${JSON.stringify(use.params.toleranceMinor)}`] : []),
    ];
  },
  rule: use => {
    const tol = minorOf(use.params.toleranceMinor)!;
    const abs = (v: bigint) => (v < 0n ? -v : v);
    return {
      check: (call, ctx) => {
        if (baseName(call.tool) !== 'propose_ic_elimination' || !ctx.history) return allow;
        const off = arr(call.input.pairs).map(obj).filter(p => abs(minorOf(p.differenceMinor) ?? 0n) > tol);
        if (!off.length) return allow;
        const thread = `close:${str(call.input.periodYm)}`;
        const raised = ctx.history.some(c => baseName(c.tool) === 'post_message' && str(c.input.threadId) === thread && DIFFERENCE.test(str(c.input.body)));
        return raised ? allow : deny(`${off.map(p => str(p.label) || '?').join(', ')} ${off.length > 1 ? 'differ' : 'differs'} by more than ${money(tol)} between the two companies; say so in ${thread} (post_message naming the difference) before proposing the elimination`);
      },
      format: `Before a propose_ic_elimination with any pair whose |differenceMinor| is over ${tol} (${money(tol)}), post_message to threadId close:YYYY-MM saying the two companies' books differ, naming the pair and the amount.`,
    };
  },
  probes: use => {
    const tol = minorOf(use.params.toleranceMinor)!;
    const tool = 'mcp__consolidation__propose_ic_elimination';
    const input = (diff: bigint) => ({ periodYm: '2026-09', pairs: [{ label: 'Loan', amountMinor: '20000000', counterTranslatedMinor: (20000000n - diff).toString(), differenceMinor: diff.toString() }] });
    const said: ToolCall = { tool: 'mcp__consolidation__post_message', input: { threadId: 'close:2026-09', body: 'The Loan differs between the two companies.' } };
    return [
      { label: `a difference just over ${money(tol)} nobody raised is refused`, call: { tool, input: input(tol + 1n) }, ctx: { history: [] }, expect: 'deny' },
      { label: 'the same difference, once raised in the close thread, is allowed', call: { tool, input: input(tol + 1n) }, ctx: { history: [said] }, expect: 'allow' },
      { label: `a difference of exactly ${money(tol)} needs no message`, call: { tool, input: input(tol) }, ctx: { history: [] }, expect: 'allow' },
    ];
  },
  scenario: linkedScenario('ic_difference_tolerance'),
  charterParams: use => ({ icDifferenceToleranceMinor: minorOf(use.params.toleranceMinor)! }),
  tightens: { rule: role => (role === 'consolidation' ? 'consolidation.escalates.1' : undefined), format: 'replace' },
};

export const PARAM_TEMPLATES: readonly RuleTemplate[] = [batchMinConfidence, maxProposalAmount, kindsAllowed, icDifferenceTolerance];

// ---- Built-in templates: every shipped rule, unchanged ----

const builtinCache = new Map<Role, RuleTemplate[]>();

/** `builtin:<ruleId>` for every rule of the role's shipped harness, titled by the built-in charter line it enforces. */
export function builtinTemplates(role: Role): RuleTemplate[] {
  const hit = builtinCache.get(role);
  if (hit) return hit;
  const h = HARNESSES[role];
  const lines = new Map(charterLines(charterPrompt(h)).map(l => [l.label, l.text]));
  const out = h.rules.map(
    (r): RuleTemplate => ({
      id: `builtin:${r.id}`,
      role,
      titlePlain: `As shipped (${r.charter}): ${lines.get(r.charter) ?? r.format ?? r.id}`,
      params: [],
      problems: use => (Object.keys(use.params).length ? [`builtin:${r.id} takes no params`] : []),
      rule: () => ({ check: r.check, format: r.format, partial: r.partial }),
      ...(r.partial ? { scenario: () => ({ id: r.partial!.scenario.replace(/\.ya?ml$/, '') }) } : {}),
    })
  );
  builtinCache.set(role, out);
  return out;
}

/** Every template, built-in ones for every role first. */
export function allTemplates(): RuleTemplate[] {
  return [...(Object.keys(HARNESSES) as Role[]).flatMap(builtinTemplates), ...PARAM_TEMPLATES];
}

export function templateById(id: string): RuleTemplate | undefined {
  const m = /^builtin:([a-z]+)\./.exec(id);
  if (m) return Object.hasOwn(HARNESSES, m[1]!) ? builtinTemplates(m[1] as Role).find(t => t.id === id) : undefined;
  return PARAM_TEMPLATES.find(t => t.id === id);
}

/** Templates a role's lines may map to: its own built-in rules, its own parameterized templates, and the '*' ones. */
export const templatesFor = (role: Role) => [...builtinTemplates(role), ...PARAM_TEMPLATES.filter(t => t.role === role || t.role === '*')];

/** Whether a probe's verdict under a rule is the expected one, with the rule's reason when it denied. */
export function runProbe(rule: Pick<Rule, 'check'>, probe: Probe): { pass: boolean; detail: string } {
  const v = rule.check(probe.call, probe.ctx ?? {});
  const got = v.allow ? 'allow' : 'deny';
  return { pass: got === probe.expect, detail: `expected ${probe.expect}, got ${got}${v.allow ? '' : `: ${v.reason}`}` };
}
