// Cost of service over time: spend by a key for every month, and spikes against each line's own recent months.
// Pure and integer-only; money is minor units as bigint.
import { toBig } from '#lib/data/money.js';
import type { CloudCost } from '#lib/data/types.js';

const BP = 10_000n;

/** Spend for each key in each month (in `months` order), largest total first. Keys past `top` fold into "other". */
export function seriesBy<K extends string>(rows: CloudCost[], months: string[], key: (r: CloudCost) => K, top = 4): { key: K | 'other'; values: bigint[]; total: bigint }[] {
	const idx = new Map(months.map((m, i) => [m, i]));
	const by = new Map<K, bigint[]>();
	for (const r of rows) {
		const i = idx.get(r.ym);
		if (i === undefined) continue;
		const k = key(r);
		const v = by.get(k) ?? months.map(() => 0n);
		v[i] += toBig(r.amountMinor);
		by.set(k, v);
	}
	const all = [...by]
		.map(([k, values]) => ({ key: k as K | 'other', values, total: values.reduce((a, b) => a + b, 0n) }))
		.sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
	if (all.length <= top + 1) return all;
	const rest = all.slice(top);
	const other = { key: 'other' as const, values: months.map((_, i) => rest.reduce((t, x) => t + x.values[i], 0n)), total: rest.reduce((t, x) => t + x.total, 0n) };
	return [...all.slice(0, top), other];
}

export interface Spike {
	ym: string;
	provider: CloudCost['provider'];
	service: string;
	amountMinor: bigint;
	/** Average of the same line's previous `window` months. */
	baselineMinor: bigint;
	/** How far above the baseline, in basis points (3800 = 38% above). */
	upBp: number;
}

/** Bill lines that jumped against their own recent past: at least `thresholdBp` above the average of the previous
 * `window` months and at least `minMinor` more in money. Latest month first, then the biggest jump. */
export function spikes(rows: CloudCost[], opts: { window?: number; thresholdBp?: number; minMinor?: bigint } = {}): Spike[] {
	const window = opts.window ?? 3;
	const threshold = BigInt(opts.thresholdBp ?? 2500);
	const minMinor = opts.minMinor ?? 100_000n;
	const lines = new Map<string, Map<string, bigint>>();
	for (const r of rows) {
		const k = `${r.provider}|${r.service}`;
		const m = lines.get(k) ?? new Map<string, bigint>();
		m.set(r.ym, (m.get(r.ym) ?? 0n) + toBig(r.amountMinor));
		lines.set(k, m);
	}
	const out: Spike[] = [];
	for (const [k, byMonth] of lines) {
		const yms = [...byMonth.keys()].sort();
		for (let i = window; i < yms.length; i++) {
			const prev = yms.slice(i - window, i).map((m) => byMonth.get(m)!);
			const base = prev.reduce((a, b) => a + b, 0n) / BigInt(window);
			const amount = byMonth.get(yms[i])!;
			if (base <= 0n || amount - base < minMinor || amount * BP < base * (BP + threshold)) continue;
			const [provider, ...service] = k.split('|');
			out.push({ ym: yms[i], provider: provider as CloudCost['provider'], service: service.join('|'), amountMinor: amount, baselineMinor: base, upBp: Number(((amount - base) * BP) / base) });
		}
	}
	return out.sort((a, b) => b.ym.localeCompare(a.ym) || b.upBp - a.upBp);
}

/** The product carrying the most production model-usage cost in a month, for the per-token figure. */
export function topInferenceProduct(rows: CloudCost[], ym: string, isInference: (r: CloudCost) => boolean): string | undefined {
	const by = new Map<string, bigint>();
	for (const r of rows) if (r.ym === ym && r.product && isInference(r)) by.set(r.product, (by.get(r.product) ?? 0n) + toBig(r.amountMinor));
	let best: string | undefined;
	let max = -1n;
	for (const [k, v] of by) if (v > max) [best, max] = [k, v];
	return best;
}
