import { describe, expect, it } from 'vitest';
import { assertBalanced, dateMicros, detectMissingAccruals } from '../src/index.js';
import type { Bill } from '../src/index.js';
import { ACCRUED, HOSTING, SUB } from './fixtures.js';

const SEP = { year: 2026, month: 9 };
const b = (id: bigint, over: Partial<Bill>): Bill => ({
  id, vendorId: 7n, ym: SEP, amountMinor: 450_000n, dueAt: dateMicros(2026, 10, 30), status: 'open', externalRef: `NW-${id}`, ...over,
});
const opts = { subsidiaryId: SUB, periodId: 9n, expenseAccountId: HOSTING.id, accruedLiabilitiesAccountId: ACCRUED.id };

describe('detectMissingAccruals', () => {
  it('proposes Dr Expense / Cr Accrued Liabilities reversing next month', () => {
    const out = detectMissingAccruals([b(2n, { billedAt: dateMicros(2026, 10, 3) })], SEP, opts);
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.kind).toBe('accrual');
    expect(p.reversesInYm).toEqual({ year: 2026, month: 10 });
    expect(p.billId).toBe(2n);
    expect(p.memo).toBe('Accrue NW-2 for 2026-09 services');
    expect(p.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor, l.vendorId])).toEqual([
      [HOSTING.id, 450_000n, 0n, 7n],
      [ACCRUED.id, 0n, 450_000n, 7n],
    ]);
    assertBalanced(p.lines);
  });

  it('skips bills dated inside the month, other service months, and already-accrued bills', () => {
    const bills = [
      b(1n, { billedAt: dateMicros(2026, 9, 30) }), // dated in month
      b(2n, { billedAt: dateMicros(2026, 10, 1) }), // first instant after month end -> accrue
      b(3n, { ym: { year: 2026, month: 8 }, billedAt: dateMicros(2026, 10, 1) }),
      b(4n, { billedAt: dateMicros(2026, 10, 2) }),
      b(5n, {}), // no billedAt: falls back to dueAt (Oct 30) -> accrue
    ];
    const out = detectMissingAccruals(bills, SEP, { ...opts, accruedBillIds: [4n] });
    expect(out.map((p) => p.billId)).toEqual([2n, 5n]);
  });

  it('edge: December close reverses in January and per-vendor expense accounts apply', () => {
    const out = detectMissingAccruals(
      [b(9n, { ym: { year: 2026, month: 12 }, billedAt: dateMicros(2027, 1, 5) })],
      { year: 2026, month: 12 },
      { ...opts, expenseAccountByVendor: new Map([[7n, 77n]]) },
    );
    expect(out[0]!.reversesInYm).toEqual({ year: 2027, month: 1 });
    expect(out[0]!.lines[0]!.accountId).toBe(77n);
  });
});
