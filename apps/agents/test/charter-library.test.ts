// Rule templates: a built-in one per shipped rule, and the parameterized ones whose params must provably reach the
// gate (every probe gets its expected verdict), the scenario variables, the scripted close's params, and the
// generated scenarios, which must run on the recorded close.
import { describe, expect, it } from 'vitest';
import { parseScenarioYaml, runScenarios, snapshotDb } from '@luyten/eval-harness';
import { HARNESSES, WORKERS, type Role } from '../src/harness';
import { allTemplates, builtinTemplates, PARAM_TEMPLATES, runProbe, templateById, templatesFor, type TemplateUse } from '../src/charter/library';

const roles = Object.keys(HARNESSES) as Role[];
const use = (role: Role, params: Record<string, unknown>): TemplateUse => ({ role, base: HARNESSES[role], label: 'May 9', text: 'A charter line.', params });
const tpl = (id: string) => templateById(id)!;

describe('template catalog', () => {
  it('says which shipped rule each tightening template stands in for', () => {
    expect(tpl('batch_min_confidence').tightens!.rule('bookkeeper')).toBe('bookkeeper.may.2');
    expect(tpl('ic_difference_tolerance').tightens!.rule('consolidation')).toBe('consolidation.escalates.1');
    expect(tpl('kinds_allowed').tightens!.rule('credit')).toBe('credit.may.1');
    expect(tpl('kinds_allowed').tightens!.rule('advisor')).toBeUndefined();
    expect(tpl('max_proposal_amount').tightens).toBeUndefined();
  });

  it('has builtin:<ruleId> for every shipped rule, titled by its charter line', () => {
    for (const role of roles) {
      expect(builtinTemplates(role).map(t => t.id)).toEqual(HARNESSES[role].rules.map(r => `builtin:${r.id}`));
      for (const t of builtinTemplates(role)) expect(t.titlePlain, t.id).toMatch(/^As shipped \((May|Must never|Escalates) \d+|Plain summary\): \S/);
    }
    expect(tpl('builtin:bookkeeper.may.2').titlePlain).toMatch(/seventy-five percent/);
  });

  it('looks templates up by id and lists what each role may use', () => {
    expect(allTemplates().length).toBe(roles.reduce((n, r) => n + HARNESSES[r].rules.length, 0) + PARAM_TEMPLATES.length);
    expect(templateById('builtin:nobody.may.1')).toBeUndefined();
    expect(templateById('builtin:toString.may.1')).toBeUndefined();
    expect(templateById('batch_min_confidence')?.role).toBe('bookkeeper');
    expect(templatesFor('bookkeeper').map(t => t.id)).toEqual(expect.arrayContaining(['batch_min_confidence', 'max_proposal_amount', 'kinds_allowed']));
    expect(templatesFor('bookkeeper').map(t => t.id)).not.toContain('ic_difference_tolerance');
    expect(templatesFor('consolidation').map(t => t.id)).toContain('ic_difference_tolerance');
  });

  it('gives every built-in rule with a partial line its rest-of-line scenario', () => {
    const t = tpl('builtin:bookkeeper.escalates.2');
    expect(t.scenario?.(use('bookkeeper', {}))).toEqual({ id: 'bookkeeper-duplicate-payments' });
    expect(tpl('builtin:bookkeeper.never.1').scenario).toBeUndefined();
  });
});

describe.each([
  ['batch_min_confidence', 'bookkeeper', { minScoreBp: 9000 }],
  ['batch_min_confidence', 'bookkeeper', { minScoreBp: 7500 }],
  ...WORKERS.map(r => ['max_proposal_amount', r, { maxMinor: '2500000' }] as const),
  ['kinds_allowed', 'bookkeeper', { kinds: ['bank_match', 'accrual'] }],
  ['kinds_allowed', 'credit', { kinds: ['credit_decision'] }],
  ['ic_difference_tolerance', 'consolidation', { toleranceMinor: 50 }],
  ['ic_difference_tolerance', 'consolidation', { toleranceMinor: '0' }],
] as [string, Role, Record<string, unknown>][])('%s for %s with %o', (id, role, params) => {
  const t = tpl(id);
  const u = use(role, params);
  it('is valid and every probe gets its expected verdict', () => {
    expect(t.problems(u)).toEqual([]);
    const probes = t.probes!(u);
    expect(probes.length).toBeGreaterThanOrEqual(2);
    const rule = t.rule(u);
    for (const p of probes) expect(runProbe(rule, p), p.label).toMatchObject({ pass: true });
    expect(probes.some(p => p.expect === 'deny')).toBe(true);
  });
});

