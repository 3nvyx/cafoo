import type { Contract, ContractItem, Invoice, Ym } from './types.js';
import { DAY_MICROS, ymAdd, ymRange, ymWithin } from './ym.js';

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ARR per customer in month `ym`: 12 * sum(priceMinor * qty) over subscription items of contracts
 * active that month (startYm..endYm inclusive). Usage items are excluded. Customers with 0 are omitted.
 */
export function customerArr(contracts: readonly Contract[], items: readonly ContractItem[], ym: Ym): Map<bigint, bigint> {
  const byContract = new Map<bigint, Contract>();
  for (const c of contracts) byContract.set(c.id, c);
  const out = new Map<bigint, bigint>();
  for (const it of items) {
    if (it.kind !== 'subscription') continue;
    const c = byContract.get(it.contractId);
    if (!c || !ymWithin(ym, c.startYm, c.endYm)) continue;
    out.set(c.customerId, (out.get(c.customerId) ?? 0n) + it.priceMinor * it.qty * 12n);
  }
  for (const [k, v] of [...out]) if (v === 0n) out.delete(k);
  return out;
}

export type ArrMovementKind = 'new' | 'expansion' | 'contraction' | 'churn';

export interface ArrMovement {
  customerId: bigint;
  kind: ArrMovementKind;
  /** Signed change in ARR. */
  deltaMinor: bigint;
}

export interface ArrWaterfallRow {
  ym: Ym;
  startingMinor: bigint;
  newMinor: bigint;
  expansionMinor: bigint;
  /** Positive magnitude. */
  contractionMinor: bigint;
  /** Positive magnitude. */
  churnMinor: bigint;
  /** starting + new + expansion - contraction - churn */
  endingMinor: bigint;
  /** Per-customer drill-down, ascending customer id. */
  movements: ArrMovement[];
}

/**
 * Monthly ARR bridge for fromYm..toYm. Starting = ARR of the prior month. A customer going from 0 to
 * positive is new (including returning customers); positive to 0 is churn.
 */
export function arrWaterfall(
  contracts: readonly Contract[],
  items: readonly ContractItem[],
  fromYm: Ym,
  toYm: Ym,
): ArrWaterfallRow[] {
  let prev = customerArr(contracts, items, ymAdd(fromYm, -1));
  return ymRange(fromYm, toYm).map((ym) => {
    const cur = customerArr(contracts, items, ym);
    const ids = [...new Set([...prev.keys(), ...cur.keys()])].sort(cmpBig);
    const row: ArrWaterfallRow = {
      ym, startingMinor: 0n, newMinor: 0n, expansionMinor: 0n, contractionMinor: 0n, churnMinor: 0n, endingMinor: 0n, movements: [],
    };
    for (const id of ids) {
      const p = prev.get(id) ?? 0n;
      const c = cur.get(id) ?? 0n;
      row.startingMinor += p;
      row.endingMinor += c;
      if (p === c) continue;
      const deltaMinor = c - p;
      const kind: ArrMovementKind = p === 0n ? 'new' : c === 0n ? 'churn' : c > p ? 'expansion' : 'contraction';
      if (kind === 'new') row.newMinor += deltaMinor;
      else if (kind === 'expansion') row.expansionMinor += deltaMinor;
      else if (kind === 'contraction') row.contractionMinor -= deltaMinor;
      else row.churnMinor -= deltaMinor;
      row.movements.push({ customerId: id, kind, deltaMinor });
    }
    prev = cur;
    return row;
  });
}

export interface NrrResult {
  cohortStartYm: Ym;
  toYm: Ym;
  /** Customers with ARR > 0 in cohortStartYm, ascending. */
  cohortCustomerIds: bigint[];
  startingArrMinor: bigint;
  /** ARR of the same customers in toYm (new customers excluded). */
  endingArrMinor: bigint;
  /** floor(ending * 10000 / starting); null when the cohort has no ARR. */
  nrrBp: number | null;
}

export function nrr(
  contracts: readonly Contract[],
  items: readonly ContractItem[],
  cohortStartYm: Ym,
  toYm: Ym,
): NrrResult {
  const start = customerArr(contracts, items, cohortStartYm);
  const end = customerArr(contracts, items, toYm);
  const ids = [...start.keys()].sort(cmpBig);
  let s = 0n;
  let e = 0n;
  for (const id of ids) {
    s += start.get(id)!;
    e += end.get(id) ?? 0n;
  }
  return {
    cohortStartYm,
    toYm,
    cohortCustomerIds: ids,
    startingArrMinor: s,
    endingArrMinor: e,
    nrrBp: s === 0n ? null : Number((e * 10000n) / s),
  };
}

export type AgingBucketKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export interface AgingBucket {
  key: AgingBucketKey;
  label: string;
  amountMinor: bigint;
  invoiceIds: bigint[];
}

export interface AgingReport {
  asOf: bigint;
  buckets: AgingBucket[];
  totalMinor: bigint;
}

const BUCKETS: readonly [AgingBucketKey, string][] = [
  ['current', 'Current'],
  ['d1_30', '1-30 days'],
  ['d31_60', '31-60 days'],
  ['d61_90', '61-90 days'],
  ['d90_plus', 'Over 90 days'],
];

/** Days past due = floor((asOf - dueAt) / 1 day); <= 0 is current. Paid invoices are excluded. */
export function daysPastDue(dueAt: bigint, asOf: bigint): number {
  return asOf <= dueAt ? 0 : Number((asOf - dueAt) / DAY_MICROS);
}

export function agingBucketFor(days: number): AgingBucketKey {
  return days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
}

/** Open receivables by age at `asOf` (micros). Always returns all five buckets in order. */
export function aging(invoices: readonly Invoice[], asOf: bigint): AgingReport {
  const buckets: AgingBucket[] = BUCKETS.map(([key, label]) => ({ key, label, amountMinor: 0n, invoiceIds: [] }));
  const idx = new Map(buckets.map((b, i) => [b.key, i] as const));
  let total = 0n;
  for (const inv of invoices) {
    if (inv.status === 'paid') continue;
    const b = buckets[idx.get(agingBucketFor(daysPastDue(inv.dueAt, asOf)))!]!;
    b.amountMinor += inv.amountMinor;
    b.invoiceIds.push(inv.id);
    total += inv.amountMinor;
  }
  for (const b of buckets) b.invoiceIds.sort(cmpBig);
  return { asOf, buckets, totalMinor: total };
}
