import { describe, expect, it } from 'vitest';
import { checkCall, HARNESSES } from '../src/harness';
import { call, ruleSuite } from './helpers';

const h = HARNESSES.bookkeeper;
const plain = 'Match 12 bank transactions worth $48,210 to the invoices and bills they clearly pay.';
const base = { periodYm: '2026-09', rationale: 'Scores combine amount, date and counterparty name overlap.', summaryPlain: plain };
const batch = (scores: number[]) => call('mcp__bookkeeper__propose_bank_match', { ...base, matches: scores.map((s, i) => ({ bankTxId: String(i + 1), targetKind: 'invoice', targetId: String(100 + i), scoreBp: s })) });
const entry = (input: Record<string, unknown>) =>
  call('mcp__bookkeeper__propose_journal_entry', {
    ...base,
    memo: 'Bank fees: MONTHLY SERVICE FEE',
    amountMinor: '4500',
    lines: [
      { accountCode: '6000', debitMinor: '4500', creditMinor: '0' },
      { accountCode: '1000', debitMinor: '0', creditMinor: '4500' },
    ],
    bankTxIds: ['77'],
    summaryPlain: 'Record the $45 paid to the bank as bank fees.',
    ...input,
  });
const accrual = (rationale: string) =>
  call('mcp__bookkeeper__propose_accrual', {
    ...base,
    memo: 'Accrue Northwind work for 2026-09',
    amountMinor: '820000',
    lines: [
      { accountCode: '5600', debitMinor: '820000', creditMinor: '0' },
      { accountCode: '2100', debitMinor: '0', creditMinor: '820000' },
    ],
    rationale,
    summaryPlain: "Count $8,200 of Northwind's September work in this month even though their bill arrived later.",
  });
const duplicate = (codes: [string, string]) =>
  entry({
    memo: 'Duplicate payment to Acme on BILL-2209; refund requested',
    lines: [
      { accountCode: codes[0], debitMinor: '120000', creditMinor: '0' },
      { accountCode: codes[1], debitMinor: '0', creditMinor: '120000' },
    ],
    summaryPlain: 'We paid Acme twice for the same $1,200 bill; record the second payment as money they owe us back.',
  });

