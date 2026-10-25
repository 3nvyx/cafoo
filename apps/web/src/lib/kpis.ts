// The numbers an AI startup's board and investors ask about, each with the yardstick it is usually read against.
// Pure maths over DataSource rows and the Dashboard's Summary; the Metrics page renders them.
import type { Summary } from './data/dashboard';
import { arrAt, arrWaterfall, nrrBp } from './data/derive';
import { toBig } from './data/money';
import type { Contract, Employee, Minor } from './data/types';

const big = (m: Minor | bigint): bigint => (typeof m === 'bigint' ? m : toBig(m));

/** Whether a reading is healthy against its yardstick: good, watch, or poor; null when there is nothing to read. */
export type Health = 'good' | 'watch' | 'poor' | null;

/** Full-time equivalents on a day: full-time 1, part-time and interns half, contractors none. */
export function fte(employees: Employee[], at: string): number {
	let n = 0;
	for (const e of employees) {
		if (e.startAt.slice(0, 10) > at || (e.endAt && e.endAt.slice(0, 10) < at) || e.status === 'terminated') continue;
		n += e.type === 'full_time' ? 1 : e.type === 'contractor' ? 0 : 0.5;
	}
	return n;
}

/** Cash that went out net over the range, a positive amount; 0 when cash grew. */
export const netBurn = (s: Pick<Summary, 'cashChange'>): bigint => (toBig(s.cashChange) < 0n ? -toBig(s.cashChange) : 0n);

/** ARR added over (from, to]: new and expansion less contraction and churn. */
export function netNewArr(contracts: Contract[], from: string, to: string): bigint {
	const w = arrWaterfall(contracts, from, to);
	return toBig(w.end) - toBig(w.start);
}

/**
 * Burn multiple: cash burned for each dollar of net new ARR. Under 1 is excellent, 1 to 2 good, over 2 means growth is
 * expensive. Null when ARR did not grow (the multiple is undefined, and the page says so).
 */
export function burnMultiple(burn: bigint, newArr: bigint): number | null {
	if (newArr <= 0n) return null;
	return Number((burn * 100n) / newArr) / 100;
}

export const burnMultipleHealth = (m: number | null, burn: bigint): Health => (m === null ? (burn > 0n ? 'poor' : null) : m < 1 ? 'good' : m <= 2 ? 'watch' : 'poor');

/** ARR per full-time equivalent; early-stage AI companies are often read against $150k to $250k. */
export function arrPerFte(contracts: Contract[], employees: Employee[], at: string): bigint | null {
	const n = fte(employees, at);
	if (!n) return null;
	return (toBig(arrAt(contracts, at)) * 2n) / BigInt(Math.round(n * 2));
}

export const arrPerFteHealth = (v: bigint | null): Health => (v === null ? null : v >= 20_000_000n ? 'good' : v >= 10_000_000n ? 'watch' : 'poor');

/**
 * Rule of 40: ARR growth, annualized from the months given, plus the net margin. 40 or more is healthy. An early
 * company's figure swings month to month, so the page shows the inputs beside it.
 */
export function ruleOf40(contracts: Contract[], from: string, to: string, months: number, netMarginBp: number | null): { score: number; growthPct: number; marginPct: number } | null {
	const start = toBig(arrAt(contracts, from));
	if (start <= 0n || netMarginBp === null || months <= 0) return null;
	const monthly = Number(toBig(arrAt(contracts, to)) - start) / Number(start) / months;
	const growthPct = Math.round(monthly * 12 * 1000) / 10;
	const marginPct = netMarginBp / 100;
	return { score: Math.round((growthPct + marginPct) * 10) / 10, growthPct, marginPct };
}

export const ruleOf40Health = (score: number | null): Health => (score === null ? null : score >= 40 ? 'good' : score >= 20 ? 'watch' : 'poor');

/** Net dollar retention over (from, to], in basis points; 11000 = 110%. */
export const ndrBp = (contracts: Contract[], from: string, to: string): number | null => nrrBp(arrWaterfall(contracts, from, to));

export const ndrHealth = (bp: number | null): Health => (bp === null ? null : bp >= 11000 ? 'good' : bp >= 10000 ? 'watch' : 'poor');

/** Months of runway: 18 or more is comfortable for a startup between rounds, under 9 means raise now. */
export const runwayHealth = (months: number | null): Health => (months === null ? 'good' : months >= 18 ? 'good' : months >= 9 ? 'watch' : 'poor');

/**
 * Gross margin as a percentage, in basis points, from revenue and every cost of running the product. AI products
 * usually land between 50% and 65%; classic software sits near 75% to 80%.
 */
export function grossMarginBp(revenue: Minor, costOfRevenue: Minor | bigint): number | null {
	const r = toBig(revenue);
	if (r <= 0n) return null;
	return Number(((r - big(costOfRevenue)) * 10000n) / r);
}

export const aiGrossMarginHealth = (bp: number | null): Health => (bp === null ? null : bp >= 6000 ? 'good' : bp >= 4500 ? 'watch' : 'poor');

/** Share of revenue spent on model inference, in basis points. Above about 25% squeezes margin hard. */
export function shareOfRevenueBp(cost: Minor | bigint, revenue: Minor): number | null {
	const r = toBig(revenue);
	return r > 0n ? Number((big(cost) * 10000n) / r) : null;
}

export const inferenceShareHealth = (bp: number | null): Health => (bp === null ? null : bp <= 1500 ? 'good' : bp <= 2500 ? 'watch' : 'poor');
