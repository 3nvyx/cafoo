/**
 * The group seed (seed/src/group.ts) run through this engine: the September figures the demo promises must come out
 * of the real seed data to the cent, not only out of hand-made fixtures.
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNTS as US_ACCOUNTS, ELIM_ACCOUNTS, UK_ACCOUNTS } from '../../../seed/src/accounts';
import { buildGroup } from '../../../seed/src/group';
import {
  assertBalanced, consolidate, eliminations, formatMinor, groupCode, materializeEntry, revaluation, ymFromString,
} from '../src/index.js';
import type { Account, AccountType, Entity, FxRate, JournalLine } from '../src/index.js';

const SEP = { year: 2026, month: 9 };
const group = buildGroup(SEP);
const ENTITIES: Entity[] = [
  { id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', isElimination: false },
  ...group.subsidiaries.map((s, i) => ({ id: BigInt(i + 2), code: s.code, name: s.name, functionalCcy: s.functionalCcy, parentId: 1n, isElimination: s.isElimination })),
];
const subId = (code: string) => ENTITIES.find((e) => e.code === code)!.id;
const ACCOUNTS: Account[] = [...US_ACCOUNTS.map((a) => ({ ...a, subsidiaryCode: 'US' })), ...group.accounts].map((a, i) => ({
  id: BigInt(i + 1), subsidiaryId: subId(a.subsidiaryCode), code: a.code, name: a.name, type: a.accountType as AccountType, isIntercompany: a.isIntercompany,
}));
const byCode = new Map(ACCOUNTS.map((a) => [a.code, a]));
const BY_ID = new Map(ACCOUNTS.map((a) => [a.id, a]));
const RATES: FxRate[] = group.fxRates.map((r) => ({ fromCcy: r.fromCcy, toCcy: r.toCcy, ym: ymFromString(r.ym), rateE6: BigInt(r.rateE6), kind: r.kind }));
const PERIOD = (ym: string) => BigInt(ym.replace('-', ''));

let nextId = 1n;
const LINES: JournalLine[] = group.journalEntries.flatMap((je) => {
  const entry = {
    subsidiaryId: subId(je.subsidiaryCode),
    periodId: PERIOD(je.periodYm),
    memo: je.memo,
    lines: je.lines.map((l) => ({ accountId: byCode.get(l.accountCode)!.id, debitMinor: BigInt(l.debitMinor), creditMinor: BigInt(l.creditMinor), ccy: l.ccy, fxRateE6: BigInt(l.fxRateE6) })),
  };
  const jeId = nextId++;
  const firstLineId = nextId;
  nextId += BigInt(entry.lines.length);
  return materializeEntry(entry, { jeId, firstLineId, ym: ymFromString(je.periodYm), postedAt: 0n, source: 'seed' }).lines;
});

describe('group seed', () => {
  it('has the §2.5 charts: intercompany and FX accounts in every company', () => {
    const codes = (rows: { code: string; isIntercompany: boolean }[], ic: boolean) => rows.filter((a) => a.isIntercompany === ic).map((a) => a.code);
    expect(codes(US_ACCOUNTS, true)).toEqual(['1900', '1950', '4900']);
    expect(US_ACCOUNTS.find((a) => a.code === '7100')).toMatchObject({ accountType: 'expense', isIntercompany: false });
    expect(UK_ACCOUNTS.map((a) => a.code)).toEqual(['1000-UK', '1100-UK', '2000-UK', '2900-UK', '2950-UK', '3000-UK', '3100-UK', '4000-UK', '5300-UK', '5500-UK', '5900-UK', '7100-UK']);
    expect(codes(UK_ACCOUNTS, true)).toEqual(['2900-UK', '2950-UK', '5900-UK']);
    expect(codes(ELIM_ACCOUNTS, true)).toEqual(['1900-ELIM', '1950-ELIM', '2900-ELIM', '2950-ELIM', '4900-ELIM', '5900-ELIM']);
    expect(codes(ELIM_ACCOUNTS, false)).toEqual([]);
    expect(group.subsidiaries).toEqual([
      { code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentCode: 'US', isElimination: false },
      { code: 'ELIM', name: 'Group eliminations', functionalCcy: 'USD', parentCode: 'US', isElimination: true },
    ]);
  });

  it('records the plan rates and is the same on every build', () => {
    const rate = (from: string, ym: string, kind: string) => group.fxRates.find((r) => r.fromCcy === from && r.ym === ym && r.kind === kind)?.rateE6;
    expect([rate('GBP', '2026-07', 'average'), rate('USD', '2026-08', 'closing')]).toEqual(['1250000', '800000']);
    expect([rate('GBP', '2026-09', 'average'), rate('GBP', '2026-09', 'closing'), rate('USD', '2026-09', 'average'), rate('USD', '2026-09', 'closing')]).toEqual(['1270000', '1280000', '787402', '781250']);
    expect([rate('GBP', '2026-10', 'closing'), rate('USD', '2026-10', 'average')]).toEqual(['1280000', '781250']);
    expect(buildGroup(SEP)).toEqual(group);
  });

  it('posts only balanced entries, on accounts of the entry company, at a recorded rate for the month', () => {
    for (const je of group.journalEntries) {
      const sub = ENTITIES.find((e) => e.code === je.subsidiaryCode)!;
      const lines = je.lines.map((l) => ({ accountId: byCode.get(l.accountCode)!.id, debitMinor: BigInt(l.debitMinor), creditMinor: BigInt(l.creditMinor), ccy: l.ccy, fxRateE6: BigInt(l.fxRateE6) }));
      expect(() => assertBalanced(lines), je.memo).not.toThrow();
      for (const l of je.lines) {
        expect(byCode.get(l.accountCode)!.subsidiaryId, `${je.memo} ${l.accountCode}`).toBe(sub.id);
        if (l.ccy === sub.functionalCcy) expect(l.fxRateE6).toBe('1000000');
        else expect(group.fxRates.some((r) => r.fromCcy === l.ccy && r.toCcy === sub.functionalCcy && r.ym === je.periodYm && r.rateE6 === l.fxRateE6), `${je.memo} ${l.accountCode}`).toBe(true);
      }
    }
    expect(group.bankTransactions.every((t) => t.matched && t.subsidiaryCode === 'UK' && t.ccy === 'GBP')).toBe(true);
    expect(group.invoices.every((i) => i.status === 'paid')).toBe(true);
  });

  it('gives the September revaluation of £4,404.78 (£3,750.00 on the loan, £654.78 on the service fees owed)', () => {
    const r = revaluation({ entity: ENTITIES[1]!, lines: LINES, accountsById: BY_ID, rates: RATES, ym: SEP, periodId: PERIOD('2026-09'), fxGainLossAccountId: byCode.get('7100-UK')!.id });
    expect(r.items.map((i) => [i.code, i.txnBalanceMinor, i.bookedFunctionalMinor, formatMinor(i.deltaMinor, 'GBP')])).toEqual([
      ['2900-UK', -4_500_000n, -3_581_103n, '£654.78'],
      ['2950-UK', -20_000_000n, -16_000_000n, '£3,750.00'],
    ]);
    expect(formatMinor(r.gainMinor, 'GBP')).toBe('£4,404.78');
  });

  it('gives eliminations of $245,000 (balance, $0.00 differences) and $15,000 (activity, one cent of translation rounding)', () => {
    const e = eliminations({ entities: ENTITIES, accounts: ACCOUNTS, lines: LINES, rates: RATES, reportingCcy: group.reportingCcy, ym: SEP, periodId: PERIOD('2026-09') });
    expect(formatMinor(e.balance.pairs.reduce((s, p) => s + p.amountMinor, 0n), 'USD')).toBe('$245,000.00');
    expect(e.balance.pairs.map((p) => p.differenceMinor)).toEqual([0n, 0n]);
    expect(e.activity.pairs.map((p) => [formatMinor(p.amountMinor, 'USD'), formatMinor(p.counterTranslatedMinor, 'USD'), p.differenceMinor])).toEqual([['$15,000.00', '$15,000.01', -1n]]);
    expect(e.balance.entry!.subsidiaryId).toBe(subId('ELIM'));
    const elimLines = [...e.balance.entry!.lines, ...e.activity.entry!.lines].map((l) => BY_ID.get(l.accountId)!);
    expect(elimLines.every((a) => a.isIntercompany && a.subsidiaryId === subId('ELIM'))).toBe(true);
    expect(elimLines.map((a) => groupCode(a.code))).toEqual(['2900', '1900', '2950', '1950', '4900', '5900']);
  });

  it('consolidates to a balanced group with intercompany balances removed once September is closed', () => {
    const r = revaluation({ entity: ENTITIES[1]!, lines: LINES, accountsById: BY_ID, rates: RATES, ym: SEP, periodId: PERIOD('2026-09'), fxGainLossAccountId: byCode.get('7100-UK')!.id });
    const e = eliminations({ entities: ENTITIES, accounts: ACCOUNTS, lines: LINES, rates: RATES, reportingCcy: 'USD', ym: SEP, periodId: PERIOD('2026-09') });
    const post = (entry: NonNullable<typeof r.entry>) => {
      const jeId = nextId++;
      const firstLineId = nextId;
      nextId += BigInt(entry.lines.length);
      return materializeEntry(entry, { jeId, firstLineId, ym: SEP, postedAt: 0n, source: 'test' }).lines;
    };
    const lines = [...LINES, ...post(r.entry!), ...post(e.balance.entry!), ...post(e.activity.entry!)];
    const before = consolidate({ entities: ENTITIES, accounts: ACCOUNTS, lines: LINES, rates: RATES, reportingCcy: 'USD', asOfYm: SEP });
    const after = consolidate({ entities: ENTITIES, accounts: ACCOUNTS, lines, rates: RATES, reportingCcy: 'USD', asOfYm: SEP });
    expect(before.balanceSheet.balanced).toBe(true);
    expect(after.balanceSheet.balanced).toBe(true);
    for (const gc of ['1900', '1950', '2900', '2950', '4900']) {
      const rows = [...after.balanceSheet.rows, ...after.incomeStatement.month];
      expect(rows.find((x) => x.groupCode === gc)!.consolidatedMinor, gc).toBe(0n);
    }
    expect(after.unmatchedIcMinor).toBe(1n);
    // July and August were consolidated when they closed, so the year to date carries only September's cent.
    const ytd = (gc: string) => after.incomeStatement.ytd.find((x) => x.groupCode === gc)!;
    expect([ytd('4900').byEntity.get(1n), ytd('4900').eliminationsMinor, ytd('4900').consolidatedMinor]).toEqual([4_500_000n, -4_500_000n, 0n]);
    expect([ytd('5900').byEntity.get(subId('UK')), ytd('5900').eliminationsMinor, ytd('5900').consolidatedMinor]).toEqual([4_500_001n, -4_500_000n, 1n]);
    expect(before.unmatchedIcMinor).toBeGreaterThan(24_500_000n);
  });

  it('leaves September looking un-eliminated to the module: no ELIM balance through September, no ELIM activity in it', () => {
    const elim = subId('ELIM');
    const elimLines = LINES.filter((l) => BY_ID.get(l.accountId)!.subsidiaryId === elim);
    // Each closed month: its activity and balance eliminations, and the balance elimination's reversal the next month.
    expect(group.journalEntries.filter((je) => je.subsidiaryCode === 'ELIM').map((je) => je.periodYm)).toEqual(['2026-07', '2026-07', '2026-08', '2026-08', '2026-08', '2026-09']);
    const net = (pred: (l: JournalLine) => boolean) => elimLines.filter(pred).reduce((m, l) => m.set(l.accountId, (m.get(l.accountId) ?? 0n) + l.debitMinor - l.creditMinor), new Map<bigint, bigint>());
    const balanceSheet = (l: JournalLine) => BY_ID.get(l.accountId)!.type === 'asset' || BY_ID.get(l.accountId)!.type === 'liability';
    expect([...net(balanceSheet).values()].every((v) => v === 0n)).toBe(true);
    expect(net((l) => l.ym.month === 9 && !balanceSheet(l)).size).toBe(0);
  });

  it('keeps each closed month consolidated: ELIM carries exactly what Cafoo Inc shows on 1900 and 1950 through it', () => {
    const through = (code: string, month: number) =>
      LINES.filter((l) => l.accountId === byCode.get(code)!.id && l.ym.month <= month).reduce((a, l) => a + l.debitMinor - l.creditMinor, 0n);
    for (const month of [7, 8]) {
      expect([through('1900', month) + through('1900-ELIM', month), through('1950', month) + through('1950-ELIM', month)]).toEqual([0n, 0n]);
      expect(through('1950', month)).toBe(20_000_000n);
    }
    expect([through('1900', 7), through('1900', 8)]).toEqual([1_500_000n, 3_000_000n]);
  });
});
