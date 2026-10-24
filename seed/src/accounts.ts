/**
 * The group's charts of accounts: Cafoo Inc (US, the root, bare codes), Cafoo Ltd (UK, `<code>-UK`) and the group
 * eliminations company (ELIM, `<code>-ELIM`). Shared by the generator (which writes them into seed.json) and the loader
 * (which checks an existing database against them, so a stale seed.json cannot hide a missing account).
 * sortOrder is explicit and follows the group code, so adding an account never renumbers the others.
 * Intercompany group codes mirror each other: 1900 due from / 2900 due to, 1950 loan to / 2950 loan from,
 * 4900 service fees charged / 5900 service fees paid. 7100 FX gain or loss takes revaluation differences.
 */
export type SeedAccount = { code: string; name: string; accountType: string; isIntercompany: boolean; sortOrder: number };

const chart: [code: string, name: string, accountType: string, sortOrder: number][] = [
  ['1000', 'Cash', 'asset', 1000],
  ['1100', 'Accounts Receivable', 'asset', 1100],
  ['1150', 'Allowance for Doubtful Accounts', 'asset', 1150],
  ['1200', 'Prepaid Expenses', 'asset', 1200],
  ['1250', 'Receivable from Vendors', 'asset', 1250],
  ['1500', 'Equipment', 'asset', 1500],
  ['1900', 'Due from Cafoo Ltd', 'asset', 1900],
  ['1950', 'Loan to Cafoo Ltd', 'asset', 1950],
  ['2000', 'Accounts Payable', 'liability', 2000],
  ['2100', 'Accrued Liabilities', 'liability', 2100],
  ['2400', 'Deferred Revenue', 'liability', 2400],
  ['3000', 'Common Stock', 'equity', 3000],
  ['3100', 'Retained Earnings', 'equity', 3100],
  ['4000', 'Subscription Revenue', 'revenue', 4000],
  ['4100', 'Usage Revenue', 'revenue', 4100],
  ['4900', 'Intercompany service fees', 'revenue', 4900],
  ['5000', 'Hosting & Infrastructure', 'expense', 5000],
  ['5100', 'Software & Tools', 'expense', 5100],
  ['5200', 'Contractors', 'expense', 5200],
  ['5300', 'Payroll', 'expense', 5300],
  ['5400', 'Marketing', 'expense', 5400],
  ['5500', 'Rent & Office', 'expense', 5500],
  ['5600', 'Professional Services', 'expense', 5600],
  ['5700', 'Bad Debt Expense', 'expense', 5700],
  ['5800', 'Travel', 'expense', 5800],
  ['6000', 'Bank Fees', 'expense', 6000],
  ['7100', 'FX gain or loss', 'expense', 7100],
];

/** Group codes that only ever hold balances with other group companies. */
const INTERCOMPANY = new Set(['1900', '1950', '2900', '2950', '4900', '5900']);

const accounts = (rows: typeof chart, suffix = ''): SeedAccount[] =>
  rows.map(([code, name, accountType, sortOrder]) => ({ code: code + suffix, name, accountType, isIntercompany: INTERCOMPANY.has(code), sortOrder }));

/** Cafoo Inc (US), the root company: bare codes. */
export const ACCOUNTS: SeedAccount[] = accounts(chart);

/** Cafoo Ltd (UK, pounds). */
export const UK_ACCOUNTS: SeedAccount[] = accounts(
  [
    ['1000', 'Cash', 'asset', 1000],
    ['1100', 'Accounts Receivable', 'asset', 1100],
    ['2000', 'Accounts Payable', 'liability', 2000],
    ['2900', 'Due to Cafoo Inc', 'liability', 2900],
    ['2950', 'Loan from Cafoo Inc', 'liability', 2950],
    ['3000', 'Share Capital', 'equity', 3000],
    ['3100', 'Retained Earnings', 'equity', 3100],
    ['4000', 'Subscription Revenue', 'revenue', 4000],
    ['5300', 'Payroll', 'expense', 5300],
    ['5500', 'Rent & Office', 'expense', 5500],
    ['5900', 'Intercompany service fees', 'expense', 5900],
    ['7100', 'FX gain or loss', 'expense', 7100],
  ],
  '-UK'
);

/** Group eliminations (ELIM, dollars): intercompany accounts only, never trades. */
export const ELIM_ACCOUNTS: SeedAccount[] = accounts(
  [
    ['1900', 'Due from Cafoo Ltd', 'asset', 1900],
    ['1950', 'Loan to Cafoo Ltd', 'asset', 1950],
    ['2900', 'Due to Cafoo Inc', 'liability', 2900],
    ['2950', 'Loan from Cafoo Inc', 'liability', 2950],
    ['4900', 'Intercompany service fees', 'revenue', 4900],
    ['5900', 'Intercompany service fees', 'expense', 5900],
  ],
  '-ELIM'
);
