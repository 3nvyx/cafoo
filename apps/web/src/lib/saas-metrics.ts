// SaaS metrics the way finance tools lay them out (ARR movement, retention, efficiency, payback), over a chosen window
// ending at a month. Pure maths over the source's rows, building on derive.ts (ARR), dashboard.ts (the books' summary),
// costs.ts (cost of service) and kpis.ts (burn, FTE). Money stays bigint minor units; ratios are basis points.
import { addDays, monthRange, type Posting } from './data/dashboard';
import { arrWaterfall, type ArrWaterfall } from './data/derive';
import { toBig } from './data/money';
import type { Contract } from './data/types';
import type { CostOfService } from './costs';
import type { Health } from './kpis';

export type Window = 'month' | 'quarter' | 'ttm';
export const WINDOWS: { id: Window; label: string; months: number }[] = [
	{ id: 'month', label: 'Month', months: 1 },
	{ id: 'quarter', label: 'Quarter', months: 3 },
	{ id: 'ttm', label: 'Trailing 12 months', months: 12 }
];

/** "2026-09" moved by `n` months. */
export function shiftYm(ym: string, n: number): string {
	const [y, m] = ym.split('-').map(Number);
	const i = y * 12 + (m - 1) + n;
	return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/**
 * The window of `months` months ending with `endYm`, never starting before `firstYm` (the books' first month).
 * `before` is the day before it starts: ARR movement runs over (before, to].
 */
export function windowRange(endYm: string, months: number, firstYm: string): { from: string; to: string; before: string; months: number; yms: string[] } {
	let start = shiftYm(endYm, -(months - 1));
	if (start < firstYm) start = firstYm;
	const yms: string[] = [];
	for (let ym = start; ym <= endYm; ym = shiftYm(ym, 1)) yms.push(ym);
	const from = monthRange(start).from;
	return { from, to: monthRange(endYm).to, before: addDays(from, -1), months: yms.length, yms };
}

/** ARR movement for one month: new, expansion, contraction and churn, and the net change (end less start). */
export interface ArrMove {
	ym: string;
	added: bigint;
	expansion: bigint;
	contraction: bigint;
	churned: bigint;
	net: bigint;
}

export function arrMovement(contracts: Contract[], yms: string[]): ArrMove[] {
	return yms.map((ym) => {
		const r = monthRange(ym);
		const w = arrWaterfall(contracts, addDays(r.from, -1), r.to);
		return { ym, added: toBig(w.added), expansion: toBig(w.expansion), contraction: toBig(w.contraction), churned: toBig(w.churned), net: toBig(w.end) - toBig(w.start) };
	});
}

/**
 * Gross revenue retention, in basis points: what the customers who had ARR at the start still pay at the end, counting
 * contraction and churn but not expansion, so it can never pass 100%. Floored; null when nobody had ARR at the start.
 */
export function grrBp(w: ArrWaterfall): number | null {
	const start = toBig(w.start);
	if (start <= 0n) return null;
	const kept = start - toBig(w.contraction) - toBig(w.churned);
	return Number(((kept < 0n ? 0n : kept) * 10000n) / start);
}

export const grrHealth = (bp: number | null): Health => (bp === null ? null : bp >= 9000 ? 'good' : bp >= 8000 ? 'watch' : 'poor');

/** Gross margin after inference over several months: revenue less hosting, service engineering and model calls, over revenue. */
export function windowGmAfterInferenceBp(months: { revenue: bigint; cos: CostOfService }[]): number | null {
	let rev = 0n;
	let left = 0n;
	for (const m of months) {
		rev += m.revenue;
		left += m.revenue - toBig(m.cos.hostingMinor) - toBig(m.cos.serviceEngineeringMinor) - toBig(m.cos.inferenceMinor);
	}
	return rev > 0n ? Number((left * 10000n) / rev) : null;
}

/** Sales and marketing spend over the range: expense accounts named for marketing, sales or advertising. */
export const isSalesAndMarketing = (name: string) => /marketing|sales|advertis/i.test(name);
export function salesAndMarketing(ps: Posting[], from: string, to: string): bigint {
	let t = 0n;
	for (const p of ps) if (p.date >= from && p.date <= to && p.account.type === 'expense' && !p.account.isIntercompany && isSalesAndMarketing(p.account.name)) t += p.amount;
	return t;
}

/**
 * CAC payback in months: sales and marketing spend over the gross profit the new and expansion ARR it bought earns
 * each month. S&M / ((new + expansion ARR) / 12 x gross margin). Under 12 months is strong, over 24 is slow. Null when
 * no ARR was added or the margin is not positive.
 */
export function cacPaybackMonths(sm: bigint, newArr: bigint, gmBp: number | null): number | null {
	if (newArr <= 0n || gmBp === null || gmBp <= 0) return null;
	// months = sm * 12 * 10000 / (newArr * gmBp), to one decimal place.
	const tenths = (sm * 12n * 10000n * 10n) / (newArr * BigInt(gmBp));
	return Number(tenths) / 10;
}

export const cacPaybackHealth = (m: number | null): Health => (m === null ? null : m <= 12 ? 'good' : m <= 24 ? 'watch' : 'poor');

/** Revenue per employee, annualized: the window's revenue times 12 over its months, over full-time equivalents. */
export function revenuePerEmployee(revenue: bigint, months: number, fte: number): bigint | null {
	if (!fte || months <= 0) return null;
	return (revenue * 12n * 2n) / (BigInt(months) * BigInt(Math.round(fte * 2)));
}

export const revenuePerEmployeeHealth = (v: bigint | null): Health => (v === null ? null : v >= 20_000_000n ? 'good' : v >= 10_000_000n ? 'watch' : 'poor');

/** An SVG path through the values, scaled to fill a w x h box (top is the highest value). Null values break the line. */
export function sparkPath(values: (number | null)[], w: number, h: number): string {
	const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
	if (!nums.length) return '';
	const lo = Math.min(...nums);
	const hi = Math.max(...nums);
	const span = hi - lo || 1;
	const step = values.length > 1 ? w / (values.length - 1) : 0;
	let d = '';
	let pen = false;
	values.forEach((v, i) => {
		if (v === null || !Number.isFinite(v)) {
			pen = false;
			return;
		}
		const x = Math.round(i * step * 10) / 10;
		const y = hi === lo ? h / 2 : Math.round((h - ((v - lo) / span) * h) * 10) / 10;
		d += `${pen ? 'L' : 'M'}${x} ${y}`;
		pen = true;
	});
	return d;
}
