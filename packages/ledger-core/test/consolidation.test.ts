import { describe, expect, it } from 'vitest';
import {
  assertBalanced, consolidate, consolidationWireJson, eliminations, foreignBalances, formatMinor, fxRevaluationPayload, IC_PAIRS,
  icEliminationPayload, LedgerError, parseProposalPayload, revaluation, serializeProposalPayload, translateBooks,
} from '../src/index.js';
import type { ConsolidatedRow, JournalLine } from '../src/index.js';
import {
  A, ACCOUNTS, ACCOUNTS_BY_ID, ELIM, ELIM_ENTITY, ENTITIES, groupLines, OCT, PERIOD, postEntry, RATES, SEP, UK, UK_ENTITY, US, US_ENTITY,
} from './group.js';

const BASE = groupLines();

function reval(lines: readonly JournalLine[] = BASE, rates = RATES) {
  return revaluation({ entity: UK_ENTITY, lines, accountsById: ACCOUNTS_BY_ID, rates, ym: SEP, periodId: PERIOD[9]!, fxGainLossAccountId: A.ukFx.id });
}
function elims(lines: readonly JournalLine[] = BASE) {
  return eliminations({ entities: ENTITIES, accounts: ACCOUNTS, lines, rates: RATES, reportingCcy: 'USD', ym: SEP, periodId: PERIOD[9]! });
}
/** BASE plus the September revaluation and both eliminations, as if all were approved. */
function closedSeptember(): JournalLine[] {
  const r = reval();
  const e = elims();
  return [...BASE, ...postEntry(r.entry!, SEP), ...postEntry(e.balance.entry!, SEP), ...postEntry(e.activity.entry!, SEP)];
}
const row = (rows: readonly ConsolidatedRow[], gc: string) => rows.find((r) => r.groupCode === gc)!;

describe('foreignBalances', () => {
  it('lists only balance-sheet accounts holding a foreign currency, with raw and booked amounts', () => {
    expect(foreignBalances(BASE, ACCOUNTS_BY_ID, { entity: UK_ENTITY, throughYm: SEP })).toEqual([
      { accountId: A.ukDueTo.id, code: '2900-UK', ccy: 'USD', txnBalanceMinor: -4_500_000n, bookedFunctionalMinor: -3_581_103n },
      { accountId: A.ukLoanFrom.id, code: '2950-UK', ccy: 'USD', txnBalanceMinor: -20_000_000n, bookedFunctionalMinor: -16_000_000n },
    ]);
  });

  it('respects the month bound and ignores other subsidiaries', () => {
    const aug = foreignBalances(BASE, ACCOUNTS_BY_ID, { entity: UK_ENTITY, throughYm: { year: 2026, month: 8 } });
    expect(aug.find((f) => f.code === '2900-UK')).toMatchObject({ txnBalanceMinor: -3_000_000n, bookedFunctionalMinor: -2_400_000n });
    expect(foreignBalances(BASE, ACCOUNTS_BY_ID, { entity: US_ENTITY, throughYm: SEP })).toEqual([]);
  });
});

