import { describe, expect, it } from 'vitest';
import type { BankTransaction, Bill, Invoice } from '@cafoo/ledger-core';
import { citedBankTxIds, planFeedProposals, waitingFeedLines, type FeedPlanParams } from '../src/continuous/bookkeeper';
import { checkCall, HARNESSES } from '../src/harness';
import { plainSummaryProblems } from '../src/harness/rules';
import { fakeConn } from './fake-conn';

const at = (iso: string) => BigInt(Date.parse(iso)) * 1000n;
const inv = (id: bigint, customerId: bigint, amountMinor: bigint, due = '2026-10-05'): Invoice => ({ id, customerId, ym: { year: 2026, month: 9 }, amountMinor, dueAt: at(due), status: 'open' });
const bill = (id: bigint, vendorId: bigint, amountMinor: bigint, externalRef: string, status: Bill['status'] = 'open'): Bill => ({ id, vendorId, ym: { year: 2026, month: 9 }, amountMinor, dueAt: at('2026-10-01'), billedAt: at('2026-09-20'), status, externalRef });
const tx = (id: bigint, amountMinor: bigint, description: string, counterparty: string, day = '2026-10-05', matched = false): BankTransaction => ({ id, bookedAt: at(day), amountMinor, ccy: 'USD', description, counterparty, matched });

/** The root company's books before the October feed: three September usage invoices, Northwind's bill already paid once. */
const books = (extra: Partial<{ bankTxs: BankTransaction[] }> = {}) => ({
  invoices: [inv(1n, 11n, 420000n), inv(2n, 12n, 300000n), inv(3n, 13n, 250000n)],
  bills: [bill(9n, 21n, 120000n, 'NW-311', 'paid')],
  customerName: new Map([[11n, 'Acme Analytics'], [12n, 'Beta Corp'], [13n, 'Gamma Holdings Group']]),
  vendorName: new Map([[21n, 'Northwind Traders'], [22n, 'Shady Supplies']]),
  vendors: [
    { id: 21n, name: 'Northwind Traders', verification: { tag: 'Verified' } },
    { id: 22n, name: 'Shady Supplies', verification: { tag: 'Blocked' } },
  ],
  bankTxs: [tx(90n, -120000n, 'NORTHWIND NW-311', 'Northwind Traders', '2026-09-30', true), ...(extra.bankTxs ?? [])],
});
const params: FeedPlanParams = { ym: '2026-10', subsidiaryId: 1n, batchMinScoreBp: 7500 };

const receipt = tx(101n, 420000n, 'ACME ANALYTICS PAYMENT INV 1', 'Acme Analytics');
const partial = tx(102n, 150000n, 'BETA CORP PART PAYMENT', 'Beta Corp');
const short = tx(103n, 299000n, 'BETA CORP INV 2', 'Beta Corp');
const partlyNamed = tx(104n, 250000n, 'WIRE GAMMA', 'Gamma LLC', '2026-10-12');
const fee = tx(105n, -4500n, 'MONTHLY SERVICE FEE', 'First Bank');
const payroll = tx(106n, -4860000n, 'PAYROLL RUN OCT 15', 'Payroll Services', '2026-10-15');
const unknownPayee = tx(107n, -12000n, 'ZETA DESIGN', 'Zeta Design Studio');
const wireIn = tx(108n, 99900n, 'INCOMING WIRE', 'Unknown Sender');
const blocked = tx(109n, -500000n, 'SHADY SUPPLIES ORDER', 'Shady Supplies');
const duplicate = tx(110n, -120000n, 'NORTHWIND NW-311', 'Northwind Traders', '2026-10-03');

