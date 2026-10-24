import { describe, expect, it } from 'vitest';
import {
  dateLabel, dateMicros, lastCompletedYm, ymAdd, ymCompare, ymDiff, ymEndMicros, ymFromString, ymLabel, ymOfMicros, ymRange,
  ymStartMicros, ymToString, LedgerError,
} from '../src/index.js';

describe('ym', () => {
  it('adds months across year boundaries both ways', () => {
    expect(ymAdd({ year: 2026, month: 11 }, 3)).toEqual({ year: 2027, month: 2 });
    expect(ymAdd({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(ymAdd({ year: 2026, month: 1 }, -25)).toEqual({ year: 2023, month: 12 });
  });

  it('compares, diffs and ranges inclusively', () => {
    expect(ymCompare({ year: 2026, month: 9 }, { year: 2026, month: 10 })).toBe(-1);
    expect(ymCompare({ year: 2027, month: 1 }, { year: 2026, month: 12 })).toBe(1);
    expect(ymCompare({ year: 2026, month: 9 }, { year: 2026, month: 9 })).toBe(0);
    expect(ymDiff({ year: 2026, month: 9 }, { year: 2027, month: 8 })).toBe(11);
    expect(ymRange({ year: 2026, month: 11 }, { year: 2027, month: 2 }).map(ymToString)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(ymRange({ year: 2026, month: 5 }, { year: 2026, month: 4 })).toEqual([]);
  });

  it('round-trips strings and rejects bad input', () => {
    expect(ymToString({ year: 2026, month: 9 })).toBe('2026-09');
    expect(ymFromString('2026-09')).toEqual({ year: 2026, month: 9 });
    expect(() => ymFromString('2026-13')).toThrow(LedgerError);
    expect(() => ymFromString('2026-9')).toThrow(LedgerError);
    expect(ymLabel({ year: 2026, month: 9 })).toBe('September 2026');
  });

  it('converts micros to calendar months in UTC, including leap days and pre-epoch', () => {
    expect(ymOfMicros(dateMicros(2024, 2, 29))).toEqual({ year: 2024, month: 2 });
    expect(ymOfMicros(ymEndMicros({ year: 2024, month: 2 }) - 1n)).toEqual({ year: 2024, month: 2 });
    expect(ymOfMicros(-1n)).toEqual({ year: 1969, month: 12 });
    expect(ymStartMicros({ year: 1970, month: 1 })).toBe(0n);
    expect(dateLabel(dateMicros(2026, 9, 14) + 3_600_000_000n)).toBe('September 14, 2026');
  });

  it('lastCompletedYm is pure and uses the supplied clock', () => {
    expect(lastCompletedYm(dateMicros(2026, 10, 24))).toEqual({ year: 2026, month: 9 });
    expect(lastCompletedYm(dateMicros(2026, 1, 1))).toEqual({ year: 2025, month: 12 });
    // last microsecond of a month still belongs to that month
    expect(lastCompletedYm(dateMicros(2026, 3, 1) - 1n)).toEqual({ year: 2026, month: 1 });
  });
});