describe('revaluation', () => {
  it('restates the dollar balances at the September closing rate: a £4,404.78 gain', () => {
    const r = reval();
    expect(r.items.map((i) => [i.code, i.closingRateE6, i.targetFunctionalMinor, i.deltaMinor])).toEqual([
      ['2900-UK', 781_250n, -3_515_625n, 65_478n],
      ['2950-UK', 781_250n, -15_625_000n, 375_000n],
    ]);
    expect(formatMinor(r.items[0]!.deltaMinor, 'GBP')).toBe('£654.78');
    expect(formatMinor(r.items[1]!.deltaMinor, 'GBP')).toBe('£3,750.00');
    expect(r.gainMinor).toBe(440_478n);
    expect(formatMinor(r.gainMinor, 'GBP')).toBe('£4,404.78');
    expect(r.entry).toEqual({
      subsidiaryId: UK,
      periodId: 9n,
      memo: 'Revalue Cafoo Ltd dollar balances at the September 2026 closing rate',
      lines: [
        { accountId: A.ukDueTo.id, debitMinor: 65_478n, creditMinor: 0n, ccy: 'GBP', fxRateE6: 1_000_000n },
        { accountId: A.ukLoanFrom.id, debitMinor: 375_000n, creditMinor: 0n, ccy: 'GBP', fxRateE6: 1_000_000n },
        { accountId: A.ukFx.id, debitMinor: 0n, creditMinor: 440_478n, ccy: 'GBP', fxRateE6: 1_000_000n },
      ],
    });
    expect(assertBalanced(r.entry!.lines).debitMinor).toBe(440_478n);
  });

  it('is idempotent: once posted, the next run moves nothing', () => {
    const first = reval();
    const again = reval([...BASE, ...postEntry(first.entry!, SEP)]);
    expect(again.items.every((i) => i.deltaMinor === 0n)).toBe(true);
    expect(again.entry).toBeNull();
    expect(again.gainMinor).toBe(0n);
    expect(fxRevaluationPayload(again)).toBeNull();
  });

  it('books a loss on FX gain or loss when the dollar strengthens', () => {
    const rates = RATES.map((x) => (x.fromCcy === 'USD' && x.kind === 'closing' && x.ym.month === 9 ? { ...x, rateE6: 820_000n } : x));
    const r = reval(BASE, rates);
    expect(r.gainMinor).toBe(-(3_690_000n - 3_581_103n) - (16_400_000n - 16_000_000n));
    const fxLine = r.entry!.lines.find((l) => l.accountId === A.ukFx.id)!;
    expect(fxLine.debitMinor).toBe(-r.gainMinor);
    expect(assertBalanced(r.entry!.lines).debitMinor).toBeGreaterThan(0n);
  });

  it('derives the closing rate from the inverse and refuses when none is recorded', () => {
    const noDirect = RATES.filter((x) => !(x.fromCcy === 'USD' && x.ym.month === 9));
    expect(reval(BASE, noDirect).gainMinor).toBe(440_478n);
    const none = noDirect.filter((x) => !(x.ym.month === 9 && x.kind === 'closing'));
    expect(() => reval(BASE, none)).toThrow(expect.objectContaining({ code: 'missing_rate' }));
  });

  it('refuses an FX gain or loss account of another subsidiary', () => {
    expect(() =>
      revaluation({ entity: UK_ENTITY, lines: BASE, accountsById: ACCOUNTS_BY_ID, rates: RATES, ym: SEP, periodId: 9n, fxGainLossAccountId: A.fx.id }),
    ).toThrow(expect.objectContaining({ code: 'wrong_subsidiary' }));
  });
});

