import { describe, expect, it } from 'vitest';
import {
  allocateBySsp, assertBalanced, buildRevenueSchedule, deferredRevenueRollforward, LedgerError, recognitionEntry, ymToString,
} from '../src/index.js';
import type { Contract, ContractItem } from '../src/index.js';
import { DEFERRED, REVENUE, SUB } from './fixtures.js';

const contract: Contract = { id: 1n, customerId: 50n, startYm: { year: 2026, month: 9 }, endYm: { year: 2027, month: 8 }, totalMinor: 100_000n, plan: 'annual' };
const sub: ContractItem = { id: 11n, contractId: 1n, kind: 'subscription', priceMinor: 1_000n, qty: 5n, sspMinor: 80_000n };
const usage: ContractItem = { id: 12n, contractId: 1n, kind: 'usage', priceMinor: 3n, qty: 0n, sspMinor: 40_000n };

describe('revrec', () => {
  it('subscription defaults to price * qty per month, inclusive of start and end', () => {
    const s = buildRevenueSchedule(sub, contract);
    expect(s).toHaveLength(12);
    expect(ymToString(s[0]!.ym)).toBe('2026-09');
    expect(ymToString(s[11]!.ym)).toBe('2027-08');
    expect(s.every((l) => l.amountMinor === 5_000n && !l.recognized)).toBe(true);
  });

  it('straight-line puts the remainder in the last month and sums exactly', () => {
    const s = buildRevenueSchedule(sub, contract, [], { allocatedMinor: 100_000n });
    expect(s.slice(0, 11).every((l) => l.amountMinor === 8_333n)).toBe(true);
    expect(s[11]!.amountMinor).toBe(8_337n);
    expect(s.reduce((a, l) => a + l.amountMinor, 0n)).toBe(100_000n);
  });

  it('edge: total smaller than the number of months', () => {
    const s = buildRevenueSchedule(sub, contract, [], { allocatedMinor: 5n });
    expect(s.slice(0, 11).every((l) => l.amountMinor === 0n)).toBe(true);
    expect(s[11]!.amountMinor).toBe(5n);
  });

  it('edge: single-month contract gets everything', () => {
    const one = { ...contract, endYm: contract.startYm };
    expect(buildRevenueSchedule(sub, one, [], { allocatedMinor: 777n })).toEqual([
      { contractItemId: 11n, ym: { year: 2026, month: 9 }, amountMinor: 777n, recognized: false },
    ]);
  });

  it('usage recognizes quantity * unit price in the usage month, merging records', () => {
    const s = buildRevenueSchedule(usage, contract, [
      { contractItemId: 12n, ym: { year: 2026, month: 10 }, quantity: 1_000n, unitPriceMinor: 3n },
      { contractItemId: 12n, ym: { year: 2026, month: 9 }, quantity: 10n, unitPriceMinor: 4n },
      { contractItemId: 12n, ym: { year: 2026, month: 10 }, quantity: 1n, unitPriceMinor: 3n },
      { contractItemId: 99n, ym: { year: 2026, month: 10 }, quantity: 9n, unitPriceMinor: 9n },
    ]);
    expect(s.map((l) => [ymToString(l.ym), l.amountMinor])).toEqual([['2026-09', 40n], ['2026-10', 3_003n]]);
  });

  it('rejects inverted terms and foreign items', () => {
    expect(() => buildRevenueSchedule(sub, { ...contract, endYm: { year: 2026, month: 8 } })).toThrow(LedgerError);
    expect(() => buildRevenueSchedule({ ...sub, contractId: 2n }, contract)).toThrow(LedgerError);
  });

  it('SSP allocation is relative and exact', () => {
    expect(allocateBySsp([sub, usage], 100_000n)).toEqual([
      { contractItemId: 11n, allocatedMinor: 66_667n },
      { contractItemId: 12n, allocatedMinor: 33_333n },
    ]);
    const three = allocateBySsp([sub, { ...sub, id: 13n }, { ...sub, id: 14n }], 100n);
    expect(three.map((x) => x.allocatedMinor)).toEqual([34n, 33n, 33n]);
  });

  it('recognition entry: Dr Deferred Revenue / Cr Revenue per item, balanced', () => {
    const lines = [
      { contractItemId: 12n, ym: { year: 2026, month: 9 }, amountMinor: 40n, recognized: false },
      { contractItemId: 11n, ym: { year: 2026, month: 9 }, amountMinor: 8_333n, recognized: false },
      { contractItemId: 11n, ym: { year: 2026, month: 9 }, amountMinor: 1n, recognized: true },
    ];
    const e = recognitionEntry(lines, { subsidiaryId: SUB, periodId: 9n, deferredRevenueAccountId: DEFERRED.id, revenueAccountId: REVENUE.id })!;
    expect(e.memo).toBe('Recognize revenue for 2026-09');
    expect(e.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      [DEFERRED.id, 8_373n, 0n],
      [REVENUE.id, 0n, 8_333n],
      [REVENUE.id, 0n, 40n],
    ]);
    assertBalanced(e.lines);
  });

  it('recognition entry is null when nothing is pending and rejects mixed months', () => {
    const acc = { subsidiaryId: SUB, periodId: 9n, deferredRevenueAccountId: DEFERRED.id, revenueAccountId: REVENUE.id };
    expect(recognitionEntry([{ contractItemId: 1n, ym: { year: 2026, month: 9 }, amountMinor: 5n, recognized: true }], acc)).toBeNull();
    expect(recognitionEntry([], acc)).toBeNull();
    expect(() => recognitionEntry([
      { contractItemId: 1n, ym: { year: 2026, month: 9 }, amountMinor: 5n, recognized: false },
      { contractItemId: 1n, ym: { year: 2026, month: 10 }, amountMinor: 5n, recognized: false },
    ], acc)).toThrow(LedgerError);
  });

  it('deferred revenue rollforward closes and reports mismatch against the ledger', () => {
    expect(deferredRevenueRollforward({ openingMinor: 1_000n, billingsMinor: 500n, recognizedMinor: 300n, ledgerBalanceMinor: 1_150n })).toEqual({
      openingMinor: 1_000n, billingsMinor: 500n, recognizedMinor: 300n, closingMinor: 1_200n, ledgerBalanceMinor: 1_150n, mismatchMinor: -50n, reconciled: false,
    });
    const ok = deferredRevenueRollforward({ openingMinor: 0n, billingsMinor: 0n, recognizedMinor: 0n });
    expect(ok.mismatchMinor).toBe(0n);
    expect(ok.ledgerBalanceMinor).toBeNull();
    expect(ok.reconciled).toBe(true);
  });
});
