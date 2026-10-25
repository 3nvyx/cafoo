// Agents write a foreign-currency amount into a sentence ("a £4,404.78 gain"). In a pack that reports in another
// currency the reporting-currency figure leads and the original follows in brackets: "a $5,543.08 gain (£4,404.78)".
import type { FxRate } from './data/types';
import { formatMoney } from './data/money';
import type { DataSource } from './data/source';

export interface ReportingContext {
	rates: readonly FxRate[];
	reportingCcy: string;
	/** The month the sentence is about ("yyyy-mm"); its closing rate is used. */
	ym: string;
}

const SYMBOL_CCY: Record<string, string> = { '£': 'GBP', '€': 'EUR' };
const SYMBOL_OF: Record<string, string> = { GBP: '£', EUR: '€' };

/** Units of `to` per unit of `from`, scaled 1e6, from the month's closing rate (or its inverse). */
function closingRateE6(rates: readonly FxRate[], from: string, to: string, ym: string): bigint | null {
	const direct = rates.find((r) => r.kind === 'closing' && r.ym === ym && r.fromCcy === from && r.toCcy === to);
	if (direct) return BigInt(direct.rateE6);
	const inverse = rates.find((r) => r.kind === 'closing' && r.ym === ym && r.fromCcy === to && r.toCcy === from);
	if (inverse && BigInt(inverse.rateE6) > 0n) return (1_000_000_000_000n + BigInt(inverse.rateE6) / 2n) / BigInt(inverse.rateE6);
	return null;
}

/**
 * Rewrites "£X gain|loss" (or €) to "<reporting amount> gain|loss (£X)". Text with no such amount, an amount already in
 * the reporting currency, or a month with no recorded rate comes back unchanged.
 */
export function reportingFirst(text: string, ctx: ReportingContext): string {
	return text.replace(/([£€])(\d[\d,]*(?:\.\d{1,2})?)(\s+(?:gain|loss)\b)/g, (whole, sym: string, num: string, tail: string) => {
		const from = SYMBOL_CCY[sym];
		if (!from || from === ctx.reportingCcy) return whole;
		const rate = closingRateE6(ctx.rates, from, ctx.reportingCcy, ctx.ym);
		if (rate === null) return whole;
		const [whole$, frac = ''] = num.replace(/,/g, '').split('.');
		const minor = BigInt(whole$) * 100n + BigInt(frac.padEnd(2, '0'));
		const converted = (minor * rate + 500_000n) / 1_000_000n;
		return `${formatMoney(converted.toString(), { currency: ctx.reportingCcy })}${tail} (${SYMBOL_OF[from] ?? ''}${num})`;
	});
}

/** `reportingFirst` with the books' own rates and Reporting currency. Reads reactive data when called in a template. */
export function reportingText(books: Pick<DataSource, 'fxRates' | 'settings'>, text: string, ym: string): string {
	return reportingFirst(text, { rates: books.fxRates(), reportingCcy: books.settings().reportingCcy || 'USD', ym });
}
