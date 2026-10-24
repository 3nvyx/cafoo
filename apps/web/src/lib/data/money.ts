import type { Minor } from './types';

/** Parse a minor-units string safely into a bigint (bad input becomes 0). */
export function toBig(minor: Minor | undefined | null): bigint {
	if (!minor) return 0n;
	try {
		return BigInt(minor);
	} catch {
		return 0n;
	}
}

/** Minor units to a float of major units. Only for display maths (charts, count-up). */
export function toNumber(minor: Minor | undefined | null): number {
	return Number(toBig(minor)) / 100;
}

export function sumMinor(values: Iterable<Minor>): Minor {
	let t = 0n;
	for (const v of values) t += toBig(v);
	return t.toString();
}

export function negMinor(minor: Minor): Minor {
	return (-toBig(minor)).toString();
}

export interface FormatMoneyOptions {
	/** Drop cents ($1,234 instead of $1,234.00). */
	whole?: boolean;
	/** Short form for headline numbers ($1.2M, $48.5K). */
	compact?: boolean;
	/** Always show a sign (+$12 / -$12). */
	signed?: boolean;
	currency?: string;
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

/** Format a minor-units string as money. Exact for any size: uses bigint, never floats. */
export function formatMoney(minor: Minor | undefined | null, opts: FormatMoneyOptions = {}): string {
	const n = toBig(minor);
	const neg = n < 0n;
	const abs = neg ? -n : n;
	const sym = SYMBOLS[opts.currency ?? 'USD'] ?? '';
	let body: string;
	if (opts.compact && abs >= 100_000n) {
		const major = Number(abs) / 100;
		if (major >= 1_000_000) body = `${trim(major / 1_000_000)}M`;
		else body = `${trim(major / 1_000)}K`;
	} else {
		const dollars = (abs / 100n).toLocaleString('en-US');
		const cents = (abs % 100n).toString().padStart(2, '0');
		body = opts.whole || opts.compact ? dollars : `${dollars}.${cents}`;
	}
	const sign = neg ? '-' : opts.signed && n > 0n ? '+' : '';
	return `${sign}${sym}${body}`;
}

function trim(x: number): string {
	return x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, '');
}

/** Dollars (number) to minor-units string. */
export function fromMajor(major: number): Minor {
	return Math.round(major * 100).toString();
}
