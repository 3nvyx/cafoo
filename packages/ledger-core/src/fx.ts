import { LedgerError } from './errors.js';
import { applyFx, divRound, FX_SCALE } from './money.js';
import type { Ym } from './types.js';
import { ymEquals, ymToString } from './ym.js';

export type FxRateKind = 'spot' | 'average' | 'closing';

/** One recorded rate: 1 unit of `fromCcy` buys `rateE6 / 1e6` units of `toCcy` in month `ym`. */
export interface FxRate {
  fromCcy: string;
  toCcy: string;
  ym: Ym;
  rateE6: bigint;
  kind: FxRateKind;
}

/** Currency codes compare case-insensitively, as the module stores them ("usd" is USD). */
export function ccyKey(ccy: string): string {
  return ccy.trim().toUpperCase();
}

function find(rates: readonly FxRate[], from: string, to: string, ym: Ym, kind: FxRateKind): FxRate | undefined {
  return rates.find((r) => r.kind === kind && ymEquals(r.ym, ym) && ccyKey(r.fromCcy) === from && ccyKey(r.toCcy) === to);
}

/**
 * Rate from `from` to `to` for a month and kind, scaled by 1e6. Same currency is exactly 1_000_000n; otherwise the
 * first recorded direct rate; otherwise the reciprocal of the first recorded inverse rate, rounded half away from zero.
 * Throws LedgerError('missing_rate') when neither direction is recorded.
 */
export function fxRate(rates: readonly FxRate[], from: string, to: string, ym: Ym, kind: FxRateKind): bigint {
  const f = ccyKey(from);
  const t = ccyKey(to);
  if (f === t) return FX_SCALE;
  const direct = find(rates, f, t, ym, kind);
  if (direct) {
    if (direct.rateE6 <= 0n) throw new LedgerError('invalid_input', `The ${kind} ${f} to ${t} rate for ${ymToString(ym)} must be greater than zero.`);
    return direct.rateE6;
  }
  const inverse = find(rates, t, f, ym, kind);
  if (inverse) {
    if (inverse.rateE6 <= 0n) throw new LedgerError('invalid_input', `The ${kind} ${t} to ${f} rate for ${ymToString(ym)} must be greater than zero.`);
    return divRound(FX_SCALE * FX_SCALE, inverse.rateE6);
  }
  throw new LedgerError('missing_rate', `There is no ${kind} rate from ${f} to ${t} for ${ymToString(ym)}; record one before converting.`);
}

/** Convert an amount between currencies at the month's rate of `kind`, rounding half away from zero. */
export function translate(amountMinor: bigint, rates: readonly FxRate[], from: string, to: string, ym: Ym, kind: FxRateKind): bigint {
  return applyFx(amountMinor, fxRate(rates, from, to, ym, kind));
}

/** The group-wide code of an account: `2950-UK` is `2950`, a root account's bare code is itself. */
export function groupCode(code: string): string {
  const i = code.indexOf('-');
  return i < 0 ? code : code.slice(0, i);
}

/** The account code a subsidiary uses for a group code: bare for the root (no parent), `<code>-<SUB>` otherwise. */
export function subsidiaryCode(base: string, sub: { code: string; parentId?: bigint | null }): string {
  return sub.parentId === undefined || sub.parentId === null ? base : `${base}-${sub.code}`;
}
