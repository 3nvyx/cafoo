/**
 * Pure helpers for the group seed and the feed plan: no clock, no Node APIs, so the feed plan can run in the agents'
 * gateway and in tests. Months are { year, month } or "YYYY-MM"; instants are bigint microseconds since the Unix epoch.
 */
export type Ym = { year: number; month: number };

export const DAY_MICROS = 86_400_000_000n;

export const ymStr = (ym: Ym) => `${ym.year}-${String(ym.month).padStart(2, '0')}`;

export function ymParse(s: string): Ym {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(s);
  if (!m) throw new Error(`"${s}" is not a month in YYYY-MM form`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export const ymAdd = (ym: Ym, n: number): Ym => {
  const idx = ym.year * 12 + (ym.month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
};

function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export const daysInMonth = (ym: Ym) => daysFromCivil(ym.year, ym.month + 1, 1) - daysFromCivil(ym.year, ym.month, 1);

/** UTC instant of a calendar date and hour, in microseconds. Same values as the generator's Date.UTC-based helper. */
export const microsAt = (ym: Ym, day: number, hour = 12): bigint =>
  BigInt(daysFromCivil(ym.year, ym.month, Math.min(day, daysInMonth(ym)))) * DAY_MICROS + BigInt(hour) * 3_600_000_000n;

/** Same PRNG as the generator (mulberry32); each consumer owns its own stream. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string: content-based seeds, so a value depends only on its key, never on draw order. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A number in [0, 1) that depends only on the key. */
export const keyed = (key: string) => mulberry32(hash32(key))();
