import { materializeEntry } from '../src/posting.js';
import type { Account, AccountType, JournalEntryInput, JournalLine, JournalLineInput, Ym } from '../src/types.js';

export const SUB = 1n;
export const USD = 1_000_000n;

let nextId = 100n;
export function acct(id: bigint, code: string, name: string, type: AccountType, subsidiaryId = SUB): Account {
  return { id, subsidiaryId, code, name, type, isIntercompany: false };
}

export const CASH = acct(1n, '1000', 'Operating Cash', 'asset');
export const AR = acct(2n, '1200', 'Accounts Receivable', 'asset');
export const ALLOW = acct(3n, '1250', 'Allowance for Doubtful Accounts', 'asset');
export const AP = acct(4n, '2000', 'Accounts Payable', 'liability');
export const ACCRUED = acct(5n, '2100', 'Accrued Liabilities', 'liability');
export const DEFERRED = acct(6n, '2400', 'Deferred Revenue', 'liability');
export const EQUITY = acct(7n, '3000', 'Owner Capital', 'equity');
export const REVENUE = acct(8n, '4000', 'Subscription Revenue', 'revenue');
export const HOSTING = acct(9n, '6100', 'Hosting', 'expense');
export const BAD_DEBT = acct(10n, '6900', 'Bad Debt Expense', 'expense');
export const OTHER_SUB_CASH = acct(11n, '1000', 'Cash UK', 'asset', 2n);

export const ACCOUNTS = new Map<bigint, Account>(
  [CASH, AR, ALLOW, AP, ACCRUED, DEFERRED, EQUITY, REVENUE, HOSTING, BAD_DEBT, OTHER_SUB_CASH].map((a) => [a.id, a]),
);

export function dr(accountId: bigint, amount: bigint, extra: Partial<JournalLineInput> = {}): JournalLineInput {
  return { accountId, debitMinor: amount, creditMinor: 0n, ccy: 'USD', fxRateE6: USD, ...extra };
}
export function cr(accountId: bigint, amount: bigint, extra: Partial<JournalLineInput> = {}): JournalLineInput {
  return { accountId, debitMinor: 0n, creditMinor: amount, ccy: 'USD', fxRateE6: USD, ...extra };
}

export function entry(lines: JournalLineInput[], periodId = 1n, memo = 'test'): JournalEntryInput {
  return { subsidiaryId: SUB, periodId, memo, lines };
}

/** Post an input as lines in `ym` with fresh ids. */
export function post(ym: Ym, ...lines: JournalLineInput[]): JournalLine[] {
  const jeId = nextId++;
  const firstLineId = nextId;
  nextId += BigInt(lines.length);
  return materializeEntry(entry(lines), { jeId, firstLineId, ym, postedAt: 0n, source: 'test' }).lines;
}
