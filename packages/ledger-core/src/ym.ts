import { LedgerError } from './errors.js';
import type { Ym } from './types.js';

export const DAY_MICROS = 86_400_000_000n;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export function ym(year: number, month: number): Ym {
  assertYm({ year, month });
  return { year, month };
}

export function assertYm(v: Ym): void {
  if (!Number.isInteger(v.year) || !Number.isInteger(v.month) || v.month < 1 || v.month > 12) {
    throw new LedgerError('invalid_ym', `"${v.year}-${v.month}" is not a valid year and month.`);
  }
}

function index(v: Ym): number {
  return v.year * 12 + (v.month - 1);
}

function fromIndex(i: number): Ym {
  const year = Math.floor(i / 12);
  return { year, month: i - year * 12 + 1 };
}

export function ymAdd(v: Ym, months: number): Ym {
  assertYm(v);
  if (!Number.isInteger(months)) throw new LedgerError('invalid_ym', 'Months to add must be a whole number.');
  return fromIndex(index(v) + months);
}

export function ymCompare(a: Ym, b: Ym): -1 | 0 | 1 {
  const d = index(a) - index(b);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

export function ymEquals(a: Ym, b: Ym): boolean {
  return a.year === b.year && a.month === b.month;
}

/** Months from `a` to `b` (b - a). */
export function ymDiff(a: Ym, b: Ym): number {
  return index(b) - index(a);
}

/** Inclusive range; empty when from > to. */
export function ymRange(from: Ym, to: Ym): Ym[] {
  assertYm(from);
  assertYm(to);
  const out: Ym[] = [];
  for (let i = index(from); i <= index(to); i++) out.push(fromIndex(i));
  return out;
}

/** True when lo <= v <= hi (either bound optional). */
export function ymWithin(v: Ym, lo?: Ym, hi?: Ym): boolean {
  if (lo && ymCompare(v, lo) < 0) return false;
  if (hi && ymCompare(v, hi) > 0) return false;
  return true;
}

export function ymToString(v: Ym): string {
  assertYm(v);
  const y = String(Math.abs(v.year)).padStart(4, '0');
  return `${v.year < 0 ? '-' : ''}${y}-${String(v.month).padStart(2, '0')}`;
}

export function ymFromString(s: string): Ym {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m) throw new LedgerError('invalid_ym', `"${s}" is not a month in YYYY-MM form.`);
  const v = { year: Number(m[1]), month: Number(m[2]) };
  assertYm(v);
  return v;
}

/** "September 2026" */
export function ymLabel(v: Ym): string {
  assertYm(v);
  return `${MONTH_NAMES[v.month - 1]} ${v.year}`;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

// Proleptic Gregorian calendar conversions (UTC), integer-only.
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Calendar month (UTC) containing the instant. */
export function ymOfMicros(micros: bigint): Ym {
  const c = civilFromDays(Number(floorDiv(micros, DAY_MICROS)));
  return { year: c.year, month: c.month };
}

/** First instant (UTC micros) of the month. */
export function ymStartMicros(v: Ym): bigint {
  assertYm(v);
  return BigInt(daysFromCivil(v.year, v.month, 1)) * DAY_MICROS;
}

/** First instant of the following month: the exclusive end of `v`. */
export function ymEndMicros(v: Ym): bigint {
  return ymStartMicros(ymAdd(v, 1));
}

/** Micros for a UTC calendar date at 00:00. Handy for fixtures. */
export function dateMicros(year: number, month: number, day: number): bigint {
  return BigInt(daysFromCivil(year, month, day)) * DAY_MICROS;
}

/** The month before the one containing `nowMicros`. Pure: the caller supplies the clock. */
export function lastCompletedYm(nowMicros: bigint): Ym {
  return ymAdd(ymOfMicros(nowMicros), -1);
}

/** UTC calendar date of an instant. */
export function dateOfMicros(micros: bigint): { year: number; month: number; day: number } {
  return civilFromDays(Number(floorDiv(micros, DAY_MICROS)));
}

/** "September 14, 2026" (UTC). */
export function dateLabel(micros: bigint): string {
  const d = dateOfMicros(micros);
  return `${MONTH_NAMES[d.month - 1]} ${d.day}, ${d.year}`;
}
