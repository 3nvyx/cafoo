import { describe, expect, it } from 'vitest';
import { accountBalances, balanceSheet, drilldown, incomeStatement, LedgerError, trialBalance } from '../src/index.js';
import { ACCOUNTS, AR, CASH, cr, DEFERRED, dr, EQUITY, HOSTING, post, REVENUE } from './fixtures.js';

const AUG = { year: 2026, month: 8 };
const SEP = { year: 2026, month: 9 };
const OCT = { year: 2026, month: 10 };
const DEC25 = { year: 2025, month: 12 };

const capital = post(DEC25, dr(CASH.id, 1_000_000n), cr(EQUITY.id, 1_000_000n));
const lastYearSale = post(DEC25, dr(CASH.id, 50_000n), cr(REVENUE.id, 50_000n));
const augInvoice = post(AUG, dr(AR.id, 120_000n), cr(DEFERRED.id, 120_000n));
const augRec = post(AUG, dr(DEFERRED.id, 10_000n), cr(REVENUE.id, 10_000n));
const sepRec = post(SEP, dr(DEFERRED.id, 10_000n), cr(REVENUE.id, 10_000n));
const sepHosting = post(SEP, dr(HOSTING.id, 3_333n), cr(CASH.id, 3_333n));
// EUR hosting bill: 20.00 EUR at 1.1 = 22.00 USD
const sepEur = post(SEP, dr(HOSTING.id, 2_000n, { ccy: 'EUR', fxRateE6: 1_100_000n }), cr(CASH.id, 2_200n));
const octRec = post(OCT, dr(DEFERRED.id, 10_000n), cr(REVENUE.id, 10_000n));
const LINES = [...capital, ...lastYearSale, ...augInvoice, ...augRec, ...sepRec, ...sepHosting, ...sepEur, ...octRec];

describe('balances', () => {
  it('account balances are normal-signed and carry line ids', () => {
    const rows = accountBalances(LINES, ACCOUNTS, { throughYm: SEP });
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(rows.map((r) => r.code)).toEqual(['1000', '1200', '2400', '3000', '4000', '6100']);
    expect(byCode['1000']!.balanceMinor).toBe(1_000_000n + 50_000n - 3_333n - 2_200n);
    expect(byCode['2400']!.balanceMinor).toBe(100_000n);
    expect(byCode['6100']!.balanceMinor).toBe(3_333n + 2_200n); // EUR line converted
    expect(byCode['4000']!.lineIds).toEqual([lastYearSale[1]!.id, augRec[1]!.id, sepRec[1]!.id]);
  });

  it('trial balance debits equal credits', () => {
    for (const through of [DEC25, AUG, SEP, OCT]) {
      const tb = trialBalance(LINES, ACCOUNTS, { throughYm: through });
      expect(tb.balanced).toBe(true);
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
      for (const r of tb.rows) expect(r.debitMinor === 0n || r.creditMinor === 0n).toBe(true);
    }
  });

  it('income statement over a month range', () => {
    const is = incomeStatement(LINES, ACCOUNTS, { fromYm: SEP, toYm: SEP });
    expect(is.totalRevenueMinor).toBe(10_000n);
    expect(is.totalExpensesMinor).toBe(5_533n);
    expect(is.netIncomeMinor).toBe(4_467n);
    expect(is.lineIds).toEqual([sepRec[1]!.id, sepHosting[0]!.id, sepEur[0]!.id].sort((a, b) => (a < b ? -1 : 1)));
    const ytd = incomeStatement(LINES, ACCOUNTS, { fromYm: { year: 2026, month: 1 }, toYm: OCT });
    expect(ytd.netIncomeMinor).toBe(30_000n - 5_533n);
  });

  it('balance sheet balances with retained earnings including current-period income', () => {
    for (const asOfYm of [DEC25, AUG, SEP, OCT]) {
      const bs = balanceSheet(LINES, ACCOUNTS, { asOfYm });
      expect(bs.balanced, `as of ${asOfYm.year}-${asOfYm.month}`).toBe(true);
      expect(bs.totalAssetsMinor).toBe(bs.totalLiabilitiesMinor + bs.totalEquityMinor);
    }
    const bs = balanceSheet(LINES, ACCOUNTS, { asOfYm: SEP });
    expect(bs.retainedEarnings.priorMinor).toBe(50_000n);
    expect(bs.retainedEarnings.currentYearNetIncomeMinor).toBe(20_000n - 5_533n);
    expect(bs.retainedEarnings.lineIds).toContain(sepRec[1]!.id);
    expect(bs.retainedEarnings.lineIds).not.toContain(octRec[1]!.id);
  });

  it('fiscal year start moves income between prior and current', () => {
    const bs = balanceSheet(LINES, ACCOUNTS, { asOfYm: SEP, fiscalYearStartMonth: 9 });
    expect(bs.retainedEarnings.priorMinor).toBe(60_000n);
    expect(bs.retainedEarnings.currentYearNetIncomeMinor).toBe(10_000n - 5_533n);
    expect(bs.balanced).toBe(true);
  });

  it('drilldown returns exactly the lines behind a month balance', () => {
    expect(drilldown(LINES, CASH.id, SEP)).toEqual([sepHosting[1]!.id, sepEur[1]!.id]);
    expect(drilldown(LINES, CASH.id, OCT)).toEqual([]);
  });

  it('subsidiary filter and unknown accounts', () => {
    expect(accountBalances(LINES, ACCOUNTS, { subsidiaryId: 2n })).toEqual([]);
    expect(() => accountBalances([{ ...LINES[0]!, accountId: 999n }], ACCOUNTS)).toThrow(LedgerError);
  });
});
