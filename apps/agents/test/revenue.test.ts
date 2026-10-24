import { describe, expect, it } from 'vitest';
import { checkCall, HARNESSES } from '../src/harness';
import { call, ruleSuite } from './helpers';

const h = HARNESSES.revenue;
const base = { periodYm: '2026-09', rationale: 'Straight-line over the twelve months of the term.' };
const months = (start: number, n: number) => Array.from({ length: n }, (_, i) => `2026-${String(start + i).padStart(2, '0')}`);
const schedule = (yms: string[], amount = '220000', totalMinor = String(BigInt(amount) * BigInt(yms.length))) =>
  call('mcp__revenue__propose_revenue_schedule', {
    ...base,
    contractItemId: '41',
    customerId: '7',
    lines: yms.map(ym => ({ ym, amountMinor: amount })),
    totalMinor,
    summaryPlain: "Spread the customer's $26,400 contract evenly across its twelve months.",
  });
const recognition = (input: Record<string, unknown> = {}) =>
  call('mcp__revenue__propose_journal_entry', {
    ...base,
    memo: 'Revenue recognition 2026-09',
    amountMinor: '1500000',
    lines: [
      { accountCode: '2400', debitMinor: '1500000', creditMinor: '0', customerId: '7' },
      { accountCode: '4000', debitMinor: '0', creditMinor: '1500000', customerId: '7' },
    ],
    recognizeScheduleYm: '2026-09',
    summaryPlain: 'Recognize $15,000 of subscription revenue earned through September across 9 customers.',
    ...input,
  });

ruleSuite(h, {
  'revenue.may.1': {
    allow: [{ call: schedule(months(1, 12)) }, { call: recognition() }],
    deny: [
      { call: call('mcp__revenue__propose_bank_match', { ...base, matches: [] }), why: /not bank matches/ },
      { call: recognition({ lines: [{ accountCode: '2400', debitMinor: '100', creditMinor: '0' }, { accountCode: '1100', debitMinor: '0', creditMinor: '100' }] }), why: /revenue account/ },
      // A revenue account on the first line only: the eval (revenue-proposal-kinds) wants it on the second.
      { call: recognition({ lines: [{ accountCode: '4100', debitMinor: '100', creditMinor: '0' }, { accountCode: '1100', debitMinor: '0', creditMinor: '100' }] }), why: /second line; got "1100"/ },
    ],
  },
  'revenue.may.2': {
    allow: [{ call: schedule(months(1, 12)) }, { call: schedule(['2026-11', '2026-12', '2027-01']) }],
    deny: [
      { call: schedule(['2026-01', '2026-01']), why: /scheduled twice/ },
      { call: schedule(['2026-01', '2026-03']), why: /without gaps/ },
      { call: schedule(['2026-13']), why: /not YYYY-MM/ },
    ],
  },
  'revenue.never.1': {
    allow: [{ call: recognition() }],
    deny: [{ call: call('mcp__advisor__approve_proposal', { proposalId: '5' }), why: /posts to the ledger/ }],
  },
  'revenue.never.2': {
    allow: [
      { call: recognition() },
      { call: recognition({ recognizeScheduleYm: '2026-08' }) },
      { call: schedule(months(1, 12)) },
      // Usage revenue on 4100 needs no recognition month.
      { call: recognition({ recognizeScheduleYm: undefined, lines: [{ accountCode: '1100', debitMinor: '5', creditMinor: '0', customerId: '7' }, { accountCode: '4100', debitMinor: '0', creditMinor: '5', customerId: '7' }] }) },
    ],
    deny: [
      { call: recognition({ recognizeScheduleYm: '2026-10' }), why: /before its service month/ },
      { call: recognition({ recognizeScheduleYm: undefined }), why: /net credit to 4000 Subscription Revenue appears only in a recognition entry/ },
      { call: schedule(months(1, 12), '220000', '2640001'), why: /sum to 2640000 minor units, not the contract total 2640001/ },
      { call: schedule(months(1, 2), '22.5', '45'), why: /whole minor units/ },
    ],
  },
  'revenue.never.4': {
    allow: [{ call: call('mcp__revenue__update_close_task', { taskId: '4', status: 'blocked', note: 'waiting on contract' }) }],
    deny: [
      { call: call('mcp__advisor__reject_proposal', { proposalId: '3' }), why: /only the Advisor rules/ },
      { call: call('mcp__revenue__update_close_task', { taskId: '4', status: 'done', note: 'x' }), why: /done/ },
    ],
  },
  'revenue.escalates.1': {
    allow: [
      { call: recognition() },
      { call: recognition(), ctx: { pendingProposals: [{ kind: 'revenue_schedule', payload: { lines: [{ customerId: '8', ym: '2026-09', amountMinor: '100' }] } }] } },
      // A pending journal entry for the same customer does not block recognition; only a pending schedule does.
      { call: recognition(), ctx: { pendingProposals: [{ kind: 'journal_entry', payload: { lines: [{ accountCode: '4000', customerId: '7' }] } }] } },
      { call: recognition({ recognizeScheduleYm: undefined, lines: [{ accountCode: '1100', debitMinor: '5', creditMinor: '0' }, { accountCode: '4100', debitMinor: '0', creditMinor: '5' }] }) },
      // One combined, untagged 2400 debit is valid; only the 4000 lines name their customers.
      { call: recognition({ lines: [{ accountCode: '2400', debitMinor: '300', creditMinor: '0' }, { accountCode: '4000', debitMinor: '0', creditMinor: '100', customerId: '7' }, { accountCode: '4000', debitMinor: '0', creditMinor: '200', customerId: '8' }] }) },
    ],
    deny: [
      { call: recognition(), ctx: { pendingProposals: [{ kind: 'revenue_schedule', payload: { lines: [{ customerId: '007', ym: '2026-09', amountMinor: '100' }] } }] }, why: /customer 7 has a revenue schedule still waiting/ },
      { call: recognition({ lines: [{ accountCode: '2400', debitMinor: '100', creditMinor: '0', customerId: '7' }, { accountCode: '4000', debitMinor: '0', creditMinor: '100' }] }), why: /every 4000 Subscription Revenue line with its customerId; 1 line\(s\) have none/ },
    ],
  },
  'revenue.plain': {
    allow: [{ call: recognition() }],
    deny: [{ call: recognition({ summaryPlain: 'Dr 2400 / Cr 4000 per ASC 606.' }), why: /account code 2400, 4000/ }],
  },
});

describe('revenue harness as a whole', () => {
  it('lets well-formed proposals through every rule', () => {
    expect(checkCall(h, schedule(months(1, 12)))).toEqual({ allow: true });
    expect(checkCall(h, recognition())).toEqual({ allow: true });
  });
  it('has no credit or bank tools', () => {
    expect(h.tools.filter(t => /propose_(bank_match|accrual|credit_decision|vendor_block)|crs__/.test(t))).toEqual([]);
  });
});
