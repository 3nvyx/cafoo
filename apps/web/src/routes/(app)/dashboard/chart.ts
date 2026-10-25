// Small drawing helpers the Dashboard's charts share. Charts are hand-drawn SVG: a few marks, no chart library.
import { formatMoney, fromMajor } from '#lib/data/money.js';

/** The smallest 1, 2 or 5 times a power of ten at or above `v`, so axis ticks land on round numbers. */
export function niceMax(v: number): number {
	if (v <= 0) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

/** A column with a 4px rounded data end and a square foot on the baseline. Negative heights hang below it. */
export function column(x: number, base: number, w: number, h: number): string {
	if (Math.abs(h) < 0.5) return '';
	const r = Math.min(4, w / 2, Math.abs(h));
	if (h > 0) {
		const top = base - h;
		return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
	}
	const bottom = base - h;
	return `M${x},${base}V${bottom - r}Q${x},${bottom} ${x + r},${bottom}H${x + w - r}Q${x + w},${bottom} ${x + w},${bottom - r}V${base}Z`;
}

/** Axis tick text: $0, $50K, $1.2M; $1.75M when the ticks are closer than the compact form can tell apart. */
export function tick(major: number, step = major): string {
	if (Math.abs(major) >= 1_000_000 && step < 100_000) return `${major < 0 ? '-' : ''}$${(Math.abs(major) / 1_000_000).toFixed(2)}M`;
	return formatMoney(fromMajor(major), { compact: true });
}

/** Exact readout text: $41,250. */
export const money = (major: number) => formatMoney(fromMajor(major), { whole: true });
