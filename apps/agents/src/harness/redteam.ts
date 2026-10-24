/** Red Team harness: critiques on open Proposals only, on a second model vendor (Grok through the Vercel AI SDK). */
import { REDTEAM_TOOLS, allow, baseName, deny, isRuled, noPosting, plainSummaryRule, rule, statusKey, str } from './rules';
import type { Harness } from './types';

export const redteam: Harness = {
  role: 'redteam',
  charterFile: 'redteam.md',
  fallbackPrompt: `You are the Red Team of a finance close. A worker agent proposed a change to the books; the Chief Finance Advisor will rule next. Your job is to find what is wrong or unverified: weak evidence, wrong account, wrong period, double counting, an assumed rate, a single data source. Be specific and short (under 90 words). Use search_policies for the house accounting policy. If the proposal is sound, say so in one sentence and name the one check you would still make. Always finish by calling submit_critique with a technical body and a one-sentence plain summary for a non-technical CFO (no account codes).`,
  model: { env: 'REDTEAM_MODEL', default: 'grok-4.7' },
  tools: REDTEAM_TOOLS,
  proposalKinds: [],
  maxTurns: 6,
  rules: [
    rule('redteam.may.1', 'May 1', (call, ctx) => {
      if (baseName(call.tool) !== 'submit_critique') return allow;
      const id = str(call.input.proposalId);
      if (!/^\d+$/.test(id)) return deny('a critique is attached to one Proposal (proposalId)');
      const status = ctx.proposalStatus?.(id);
      return status === undefined || statusKey(status) === 'open' ? allow : deny(`Proposal ${id} is ${status}, not open`);
    }, { format: 'submit_critique only for the Open Proposal you were given.' }),
    rule('redteam.never.1', 'Must never 1', call => {
      const name = baseName(call.tool);
      return name.startsWith('propose_') || ['approve_proposal', 'reject_proposal', 'post_ruling', 'request_period_lock'].includes(name) ? deny(`${name} proposes or rules; the Red Team critiques only`) : allow;
    }, { format: 'Critique only: never propose or rule.' }),
    noPosting('redteam.never.2', 'Must never 2'),
    rule('redteam.never.3', 'Must never 3', (call, ctx) => {
      if (baseName(call.tool) !== 'submit_critique') return allow;
      const status = ctx.proposalStatus?.(str(call.input.proposalId));
      return isRuled(status) ? deny(`the Advisor has already ruled on Proposal ${str(call.input.proposalId)} (${status}); a late critique cannot change the outcome`) : allow;
    }, { format: 'Once the Advisor has ruled, stop: a late critique is refused.' }),
    plainSummaryRule('redteam.plain'),
  ],
  evalOnly: [
    { charter: 'Escalates 1', scenario: 'redteam-challenges-weak-matches.yaml', why: 'a duty to critique every weak match, checked across the close; no single call shows a missing critique' },
    { charter: 'Escalates 2', scenario: 'redteam-challenges-material-reserves.yaml', why: 'a duty to critique every material reserve, checked across the close; no single call shows a missing critique' },
  ],
};