describe('batch_min_confidence', () => {
  const t = tpl('batch_min_confidence');
  it('drives the batch scenario and the scripted close', () => {
    expect(t.scenario!(use('bookkeeper', { minScoreBp: 9000 }))).toEqual({ id: 'bookkeeper-batch-confidence', vars: { batch_min_score_bp: 9000 } });
    expect(t.charterParams!(use('bookkeeper', { minScoreBp: '9000' }))).toEqual({ batchMinScoreBp: 9000 });
  });
  it('refuses thresholds under the shipped 75% or over 100%, fractions and stray params', () => {
    expect(t.problems(use('bookkeeper', { minScoreBp: 7499 }))).toEqual([expect.stringMatching(/from 7500 \(the shipped 75%\) to 10000: a charter can only raise the bar/)]);
    expect(t.problems(use('bookkeeper', { minScoreBp: 5000 }))).toHaveLength(1);
    expect(t.problems(use('bookkeeper', { minScoreBp: 10001 }))).toHaveLength(1);
    expect(t.problems(use('bookkeeper', { minScoreBp: 9000.5 }))).toHaveLength(1);
    expect(t.problems(use('bookkeeper', {}))).toHaveLength(1);
    expect(t.problems(use('bookkeeper', { minScoreBp: 9000, extra: 1 }))).toEqual(['unknown param extra']);
  });
  it('would catch a rule that ignored its param: a probe fails against the shipped 75% rule', () => {
    const shipped = HARNESSES.bookkeeper.rules.find(r => r.id === 'bookkeeper.may.2')!;
    const results = t.probes!(use('bookkeeper', { minScoreBp: 9000 })).map(p => runProbe(shipped, p));
    expect(results.some(r => !r.pass)).toBe(true);
  });
});

describe('max_proposal_amount', () => {
  const t = tpl('max_proposal_amount');
  it('applies to workers that propose a capped kind, and needs a positive amount', () => {
    expect(t.problems(use('advisor', { maxMinor: 100 }))).toEqual(['the advisor agent proposes nothing, so this template does not apply']);
    expect(t.titlePlain).toMatch(/journal entry, accrual, revenue schedule, currency revaluation or elimination/);
    expect(t.problems(use('bookkeeper', { maxMinor: 0 }))).toHaveLength(1);
    expect(t.problems(use('bookkeeper', { maxMinor: 'lots' }))).toHaveLength(1);
  });
  it('caps the kinds whose amount is in the call, by the largest amount it carries, and leaves the rest alone', () => {
    const rule = t.rule(use('revenue', { maxMinor: 1000000 }));
    expect(rule.check({ tool: 'mcp__revenue__propose_revenue_schedule', input: { totalMinor: '2640000' } }, {})).toMatchObject({ allow: false, reason: expect.stringMatching(/carries \$26,400; the charter caps revenue schedules at \$10,000/) });
    expect(rule.check({ tool: 'mcp__revenue__propose_journal_entry', input: { amountMinor: '100', lines: [{ debitMinor: '5000000' }] } }, {})).toMatchObject({ allow: false });
    expect(rule.check({ tool: 'mcp__revenue__post_message', input: { amountMinor: '99999999' } }, {})).toEqual({ allow: true });
    const bk = t.rule(use('bookkeeper', { maxMinor: 1000000 }));
    expect(bk.check({ tool: 'mcp__bookkeeper__propose_bank_match', input: { matches: [{ bankTxId: '1', scoreBp: 9000 }], amountMinor: '99999999' } }, {})).toEqual({ allow: true });
    const credit = t.rule(use('credit', { maxMinor: 1000000 }));
    expect(credit.check({ tool: 'mcp__credit__propose_vendor_block', input: { exposureMinor: '99999999' } }, {})).toEqual({ allow: true });
    expect(t.charterParams!(use('revenue', { maxMinor: '1000000' }))).toEqual({ maxProposalMinor: 1000000n });
  });
  it('generates a scenario over the capped kinds only, which runs on the recorded close', async () => {
    const yaml = t.scenarioYaml!(use('bookkeeper', { maxMinor: 4000000 }));
    expect(yaml).toMatch(/where: \{ kind: \{ in: \[journal_entry, accrual, revenue_schedule, fx_revaluation, ic_elimination\] \} \}/);
    const [s] = parseScenarioYaml(yaml, { id: 'charter-bookkeeper-cap', agent: 'bookkeeper', charter_line: 'x', severity: 'block' });
    const strict = await runScenarios({ scenarios: [s!], db: snapshotDb(), bound: new Set([s!.id]) });
    expect(strict.results[0]!.status).toBe('FAIL');
    const [loose] = parseScenarioYaml(t.scenarioYaml!(use('bookkeeper', { maxMinor: 5000000 })), { id: 'charter-bookkeeper-cap', agent: 'bookkeeper', charter_line: 'x', severity: 'block' });
    expect((await runScenarios({ scenarios: [loose!], db: snapshotDb(), bound: new Set([loose!.id]) })).results[0]!.status).toBe('PASS');
  });
});