ruleSuite(h, {
  'bookkeeper.may.1': {
    allow: [{ call: batch([9000]) }, { call: entry({}) }, { call: accrual('bill NW-311 covers September') }, { call: call('mcp__books__close_snapshot', { periodYm: '2026-09' }) }],
    deny: [
      { call: call('mcp__bookkeeper__propose_revenue_schedule', { ...base, contractItemId: '1', customerId: '1', lines: [], totalMinor: '0' }), why: /nothing else, not revenue schedules/ },
      { call: call('mcp__bookkeeper__propose_vendor_block', { ...base, vendorId: '3', reasonPlain: 'x', exposureMinor: '0' }), why: /vendor blocks/ },
    ],
  },
  'bookkeeper.may.2': {
    allow: [{ call: batch([7500, 9900, 8000]) }, { call: batch([6100]) }, { call: entry({}) }],
    deny: [{ call: batch([9000, 7499]), why: /below 75% confidence \(2 at 74.99%\)/ }],
  },
  'bookkeeper.may.3': {
    allow: [
      { call: call('mcp__bookkeeper__post_message', { threadId: 'close:2026-09', body: 'Unknown counterparty "ZETA LLC". Looked them up: a design studio.', summaryPlain: 'The Bookkeeper looked up ZETA LLC on the web.' }) },
      { call: call('mcp__bookkeeper__post_message', { threadId: 'proposal:12', body: 'Matched on invoice number in the memo.', summaryPlain: 'The Bookkeeper explains the match.' }) },
      // Only a body saying the Bookkeeper looked them or it up must go to the close thread, as in the eval.
      { call: call('mcp__bookkeeper__post_message', { threadId: 'proposal:12', body: 'No lookup was needed: the bank description names the payee.', summaryPlain: 'The Bookkeeper explains the entry.' }) },
      { call: call('mcp__bookkeeper__post_message', { threadId: 'proposal:12', body: 'The payee is listed on the web as a software company.', summaryPlain: 'The Bookkeeper explains the entry.' }) },
      { call: call('mcp__bookkeeper__post_message', { threadId: 'proposal:12', body: 'Should I look it up before you rule?', summaryPlain: 'The Bookkeeper asks a question.', kind: 'question' }) },
      { call: call('mcp__bookkeeper__post_message', { threadId: 'proposal:12', body: 'Booked as office supplies.', summaryPlain: 'The Bookkeeper looked them up on the web.' }) },
    ],
    deny: [{ call: call('mcp__bookkeeper__post_message', { threadId: 'proposal:12', body: 'Looked them up on the web: a design studio.', summaryPlain: 'The Bookkeeper looked up the payee.' }), why: /close thread/ }],
  },
  'bookkeeper.never.1': {
    allow: [{ call: entry({}) }],
    deny: [{ call: call('mcp__advisor__approve_proposal', { proposalId: '3', rationale: 'x', summaryPlain: 'x' }), why: /posts to the ledger/ }],
  },
  'bookkeeper.never.2': {
    allow: [{ call: call('mcp__bookkeeper__update_close_task', { taskId: '2', status: 'in_progress', note: 'matching' }) }],
    deny: [
      { call: call('mcp__advisor__reject_proposal', { proposalId: '3' }), why: /only the Advisor rules/ },
      { call: call('mcp__bookkeeper__update_close_task', { taskId: '2', status: 'done', note: 'x' }), why: /marks a close task done/ },
      { call: call('mcp__advisor__update_close_task', { taskId: '2', status: 'in_progress', note: 'x' }), why: /marks a close task done/ },
    ],
  },
  'bookkeeper.never.3': {
    allow: [
      { call: batch([9000, 8000]) },
      { call: entry({}) },
      { call: accrual("Northwind's bill NW-311 covers September work but is dated October.") },
      { call: accrual('Bill TWC-202609 covers September work but is dated after month end.') },
    ],
    deny: [
      { call: entry({ bankTxIds: undefined }), why: /bankTxIds/ },
      { call: entry({ bankTxIds: [] }), why: /bankTxIds/ },
      { call: accrual('Work done in September, billed later.'), why: /bill <reference>/ },
      { call: call('mcp__bookkeeper__propose_bank_match', { ...base, matches: [{ bankTxId: '', targetKind: 'bill', targetId: '4', scoreBp: 9000 }] }), why: /bankTxId/ },
    ],
  },
  'bookkeeper.never.4': {
    allow: [{ call: call('mcp__bookkeeper__post_message', { threadId: 'close:2026-09', body: 'x', summaryPlain: 'Started matching the bank feed.', kind: 'question' }) }],
    deny: [
      { call: call('mcp__bookkeeper__post_message', { threadId: 'proposal:3', body: 'x', summaryPlain: 'x', kind: 'critique' }), why: /statements or questions/ },
      { call: call('mcp__advisor__post_ruling', { threadId: 'close:2026-09', body: 'x', summaryPlain: 'x' }), why: /ruling/ },
    ],
  },
  'bookkeeper.escalates.1': {
    allow: [{ call: entry({}) }, { call: entry({ bankTxIds: undefined, lines: [{ accountCode: '1000', debitMinor: '100', creditMinor: '0' }, { accountCode: '3000', debitMinor: '0', creditMinor: '100' }] }) }],
    deny: [
      {
        call: entry({ lines: [{ accountCode: '1000', debitMinor: '250000', creditMinor: '0' }, { accountCode: '1100', debitMinor: '0', creditMinor: '250000' }] }),
        why: /incoming money/,
      },
    ],
  },
  'bookkeeper.escalates.2': {
    allow: [{ call: duplicate(['1250', '1000']) }, { call: entry({}) }],
    deny: [{ call: duplicate(['5100', '1000']), why: /owes back/ }],
  },
  'bookkeeper.plain': {
    allow: [
      { call: entry({}) },
      { call: batch([9000]) },
      // Invoice ids stay allowed: the eval's account-code and 5+ digit checks do not flag them either.
      { call: entry({ summaryPlain: 'Match the $7,620 payment from Acme to invoice INV-1042; confidence 61%.' }), ctx: { accountCodes: ['1000', '6000'] } },
      { call: entry({ summaryPlain: 'Match the $7,620 payment from Acme to invoice #1042 and INV-1043.' }) },
      { call: entry({ summaryPlain: 'Recognize revenue earned in September 2026 across 9 customers.' }) },
    ],
    deny: [
      { call: entry({ summaryPlain: 'Debit 6000 bank fees for 4500.' }), why: /account code 6000, 4500; bookkeeping jargon "Debit"/ },
      { call: entry({ summaryPlain: 'Record 4500 of bank fees on 6000.' }), ctx: { accountCodes: ['1000', '6000'] }, why: /account code 6000; raw number "4500"/ },
      { call: entry({ summaryPlain: 'Record the 4800000 reserve against the customer.' }), why: /raw number "4800000"/ },
      { call: entry({ summaryPlain: 'Book it against thin_file_tu for the customer.' }), why: /machine reason code/ },
      // Shapes the eval's plain_summary_clean blocks, so the gate must too.
      { call: entry({ summaryPlain: 'Move the fee to account #6000 for the bank.' }), ctx: { accountCodes: ['1000', '6000'] }, why: /account code 6000/ },
      { call: entry({ summaryPlain: 'Move the fee to account #6000 for the bank.' }), why: /account code 6000/ },
      { call: entry({ summaryPlain: 'Book the charge to Software-5100 this month.' }), ctx: { accountCodes: ['5100'] }, why: /account code 5100/ },
      { call: entry({ summaryPlain: 'Record a refund of -450000 from the vendor.' }), why: /raw number "450000"/ },
      { call: entry({ summaryPlain: 'Match the payment to invoice #48000 from Acme.' }), why: /raw number "48000"/ },
      { call: entry({ summaryPlain: 'Match the payment to contract K-12000 from Acme.' }), why: /raw number "12000"/ },
      { call: entry({ summaryPlain: 'Record the fee. It was charged by the bank.' }), why: /more than one sentence/ },
      { call: entry({ summaryPlain: 'Fees' }), why: /shorter than 10/ },
    ],
  },
});

describe('bookkeeper harness as a whole', () => {
  it('lets well-formed proposals through every rule', () => {
    for (const c of [batch([9100, 8800]), batch([6200]), entry({}), accrual("Northwind's bill NW-311 covers September work."), duplicate(['1250', '1000'])]) expect(checkCall(h, c)).toEqual({ allow: true });
  });
  it('denies tools off its list, including other roles’ propose tools', () => {
    const d = checkCall(h, call('mcp__revenue__propose_revenue_schedule', {}));
    expect(d).toMatchObject({ allow: false, ruleIds: ['bookkeeper.tools'] });
    expect(checkCall(h, call('mcp__crs__crs_cascade', { personaId: 'P01' })).allow).toBe(false);
  });
});
