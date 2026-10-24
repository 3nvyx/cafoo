import { describe, expect, it } from 'vitest';
import { fxRate, groupCode, LedgerError, subsidiaryCode, translate } from '../src/index.js';
import { OCT, RATES, SEP } from './group.js';

describe('fxRate', () => {
  it('is exactly 1.0 within one currency, whatever the case', () => {
    expect(fxRate([], 'usd', 'USD', SEP, 'closing')).toBe(1_000_000n);
  });

  it('uses the recorded direct rate of the requested kind', () => {
    expect(fxRate(RATES, 'GBP', 'USD', SEP, 'average')).toBe(1_270_000n);
    expect(fxRate(RATES, 'GBP', 'USD', SEP, 'closing')).toBe(1_280_000n);
    expect(fxRate(RATES, 'usd', 'gbp', SEP, 'closing')).toBe(781_250n);
  });

  it('falls back to the reciprocal of the inverse rate, rounded half away from zero', () => {
    const onlyGbpUsd = RATES.filter((r) => r.fromCcy === 'GBP');
    expect(fxRate(onlyGbpUsd, 'USD', 'GBP', SEP, 'closing')).toBe(781_250n); // 1e12 / 1,280,000 exactly
    expect(fxRate(onlyGbpUsd, 'USD', 'GBP', SEP, 'average')).toBe(787_402n); // 787,401.57 rounds up
    const onlyUsdGbp = RATES.filter((r) => r.fromCcy === 'USD');
    expect(fxRate(onlyUsdGbp, 'GBP', 'USD', SEP, 'average')).toBe(1_269_999n); // 1,269,999.31 rounds down
  });

  it('throws missing_rate in plain words when neither direction is recorded', () => {
    let err: unknown;
    try {
      fxRate(RATES, 'EUR', 'USD', SEP, 'closing');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('missing_rate');
    expect((err as LedgerError).message).toBe('There is no closing rate from EUR to USD for 2026-09; record one before converting.');
    expect(() => fxRate(RATES, 'GBP', 'USD', { year: 2026, month: 11 }, 'average')).toThrow(LedgerError);
    expect(() => fxRate(RATES, 'GBP', 'USD', SEP, 'spot')).toThrow('no spot rate');
  });
});

describe('translate', () => {
  it('converts at the month rate and rounds half away from zero in both directions', () => {
    expect(translate(1_181_103n, RATES, 'GBP', 'USD', SEP, 'average')).toBe(1_500_001n); // £11,811.03 -> $15,000.01
    expect(translate(-1_181_103n, RATES, 'GBP', 'USD', SEP, 'average')).toBe(-1_500_001n);
    expect(translate(-3_515_625n, RATES, 'GBP', 'USD', SEP, 'closing')).toBe(-4_500_000n);
    expect(translate(20_000_000n, RATES, 'USD', 'GBP', OCT, 'closing')).toBe(15_625_000n);
    expect(translate(123n, RATES, 'USD', 'USD', SEP, 'closing')).toBe(123n);
  });
});

describe('group codes', () => {
  it('groupCode strips the subsidiary suffix', () => {
    expect(groupCode('2950-UK')).toBe('2950');
    expect(groupCode('1900-ELIM')).toBe('1900');
    expect(groupCode('1000')).toBe('1000');
  });

  it('subsidiaryCode is bare for the root and suffixed for any subsidiary with a parent', () => {
    expect(subsidiaryCode('1000', { code: 'US' })).toBe('1000');
    expect(subsidiaryCode('1000', { code: 'US', parentId: null })).toBe('1000');
    expect(subsidiaryCode('7100', { code: 'UK', parentId: 1n })).toBe('7100-UK');
    expect(groupCode(subsidiaryCode('2900', { code: 'ELIM', parentId: 1n }))).toBe('2900');
  });
});