describe('planFeedProposals', () => {
  it('batches confident exact receipts and gives a less certain exact match its own ruling', () => {
    const { drafts } = planFeedProposals([receipt, partlyNamed], books(), params);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ kind: 'bank_match', amountMinor: 0n, periodYm: '2026-10', payload: { matches: [{ bankTxId: '101', targetKind: 'invoice', targetId: '1' }] } });
    expect((drafts[0]!.payload as { matches: { scoreBp: number }[] }).matches[0]!.scoreBp).toBeGreaterThanOrEqual(7500);
    expect(drafts[0]!.summaryPlain).toBe('Match 1 customer payment worth $4,200 to the invoices they pay as they arrive from the bank; every match is at least 100% confident.');
    expect(drafts[1]).toMatchObject({ kind: 'bank_match', payload: { matches: [{ bankTxId: '104', targetId: '3' }] } });
    expect((drafts[1]!.payload as { matches: { scoreBp: number }[] }).matches[0]!.scoreBp).toBeLessThan(7500);
  });

  it('follows a stricter batch threshold from the charter', () => {
    const { drafts } = planFeedProposals([receipt], books(), { ...params, batchMinScoreBp: 10001 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.rationale).toMatch(/Below the 100% batch threshold, so this needs its own ruling/);
  });

  it('leaves short and partial payments and unexplained incoming money for a person', () => {
    const { drafts, leftForPerson } = planFeedProposals([partial, short, wireIn], books(), params);
    expect(drafts).toEqual([]);
    expect(leftForPerson.map(l => l.bankTxId).sort()).toEqual([102n, 103n, 108n]);
    expect(leftForPerson.find(l => l.bankTxId === 103n)!.body).toMatch(/amounts differ\. A bank match must be exact/);
    expect(leftForPerson.find(l => l.bankTxId === 108n)!.body).toMatch(/I do not guess which customer paid/);
  });

  it('books fees and payroll from the description, and the second payment of a bill as money owed back', () => {
    const { drafts } = planFeedProposals([fee, payroll, duplicate], books({ bankTxs: [] }), params);
    const byTx = new Map(drafts.map(d => [(d.payload as { bankTxIds: string[] }).bankTxIds[0], d]));
    expect(byTx.get('105')).toMatchObject({ kind: 'journal_entry', amountMinor: 4500n, payload: { memo: 'Bank fees: MONTHLY SERVICE FEE', lines: [{ accountCode: '6000', debitMinor: '4500' }, { accountCode: '1000', creditMinor: '4500' }] } });
    expect(byTx.get('106')).toMatchObject({ amountMinor: 4860000n, summaryPlain: 'Record the $48,600 paid to Payroll Services on October 15 as payroll.', payload: { lines: [{ accountCode: '5300' }, { accountCode: '1000' }] } });
    expect(byTx.get('110')).toMatchObject({ amountMinor: 120000n, payload: { memo: 'Duplicate payment to Northwind Traders on NW-311; refund requested', lines: [{ accountCode: '1250' }, { accountCode: '1000' }] } });
    expect(byTx.get('106')!.rationale).toMatch(/Description "PAYROLL RUN OCT 15" indicates payroll/);
  });

  it('asks for a lookup on a payee the description does not explain, and cites what it found', () => {
    const first = planFeedProposals([unknownPayee], books(), params);
    expect(first.needsLookup).toEqual(['Zeta Design Studio']);
    expect(first.drafts[0]!.rationale).toMatch(/no public record found for "Zeta Design Studio"/);
    const second = planFeedProposals([unknownPayee], books(), { ...params, lookups: new Map([['Zeta Design Studio', 'search results summarized: a design studio in Austin']]) });
    expect(second.needsLookup).toEqual([]);
    expect(second.drafts[0]!.rationale).toMatch(/search results summarized: a design studio in Austin/);
  });

  it('never books a payment to a blocked vendor, and leaves anything over the cap for a person', () => {
    const { drafts, leftForPerson } = planFeedProposals([blocked, payroll, fee], books(), { ...params, maxProposalMinor: 1_000_000n });
    expect(drafts.map(d => (d.payload as { bankTxIds: string[] }).bankTxIds[0])).toEqual(['105']);
    expect(leftForPerson.find(l => l.bankTxId === 109n)!.body).toMatch(/Shady Supplies is blocked/);
    expect(leftForPerson.find(l => l.bankTxId === 106n)!.body).toMatch(/over the \$10,000 I may propose/);
  });

  it('skips lines already matched', () => {
    expect(planFeedProposals([{ ...receipt, matched: true }], books(), params).drafts).toEqual([]);
  });

  it('writes Proposals the Bookkeeper harness allows, with plain summaries', () => {
    const { drafts, leftForPerson } = planFeedProposals([receipt, partlyNamed, partial, short, fee, payroll, unknownPayee, wireIn, blocked, duplicate], books(), params);
    const codes = ['1000', '1100', '1250', '2000', '5300', '5500', '6000'];
    for (const d of drafts) {
      const tool = d.kind === 'bank_match' ? 'mcp__bookkeeper__propose_bank_match' : 'mcp__bookkeeper__propose_journal_entry';
      const input = { ...(d.payload as Record<string, unknown>), rationale: d.rationale, summaryPlain: d.summaryPlain, periodYm: d.periodYm, amountMinor: d.amountMinor.toString() };
      expect(checkCall(HARNESSES.bookkeeper, { tool, input }, { accountCodes: codes }), d.summaryPlain).toEqual({ allow: true });
    }
    for (const l of leftForPerson) expect(plainSummaryProblems(l.summaryPlain, codes), l.summaryPlain).toEqual([]);
  });
});

