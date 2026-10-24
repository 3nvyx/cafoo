/** A three-company group mirroring the seed's §2.5 story: Cafoo Inc (USD, root), Cafoo Ltd (GBP), Group eliminations (USD). */
import type { Entity, FxRate } from '../src/index.js';
import { materializeEntry } from '../src/posting.js';
import type { Account, AccountType, JournalEntryInput, JournalLine, JournalLineInput, Ym } from '../src/types.js';

export const US = 1n;
export const UK = 2n;
export const ELIM = 3n;

export const ENTITIES: Entity[] = [
  { id: ELIM, code: 'ELIM', name: 'Group eliminations', functionalCcy: 'USD', parentId: US, isElimination: true },
  { id: UK, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: US, isElimination: false },
  { id: US, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', isElimination: false },
];

export const JUL: Ym = { year: 2026, month: 7 };
export const AUG: Ym = { year: 2026, month: 8 };
export const SEP: Ym = { year: 2026, month: 9 };
export const OCT: Ym = { year: 2026, month: 10 };
export const PERIOD: Record<number, bigint> = { 7: 7n, 8: 8n, 9: 9n, 10: 10n };

const IC = new Set(['1900', '1950', '2900', '2950', '4900', '5900']);
let nextAccount = 0n;
function a(subsidiaryId: bigint, code: string, name: string, type: AccountType): Account {
  nextAccount += 1n;
  return { id: subsidiaryId * 100n + nextAccount, subsidiaryId, code, name, type, isIntercompany: IC.has(code.split('-')[0]!) };
}

export const A = {
  cash: a(US, '1000', 'Cash', 'asset'),
  dueFrom: a(US, '1900', 'Due from Cafoo Ltd', 'asset'),
  loanTo: a(US, '1950', 'Loan to Cafoo Ltd', 'asset'),
  stock: a(US, '3000', 'Common Stock', 'equity'),
  revenue: a(US, '4000', 'Subscription Revenue', 'revenue'),
  icFees: a(US, '4900', 'Intercompany service fees', 'revenue'),
  payroll: a(US, '5300', 'Payroll', 'expense'),
  fx: a(US, '7100', 'FX gain or loss', 'expense'),
  ukCash: a(UK, '1000-UK', 'Cash', 'asset'),
  ukDueTo: a(UK, '2900-UK', 'Due to Cafoo Inc', 'liability'),
  ukLoanFrom: a(UK, '2950-UK', 'Loan from Cafoo Inc', 'liability'),
  ukCapital: a(UK, '3000-UK', 'Share Capital', 'equity'),
  ukRevenue: a(UK, '4000-UK', 'Subscription Revenue', 'revenue'),
  ukPayroll: a(UK, '5300-UK', 'Payroll', 'expense'),
  ukIcFees: a(UK, '5900-UK', 'Intercompany service fees', 'expense'),
  ukFx: a(UK, '7100-UK', 'FX gain or loss', 'expense'),
  elDueFrom: a(ELIM, '1900-ELIM', 'Due from Cafoo Ltd', 'asset'),
  elLoanTo: a(ELIM, '1950-ELIM', 'Loan to Cafoo Ltd', 'asset'),
  elDueTo: a(ELIM, '2900-ELIM', 'Due to Cafoo Inc', 'liability'),
  elLoanFrom: a(ELIM, '2950-ELIM', 'Loan from Cafoo Inc', 'liability'),
  elFees: a(ELIM, '4900-ELIM', 'Intercompany service fees', 'revenue'),
  elFeesPaid: a(ELIM, '5900-ELIM', 'Intercompany service fees', 'expense'),
};

export const ACCOUNTS: Account[] = Object.values(A);
export const ACCOUNTS_BY_ID = new Map(ACCOUNTS.map((x) => [x.id, x]));

function rate(fromCcy: string, toCcy: string, ym: Ym, average: bigint, closing: bigint): FxRate[] {
  return [
    { fromCcy, toCcy, ym, rateE6: average, kind: 'average' },
    { fromCcy, toCcy, ym, rateE6: closing, kind: 'closing' },
  ];
}

/** §2.5 rates. */
export const RATES: FxRate[] = [
  ...rate('GBP', 'USD', JUL, 1_250_000n, 1_250_000n), ...rate('USD', 'GBP', JUL, 800_000n, 800_000n),
  ...rate('GBP', 'USD', AUG, 1_250_000n, 1_250_000n), ...rate('USD', 'GBP', AUG, 800_000n, 800_000n),
  ...rate('GBP', 'USD', SEP, 1_270_000n, 1_280_000n), ...rate('USD', 'GBP', SEP, 787_402n, 781_250n),
  ...rate('GBP', 'USD', OCT, 1_280_000n, 1_280_000n), ...rate('USD', 'GBP', OCT, 781_250n, 781_250n),
];

export const USD_AVG: Record<number, bigint> = { 7: 800_000n, 8: 800_000n, 9: 787_402n, 10: 781_250n };

export function dr(acct: Account, amount: bigint, ccy?: string, fxRateE6 = 1_000_000n): JournalLineInput {
  return { accountId: acct.id, debitMinor: amount, creditMinor: 0n, ccy: ccy ?? (acct.subsidiaryId === UK ? 'GBP' : 'USD'), fxRateE6 };
}
export function cr(acct: Account, amount: bigint, ccy?: string, fxRateE6 = 1_000_000n): JournalLineInput {
  return { accountId: acct.id, debitMinor: 0n, creditMinor: amount, ccy: ccy ?? (acct.subsidiaryId === UK ? 'GBP' : 'USD'), fxRateE6 };
}

let nextId = 1000n;
export function post(subsidiaryId: bigint, ym: Ym, lines: JournalLineInput[], memo = 'test'): JournalLine[] {
  return postEntry({ subsidiaryId, periodId: PERIOD[ym.month]!, memo, lines }, ym);
}
export function postEntry(entry: JournalEntryInput, ym: Ym): JournalLine[] {
  const jeId = nextId++;
  const firstLineId = nextId;
  nextId += BigInt(entry.lines.length);
  return materializeEntry(entry, { jeId, firstLineId, ym, postedAt: 0n, source: 'test' }).lines;
}

/** Books through September: July and August consolidated, September before any revaluation or elimination. */
export function groupLines(opts: { serviceFees?: boolean } = {}): JournalLine[] {
  const fees = opts.serviceFees ?? true;
  const out: JournalLine[] = [
    ...post(US, JUL, [dr(A.cash, 50_000_000n), cr(A.stock, 50_000_000n)], 'US opening'),
    ...post(US, JUL, [dr(A.loanTo, 20_000_000n), cr(A.stock, 20_000_000n)], 'Loan to Cafoo Ltd'),
    ...post(UK, JUL, [dr(A.ukCash, 2_000_000n), cr(A.ukCapital, 2_000_000n)], 'UK opening'),
    ...post(UK, JUL, [dr(A.ukCash, 16_000_000n), cr(A.ukLoanFrom, 20_000_000n, 'USD', 800_000n)], 'Loan from Cafoo Inc'),
  ];
  for (const ym of [JUL, AUG, SEP]) {
    if (fees) {
      const avg = USD_AVG[ym.month]!;
      out.push(
        ...post(US, ym, [dr(A.dueFrom, 1_500_000n), cr(A.icFees, 1_500_000n)], 'Service fee'),
        ...post(UK, ym, [dr(A.ukIcFees, 1_500_000n, 'USD', avg), cr(A.ukDueTo, 1_500_000n, 'USD', avg)], 'Service fee'),
      );
      // Closed months were consolidated when they closed, as in the seed.
      if (ym.month < 9) out.push(...post(ELIM, ym, [dr(A.elFees, 1_500_000n), cr(A.elFeesPaid, 1_500_000n)], 'Closed-month service fee elimination'));
    }
    out.push(
      ...post(US, ym, [dr(A.cash, 5_000_000n), cr(A.revenue, 5_000_000n)], 'US revenue'),
      ...post(US, ym, [dr(A.payroll, 3_000_000n), cr(A.cash, 3_000_000n)], 'US payroll'),
      ...post(UK, ym, [dr(A.ukCash, 1_000_000n), cr(A.ukRevenue, 1_000_000n)], 'UK revenue'),
      ...post(UK, ym, [dr(A.ukPayroll, 800_000n), cr(A.ukCash, 800_000n)], 'UK payroll'),
    );
  }
  return out;
}

export const UK_ENTITY = ENTITIES.find((e) => e.id === UK)!;
export const US_ENTITY = ENTITIES.find((e) => e.id === US)!;
export const ELIM_ENTITY = ENTITIES.find((e) => e.id === ELIM)!;
