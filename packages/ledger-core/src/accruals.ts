import { FX_SCALE } from './money.js';
import type { AccrualPayload, Bill, Ym } from './types.js';
import { ymAdd, ymEndMicros, ymEquals, ymToString } from './ym.js';

export interface AccrualOptions {
  subsidiaryId: bigint;
  /** Period id of the close month. */
  periodId: bigint;
  expenseAccountId: bigint;
  accruedLiabilitiesAccountId: bigint;
  /** Per-vendor expense account; falls back to expenseAccountId. */
  expenseAccountByVendor?: ReadonlyMap<bigint, bigint>;
  /** Bills that already have an accrual entry. */
  accruedBillIds?: Iterable<bigint>;
  ccy?: string;
  fxRateE6?: bigint;
}

/**
 * Bills for services in `closeYm` dated after that month ends (billedAt, else dueAt) with no accrual yet.
 * Each becomes an accrual proposal: Dr Expense / Cr Accrued Liabilities, reversing next month.
 * Output sorted by bill id.
 */
export function detectMissingAccruals(bills: readonly Bill[], closeYm: Ym, opts: AccrualOptions): AccrualPayload[] {
  const monthEnd = ymEndMicros(closeYm);
  const done = new Set(opts.accruedBillIds ?? []);
  const ccy = opts.ccy ?? 'USD';
  const fxRateE6 = opts.fxRateE6 ?? FX_SCALE;
  const reversesInYm = ymAdd(closeYm, 1);
  return bills
    .filter((b) => ymEquals(b.ym, closeYm) && (b.billedAt ?? b.dueAt) >= monthEnd && !done.has(b.id) && b.amountMinor > 0n)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((b) => ({
      kind: 'accrual' as const,
      subsidiaryId: opts.subsidiaryId,
      periodId: opts.periodId,
      memo: `Accrue ${b.externalRef || `bill ${b.id}`} for ${ymToString(closeYm)} services`,
      reversesInYm: { ...reversesInYm },
      billId: b.id,
      lines: [
        { accountId: opts.expenseAccountByVendor?.get(b.vendorId) ?? opts.expenseAccountId, debitMinor: b.amountMinor, creditMinor: 0n, ccy, fxRateE6, vendorId: b.vendorId },
        { accountId: opts.accruedLiabilitiesAccountId, debitMinor: 0n, creditMinor: b.amountMinor, ccy, fxRateE6, vendorId: b.vendorId },
      ],
    }));
}
