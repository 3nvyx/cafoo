import { describe, expect, it } from 'vitest';
import type { HookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { agentPrompt, charterPrompt, gateFormats, harnessFor, HARNESSES, modelFor } from '../src/harness';
import { harnessGate, serverGate } from '../src/harness/hook';

let useId = 0;
const pre = (tool_name: string, tool_input: Record<string, unknown>, agent?: string): PreToolUseHookInput => ({
  hook_event_name: 'PreToolUse',
  session_id: 's',
  transcript_path: '/dev/null',
  cwd: '/',
  tool_name,
  tool_input,
  tool_use_id: `t${++useId}`,
  ...(agent ? { agent_type: agent, agent_id: `${agent}-1` } : {}),
});
const run = (gate: ReturnType<typeof harnessGate>, input: HookInput) => gate(input, 'tool_use_id' in input ? input.tool_use_id : 't', { signal: new AbortController().signal });
type Outcome = 'ok' | 'isError' | 'failure';
/** A whole tool call through the gate: PreToolUse, then (if allowed) the result event for `outcome`. */
async function complete(gate: ReturnType<typeof harnessGate>, input: PreToolUseHookInput, outcome: Outcome = 'ok') {
  const out = await run(gate, input);
  if (reasonOf(out)?.permissionDecision === 'deny') return out;
  const { hook_event_name: _e, ...base } = input;
  await run(
    gate,
    outcome === 'failure'
      ? { ...base, hook_event_name: 'PostToolUseFailure', error: 'reducer refused' }
      : { ...base, hook_event_name: 'PostToolUse', tool_response: outcome === 'ok' ? { content: [{ type: 'text', text: 'ok' }] } : { content: [{ type: 'text', text: 'invalid id' }], isError: true } }
  );
  return out;
}
const reasonOf = (out: unknown) => (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
const ruling = { proposalId: '12', rationale: 'Reviewed the evidence; the match is one to one and the amounts agree.', summaryPlain: 'Approved: the payment clearly settles the invoice.' };

describe('server gate (kept from the inline roleGate)', () => {
  it('keeps workers off the advisor server and off each other', () => {
    expect(serverGate('mcp__advisor__approve_proposal', 'bookkeeper')).toBe('Only the Advisor may use advisor tools; you are bookkeeper.');
    expect(serverGate('mcp__credit__propose_vendor_block', 'revenue')).toBe('Only the credit agent may use credit tools; you are revenue.');
    expect(serverGate('mcp__bookkeeper__propose_bank_match', undefined)).toBe('Only the bookkeeper agent may use bookkeeper tools.');
    expect(serverGate('mcp__books__close_snapshot', 'credit')).toBeUndefined();
  });
});

describe('harnessGate', () => {
  it('allows a clean call and denies with the rule id and reason', async () => {
    const gate = harnessGate();
    expect(await run(gate, pre('mcp__books__close_snapshot', { periodYm: '2026-09' }, 'bookkeeper'))).toEqual({});
    const out = reasonOf(await run(gate, pre('mcp__bookkeeper__update_close_task', { taskId: '1', status: 'done', note: 'x' }, 'bookkeeper')));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/^Denied by the bookkeeper harness: bookkeeper\.never\.2 \(Must never 2\): only the Advisor or the CFO marks a close task done/);
  });

  it('runs the cross-role gate first', async () => {
    const out = reasonOf(await run(harnessGate(), pre('mcp__advisor__approve_proposal', ruling, 'credit')));
    expect(out?.permissionDecisionReason).toBe('Only the Advisor may use advisor tools; you are credit.');
  });

  it('treats the root query as the Advisor and keeps it off worker tools it does not list', async () => {
    expect(await run(harnessGate(), pre('mcp__advisor__approve_proposal', ruling))).toEqual({});
    const out = reasonOf(await run(harnessGate(), pre('mcp__crs__crs_cascade', { personaId: 'P01', subjectKind: 'customer_guarantor' })));
    expect(out?.permissionDecisionReason).toMatch(/advisor\.tools/);
  });

  it('denies agent types that have no harness', async () => {
    const out = reasonOf(await run(harnessGate(), pre('mcp__books__close_snapshot', { periodYm: '2026-09' }, 'general-purpose')));
    expect(out?.permissionDecisionReason).toMatch(/No harness for agent type general-purpose/);
  });

  it('fails closed when the context throws', async () => {
    const gate = harnessGate({
      context: () => {
        throw new Error('cache gone');
      },
      onDeny: () => {
        throw new Error('reporter broken');
      },
    });
    const out = reasonOf(await run(gate, pre('mcp__books__close_snapshot', { periodYm: '2026-09' }, 'bookkeeper')));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/could not judge this call \(cache gone\)/);
  });

  it('shares history across runs of the same role, so a credit decision can cite checks from an earlier run', async () => {
    const gate = harnessGate();
    const check = (product: string, requestId: string) => ({ subjectKind: 'customer', subjectId: '7', personaId: 'P03', product, requestId, summaryJson: JSON.stringify({ requestId }), tier: 'C', decision: 'REVIEW' });
    const first = (input: Record<string, unknown>) => ({ ...pre('mcp__credit__record_credit_check', input, 'credit'), agent_id: 'credit-1' });
    expect(await complete(gate, first(check('tu_identity_verification', 'R-1')))).toEqual({});
    expect(await complete(gate, first(check('fraud_finder', 'R-2')))).toEqual({});
    const decision = { periodYm: '2026-09', rationale: 'Tier C from a thin file.', summaryPlain: 'Shorten the customer\'s payment terms to fifteen days.', customerId: '7', tier: 'C', paymentTermsDays: 15, creditCheckRequestIds: ['R-1', 'R-2'] };
    expect(await complete(gate, { ...pre('mcp__credit__propose_credit_decision', decision, 'credit'), agent_id: 'credit-2' })).toEqual({});
    const out = reasonOf(await complete(gate, pre('mcp__credit__propose_credit_decision', { ...decision, creditCheckRequestIds: ['R-3'] }, 'credit')));
    expect(out?.permissionDecisionReason).toMatch(/credit\.never\.2.*not recorded: R-3/);
  });

  it('remembers allowed rulings, so a second ruling on one Proposal is denied when its status is unknown', async () => {
    const denied: string[] = [];
    const gate = harnessGate({ onDeny: (_a, _t, why) => denied.push(why) });
    expect(await complete(gate, pre('mcp__advisor__approve_proposal', ruling))).toEqual({});
    const out = reasonOf(await complete(gate, pre('mcp__advisor__reject_proposal', ruling)));
    expect(out?.permissionDecisionReason).toMatch(/advisor\.never\.4/);
    expect(denied).toHaveLength(1);
  });

  it('prefers the live Proposal status from context over its own history', async () => {
    let status = 'Open';
    const gate = harnessGate({ context: () => ({ proposalStatus: () => status }) });
    expect(await complete(gate, pre('mcp__advisor__approve_proposal', ruling))).toEqual({});
    status = 'SentBack';
    expect(await complete(gate, pre('mcp__advisor__approve_proposal', ruling))).toEqual({});
    status = 'Approved';
    expect(reasonOf(await complete(gate, pre('mcp__advisor__approve_proposal', ruling)))?.permissionDecision).toBe('deny');
  });

  it('learns only from calls that succeeded in the tool', async () => {
    const gate = harnessGate();
    const check = (product: string, requestId: string) => ({ subjectKind: 'customer', subjectId: '7', personaId: 'P03', product, requestId, summaryJson: JSON.stringify({ requestId }), tier: 'C', decision: 'REVIEW' });
    expect(await complete(gate, pre('mcp__credit__record_credit_check', check('tu_identity_verification', 'R-1'), 'credit'))).toEqual({});
    expect(await complete(gate, pre('mcp__credit__record_credit_check', check('fraud_finder', 'R-2'), 'credit'), 'failure')).toEqual({});
    expect(await complete(gate, pre('mcp__credit__record_credit_check', check('fraud_finder', 'R-3'), 'credit'), 'isError')).toEqual({});
    // Allowed but never answered: not history either.
    expect(await run(gate, pre('mcp__credit__record_credit_check', check('fraud_finder', 'R-4'), 'credit'))).toEqual({});
    const decision = { periodYm: '2026-09', rationale: 'Tier C from a thin file.', summaryPlain: 'Shorten the customer\'s payment terms to fifteen days.', customerId: '7', tier: 'C', paymentTermsDays: 15 };
    for (const id of ['R-2', 'R-3', 'R-4']) {
      const out = reasonOf(await run(gate, pre('mcp__credit__propose_credit_decision', { ...decision, creditCheckRequestIds: ['R-1', id] }, 'credit')));
      expect(out?.permissionDecisionReason).toMatch(new RegExp(`not recorded: ${id}`));
    }
    // Leading zeros name the same customer.
    expect(reasonOf(await run(gate, pre('mcp__credit__propose_credit_decision', { ...decision, customerId: '07', creditCheckRequestIds: ['R-1'] }, 'credit')))?.permissionDecisionReason).toMatch(/missing fraud_finder for customer 7/);
  });

  it('passes account codes from context to the Plain summary rule', async () => {
    const gate = harnessGate({ context: () => ({ accountCodes: ['1000', '6000'] }) });
    const input = { threadId: 'close:2026-09', body: 'Matching the feed now.', summaryPlain: 'Started on the 2026 bank feed.' };
    expect(await run(gate, pre('mcp__bookkeeper__post_message', input, 'bookkeeper'))).toEqual({});
    const out = reasonOf(await run(gate, pre('mcp__bookkeeper__post_message', { ...input, summaryPlain: 'Moved fees to 6000.' }, 'bookkeeper')));
    expect(out?.permissionDecisionReason).toMatch(/bookkeeper\.plain.*account code 6000/);
  });
});

