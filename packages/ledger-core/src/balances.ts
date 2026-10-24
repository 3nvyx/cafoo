import { LedgerError } from './errors.js';
import { functionalAmounts, signedBalance } from './posting.js';
import type { Account, AccountType, JournalLine, Ym } from './types.js';
import { ymCompare, ymEquals, ymWithin } from './ym.js';

export interface BalanceOptions {
  /** Inclusive lower bound. */
  fromYm?: Ym;
  /** Inclusive upper bound. */
  throughYm?: Ym;
  /** Restrict to accounts of one subsidiary. */
  subsidiaryId?: bigint;
}

export interface AccountBalanceRow {
  accountId: bigint;
  code: string;
  name: string;
  type: AccountType;
  /** Functional-currency totals. */
  debitMinor: bigint;
  creditMinor: bigint;
  /** Net in the account's normal direction; positive = normal balance. */
  balanceMinor: bigint;
  lineIds: bigint[];
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Per-account functional totals. Rows sorted by code then id; line ids ascending. */
export function accountBalances(
  lines: readonly JournalLine[],
  accountsById: ReadonlyMap<bigint, Account>,
  opts: BalanceOptions = {},
): AccountBalanceRow[] {
  const rows = new Map<bigint, AccountBalanceRow>();
  for (const l of lines) {
    const acct = accountsById.get(l.accountId);
    if (!acct) throw new LedgerError('unknown_account', `Journal line ${l.id} uses account ${l.accountId}, which does not exist.`);
    if (opts.subsidiaryId !== undefined && acct.subsidiaryId !== opts.subsidiaryId) continue;
    if (!ymWithin(l.ym, opts.fromYm, opts.throughYm)) continue;
    let row = rows.get(acct.id);
    if (!row) {
      row = { accountId: acct.id, code: acct.code, name: acct.name, type: acct.type, debitMinor: 0n, creditMinor: 0n, balanceMinor: 0n, lineIds: [] };
      rows.set(acct.id, row);
    }
    const f = functionalAmounts(l);
    row.debitMinor += f.debitMinor;
    row.creditMinor += f.creditMinor;
    row.lineIds.push(l.id);
  }
  const out = [...rows.values()];
  for (const r of out) {
    r.balanceMinor = signedBalance(r.type, r.debitMinor, r.creditMinor);
    r.lineIds.sort(cmpBig);
  }
  return out.sort((a, b) => cmpStr(a.code, b.code) || cmpBig(a.accountId, b.accountId));
}

export interface TrialBalanceRow {
  accountId: bigint;
  code: string;
  name: string;
  type: AccountType;
  /** Net shown on one side; the other is 0n. */
  debitMinor: bigint;
  creditMinor: bigint;
  lineIds: bigint[];
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitMinor: bigint;
  totalCreditMinor: bigint;
  /** True whenever every posted entry balanced. */
  balanced: boolean;
}

export function trialBalance(
  lines: readonly JournalLine[],
  accountsById: ReadonlyMap<bigint, Account>,
  opts: BalanceOptions = {},
): TrialBalance {
  let td = 0n;
  let tc = 0n;
  const rows = accountBalances(lines, accountsById, opts).map((r) => {
    const net = r.debitMinor - r.creditMinor;
    const debitMinor = net > 0n ? net : 0n;
    const creditMinor = net < 0n ? -net : 0n;
    td += debitMinor;
    tc += creditMinor;
    return { accountId: r.accountId, code: r.code, name: r.name, type: r.type, debitMinor, creditMinor, lineIds: r.lineIds };
  });
  return { rows, totalDebitMinor: td, totalCreditMinor: tc, balanced: td === tc };
}

export interface IncomeStatement {
  fromYm: Ym;
  toYm: Ym;
  revenue: AccountBalanceRow[];
  expenses: AccountBalanceRow[];
  totalRevenueMinor: bigint;
  totalExpensesMinor: bigint;
  netIncomeMinor: bigint;
  lineIds: bigint[];
}

function mergeIds(rows: readonly { lineIds: bigint[] }[]): bigint[] {
  return rows.flatMap((r) => r.lineIds).sort(cmpBig);
}

/** Revenue and expense activity for fromYm..toYm inclusive. */
export function incomeStatement(
  lines: readonly JournalLine[],
  accountsById: ReadonlyMap<bigint, Account>,
  opts: { fromYm: Ym; toYm: Ym; subsidiaryId?: bigint },
): IncomeStatement {
  const rows = accountBalances(lines, accountsById, { fromYm: opts.fromYm, throughYm: opts.toYm, subsidiaryId: opts.subsidiaryId });
  const revenue = rows.filter((r) => r.type === 'revenue');
  const expenses = rows.filter((r) => r.type === 'expense');
  const totalRevenueMinor = revenue.reduce((s, r) => s + r.balanceMinor, 0n);
  const totalExpensesMinor = expenses.reduce((s, r) => s + r.balanceMinor, 0n);
  return {
    fromYm: opts.fromYm,
    toYm: opts.toYm,
    revenue,
    expenses,
    totalRevenueMinor,
    totalExpensesMinor,
    netIncomeMinor: totalRevenueMinor - totalExpensesMinor,
    lineIds: mergeIds([...revenue, ...expenses]),
  };
}

export interface RetainedEarnings {
  /** Net income of fiscal years before the one containing asOfYm. */
  priorMinor: bigint;
  /** Net income from fiscal-year start through asOfYm (includes the current period). */
  currentYearNetIncomeMinor: bigint;
  totalMinor: bigint;
  lineIds: bigint[];
}

export interface BalanceSheet {
  asOfYm: Ym;
  assets: AccountBalanceRow[];
  liabilities: AccountBalanceRow[];
  /** Posted equity accounts only; retained earnings are computed separately. */
  equity: AccountBalanceRow[];
  retainedEarnings: RetainedEarnings;
  totalAssetsMinor: bigint;
  totalLiabilitiesMinor: bigint;
  /** Equity accounts plus retained earnings. */
  totalEquityMinor: bigint;
  /** assets = liabilities + equity + retained earnings. */
  balanced: boolean;
}

/** Cumulative position at the end of asOfYm. */
export function balanceSheet(
  lines: readonly JournalLine[],
  accountsById: ReadonlyMap<bigint, Account>,
  opts: { asOfYm: Ym; subsidiaryId?: bigint; fiscalYearStartMonth?: number },
): BalanceSheet {
  const fsm = opts.fiscalYearStartMonth ?? 1;
  const fyStart: Ym = { year: opts.asOfYm.month >= fsm ? opts.asOfYm.year : opts.asOfYm.year - 1, month: fsm };
  const rows = accountBalances(lines, accountsById, { throughYm: opts.asOfYm, subsidiaryId: opts.subsidiaryId });
  const assets = rows.filter((r) => r.type === 'asset');
  const liabilities = rows.filter((r) => r.type === 'liability');
  const equity = rows.filter((r) => r.type === 'equity');

  let prior = 0n;
  let current = 0n;
  const reIds: bigint[] = [];
  for (const l of lines) {
    const acct = accountsById.get(l.accountId)!;
    if (acct.type !== 'revenue' && acct.type !== 'expense') continue;
    if (opts.subsidiaryId !== undefined && acct.subsidiaryId !== opts.subsidiaryId) continue;
    if (ymCompare(l.ym, opts.asOfYm) > 0) continue;
    const f = functionalAmounts(l);
    const ni = f.creditMinor - f.debitMinor;
    if (ymCompare(l.ym, fyStart) < 0) prior += ni;
    else current += ni;
    reIds.push(l.id);
  }
  reIds.sort(cmpBig);
  const sum = (rs: AccountBalanceRow[]) => rs.reduce((s, r) => s + r.balanceMinor, 0n);
  const totalAssetsMinor = sum(assets);
  const totalLiabilitiesMinor = sum(liabilities);
  const totalEquityMinor = sum(equity) + prior + current;
  return {
    asOfYm: opts.asOfYm,
    assets,
    liabilities,
    equity,
    retainedEarnings: { priorMinor: prior, currentYearNetIncomeMinor: current, totalMinor: prior + current, lineIds: reIds },
    totalAssetsMinor,
    totalLiabilitiesMinor,
    totalEquityMinor,
    balanced: totalAssetsMinor === totalLiabilitiesMinor + totalEquityMinor,
  };
}

/** Line ids posted to `accountId` in month `ym`, ascending. */
export function drilldown(lines: readonly JournalLine[], accountId: bigint, ym: Ym): bigint[] {
  return lines.filter((l) => l.accountId === accountId && ymEquals(l.ym, ym)).map((l) => l.id).sort(cmpBig);
}
