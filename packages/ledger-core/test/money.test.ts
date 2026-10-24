import { describe, expect, it } from 'vitest';
import {
  allocateLargestRemainder, applyBp, applyFx, formatMinor, fromJsonMoney, LedgerError, parseMinor, toJsonMoney,
} from '../src/index.js';

describe('money', () => {
  it('parses human amounts into minor units', () => {
    expect(parseMinor('1,234.56')).toBe(123456n);
    expect(parseMinor('1234.5')).toBe(123450n);
    expect(parseMinor('-$12')).toBe(-1200n);
    expect(parseMinor(' £1,000,000.01 ')).toBe(100000001n);
    expect(parseMinor('0.07')).toBe(7n);
  });

  it('rejects ambiguous input instead of rounding', () => {
    for (const bad of ['1.234', '12,34', '1,2345.00', '', 'abc', '1.', '.5', '1e3']) {
      expect(() => parseMinor(bad), bad).toThrow(LedgerError);
    }
  });

  it('formats without Intl', () => {
    expect(formatMinor(123456n, 'USD')).toBe('$1,234.56');
    expect(formatMinor(-5n, 'GBP')).toBe('-£0.05');
    expect(formatMinor(100000000n, 'EUR')).toBe('EUR 1,000,000.00');
    expect(formatMinor(4800000n, 'USD', { trimZeroCents: true })).toBe('$48,000');
    expect(formatMinor(4800001n, 'USD', { trimZeroCents: true })).toBe('$48,000.01');
    expect(formatMinor(0n, 'usd')).toBe('$0.00');
  });

  it('parse(format(x)) round-trips', () => {
    for (const v of [0n, 1n, 99n, 100n, 123456789n, -987654321n]) {
      expect(parseMinor(formatMinor(v, 'USD'))).toBe(v);
    }
  });

  it('largest remainder sums exactly and favours the biggest fractions', () => {
    expect(allocateLargestRemainder(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateLargestRemainder(10n, [1n, 2n, 7n])).toEqual([1n, 2n, 7n]);
    expect(allocateLargestRemainder(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(allocateLargestRemainder(5n, [0n, 3n, 0n, 3n])).toEqual([0n, 3n, 0n, 2n]);
    const parts = allocateLargestRemainder(1_000_003n, [17n, 29n, 31n, 1n, 997n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1_000_003n);
  });

  it('largest remainder rejects empty, negative and all-zero weights', () => {
    expect(() => allocateLargestRemainder(1n, [])).toThrow(LedgerError);
    expect(() => allocateLargestRemainder(1n, [1n, -1n])).toThrow(LedgerError);
    expect(() => allocateLargestRemainder(1n, [0n, 0n])).toThrow(LedgerError);
  });

  it('applies FX and bp with half-away-from-zero rounding', () => {
    expect(applyFx(10000n, 1_250_000n)).toBe(12500n);
    expect(applyFx(1n, 1_500_000n)).toBe(2n); // 1.5 -> 2
    expect(applyFx(-1n, 1_500_000n)).toBe(-2n);
    expect(applyFx(1n, 1_499_999n)).toBe(1n);
    expect(() => applyFx(1n, 0n)).toThrow(LedgerError);
    expect(applyBp(12345n, 500)).toBe(617n); // 617.25
  });

  it('JSON money is an integer string', () => {
    expect(toJsonMoney(-123n)).toBe('-123');
    expect(fromJsonMoney('9007199254740993')).toBe(9007199254740993n);
    expect(() => fromJsonMoney('1.5')).toThrow(LedgerError);
    expect(() => fromJsonMoney(12 as unknown as string)).toThrow(LedgerError);
  });
});
