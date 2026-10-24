import { describe, expect, it } from 'vitest';
import { assertBalanced, LedgerError, materializeEntry, normalBalance, reversalOf, validateEntry } from '../src/index.js';
import type { Period } from '../src/index.js';
import { ACCOUNTS, CASH, cr, dr, entry, HOSTING, OTHER_SUB_CASH, REVENUE, SUB } from './fixtures.js';

const OPEN: Period = { id: 1n, subsidiaryId: SUB, year: 2026, month: 9, status: 'open' };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return undefined;
}

describe('posting', () => {
  it('normal balances', () => {
    expect(normalBalance('asset')).toBe('debit');
    expect(normalBalance('expense')).toBe('debit');
    expect(normalBalance('liability')).toBe('credit');
    expect(normalBalance('equity')).toBe('credit');
    expect(normalBalance('revenue')).toBe('credit');
  });

  it('accepts a balanced entry and returns functional totals', () => {
    expect(assertBalanced([dr(CASH.id, 500n), cr(REVENUE.id, 300n), cr(REVENUE.id, 200n)])).toEqual({ debitMinor: 500n, creditMinor: 500n });
  });

  it('rejects unbalanced entries with a plain message', () => {
    expect(() => assertBalanced([dr(CASH.id, 100000n), cr(REVENUE.id, 99000n)])).toThrow(
      'debits total 1,000.00 but credits total 990.00 (off by 10.00)',
    );
  });

  it('rejects malformed lines', () => {
    expect(code(() => assertBalanced([dr(CASH.id, 1n)]))).toBe('too_few_lines');
    expect(code(() => assertBalanced([{ ...dr(CASH.id, 1n), creditMinor: 1n }, cr(REVENUE.id, 0n)]))).toBe('invalid_line');
    expect(code(() => assertBalanced([dr(CASH.id, 0n), cr(REVENUE.id, 0n)]))).toBe('invalid_line');
    expect(code(() => assertBalanced([dr(CASH.id, -5n), cr(REVENUE.id, -5n)]))).toBe('invalid_line');
    expect(code(() => assertBalanced([dr(CASH.id, 5n, { fxRateE6: 0n }), cr(REVENUE.id, 5n)]))).toBe('invalid_line');
  });

  it('balances in functional currency after FX', () => {
    // 100.00 EUR at 1.10 = 110.00 USD
    const lines = [dr(CASH.id, 10000n, { ccy: 'EUR', fxRateE6: 1_100_000n }), cr(REVENUE.id, 11000n)];
    expect(assertBalanced(lines)).toEqual({ debitMinor: 11000n, creditMinor: 11000n });
    // Same nominal amounts across currencies do not balance
    expect(code(() => assertBalanced([dr(CASH.id, 10000n, { ccy: 'EUR', fxRateE6: 1_100_000n }), cr(REVENUE.id, 10000n)]))).toBe('unbalanced');
  });

  it('validateEntry enforces period, subsidiary and accounts', () => {
    const good = entry([dr(CASH.id, 100n), cr(REVENUE.id, 100n)]);
    expect(() => validateEntry(good, OPEN, ACCOUNTS)).not.toThrow();
    expect(code(() => validateEntry(good, { ...OPEN, status: 'closing' }, ACCOUNTS))).toBe('period_not_open');
    expect(code(() => validateEntry(good, { ...OPEN, status: 'closed' }, ACCOUNTS))).toBe('period_not_open');
    expect(code(() => validateEntry(good, { ...OPEN, id: 2n }, ACCOUNTS))).toBe('wrong_period');
    expect(code(() => validateEntry(good, { ...OPEN, subsidiaryId: 2n }, ACCOUNTS))).toBe('wrong_subsidiary');
    expect(code(() => validateEntry(entry([dr(999n, 100n), cr(REVENUE.id, 100n)]), OPEN, ACCOUNTS))).toBe('unknown_account');
    expect(code(() => validateEntry(entry([dr(OTHER_SUB_CASH.id, 100n), cr(REVENUE.id, 100n)]), OPEN, ACCOUNTS))).toBe('wrong_subsidiary');
    expect(code(() => validateEntry(entry([dr(CASH.id, 100n), cr(REVENUE.id, 99n)]), OPEN, ACCOUNTS))).toBe('unbalanced');
  });

  it('reversal mirrors every line and nets to zero with the original', () => {
    const orig = entry([dr(HOSTING.id, 700n, { vendorId: 9n, memo: 'aws' }), cr(CASH.id, 700n)], 1n, 'Hosting');
    const rev = reversalOf(orig, { periodId: 2n });
    expect(rev.periodId).toBe(2n);
    expect(rev.memo).toBe('Reversal of: Hosting');
    expect(rev.lines[0]).toEqual({ accountId: HOSTING.id, debitMinor: 0n, creditMinor: 700n, ccy: 'USD', fxRateE6: 1_000_000n, vendorId: 9n, memo: 'aws' });
    assertBalanced(rev.lines);
    const net = new Map<bigint, bigint>();
    for (const l of [...orig.lines, ...rev.lines]) net.set(l.accountId, (net.get(l.accountId) ?? 0n) + l.debitMinor - l.creditMinor);
    expect([...net.values()].every((v) => v === 0n)).toBe(true);
  });

  it('reversal of a posted entry strips posting metadata and cites the entry id', () => {
    const posted = materializeEntry(entry([dr(CASH.id, 1n), cr(REVENUE.id, 1n)]), { jeId: 42n, firstLineId: 7n, ym: { year: 2026, month: 9 }, postedAt: 5n, source: 'test' });
    expect(posted.lines.map((l) => l.id)).toEqual([7n, 8n]);
    const rev = reversalOf(posted);
    expect(rev.memo).toBe('Reversal of (entry 42): test');
    expect(Object.keys(rev.lines[0]!).sort()).toEqual(['accountId', 'ccy', 'creditMinor', 'debitMinor', 'fxRateE6']);
  });
});
