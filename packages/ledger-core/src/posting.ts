import { LedgerError } from './errors.js';
import { applyFx, formatMinorNumber } from './money.js';
import type {
  Account, AccountType, JournalEntry, JournalEntryInput, JournalLine, JournalLineInput, NormalBalance, Period, Ym,
} from './types.js';
import { ymToString } from './ym.js';

export function normalBalance(type: AccountType): NormalBalance {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** Net balance in the account's normal direction (positive = normal). */
export function signedBalance(type: AccountType, debitMinor: bigint, creditMinor: bigint): bigint {
  return normalBalance(type) === 'debit' ? debitMinor - creditMinor : creditMinor - debitMinor;
}

/** Debit and credit of one line in functional currency. */
export function functionalAmounts(line: JournalLineInput): { debitMinor: bigint; creditMinor: bigint } {
  return { debitMinor: applyFx(line.debitMinor, line.fxRateE6), creditMinor: applyFx(line.creditMinor, line.fxRateE6) };
}

/**
 * Throws LedgerError unless: at least two lines; each line has exactly one of debit/credit > 0,
 * neither negative, and a positive FX rate; functional debits equal functional credits.
 * Returns the functional totals.
 */
export function assertBalanced(lines: readonly JournalLineInput[]): { debitMinor: bigint; creditMinor: bigint } {
  if (lines.length < 2) {
    throw new LedgerError('too_few_lines', 'A journal entry needs at least two lines: something taken from and something given to.');
  }
  let debit = 0n;
  let credit = 0n;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (l.debitMinor < 0n || l.creditMinor < 0n) {
      throw new LedgerError('invalid_line', `Line ${n} has a negative amount; use the other side instead.`);
    }
    if (l.debitMinor > 0n && l.creditMinor > 0n) {
      throw new LedgerError('invalid_line', `Line ${n} has both a debit and a credit; each line must be one or the other.`);
    }
    if (l.debitMinor === 0n && l.creditMinor === 0n) {
      throw new LedgerError('invalid_line', `Line ${n} has no amount.`);
    }
    if (l.fxRateE6 <= 0n) {
      throw new LedgerError('invalid_line', `Line ${n} has an exchange rate of zero or less.`);
    }
    const f = functionalAmounts(l);
    debit += f.debitMinor;
    credit += f.creditMinor;
  });
  if (debit !== credit) {
    throw new LedgerError(
      'unbalanced',
      `This entry does not balance: debits total ${formatMinorNumber(debit)} but credits total ${formatMinorNumber(credit)} ` +
        `(off by ${formatMinorNumber(debit > credit ? debit - credit : credit - debit)}) after currency conversion.`,
    );
  }
  return { debitMinor: debit, creditMinor: credit };
}

/**
 * Full posting gate: the entry targets `period`, the period belongs to the same subsidiary and is open,
 * every account exists and belongs to the subsidiary, and the lines balance.
 */
export function validateEntry(
  entry: JournalEntryInput,
  period: Period,
  accountsById: ReadonlyMap<bigint, Account>,
): { debitMinor: bigint; creditMinor: bigint } {
  const when = ymToString({ year: period.year, month: period.month });
  if (entry.periodId !== period.id) {
    throw new LedgerError('wrong_period', `This entry is for a different period than ${when}.`);
  }
  if (period.subsidiaryId !== entry.subsidiaryId) {
    throw new LedgerError('wrong_subsidiary', `Period ${when} belongs to a different subsidiary than this entry.`);
  }
  if (period.status !== 'open') {
    throw new LedgerError('period_not_open', `Period ${when} is ${period.status}, so nothing new can be posted to it.`);
  }
  entry.lines.forEach((l, i) => {
    const acct = accountsById.get(l.accountId);
    if (!acct) throw new LedgerError('unknown_account', `Line ${i + 1} uses account ${l.accountId}, which does not exist.`);
    if (acct.subsidiaryId !== entry.subsidiaryId) {
      throw new LedgerError('wrong_subsidiary', `Line ${i + 1} uses account "${acct.name}", which belongs to a different subsidiary.`);
    }
  });
  return assertBalanced(entry.lines);
}

function stripPosted(l: JournalLineInput | JournalLine): JournalLineInput {
  const out: JournalLineInput = {
    accountId: l.accountId, debitMinor: l.debitMinor, creditMinor: l.creditMinor, ccy: l.ccy, fxRateE6: l.fxRateE6,
  };
  if (l.customerId !== undefined) out.customerId = l.customerId;
  if (l.vendorId !== undefined) out.vendorId = l.vendorId;
  if (l.memo !== undefined) out.memo = l.memo;
  return out;
}

/** The mirror entry: every debit becomes a credit and vice versa. Optionally lands in another period. */
export function reversalOf(
  entry: JournalEntryInput | JournalEntry,
  opts: { periodId?: bigint; memo?: string } = {},
): JournalEntryInput {
  const ref = 'id' in entry ? ` (entry ${entry.id})` : '';
  return {
    subsidiaryId: entry.subsidiaryId,
    periodId: opts.periodId ?? entry.periodId,
    memo: opts.memo ?? `Reversal of${ref}: ${entry.memo}`,
    lines: entry.lines.map((l) => ({ ...stripPosted(l), debitMinor: l.creditMinor, creditMinor: l.debitMinor })),
  };
}

/** Turn a validated input into a posted entry with sequential line ids starting at `firstLineId`. */
export function materializeEntry(
  input: JournalEntryInput,
  meta: { jeId: bigint; firstLineId: bigint; ym: Ym; postedAt: bigint; source: string },
): JournalEntry {
  return {
    id: meta.jeId,
    subsidiaryId: input.subsidiaryId,
    periodId: input.periodId,
    memo: input.memo,
    ym: { ...meta.ym },
    postedAt: meta.postedAt,
    source: meta.source,
    lines: input.lines.map((l, i) => ({
      ...stripPosted(l),
      id: meta.firstLineId + BigInt(i),
      jeId: meta.jeId,
      ym: { ...meta.ym },
      postedAt: meta.postedAt,
      source: meta.source,
    })),
  };
}