describe('waiting feed lines', () => {
  const rows = (extra: Record<string, unknown[]> = {}) => ({
    period: [
      { id: 1n, ym: '2026-09', status: { tag: 'Closed' } },
      { id: 2n, ym: '2026-10', status: { tag: 'Open' } },
    ],
    periodLock: [{ id: 1n, periodId: 1n, lockedByRole: 'cfo' }],
    feedEvent: [
      { externalId: 'feed-2026-10-rcpt-1', kind: { tag: 'BankTx' }, rowId: 101n },
      { externalId: 'feed-2026-10-fee-5', kind: { tag: 'BankTx' }, rowId: 105n },
      { externalId: 'feed-2026-10-inv-9', kind: { tag: 'Invoice' }, rowId: 102n },
      { externalId: 'feed-2026-09-x', kind: { tag: 'BankTx' }, rowId: 50n },
    ],
    bankTransaction: [
      { id: 50n, ym: '2026-09', matched: false },
      { id: 100n, ym: '2026-10', matched: false },
      { id: 101n, ym: '2026-10', matched: false },
      { id: 102n, ym: '2026-10', matched: false },
      { id: 105n, ym: '2026-10', matched: false },
    ],
    ...extra,
  });

  it('are feed bank lines of an open month, unmatched and never proposed', () => {
    expect(waitingFeedLines(fakeConn(rows()))).toEqual(new Map([['2026-10', [101n, 105n]]]));
    const proposed = fakeConn(rows({ proposal: [{ id: 1n, status: { tag: 'Rejected' }, payloadJson: JSON.stringify({ matches: [{ bankTxId: '101' }] }) }] }));
    expect(citedBankTxIds(proposed)).toEqual(new Set([101n]));
    expect(waitingFeedLines(proposed)).toEqual(new Map([['2026-10', [105n]]]));
    expect(waitingFeedLines(fakeConn(rows()), { skip: new Set([105n]) })).toEqual(new Map([['2026-10', [101n]]]));
    // A line already left for a person in the close thread is not announced again after a restart.
    const announced = fakeConn(rows({ agentMessage: [{ threadId: 'close:2026-10', senderRole: 'bookkeeper', body: 'Bank transaction 105 ("MONTHLY SERVICE FEE", $45, Bank): incoming money with no matching invoice.' }] }));
    expect(waitingFeedLines(announced)).toEqual(new Map([['2026-10', [101n]]]));
  });

  it('are none in a month whose previous month only the seed locked', () => {
    expect(waitingFeedLines(fakeConn(rows({ periodLock: [{ id: 1n, periodId: 1n, lockedByRole: 'seed' }] }))).size).toBe(0);
  });

  it('wait for nobody once the month is closing in this gateway or its close has started', () => {
    expect(waitingFeedLines(fakeConn(rows()), { isClosing: ym => ym === '2026-10' }).size).toBe(0);
    const started = fakeConn(rows({ agentMessage: [{ threadId: 'close:2026-10', senderRole: 'advisor', body: 'Opening the 2026-10 close for Cafoo Inc.' }] }));
    expect(waitingFeedLines(started).size).toBe(0);
  });
});

describe('single bank matches to bills', () => {
  it('name the bill by vendor and month in the summary, never by its reference', () => {
    const b = { ...books(), bills: [bill(9n, 21n, 120000n, 'NORTHWIND-202609-7019')] };
    const pay = tx(120n, -120000n, 'ACH DEBIT NORTHWIND-202609-7019', 'Northwind Traders', '2026-10-01');
    const { drafts } = planFeedProposals([pay], b, { ...params, batchMinScoreBp: 10001 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.summaryPlain).toMatch(/to Northwind Traders's September 2026 bill; confidence \d+%\.$/);
    expect(drafts[0]!.rationale).toMatch(/bill NORTHWIND-202609-7019 from Northwind Traders/);
    expect(plainSummaryProblems(drafts[0]!.summaryPlain, ['1000'])).toEqual([]);
  });
});