describe('registry', () => {
  it('maps agent types to harnesses', () => {
    expect(harnessFor(undefined)).toBe(HARNESSES.advisor);
    expect(harnessFor('revenue')).toBe(HARNESSES.revenue);
    expect(harnessFor('toString')).toBeUndefined();
  });
  it('loads the charter as the prompt and falls back when the file is missing', () => {
    expect(charterPrompt(HARNESSES.bookkeeper)).toMatch(/^# Bookkeeper charter/);
    expect(charterPrompt(HARNESSES.bookkeeper, '/nonexistent')).toBe(HARNESSES.bookkeeper.fallbackPrompt);
  });
  it('tells each agent the formats its gate checks, after the charter', () => {
    const credit = agentPrompt(HARNESSES.credit);
    expect(credit.indexOf('# Credit & Risk charter')).toBe(0);
    expect(credit).toMatch(/## Formats the gate checks[\s\S]*Allowance for doubtful accounts[\s\S]*summaryJson[\s\S]*creditCheckRequestIds/);
    expect(agentPrompt(HARNESSES.bookkeeper)).toMatch(/"Duplicate payment".*1250.*1000[\s\S]*"bill <externalRef>"|"bill <externalRef>"[\s\S]*"Duplicate payment".*1250.*1000/);
    for (const h of Object.values(HARNESSES)) {
      for (const r of h.rules) if (r.format) expect(gateFormats(h), r.id).toContain(`(${r.id})`);
    }
    // The plain-summary format lists every jargon word the rule checks, and the bare-number check.
    const plain = gateFormats(HARNESSES.credit);
    for (const w of ['debited', 'accrue', 'ECL', 'ASC 606', 'tradelines', 'BLJ', 'PitchPoint', 'risk.score']) expect(plain).toContain(w);
    expect(plain).toContain('no bare numbers of 4 or more digits except years and ids like INV-1042');
  });
  it('puts the operating instructions before the charter when asked, and falls back without the charter file', () => {
    const red = agentPrompt(HARNESSES.redteam, { withInstructions: true });
    expect(red.startsWith(HARNESSES.redteam.fallbackPrompt)).toBe(true);
    expect(red).toContain('# Red Team charter');
    expect(agentPrompt(HARNESSES.redteam, { withInstructions: true, dir: '/nonexistent' }).split(HARNESSES.redteam.fallbackPrompt)).toHaveLength(2);
  });
  it('reads the model from the harness env var with its default', () => {
    expect(modelFor(HARNESSES.advisor, {})).toBe('opus');
    expect(modelFor(HARNESSES.credit, { WORKER_MODEL: 'haiku' })).toBe('haiku');
    expect(modelFor(HARNESSES.redteam, {})).toBe('grok-4.7');
  });
});
