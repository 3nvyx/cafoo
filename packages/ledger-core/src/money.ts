import { LedgerError } from './errors.js';

/** FX rates are scaled by 1e6. */
export const FX_SCALE = 1_000_000n;
/** Basis points per whole. */
export const BP_SCALE = 10_000n;

const SYMBOLS: Readonly<Record<string, string>> = { USD: '$', GBP: '£' };

export function absMinor(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export function sumMinor(values: Iterable<bigint>): bigint {
  let s = 0n;
  for (const v of values) s += v;
  return s;
}

/** n / d rounded half away from zero. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new LedgerError('invalid_input', 'Cannot divide an amount by zero.');
  const neg = (n < 0n) !== (d < 0n);
  const an = absMinor(n);
  const ad = absMinor(d);
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
}

/** Convert a transaction-currency amount to functional currency, rounding half away from zero. */
export function applyFx(amountMinor: bigint, rateE6: bigint): bigint {
  if (rateE6 <= 0n) throw new LedgerError('invalid_input', 'An exchange rate must be greater than zero.');
  return divRound(amountMinor * rateE6, FX_SCALE);
}

/** amount * bp / 10000, rounding half away from zero. */
export function applyBp(amountMinor: bigint, bp: bigint | number): bigint {
  return divRound(amountMinor * BigInt(bp), BP_SCALE);
}

/**
 * Parse a human amount with two decimals into minor units.
 * Accepts "1234", "1,234.5", "-1,234.56", "$12.00", "£3". Rejects more than two decimals and bad grouping.
 */
export function parseMinor(input: string): bigint {
  const m = /^(-)?[$£]?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m || m[2] === undefined) {
    throw new LedgerError('invalid_money', `"${input}" is not an amount like 1,234.56.`);
  }
  const whole = BigInt(m[2].replaceAll(',', ''));
  const cents = BigInt((m[3] ?? '').padEnd(2, '0'));
  const v = whole * 100n + cents;
  return m[1] ? -v : v;
}

function group(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/** "1,234.56" with no currency marker. */
export function formatMinorNumber(minor: bigint, opts: { trimZeroCents?: boolean } = {}): string {
  const a = absMinor(minor);
  const cents = a % 100n;
  const body = group((a / 100n).toString()) +
    (opts.trimZeroCents && cents === 0n ? '' : '.' + cents.toString().padStart(2, '0'));
  return (minor < 0n ? '-' : '') + body;
}

/** "$1,234.56", "£1,234.56", otherwise "EUR 1,234.56". No Intl, so output is identical everywhere. */
export function formatMinor(minor: bigint, ccy: string, opts: { trimZeroCents?: boolean } = {}): string {
  const n = formatMinorNumber(absMinor(minor), opts);
  const sym = SYMBOLS[ccy.toUpperCase()];
  return (minor < 0n ? '-' : '') + (sym ?? `${ccy.toUpperCase()} `) + n;
}

/**
 * Split `total` across non-negative weights so the parts sum exactly to `total`.
 * Floor shares first, then one extra unit each to the largest remainders (ties: lower index).
 * Zero weights always receive zero. A negative total is allocated by magnitude and negated.
 */
export function allocateLargestRemainder(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new LedgerError('invalid_input', 'Nothing to split the amount across.');
  if (weights.some((w) => w < 0n)) throw new LedgerError('invalid_input', 'Split weights cannot be negative.');
  const sumW = sumMinor(weights);
  if (sumW === 0n) throw new LedgerError('invalid_input', 'Split weights add up to zero.');
  const t = absMinor(total);
  const shares = weights.map((w) => (t * w) / sumW);
  const rems = weights.map((w) => (t * w) % sumW);
  let left = t - sumMinor(shares);
  const order = weights.map((_, i) => i).sort((i, j) => {
    const ri = rems[i]!;
    const rj = rems[j]!;
    return ri === rj ? i - j : ri > rj ? -1 : 1;
  });
  for (let k = 0; left > 0n; k++, left--) {
    const idx = order[k]!;
    shares[idx] = shares[idx]! + 1n;
  }
  return total < 0n ? shares.map((s) => -s) : shares;
}

/** JSON-safe money: a base-10 integer string. */
export function toJsonMoney(v: bigint): string {
  return v.toString();
}

export function fromJsonMoney(s: string): bigint {
  if (typeof s !== 'string' || !/^-?\d+$/.test(s)) {
    throw new LedgerError('invalid_money', `"${String(s)}" is not a whole number of minor units.`);
  }
  return BigInt(s);
}