describe('eliminations', () => {
  it('removes the $245,000 the companies owe each other with $0.00 difference, reversing in October', () => {
    const { balance } = elims();
    expect(balance.pairs.map((p) => [p.label, p.sourceCode, p.counterCode, p.amountMinor, p.counterTranslatedMinor, p.differenceMinor])).toEqual([
      ['Intercompany balance', '1900', '2900-UK', 4_500_000n, 4_500_000n, 0n],
      ['Loan', '1950', '2950-UK', 20_000_000n, 20_000_000n, 0n],
    ]);
    expect(balance.pairs.reduce((s, p) => s + p.amountMinor, 0n)).toBe(24_500_000n);
    expect(balance.reversesInYm).toEqual(OCT);
    expect(balance.entry).toEqual({
      subsidiaryId: ELIM,
      periodId: 9n,
      memo: 'Remove balances Cafoo Inc and Cafoo Ltd owe each other at the end of September 2026',
      lines: [
        { accountId: A.elDueTo.id, debitMinor: 4_500_000n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1_000_000n },
        { accountId: A.elDueFrom.id, debitMinor: 0n, creditMinor: 4_500_000n, ccy: 'USD', fxRateE6: 1_000_000n },
        { accountId: A.elLoanFrom.id, debitMinor: 20_000_000n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1_000_000n },
        { accountId: A.elLoanTo.id, debitMinor: 0n, creditMinor: 20_000_000n, ccy: 'USD', fxRateE6: 1_000_000n },
      ],
    });
  });

  it("removes the month's $15,000 of service fees; the pound side translates to $15,000.01 at the average rate", () => {
    const { activity } = elims();
    expect(activity.pairs).toHaveLength(1);
    expect(activity.pairs[0]).toMatchObject({ label: 'Service fees', amountMinor: 1_500_000n, counterTranslatedMinor: 1_500_001n, differenceMinor: -1n });
    expect(activity.reversesInYm).toBeUndefined();
    expect(activity.entry!.memo).toBe('Remove September 2026 service fees between Cafoo Inc and Cafoo Ltd');
    expect(activity.entry!.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      [A.elFees.id, 1_500_000n, 0n],
      [A.elFeesPaid.id, 0n, 1_500_000n],
    ]);
  });

  it('compares against the balance after revaluation whether or not the revaluation is posted yet', () => {
    const posted = [...BASE, ...postEntry(reval().entry!, SEP)];
    expect(elims(posted).balance.pairs).toEqual(elims().balance.pairs);
  });

  it('reports a real mismatch as a difference and still balances on the source amount', () => {
    const extra = postEntry({ subsidiaryId: US, periodId: 9n, memo: 'one-sided', lines: [
      { accountId: A.dueFrom.id, debitMinor: 100_000n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1_000_000n },
      { accountId: A.cash.id, debitMinor: 0n, creditMinor: 100_000n, ccy: 'USD', fxRateE6: 1_000_000n },
    ] }, SEP);
    const pair = elims([...BASE, ...extra]).balance.pairs[0]!;
    expect(pair).toMatchObject({ amountMinor: 4_600_000n, counterTranslatedMinor: 4_500_000n, differenceMinor: 100_000n });
  });

  it('needs exactly one elimination company and a source side in the reporting currency', () => {
    const noElim = ENTITIES.filter((e) => !e.isElimination);
    expect(() => eliminations({ entities: noElim, accounts: ACCOUNTS, lines: BASE, rates: RATES, reportingCcy: 'USD', ym: SEP, periodId: 9n })).toThrow(LedgerError);
    const reversed = [{ label: 'Loan', basis: 'balance' as const, sourceGroupCode: '2950', counterGroupCode: '1950' }];
    expect(() => eliminations({ entities: ENTITIES, accounts: ACCOUNTS, lines: BASE, rates: RATES, reportingCcy: 'USD', ym: SEP, periodId: 9n, pairs: reversed })).toThrow('reporting currency');
  });

  it('pairs the 1900/2900, 1950/2950 and 4900/5900 group codes', () => {
    expect(IC_PAIRS.map((p) => `${p.label}:${p.basis}:${p.sourceGroupCode}/${p.counterGroupCode}`)).toEqual([
      'Intercompany balance:balance:1900/2900',
      'Loan:balance:1950/2950',
      'Service fees:activity:4900/5900',
    ]);
  });
});

