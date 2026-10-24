import { describe, expect, it } from 'vitest';
import { aging, arrWaterfall, dateMicros, nrr, ymToString } from '../src/index.js';
import type { Contract, ContractItem, Invoice } from '../src/index.js';

const c = (id: bigint, customerId: bigint, start: [number, number], end: [number, number]): Contract => ({
  id, customerId, startYm: { year: start[0], month: start[1] }, endYm: { year: end[0], month: end[1] }, totalMinor: 0n, plan: 'annual',
});
const subItem = (id: bigint, contractId: bigint, priceMinor: bigint, qty = 1n): ContractItem => ({ id, contractId, kind: 'subscription', priceMinor, qty, sspMinor: 1n });

// Customer 1: 1,000/mo Jan-Dec, renews at 1,500/mo from next Jan (expansion).
// Customer 2: 2,000/mo Jan-Jun, then churns.
// Customer 3: starts Mar at 500/mo x 2 seats, drops to 1 seat from Jul (contraction).
// Usage items never count.
const contracts = [
  c(1n, 1n, [2026, 1], [2026, 12]), c(2n, 1n, [2027, 1], [2027, 12]),
  c(3n, 2n, [2026, 1], [2026, 6]),
  c(4n, 3n, [2026, 3], [2026, 6]), c(5n, 3n, [2026, 7], [2027, 6]),
];
const items: ContractItem[] = [
  subItem(1n, 1n, 1_000n), subItem(2n, 2n, 1_500n), subItem(3n, 3n, 2_000n), subItem(4n, 4n, 500n, 2n), subItem(5n, 5n, 500n, 1n),
  { id: 6n, contractId: 1n, kind: 'usage', priceMinor: 999n, qty: 999n, sspMinor: 1n },
];

describe('arrWaterfall', () => {
  const rows = arrWaterfall(contracts, items, { year: 2026, month: 1 }, { year: 2027, month: 1 });

  it('every row bridges starting to ending and chains month to month', () => {
    for (const [i, r] of rows.entries()) {
      expect(r.startingMinor + r.newMinor + r.expansionMinor - r.contractionMinor - r.churnMinor).toBe(r.endingMinor);
      if (i > 0) expect(r.startingMinor).toBe(rows[i - 1]!.endingMinor);
    }
  });

  it('classifies new, contraction, churn and expansion', () => {
    const by = Object.fromEntries(rows.map((r) => [ymToString(r.ym), r]));
    expect(by['2026-01']).toMatchObject({ startingMinor: 0n, newMinor: 36_000n, endingMinor: 36_000n });
    expect(by['2026-03']!.newMinor).toBe(12_000n);
    expect(by['2026-07']).toMatchObject({ churnMinor: 24_000n, contractionMinor: 6_000n, endingMinor: 18_000n });
    expect(by['2026-07']!.movements).toEqual([
      { customerId: 2n, kind: 'churn', deltaMinor: -24_000n },
      { customerId: 3n, kind: 'contraction', deltaMinor: -6_000n },
    ]);
    expect(by['2027-01']).toMatchObject({ expansionMinor: 6_000n, endingMinor: 24_000n });
    expect(by['2026-02']!.movements).toEqual([]);
  });
});

describe('nrr', () => {
  it('measures the starting cohort only', () => {
    const r = nrr(contracts, items, { year: 2026, month: 1 }, { year: 2027, month: 1 });
    expect(r.cohortCustomerIds).toEqual([1n, 2n]);
    expect(r.startingArrMinor).toBe(36_000n);
    expect(r.endingArrMinor).toBe(18_000n); // customer 3 is not in the cohort
    expect(r.nrrBp).toBe(5000);
  });

  it('edge: empty cohort yields null', () => {
    expect(nrr(contracts, items, { year: 2025, month: 1 }, { year: 2026, month: 1 }).nrrBp).toBeNull();
  });
});

describe('aging', () => {
  const asOf = dateMicros(2026, 10, 1);
  const inv = (id: bigint, due: bigint, amountMinor = 100n, status: Invoice['status'] = 'open'): Invoice => ({ id, customerId: 1n, ym: { year: 2026, month: 9 }, amountMinor, dueAt: due, status });
  const DAY = 86_400_000_000n;

  it('buckets by days past due at the boundaries', () => {
    const r = aging([
      inv(1n, asOf + DAY), inv(2n, asOf), inv(3n, asOf - DAY), inv(4n, asOf - 30n * DAY), inv(5n, asOf - 31n * DAY),
      inv(6n, asOf - 60n * DAY), inv(7n, asOf - 61n * DAY), inv(8n, asOf - 90n * DAY), inv(9n, asOf - 91n * DAY, 500n, 'overdue'),
      inv(10n, asOf - 400n * DAY, 999n, 'paid'),
    ], asOf);
    expect(r.buckets.map((b) => [b.key, b.invoiceIds])).toEqual([
      ['current', [1n, 2n]], ['d1_30', [3n, 4n]], ['d31_60', [5n, 6n]], ['d61_90', [7n, 8n]], ['d90_plus', [9n]],
    ]);
    expect(r.totalMinor).toBe(1_300n);
    expect(r.buckets.reduce((s, b) => s + b.amountMinor, 0n)).toBe(r.totalMinor);
  });

  it('edge: less than a full day late is still current', () => {
    expect(aging([inv(1n, asOf - DAY + 1n)], asOf).buckets[0]!.invoiceIds).toEqual([1n]);
  });
});
