import { LedgerError } from './errors.js';
import { allocateLargestRemainder, FX_SCALE } from './money.js';
import type { Contract, ContractItem, JournalEntryInput, JournalLineInput, RevenueScheduleLine, UsageRecord, Ym } from './types.js';
import { ymCompare, ymDiff, ymEquals, ymRange, ymToString } from './ym.js';

/**
 * Revenue schedule for one contract item.
 * - subscription: straight-line over startYm..endYm inclusive; every month gets floor(total / months),
 *   the last month also gets the remainder. Total defaults to priceMinor * qty * months; pass
 *   `allocatedMinor` (from allocateBySsp) for multi-item contracts.
 * - usage: one line per usage month = sum(quantity * unitPriceMinor), sorted by month.
 * Lines always sum exactly to the total.
 */
export function buildRevenueSchedule(
  item: ContractItem,
  contract: Contract,
  usage: readonly UsageRecord[] = [],
  opts: { allocatedMinor?: bigint } = {},
): RevenueScheduleLine[] {
  if (item.contractId !== contract.id) {
    throw new LedgerError('invalid_input', `Contract item ${item.id} does not belong to contract ${contract.id}.`);
  }
  if (ymCompare(contract.endYm, contract.startYm) < 0) {
    throw new LedgerError('invalid_input', `Contract ${contract.id} ends before it starts.`);
  }
  if (item.kind === 'usage') {
    const byYm = new Map<string, { ym: Ym; amount: bigint }>();
    for (const u of usage) {
      if (u.contractItemId !== item.id) continue;
      if (u.quantity < 0n || u.unitPriceMinor < 0n) {
        throw new LedgerError('invalid_input', `Usage for item ${item.id} in ${ymToString(u.ym)} is negative.`);
      }
      const k = ymToString(u.ym);
      const cur = byYm.get(k) ?? { ym: { ...u.ym }, amount: 0n };
      cur.amount += u.quantity * u.unitPriceMinor;
      byYm.set(k, cur);
    }
    return [...byYm.values()]
      .sort((a, b) => ymCompare(a.ym, b.ym))
      .map((e) => ({ contractItemId: item.id, ym: e.ym, amountMinor: e.amount, recognized: false }));
  }
  const months = ymRange(contract.startYm, contract.endYm);
  const n = BigInt(months.length);
  const total = opts.allocatedMinor ?? item.priceMinor * item.qty * n;
  if (total < 0n) throw new LedgerError('invalid_input', `Contract item ${item.id} has a negative amount to recognize.`);
  const per = total / n;
  const remainder = total - per * n;
  return months.map((ym, i) => ({
    contractItemId: item.id,
    ym,
    amountMinor: i === months.length - 1 ? per + remainder : per,
    recognized: false,
  }));
}

/** Allocate a contract's transaction price across items by relative SSP (largest remainder; exact sum). */
export function allocateBySsp(
  items: readonly ContractItem[],
  totalMinor: bigint,
): { contractItemId: bigint; allocatedMinor: bigint }[] {
  const shares = allocateLargestRemainder(totalMinor, items.map((i) => i.sspMinor));
  return items.map((i, k) => ({ contractItemId: i.id, allocatedMinor: shares[k]! }));
}

export interface RecognitionAccounts {
  subsidiaryId: bigint;
  periodId: bigint;
  deferredRevenueAccountId: bigint;
  revenueAccountId: bigint;
  ccy?: string;
  fxRateE6?: bigint;
  customerId?: bigint;
}

/**
 * Dr Deferred Revenue (one line, total) / Cr Revenue (one line per contract item, ascending item id)
 * for the unrecognized schedule lines of a single month. Null when there is nothing to recognize.
 */
export function recognitionEntry(
  linesForYm: readonly RevenueScheduleLine[],
  accounts: RecognitionAccounts,
): JournalEntryInput | null {
  const pending = linesForYm.filter((l) => !l.recognized && l.amountMinor !== 0n);
  if (pending.length === 0) return null;
  const ym = pending[0]!.ym;
  if (pending.some((l) => !ymEquals(l.ym, ym))) {
    throw new LedgerError('invalid_input', 'A recognition entry covers one month; these schedule lines span several.');
  }
  if (pending.some((l) => l.amountMinor < 0n)) {
    throw new LedgerError('invalid_input', 'Revenue schedule lines cannot be negative.');
  }
  const byItem = new Map<bigint, bigint>();
  for (const l of pending) byItem.set(l.contractItemId, (byItem.get(l.contractItemId) ?? 0n) + l.amountMinor);
  const ccy = accounts.ccy ?? 'USD';
  const fxRateE6 = accounts.fxRateE6 ?? FX_SCALE;
  const extra = accounts.customerId !== undefined ? { customerId: accounts.customerId } : {};
  let total = 0n;
  const credits: JournalLineInput[] = [...byItem.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([itemId, amt]) => {
      total += amt;
      return { accountId: accounts.revenueAccountId, debitMinor: 0n, creditMinor: amt, ccy, fxRateE6, memo: `Contract item ${itemId}`, ...extra };
    });
  return {
    subsidiaryId: accounts.subsidiaryId,
    periodId: accounts.periodId,
    memo: `Recognize revenue for ${ymToString(ym)}`,
    lines: [{ accountId: accounts.deferredRevenueAccountId, debitMinor: total, creditMinor: 0n, ccy, fxRateE6, ...extra }, ...credits],
  };
}

export interface DeferredRevenueRollforward {
  openingMinor: bigint;
  billingsMinor: bigint;
  recognizedMinor: bigint;
  /** opening + billings - recognized */
  closingMinor: bigint;
  ledgerBalanceMinor: bigint | null;
  /** ledger - closing; 0n when no ledger balance was given. */
  mismatchMinor: bigint;
  reconciled: boolean;
}

export function deferredRevenueRollforward(input: {
  openingMinor: bigint;
  billingsMinor: bigint;
  recognizedMinor: bigint;
  ledgerBalanceMinor?: bigint;
}): DeferredRevenueRollforward {
  const closingMinor = input.openingMinor + input.billingsMinor - input.recognizedMinor;
  const ledger = input.ledgerBalanceMinor ?? null;
  const mismatchMinor = ledger === null ? 0n : ledger - closingMinor;
  return {
    openingMinor: input.openingMinor,
    billingsMinor: input.billingsMinor,
    recognizedMinor: input.recognizedMinor,
    closingMinor,
    ledgerBalanceMinor: ledger,
    mismatchMinor,
    reconciled: mismatchMinor === 0n,
  };
}

/** Months in a contract term, inclusive. */
export function contractMonths(contract: Contract): number {
  return ymDiff(contract.startYm, contract.endYm) + 1;
}