describe('translateBooks', () => {
  it('translates a reporting-currency company 1:1 with no CTA', () => {
    const t = translateBooks({ entity: US_ENTITY, accounts: ACCOUNTS, lines: BASE, rates: [], reportingCcy: 'USD', asOfYm: SEP });
    expect(t.rows.every((r) => r.reportingMinor === r.functionalMinor)).toBe(true);
    expect(t.ctaMinor).toBe(0n);
    expect(t.balanced).toBe(true);
    expect(t.netIncomeMonthMinor).toBe(5_000_000n + 1_500_000n - 3_000_000n);
  });

  it('uses closing, average and historical rates and balances through a computed CTA', () => {
    const t = translateBooks({ entity: UK_ENTITY, accounts: ACCOUNTS, lines: closedSeptember(), rates: RATES, reportingCcy: 'USD', asOfYm: SEP });
    const by = (code: string) => t.rows.find((r) => r.code === code)!;
    expect(by('1000-UK')).toMatchObject({ method: 'closing', functionalMinor: 18_600_000n, reportingMinor: 23_808_000n });
    expect(by('2950-UK')).toMatchObject({ method: 'closing', functionalMinor: 15_625_000n, reportingMinor: 20_000_000n });
    expect(by('2900-UK')).toMatchObject({ method: 'closing', functionalMinor: 3_515_625n, reportingMinor: 4_500_000n });
    expect(by('3000-UK')).toMatchObject({ method: 'historical', functionalMinor: 2_000_000n, reportingMinor: 2_500_000n });
    expect(by('5900-UK')).toMatchObject({ method: 'average', functionalMinor: 3_581_103n, reportingMinor: 1_500_000n + 1_500_000n + 1_500_001n });
    expect(t.monthRows.find((r) => r.code === '7100-UK')).toMatchObject({ functionalMinor: -440_478n, reportingMinor: -559_407n });
    expect(t.netIncomeMonthMinor).toBe(1_270_000n - 1_016_000n - 1_500_001n + 559_407n);
    expect(t.retainedEarningsMinor).toBe(-1_250_000n - 1_250_000n + t.netIncomeMonthMinor);
    expect(t.ctaMinor).toBe(23_808_000n - 24_500_000n - 2_500_000n - t.retainedEarningsMinor);
    expect(t.ctaMinor).toBe(-5_406n);
    expect(t.balanced).toBe(true);
  });

  it('needs no rate for a company with no books yet', () => {
    const t = translateBooks({ entity: UK_ENTITY, accounts: ACCOUNTS, lines: BASE, rates: [], reportingCcy: 'USD', asOfYm: { year: 2026, month: 6 } });
    expect(t.rows).toEqual([]);
    expect(t.balanced).toBe(true);
  });

  it('reports unbalanced books as unbalanced, even though the CTA plug makes the translated totals agree', () => {
    const lopsided = postEntry({ subsidiaryId: UK, periodId: 9n, memo: 'one-sided', lines: [
      { accountId: A.ukCash.id, debitMinor: 100n, creditMinor: 0n, ccy: 'GBP', fxRateE6: 1_000_000n },
      { accountId: A.ukRevenue.id, debitMinor: 0n, creditMinor: 1n, ccy: 'GBP', fxRateE6: 1_000_000n },
    ] }, SEP);
    const uk = translateBooks({ entity: UK_ENTITY, accounts: ACCOUNTS, lines: [...BASE, ...lopsided], rates: RATES, reportingCcy: 'USD', asOfYm: SEP });
    expect(uk.totals.assetsMinor).toBe(uk.totals.liabilitiesMinor + uk.totals.equityMinor);
    expect(uk.balanced).toBe(false);
    const usLopsided = postEntry({ subsidiaryId: US, periodId: 9n, memo: 'one-sided', lines: [
      { accountId: A.cash.id, debitMinor: 100n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1_000_000n },
      { accountId: A.revenue.id, debitMinor: 0n, creditMinor: 1n, ccy: 'USD', fxRateE6: 1_000_000n },
    ] }, SEP);
    const us = translateBooks({ entity: US_ENTITY, accounts: ACCOUNTS, lines: [...BASE, ...usLopsided], rates: [], reportingCcy: 'USD', asOfYm: SEP });
    expect(us.ctaMinor).toBe(99n);
    expect(us.balanced).toBe(false);
    const c = consolidate({ entities: ENTITIES, accounts: ACCOUNTS, lines: [...BASE, ...lopsided], rates: RATES, reportingCcy: 'USD', asOfYm: SEP });
    expect(c.balanceSheet.totals.assetsMinor).toBe(c.balanceSheet.totals.liabilitiesMinor + c.balanceSheet.totals.equityMinor);
    expect(c.balanceSheet.balanced).toBe(false);
  });

  it('throws missing_rate when a month with activity has no average rate', () => {
    const rates = RATES.filter((r) => !(r.ym.month === 8 && r.kind === 'average'));
    expect(() => translateBooks({ entity: UK_ENTITY, accounts: ACCOUNTS, lines: BASE, rates, reportingCcy: 'USD', asOfYm: SEP })).toThrow(expect.objectContaining({ code: 'missing_rate' }));
  });
});

