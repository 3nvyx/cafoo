import { describe, expect, it } from 'vitest';
import { exactAmount } from '../src/snapshot';

// Only the fields exactAmount reads; the rest of the ledger-core shapes do not matter here.
const s = {
  bankTxs: [
    { id: 1n, amountMinor: 762000n },
    { id: 2n, amountMinor: -1240000n },
    { id: 3n, amountMinor: 754380n },
  ],
  invoices: [{ id: 68n, amountMinor: 762000n }],
  bills: [{ id: 7n, amountMinor: 1240000n }],
} as unknown as Parameters<typeof exactAmount>[1];

describe('exactAmount: only cent-exact candidates become bank matches', () => {
  it('accepts a payment that equals its invoice or bill', () => {
    expect(exactAmount({ bankTxId: 1n, targetKind: 'invoice', targetId: 68n }, s)).toBe(true);
    expect(exactAmount({ bankTxId: 2n, targetKind: 'bill', targetId: 7n }, s)).toBe(true);
  });
  it('refuses a near-amount (short or partial) payment and unknown rows', () => {
    expect(exactAmount({ bankTxId: 3n, targetKind: 'invoice', targetId: 68n }, s)).toBe(false);
    expect(exactAmount({ bankTxId: 9n, targetKind: 'invoice', targetId: 68n }, s)).toBe(false);
    expect(exactAmount({ bankTxId: 1n, targetKind: 'je', targetId: 68n }, s)).toBe(false);
  });
});
