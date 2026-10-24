/**
 * Cafoo Inc's chart of accounts. Shared by the generator (which writes it into seed.json) and the loader (which checks
 * an existing database against it, so a stale seed.json cannot hide a missing account).
 * sortOrder is explicit and follows the account code, so adding an account never renumbers the others.
 */
export type SeedAccount = { code: string; name: string; accountType: string; isIntercompany: boolean; sortOrder: number };

const chart: [code: string, name: string, accountType: string, sortOrder: number][] = [
  ['1000', 'Cash', 'asset', 1000],
  ['1100', 'Accounts Receivable', 'asset', 1100],
  ['1150', 'Allowance for Doubtful Accounts', 'asset', 1150],
  ['1200', 'Prepaid Expenses', 'asset', 1200],
  ['1250', 'Receivable from Vendors', 'asset', 1250],
  ['1500', 'Equipment', 'asset', 1500],
  ['2000', 'Accounts Payable', 'liability', 2000],
  ['2100', 'Accrued Liabilities', 'liability', 2100],
  ['2400', 'Deferred Revenue', 'liability', 2400],
  ['3000', 'Common Stock', 'equity', 3000],
  ['3100', 'Retained Earnings', 'equity', 3100],
  ['4000', 'Subscription Revenue', 'revenue', 4000],
  ['4100', 'Usage Revenue', 'revenue', 4100],
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
];

export const ACCOUNTS: SeedAccount[] = chart.map(([code, name, accountType, sortOrder]) => ({ code, name, accountType, isIntercompany: false, sortOrder }));
