// Small helpers the Dashboard's charts share. The line charts use shadcn-svelte's chart (LayerChart underneath, in
// $lib/components/ui/chart); the KPI sparklines stay hand-drawn SVG.
import { formatMoney, fromMajor } from '#lib/data/money.js';

/** A time axis for monthly points that runs half a month past the first and last, so no month sits on the edge. */
export function padMonths(yms: string[]): [Date, Date] | undefined {
	if (!yms.length) return undefined;
	const half = 15 * 86_400_000;
	const start = (ym: string) => Date.parse(`${ym}-01T00:00:00Z`);
	return [new Date(start(yms[0]) - half), new Date(start(yms.at(-1)!) + half)];
}

/** The smallest 1, 2 or 5 times a power of ten at or above `v`, so axis ticks land on round numbers. */
export function niceMax(v: number): number {
	if (v <= 0) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

/** Axis tick text: $0, $50K, $1.2M; $1.75M when the ticks are closer than the compact form can tell apart. */
export function tick(major: number, step = major): string {
	if (Math.abs(major) >= 1_000_000 && step < 100_000) return `${major < 0 ? '-' : ''}$${(Math.abs(major) / 1_000_000).toFixed(2)}M`;
	return formatMoney(fromMajor(major), { compact: true });
}

/** Exact readout text: $41,250. */
export const money = (major: number) => formatMoney(fromMajor(major), { whole: true });
