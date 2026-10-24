import { describe, expect, it } from 'vitest';
import { checkCall, HARNESSES } from '../src/harness';
import { call, ruleSuite } from './helpers';

const h = HARNESSES.advisor;
const approve = (input: Record<string, unknown> = {}) =>
  call('mcp__advisor__approve_proposal', {
    proposalId: '12',
    rationale: 'Reserve approved at the tier rate; the open balance excludes invoices matched earlier in this close.',
    summaryPlain: 'Approved: set aside forty-eight thousand dollars; the CFO gets the final say because it is large.',
    ...input,
  });
const reject = (id = '12') => call('mcp__advisor__reject_proposal', { proposalId: id, rationale: 'At 61% confidence this match is a guess; leave it unmatched.', summaryPlain: 'Not matching this one yet; we will ask the customer what the payment was for.' });
const status = (s: string | undefined) => ({ proposalStatus: () => s });

ruleSuite(h, {
  'advisor.may.1': {
    allow: [{ call: approve() }, { call: approve({ amendedPayloadJson: JSON.stringify({ matches: [{ bankTxId: '1', targetKind: 'invoice', targetId: '2', scoreBp: 9000 }] }) }) }, { call: reject() }],
    deny: [
      { call: approve({ proposalId: 'the big reserve' }), why: /by its id/ },
      { call: approve({ amendedPayloadJson: '{oops' }), why: /JSON object/ },
      { call: approve({ amendedPayloadJson: '[]' }), why: /JSON object/ },
    ],
  },
  'advisor.never.1': {
    allow: [{ call: approve() }, { call: call('mcp__advisor__post_ruling', { threadId: 'close:2026-09', body: 'All bank matches above 75% are approved; two weak ones rejected.', summaryPlain: 'The Advisor approved the clear matches.' }) }],
    deny: [
      { call: approve({ summaryPlain: 'OK' }), why: /plain summary/ },
      { call: approve({ rationale: 'fine' }), why: /technical rationale/ },
      { call: approve({ rationale: 'Approved as proposed, nothing to add.', summaryPlain: 'Approved as proposed, nothing to add.' }), why: /must differ/ },
      { call: call('mcp__advisor__post_ruling', { threadId: 'close:2026-09', body: 'ok', summaryPlain: 'The Advisor approved the clear matches.' }), why: /technical body/ },
    ],
  },
  'advisor.never.3': {
    allow: [{ call: call('mcp__advisor__request_period_lock', { periodYm: '2026-09', rationale: 'All proposals are decided.', summaryPlain: 'September is ready to lock.' }) }],
    deny: [
      { call: call('mcp__advisor__lock_period', { periodYm: '2026-09' }), why: /never lock/ },
      { call: call('mcp__advisor__confirm_period_lock', { periodYm: '2026-09' }), why: /never lock/ },
    ],
  },
  'advisor.never.4': {
    allow: [
      { call: approve(), ctx: status('Open') },
      { call: approve(), ctx: status('SentBack') },
      { call: approve(), ctx: { proposalStatus: () => undefined, history: [reject('11')] } },
      // A recorded ruling that the CFO since sent back: the live status wins over history.
      { call: approve(), ctx: { ...status('SentBack'), history: [approve()] } },
    ],
    deny: [
      { call: approve(), ctx: status('Approved'), why: /already ruled \(Approved\)/ },
      { call: reject(), ctx: status('AwaitingCfo'), why: /already ruled/ },
      { call: reject(), ctx: { history: [approve()] }, why: /in this run/ },
    ],
  },
  'advisor.plain': {
    allow: [{ call: approve() }],
    deny: [{ call: approve({ summaryPlain: 'Approved: post 4800000 to 1150.' }), why: /account code 1150.*raw number "4800000"/ }],
  },
});

describe('advisor harness as a whole', () => {
  it('lets a clean ruling and the lock request through', () => {
    expect(checkCall(h, approve(), status('Open'))).toEqual({ allow: true });
    expect(checkCall(h, call('mcp__advisor__request_period_lock', { periodYm: '2026-09', rationale: 'All 31 proposals are decided and the bank feed is reconciled.', summaryPlain: '2026-09 is ready to lock with revenue of $412,000.' }))).toEqual({ allow: true });
  });
  it("does not let the Advisor call a worker's propose tools", () => {
    expect(checkCall(h, call('mcp__bookkeeper__propose_bank_match', {}))).toMatchObject({ allow: false, ruleIds: ['advisor.tools'] });
  });
  it('has no turn cap: the close is bounded by budget', () => {
    expect(h.maxTurns).toBeUndefined();
  });
});