describe('consolidate', () => {
  it('balances before eliminations and shows what is still owed inside the group', () => {
    const c = consolidate({ entities: ENTITIES, accounts: ACCOUNTS, lines: BASE, rates: RATES, reportingCcy: 'USD', asOfYm: SEP });
    expect(c.balanceSheet.balanced).toBe(true);
    expect(c.entities.map((e) => e.code)).toEqual(['US', 'UK', 'ELIM']);
    const nullRoot = ENTITIES.map((e) => (e.id === US ? { ...e, parentId: null } : e));
    expect(consolidate({ entities: nullRoot, accounts: ACCOUNTS, lines: BASE, rates: RATES, reportingCcy: 'USD', asOfYm: SEP }).entities.map((e) => e.code)).toEqual(['US', 'UK', 'ELIM']);
    expect(row(c.incomeStatement.month, '4900').consolidatedMinor).toBe(1_500_000n);
    expect(c.unmatchedIcMinor).toBeGreaterThan(24_500_000n);
  });

  it('after the revaluation and eliminations: intercompany balances are gone and the service fee nets to the one-cent translation residue', () => {
    const c = consolidate({ entities: ENTITIES, accounts: ACCOUNTS, lines: closedSeptember(), rates: RATES, reportingCcy: 'USD', asOfYm: SEP });
    for (const gc of ['1900', '1950', '2900', '2950']) expect(row(c.balanceSheet.rows, gc).consolidatedMinor, gc).toBe(0n);
    const fees = row(c.incomeStatement.month, '4900');
    expect(fees.byEntity.get(US)).toBe(1_500_000n);
    expect(fees.eliminationsMinor).toBe(-1_500_000n);
    expect(fees.consolidatedMinor).toBe(0n);
    const paid = row(c.incomeStatement.month, '5900');
    expect(paid.byEntity.get(UK)).toBe(1_500_001n);
    expect(paid.consolidatedMinor).toBe(1n);
    expect(row(c.incomeStatement.ytd, '4900')).toMatchObject({ eliminationsMinor: -4_500_000n, consolidatedMinor: 0n });
    expect(row(c.incomeStatement.ytd, '5900')).toMatchObject({ eliminationsMinor: -4_500_000n, consolidatedMinor: 1n });
    expect(c.unmatchedIcMinor).toBe(1n);
    expect(c.balanceSheet.balanced).toBe(true);
    expect(c.balanceSheet.ctaMinor).toBe(-5_406n);
    expect(c.balanceSheet.ctaByEntity.get(US)).toBe(0n);
    expect(c.balanceSheet.totals.assetsMinor).toBe(c.balanceSheet.totals.liabilitiesMinor + c.balanceSheet.totals.equityMinor);
  });

  it('sums every company, eliminations included, and keeps the drill-down to journal lines', () => {
    const lines = closedSeptember();
    const c = consolidate({ entities: ENTITIES, accounts: ACCOUNTS, lines, rates: RATES, reportingCcy: 'USD', asOfYm: SEP });
    const sum = (m: Map<bigint, bigint>) => [...m.values()].reduce((s, v) => s + v, 0n);
    expect(c.incomeStatement.netIncomeMonthMinor).toBe(sum(c.incomeStatement.netIncomeMonthByEntity));
    expect(c.incomeStatement.netIncomeYtdMinor).toBe(sum(c.incomeStatement.netIncomeYtdByEntity));
    expect(c.balanceSheet.retainedEarningsMinor).toBe(sum(c.balanceSheet.retainedEarningsByEntity));
    expect(c.incomeStatement.netIncomeMonthByEntity.get(ELIM)).toBe(0n);
    const paidIds = row(c.incomeStatement.month, '5900').lineIds;
    const expected = lines.filter((l) => l.ym.month === 9 && (l.accountId === A.ukIcFees.id || l.accountId === A.elFeesPaid.id)).map((l) => l.id);
    expect(paidIds).toEqual(expected.sort((x, y) => (x < y ? -1 : 1)));
  });

  it('refuses lines on unknown accounts', () => {
    expect(() => consolidate({ entities: ENTITIES, accounts: ACCOUNTS, lines: [{ ...BASE[0]!, accountId: 999n }], rates: RATES, reportingCcy: 'USD', asOfYm: SEP })).toThrow(LedgerError);
  });
});

