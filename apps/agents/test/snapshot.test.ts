import { describe, expect, it } from 'vitest';
import { rootSubsidiary, snapshot } from '../src/snapshot';
import { closeHasWork, closeOpened, closeOpenedAt, isFeedMonth, lockedByCfo, pendingBankTxIds, previousYm } from '../src/close-state';
import { fakeConn, ts } from './fake-conn';

const acct = (id: bigint, subsidiaryId: bigint, code: string, tag = 'Asset') => ({ id, subsidiaryId, code, name: code, accountType: { tag }, isIntercompany: false });

/** A group: the elimination subsidiary first (lowest id) and the UK before the US, so iteration order never picks the root. */
const group = () =>
  fakeConn({
    subsidiary: [
      { id: 1n, code: 'ELIM', name: 'Group eliminations', functionalCcy: 'USD', parentId: 3n, isElimination: true },
      { id: 2n, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: 3n, isElimination: false },
      { id: 3n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', parentId: undefined, isElimination: false },
    ],
    period: [{ id: 9n, subsidiaryId: 3n, ym: '2026-09', status: { tag: 'Open' } }],
    account: [acct(10n, 3n, '1000'), acct(11n, 2n, '1000-UK'), acct(12n, 1n, '1900-ELIM'), acct(13n, 3n, '4000', 'Revenue')],
    customer: [
      { id: 20n, subsidiaryId: 3n, name: 'Acme' },
      { id: 21n, subsidiaryId: 2n, name: 'Brit Co' },
    ],
    vendor: [
      { id: 30n, subsidiaryId: 3n, name: 'Northwind', verification: { tag: 'Verified' } },
      { id: 31n, subsidiaryId: 2n, name: 'London Rent', verification: { tag: 'Verified' } },
    ],
    invoice: [
      { id: 40n, customerId: 20n, ym: '2026-09', amountMinor: 100n, dueAt: ts('2026-10-01'), status: { tag: 'Open' } },
      { id: 41n, customerId: 21n, ym: '2026-09', amountMinor: 200n, dueAt: ts('2026-10-01'), status: { tag: 'Paid' } },
    ],
    bill: [
      { id: 50n, vendorId: 30n, ym: '2026-09', amountMinor: 300n, dueAt: ts('2026-10-01'), billedAt: ts('2026-09-05'), status: { tag: 'Open' }, externalRef: 'NW-1' },
      { id: 51n, vendorId: 31n, ym: '2026-09', amountMinor: 400n, dueAt: ts('2026-10-01'), billedAt: ts('2026-09-05'), status: { tag: 'Paid' }, externalRef: 'LR-1' },
    ],
    bankTransaction: [
      { id: 60n, subsidiaryId: 3n, ym: '2026-09', bookedAt: ts('2026-09-10'), amountMinor: 100n, ccy: 'USD', description: 'ACME', counterparty: 'Acme', matched: false },
      { id: 61n, subsidiaryId: 2n, ym: '2026-09', bookedAt: ts('2026-09-10'), amountMinor: -400n, ccy: 'GBP', description: 'RENT', counterparty: 'London Rent', matched: true },
    ],
    contract: [
      { id: 70n, customerId: 20n, code: 'K-1', startYm: '2026-01', endYm: '2026-12', totalMinor: 1200n, plan: { tag: 'Annual' } },
      { id: 71n, customerId: 21n, code: 'K-UK', startYm: '2026-01', endYm: '2026-12', totalMinor: 2400n, plan: { tag: 'Annual' } },
    ],
    contractItem: [
      { id: 80n, contractId: 70n, kind: { tag: 'Subscription' }, priceMinor: 100n, qty: 1n, sspMinor: 1200n },
      { id: 81n, contractId: 71n, kind: { tag: 'Subscription' }, priceMinor: 200n, qty: 1n, sspMinor: 2400n },
    ],
    revenueScheduleLine: [
      { id: 90n, contractItemId: 80n, customerId: 20n, ym: '2026-09', amountMinor: 100n, recognized: false },
      { id: 91n, contractItemId: 81n, customerId: 21n, ym: '2026-09', amountMinor: 200n, recognized: true },
    ],
    journalEntry: [{ id: 100n, periodId: 9n }],
    journalLine: [
      { id: 1n, jeId: 100n, accountId: 10n, debitMinor: 500n, creditMinor: 0n },
      { id: 2n, jeId: 100n, accountId: 13n, debitMinor: 0n, creditMinor: 500n },
      { id: 3n, jeId: 100n, accountId: 11n, debitMinor: 700n, creditMinor: 0n },
    ],
    settings: [{ key: 'materiality_threshold_minor', valueI64: 1_000_000n, valueText: '' }],
  });

describe('snapshot of a group', () => {
  it('takes the root company (no parent, not eliminations), whatever the iteration order', () => {
    expect(rootSubsidiary(group()).code).toBe('US');
    expect(snapshot(group(), '2026-09').subsidiary.code).toBe('US');
  });

  it("keeps only the root company's rows", () => {
    const s = snapshot(group(), '2026-09');
    expect(s.accounts.map(a => a.code)).toEqual(['1000', '4000']);
    expect(s.customers.map(c => c.name)).toEqual(['Acme']);
    expect(s.vendors.map(v => v.name)).toEqual(['Northwind']);
    expect(s.invoices.map(i => i.id)).toEqual([40n]);
    expect(s.bills.map(b => b.id)).toEqual([50n]);
    expect(s.bankTxs.map(t => t.id)).toEqual([60n]);
    expect(s.bankTxRows.map(t => t.id)).toEqual([60n]);
    expect(s.contracts.map(k => k.id)).toEqual([70n]);
    expect(s.items.map(i => i.id)).toEqual([80n]);
    expect(s.scheduleLines.map(l => l.id)).toEqual([90n]);
    expect(s.journalLines.map(l => l.id)).toEqual([1n, 2n]);
    expect(s.balance('1000')).toBe(500n);
    expect(s.balance('1000-UK')).toBe(0n);
  });

  it('reads another subsidiary when asked', () => {
    const s = snapshot(group(), '2026-09', { subsidiaryId: 2n });
    expect(s.subsidiary.code).toBe('UK');
    expect(s.customers.map(c => c.name)).toEqual(['Brit Co']);
    expect(s.bankTxs.map(t => t.id)).toEqual([61n]);
  });

  it('works on a single-company database seeded before the elimination column existed', () => {
    const c = fakeConn({ subsidiary: [{ id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', parentId: undefined }], period: [{ id: 2n, ym: '2026-09', status: { tag: 'Open' } }] });
    expect(snapshot(c, '2026-09').subsidiary.name).toBe('Cafoo Inc');
    expect(() => snapshot(fakeConn({ period: [{ id: 2n, ym: '2026-09' }] }), '2026-09')).toThrow(/No subsidiary seeded/);
  });
});

describe('close state', () => {
  const at = (iso: string) => ({ microsSinceUnixEpoch: BigInt(Date.parse(iso)) * 1000n });
  const rows = (extra: Record<string, unknown[]>) => ({ period: [{ id: 9n, ym: '2026-10', status: { tag: 'Open' } }], ...extra });
  const opening = (iso = '2026-11-02T09:00:00Z', ym = '2026-10', senderRole = 'advisor') => ({ threadId: `close:${ym}`, senderRole, body: `Opening the ${ym} close for Cafoo Inc.`, createdAt: at(iso) });
  const proposal = (iso: string, extra: Record<string, unknown> = {}) => ({ id: 1n, periodId: 9n, status: { tag: 'Approved' }, payloadJson: '{}', closeTaskId: undefined, createdAt: at(iso), ...extra });

  it("opens with the Advisor's opening message, not with the feed's Proposals", () => {
    expect(closeOpened(fakeConn(rows({ proposal: [proposal('2026-10-05T00:00:00Z')] })), '2026-10')).toBe(false);
    expect(closeOpened(fakeConn(rows({ agentMessage: [opening()] })), '2026-10')).toBe(true);
    // Someone else saying it, or the opening of another month, does not count.
    expect(closeOpened(fakeConn(rows({ agentMessage: [opening(undefined, '2026-10', 'bookkeeper'), opening(undefined, '2026-09')] })), '2026-10')).toBe(false);
    const twice = fakeConn(rows({ agentMessage: [opening('2026-11-02T09:00:00Z'), opening('2026-11-03T09:00:00Z')] }));
    expect(closeOpenedAt(twice, '2026-10')).toBe(at('2026-11-02T09:00:00Z').microsSinceUnixEpoch);
    expect(closeOpenedAt(twice, '2026-10', 'last')).toBe(at('2026-11-03T09:00:00Z').microsSinceUnixEpoch);
  });

  it('has work to resume only when the close filed something after opening', () => {
    // Opened, then failed before filing anything: run fresh again.
    expect(closeHasWork(fakeConn(rows({ agentMessage: [opening()] })), '2026-10')).toBe(false);
    // The feed's Proposals from before the opening are not the close's work.
    expect(closeHasWork(fakeConn(rows({ agentMessage: [opening()], proposal: [proposal('2026-10-15T00:00:00Z')] })), '2026-10')).toBe(false);
    expect(closeHasWork(fakeConn(rows({ agentMessage: [opening()], proposal: [proposal('2026-11-02T09:00:01Z')] })), '2026-10')).toBe(true);
    // A close from before the opening message existed filed its Proposals against close tasks.
    expect(closeHasWork(fakeConn(rows({ proposal: [proposal('2026-10-15T00:00:00Z', { closeTaskId: 4n })] })), '2026-10')).toBe(true);
  });

  it('feeds only the open month after a month the CFO locked, never after the seed\'s history locks', () => {
    // As the seed loads: July and August locked by the seed, September (the close month) and October open.
    const seeded = {
      period: [
        { id: 7n, ym: '2026-07', status: { tag: 'Closed' } },
        { id: 8n, ym: '2026-08', status: { tag: 'Closed' } },
        { id: 9n, ym: '2026-09', status: { tag: 'Open' } },
        { id: 10n, ym: '2026-10', status: { tag: 'Open' } },
      ],
      periodLock: [
        { id: 1n, periodId: 7n, lockedByRole: 'seed' },
        { id: 2n, periodId: 8n, lockedByRole: 'seed' },
      ],
    };
    expect(lockedByCfo(fakeConn(seeded), '2026-08')).toBe(false);
    expect(isFeedMonth(fakeConn(seeded), '2026-09')).toBe(false);
    expect(isFeedMonth(fakeConn(seeded), '2026-10')).toBe(false);
    const locked = { ...seeded, period: seeded.period.map(p => (p.ym === '2026-09' ? { ...p, status: { tag: 'Closed' } } : p)), periodLock: [...seeded.periodLock, { id: 3n, periodId: 9n, lockedByRole: 'cfo' }] };
    expect(isFeedMonth(fakeConn(locked), '2026-10')).toBe(true);
    expect(isFeedMonth(fakeConn({ ...locked, agentMessage: [opening()] }), '2026-10')).toBe(false);
    expect(previousYm('2027-01')).toBe('2026-12');
  });

  it('lists bank transactions cited by Proposals still waiting', () => {
    const c = fakeConn({
      proposal: [
        { id: 1n, status: { tag: 'Open' }, payloadJson: JSON.stringify({ matches: [{ bankTxId: '7' }, { bankTxId: '08' }] }) },
        { id: 2n, status: { tag: 'AwaitingCfo' }, payloadJson: JSON.stringify({ bankTxIds: ['9'] }) },
        { id: 3n, status: { tag: 'Approved' }, payloadJson: JSON.stringify({ bankTxIds: ['10'] }) },
        { id: 4n, status: { tag: 'SentBack' }, payloadJson: '{not json' },
      ],
    });
    expect([...pendingBankTxIds(c)].sort()).toEqual([7n, 8n, 9n]);
  });
});
