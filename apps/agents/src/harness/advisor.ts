/** Advisor harness: the root query. Rules each open Proposal once, with both explanations, and asks the CFO to lock. */
import { PLAIN_RULE, ADVISOR_TOOLS, BOOKS_TOOLS, allow, baseName, deny, isRuled, mcp, obj, plainSummaryRule, rule, str } from './rules';
import type { Harness } from './types';

const RULINGS = new Set(['approve_proposal', 'reject_proposal']);

export const advisor: Harness = {
  role: 'advisor',
  charterFile: 'advisor.md',
  fallbackPrompt: `You are the Chief Finance Advisor of Cafoo Inc. You run the month-end close by delegating to the bookkeeper, revenue, and credit subagents (use the Agent tool, one at a time or in parallel, and wait for each report). You are the only agent that approves or rejects proposals. Read every proposal with list_proposals, weigh the Red Team critiques, and rule on each one with a technical rationale and a plain summary. Amounts at or above the materiality threshold wait for the CFO automatically. When every proposal is decided, mark the close tasks done and call request_period_lock; never lock yourself. ${PLAIN_RULE}`,
  model: { env: 'ADVISOR_MODEL', default: 'opus' },
  tools: ['Agent', 'SendMessage', ...mcp('advisor', ADVISOR_TOOLS), ...mcp('books', BOOKS_TOOLS)],
  proposalKinds: [],
  // No turn cap: the close is bounded by CLOSE_BUDGET_USD instead.
  maxTurns: undefined,
  rules: [
    rule('advisor.may.1', 'May 1', call => {
      if (!RULINGS.has(baseName(call.tool))) return allow;
      if (!/^\d+$/.test(str(call.input.proposalId))) return deny(`rule on a Proposal by its id; got "${str(call.input.proposalId)}"`);
      const amended = call.input.amendedPayloadJson;
      if (amended === undefined || amended === null || amended === '') return allow;
      try {
        const payload: unknown = JSON.parse(str(amended));
        return Object.keys(obj(payload)).length ? allow : deny('amendedPayloadJson must be the amended Proposal payload as a JSON object');
      } catch {
        return deny('amendedPayloadJson must be the amended Proposal payload as a JSON object');
      }
    }, {
      format: 'approve_proposal and reject_proposal take the numeric proposalId; an amendment is approve_proposal with amendedPayloadJson as a JSON object.',
      partial: { scenario: 'advisor-only-approver.yaml', rest: 'no other identity ever rules (the worker and Red Team harnesses and the reducers deny it)' },
    }),
    rule('advisor.never.1', 'Must never 1', call => {
      const name = baseName(call.tool);
      if (!RULINGS.has(name) && name !== 'post_ruling') return allow;
      const plain = str(call.input.summaryPlain).trim();
      const technical = str(name === 'post_ruling' ? call.input.body : call.input.rationale).trim();
      if (plain.length < 10) return deny('write a plain summary (at least 10 characters) for every ruling');
      if (technical.length < 20) return deny(`write a technical ${name === 'post_ruling' ? 'body' : 'rationale'} (at least 20 characters) for every ruling`);
      if (technical === plain) return deny('the technical rationale must differ from the plain summary');
      return allow;
    }, { format: 'Every ruling has summaryPlain of at least 10 characters and a technical rationale (post_ruling: body) of at least 20, different from each other.' }),
    rule('advisor.never.3', 'Must never 3', call => {
      const name = baseName(call.tool);
      return /lock/.test(name) && name !== 'request_period_lock' ? deny(`${name} locks a period; ask the CFO with request_period_lock, never lock`) : allow;
    }, { format: 'Ask the CFO to lock with request_period_lock; never call any other lock tool.' }),
    rule('advisor.never.4', 'Must never 4', (call, ctx) => {
      if (!RULINGS.has(baseName(call.tool))) return allow;
      const id = str(call.input.proposalId);
      const status = ctx.proposalStatus?.(id);
      if (status !== undefined) return isRuled(status) ? deny(`Proposal ${id} is already ruled (${status}); rule again only after the CFO sends it back`) : allow;
      // Status unknown: fall back to this run's own record.
      const ruledBefore = ctx.history?.some(c => RULINGS.has(baseName(c.tool)) && str(c.input.proposalId) === id);
      return ruledBefore ? deny(`already ruled on Proposal ${id} in this run; rule again only after the CFO sends it back`) : allow;
    }, { format: 'Rule once per Proposal: only Open or SentBack Proposals can be ruled.' }),
    plainSummaryRule('advisor.plain'),
  ],
  evalOnly: [
    { charter: 'May 2', scenario: 'advisor-done-tasks.yaml', why: "whether a task's evidence Proposals are all ruled is ledger state across many Proposals" },
    { charter: 'May 3', scenario: 'advisor-grants-roles.yaml', why: 'role grants go through the module directly; no agent tool grants roles' },
    { charter: 'Must never 2', scenario: 'advisor-never-posts-material.yaml', why: "the Proposal's amount and the Materiality threshold are ledger state; the approval reducer holds material rulings for the CFO" },
    { charter: 'Escalates 1', scenario: 'advisor-material-waits.yaml', why: 'the approval reducer decides post-now or wait-for-CFO from ledger state' },
    { charter: 'Escalates 2', scenario: 'advisor-close-task-evidence.yaml', why: 'task evidence links are written by the module across the close' },
    { charter: 'Escalates 3', scenario: 'advisor-lock-only-when-decided.yaml', why: 'whether any Proposal of the month is still undecided is ledger state; request_period_lock also refuses in the reducer' },
  ],
};