describe('consolidation payloads', () => {
  const loanOnly = groupLines({ serviceFees: false });

  it('build the module wire form of the plan (§2.3) for a loan-only group', () => {
    const r = revaluation({ entity: UK_ENTITY, lines: loanOnly, accountsById: ACCOUNTS_BY_ID, rates: RATES, ym: SEP, periodId: 9n, fxGainLossAccountId: A.ukFx.id });
    expect(consolidationWireJson(fxRevaluationPayload(r)!, ACCOUNTS_BY_ID)).toEqual({
      subsidiaryId: '2', periodYm: '2026-09', rateYm: '2026-09', memo: 'Revalue Cafoo Ltd dollar balances at the September 2026 closing rate',
      items: [{ accountCode: '2950-UK', ccy: 'USD', txnBalanceMinor: '-20000000', closingRateE6: '781250', bookedFunctionalMinor: '-16000000', targetFunctionalMinor: '-15625000', deltaMinor: '375000' }],
      lines: [
        { accountCode: '2950-UK', debitMinor: '375000', creditMinor: '0', ccy: 'GBP', fxRateE6: '1000000' },
        { accountCode: '7100-UK', debitMinor: '0', creditMinor: '375000', ccy: 'GBP', fxRateE6: '1000000' },
      ],
    });
    const e = eliminations({ entities: ENTITIES, accounts: ACCOUNTS, lines: loanOnly, rates: RATES, reportingCcy: 'USD', ym: SEP, periodId: 9n });
    expect(e.activity.entry).toBeNull();
    expect(icEliminationPayload(e.activity)).toBeNull();
    expect(JSON.stringify(consolidationWireJson(icEliminationPayload(e.balance)!, ACCOUNTS_BY_ID))).toBe(
      '{"subsidiaryId":"3","periodYm":"2026-09","memo":"Remove balances Cafoo Inc and Cafoo Ltd owe each other at the end of September 2026","basis":"balance","reversesInYm":"2026-10",' +
        '"pairs":[{"label":"Loan","sourceSubsidiaryId":"1","sourceAccountCode":"1950","counterSubsidiaryId":"2","counterAccountCode":"2950-UK","amountMinor":"20000000","counterTranslatedMinor":"20000000","differenceMinor":"0"}],' +
        '"lines":[{"accountCode":"2950-ELIM","debitMinor":"20000000","creditMinor":"0","ccy":"USD","fxRateE6":"1000000"},{"accountCode":"1950-ELIM","debitMinor":"0","creditMinor":"20000000","ccy":"USD","fxRateE6":"1000000"}]}',
    );
  });

  it('round-trip through the ledger-core wire JSON', () => {
    const r = fxRevaluationPayload(reval())!;
    const { balance, activity } = elims();
    for (const p of [r, icEliminationPayload(balance)!, icEliminationPayload(activity)!]) {
      expect(parseProposalPayload(serializeProposalPayload(p))).toEqual(p);
    }
    expect(ELIM_ENTITY.isElimination).toBe(true);
  });
});