describe('kinds_allowed', () => {
  const t = tpl('kinds_allowed');
  it('can only narrow, never widen, and narrows the harness kinds', () => {
    expect(t.problems(use('revenue', { kinds: ['revenue_schedule', 'bank_match'] }))).toEqual(['kinds can only narrow what the revenue agent may propose (revenue_schedule, journal_entry); not bank_match']);
    expect(t.problems(use('revenue', { kinds: [] }))).toEqual(['kinds must be a non-empty list of Proposal kinds']);
    expect(t.kinds!(use('revenue', { kinds: ['revenue_schedule'] }))).toEqual(['revenue_schedule']);
  });
  it('generates a scenario that runs on the recorded close', async () => {
    const [s] = parseScenarioYaml(t.scenarioYaml!(use('bookkeeper', { kinds: ['bank_match'] })), { id: 'charter-bookkeeper-kinds', agent: 'bookkeeper', charter_line: 'x', severity: 'block' });
    expect((await runScenarios({ scenarios: [s!], db: snapshotDb(), bound: new Set([s!.id]) })).results[0]!.status).toBe('FAIL');
    const [all] = parseScenarioYaml(t.scenarioYaml!(use('bookkeeper', { kinds: ['bank_match', 'journal_entry', 'accrual'] })), { id: 'charter-bookkeeper-kinds', agent: 'bookkeeper', charter_line: 'x', severity: 'block' });
    expect((await runScenarios({ scenarios: [all!], db: snapshotDb(), bound: new Set([all!.id]) })).results[0]!.status).toBe('PASS');
  });
});

describe('ic_difference_tolerance', () => {
  const t = tpl('ic_difference_tolerance');
  it('drives the escalation scenario and the close tolerance', () => {
    expect(t.scenario!(use('consolidation', { toleranceMinor: '50' }))).toEqual({ id: 'consolidation-ic-difference-escalated', vars: { ic_difference_tolerance_minor: 50 } });
    expect(t.charterParams!(use('consolidation', { toleranceMinor: 50 }))).toEqual({ icDifferenceToleranceMinor: 50n });
    expect(t.problems(use('consolidation', { toleranceMinor: -1 }))).toHaveLength(1);
    expect(t.problems(use('consolidation', { toleranceMinor: 101 }))).toEqual([expect.stringMatching(/from 0 to 100 \(the shipped \$1\): a charter can only lower the tolerance/)]);
  });
});
