import { describe, expect, it } from 'vitest';
import { closePeriod } from '../src/close-period';

describe('closePeriod', () => {
  it('defaults to 2026-09 when CLOSE_PERIOD is unset', () => {
    expect(closePeriod({})).toBe('2026-09');
  });

  it('defaults when CLOSE_PERIOD is empty, as .env.example ships it', () => {
    expect(closePeriod({ CLOSE_PERIOD: '' })).toBe('2026-09');
    expect(closePeriod({ CLOSE_PERIOD: '   ' })).toBe('2026-09');
  });

  it('uses a set CLOSE_PERIOD, trimmed', () => {
    expect(closePeriod({ CLOSE_PERIOD: ' 2026-10 ' })).toBe('2026-10');
  });
});
