// The numbers an AI startup's board and investors ask about, each with the yardstick it is usually read against.
// Pure maths over DataSource rows and the Dashboard's Summary; the Metrics page renders them.
import { summarize, type Posting, type Summary } from './data/dashboard';
import { BURN_MONTHS, burnMultipleLabel, burnReading, burnWindowLabel, runwayLabel, windowRange } from './saas-metrics';
import { arrAt, arrWaterfall, nrrBp } from './data/derive';
import { formatMoney, toBig } from './data/money';
import type { Batch, CloudCost, Contract, Deal, Employee, FxRate, Invoice, Minor, SupportTicket } from './data/types';
import { breakage, costOfService, costPerMTokens, creditPricePerM, creditTotals, grossMarginAfterInference, type RateE6 } from './costs';
import { repeatRateBp, supportSummary, weightedPipeline } from './crm';

const big = (m: Minor | bigint): bigint => (typeof m === 'bigint' ? m : toBig(m));

/** Whether a reading is healthy against its yardstick: good, watch, or poor; null when there is nothing to read. */
export type Health = 'good' | 'watch' | 'poor' | null;

/** Full-time equivalents on a day: full-time 1, part-time and interns half, contractors none. */
export function fte(employees: Employee[], at: string): number {
	let n = 0;
	for (const e of employees) {
		// Someone who has left still counted on the days they worked; a termination with no end date counts as gone.
		if (e.startAt.slice(0, 10) > at || (e.endAt ? e.endAt.slice(0, 10) < at : e.status === 'terminated')) continue;
		n += e.type === 'full_time' ? 1 : e.type === 'contractor' ? 0 : 0.5;
	}
	return n;
}

/** Cash running the business used over the range, a positive amount; 0 when operations added cash. Money raised does
 * not count: a funding round does not lower burn. */
export const netBurn = (s: Pick<Summary, 'operatingCashChange'>): bigint => (toBig(s.operatingCashChange) < 0n ? -toBig(s.operatingCashChange) : 0n);

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

// One month's efficiency readings, shared by the Metrics page and the Dashboard's health check so they never disagree.

export interface Tile {
	key: string;
	label: string;
	value: string;
	health: Health;
	/** The figures the reading is made from. */
	inputs: string;
	/** What good looks like. */
	yardstick: string;
	href?: string;
}

/** The day before the quarter ending `range.to`, or before the books' first month when they start later. */
export function quarterStart(rangeFrom: string, firstMonthFrom: string): string {
	const d = new Date(`${rangeFrom}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() - 2);
	const from = d.toISOString().slice(0, 10);
	const start = from < firstMonthFrom ? firstMonthFrom : from;
	const back = new Date(`${start}T00:00:00Z`);
	back.setUTCDate(back.getUTCDate() - 1);
	return back.toISOString().slice(0, 10);
}

/**
 * The efficiency readings for the month ending `endYm`, over the trailing quarter (BURN_MONTHS) that the Metrics page's
 * quarter view reads too: burn and runway from burnReading, burn multiple, Rule of 40 and retention over the same
 * months. One month alone swings too much with annual prepayments and early growth.
 */
export function efficiencyTiles(input: { ps: Posting[]; endYm: string; firstYm: string; contracts: Contract[]; employees: Employee[] }): Tile[] {
	const { ps, endYm, firstYm, contracts, employees } = input;
	const money = (m: bigint | string) => formatMoney(m.toString(), { whole: true });
	const win = windowRange(endYm, BURN_MONTHS, firstYm);
	const q = summarize(ps, contracts, { from: win.from, to: win.to });
	const b = burnReading(ps, endYm, firstYm);
	const burn = b.totalBurn;
	const added = netNewArr(contracts, win.before, win.to);
	const multiple = burnMultiple(burn, added);
	const to = win.to;
	const perFte = arrPerFte(contracts, employees, to);
	const heads = fte(employees, to);
	const r40 = ruleOf40(contracts, win.before, to, win.months, q.netMarginBp);
	const ndr = ndrBp(contracts, win.before, to);
	const over = burnWindowLabel(b.yms);
	return [
		{
			key: 'burn-multiple',
			label: 'Burn multiple',
			value: multiple === null ? (burn > 0n ? 'No ARR added' : '–') : burnMultipleLabel(multiple),
			health: burnMultipleHealth(multiple, burn),
			inputs: `${money(burn)} burned · ${money(added)} net new ARR, ${over}`,
			yardstick: 'Dollars of cash burned to add $1 of recurring revenue. Under 1× is great; over 2× means growth costs too much.'
		},
		{
			key: 'runway',
			label: 'Runway',
			value: runwayLabel(b),
			health: runwayHealth(b.runwayMonths),
			inputs: `${money(b.monthlyBurn)} a month of operating burn, averaged ${over} · ${money(b.cash)} cash`,
			yardstick: 'Months your cash lasts at this rate of burn. 18 or more is comfortable; under 9 means start raising now.'
		},
		{
			key: 'arr-per-employee',
			label: 'ARR per employee',
			value: perFte === null ? '–' : money(perFte),
			health: arrPerFteHealth(perFte),
			inputs: `${money(q.arr)} ARR · ${heads} full-time equivalents`,
			yardstick: 'Recurring revenue per full-time person; higher is better. Early AI startups aim for $150k to $250k.',
			href: '/people'
		},
		{
			key: 'rule-of-40',
			label: 'Rule of 40',
			value: r40 ? `${r40.score.toFixed(0)}` : '–',
			health: ruleOf40Health(r40?.score ?? null),
			inputs: r40 ? `${r40.growthPct.toFixed(0)}% ARR growth, annualized · ${r40.marginPct.toFixed(0)}% net margin` : 'Needs ARR and revenue',
			yardstick: 'Yearly growth rate plus profit margin, which weighs speed against burn. 40 or more is healthy.'
		},
		{
			key: 'ndr',
			label: 'Net dollar retention',
			value: ndr === null ? '–' : `${(ndr / 100).toFixed(1)}%`,
			health: ndrHealth(ndr),
			inputs: "Existing customers' ARR, start of quarter to now",
			yardstick: 'Recurring revenue kept from existing customers, upgrades and cancellations included. Over 100% means upgrades beat churn; 110% is strong.',
			href: '/reports'
		}
	];
}

// AI unit economics, credits and go-to-market: the readings particular to an AI startup, from Cost of service, Batches
// and the connected CRM, support and billing tools.

/** Converts a currency to USD with the month's average rate (USD passes through), as the Cost of service page does. */
export function usdRate(fxRates: FxRate[]): RateE6 {
	return (ccy, ym) => {
		if (ccy === 'USD') return 1_000_000n;
		const r = fxRates.find((x) => x.fromCcy === ccy && x.toCcy === 'USD' && x.ym === ym && x.kind === 'average') ?? fxRates.filter((x) => x.fromCcy === ccy && x.toCcy === 'USD').at(-1);
		return r ? BigInt(r.rateE6) : 1_000_000n;
	};
}

/** Price over cost per million tokens, as a margin in basis points; 6000 or more leaves room for everything else. */
export const tokenMarginHealth = (bp: number | null): Health => (bp === null ? null : bp >= 6000 ? 'good' : bp >= 4000 ? 'watch' : 'poor');
export const slaHealth = (bp: number | null): Health => (bp === null ? null : bp >= 9000 ? 'good' : bp >= 7500 ? 'watch' : 'poor');

export function aiTiles(input: {
	ym: string;
	/** Revenue for the month, from the books. */
	revenueMinor: Minor;
	now: string;
	cloudCosts: CloudCost[];
	employees: Employee[];
	batches: Batch[];
	deals: Deal[];
	tickets: SupportTicket[];
	invoices: Invoice[];
	contracts: Contract[];
	rate: RateE6;
}): { unit: Tile[]; credits: Tile[]; market: Tile[] } {
	const { ym, revenueMinor, now, rate } = input;
	const money = (m: bigint | string) => formatMoney(m.toString(), { whole: true });
	const pct = (bp: number | null) => (bp === null ? '–' : `${(bp / 100).toFixed(1)}%`);
	const inProgress = now.slice(0, 7) === ym;
	const cos = costOfService(input.cloudCosts, input.employees, ym, rate, inProgress ? now : undefined);
	const gm = grossMarginAfterInference(revenueMinor, cos);
	const tokens = costPerMTokens(input.cloudCosts, ym);
	const price = creditPricePerM(input.batches);
	const tokenMarginBp = tokens.perMMinor && price && toBig(price) > 0n ? Number(((toBig(price) - toBig(tokens.perMMinor)) * 10000n) / toBig(price)) : null;
	const credits = creditTotals(input.batches, now);
	const broke = breakage(input.batches, ym, now);
	const pipe = weightedPipeline(input.deals);
	const repeat = repeatRateBp(input.invoices, input.contracts, input.batches);
	const support = supportSummary(input.tickets, now);
	return {
		unit: [
			{
				key: 'gm-after-inference',
				label: 'Gross margin after inference',
				value: pct(gm.afterInferenceBp),
				health: aiGrossMarginHealth(gm.afterInferenceBp),
				inputs: `${pct(gm.beforeInferenceBp)} before model costs · ${money(cos.costOfRevenueMinor)} to run the product${inProgress ? ' so far' : ''}`,
				yardstick: 'Share of revenue left after model, hosting and on-call costs. AI startups usually keep 50% to 65%; classic software 75% to 80%.',
				href: '/costs'
			},
			{
				key: 'inference-share',
				label: 'Inference as a share of revenue',
				value: pct(gm.inferenceShareBp),
				health: inferenceShareHealth(gm.inferenceShareBp),
				inputs: `${money(cos.inferenceMinor)} of model calls in production`,
				yardstick: 'Share of revenue spent running AI models. Under 15% is comfortable; above 25% leaves little room for profit.',
				href: '/costs'
			},
			{
				key: 'token-margin',
				label: 'Margin per million tokens',
				value: pct(tokenMarginBp),
				health: tokenMarginHealth(tokenMarginBp),
				inputs: tokens.perMMinor && price ? `We pay ${formatMoney(tokens.perMMinor)} · customers pay ${formatMoney(price)} on credit packs` : 'Needs model usage and credit packs',
				yardstick: 'What customers pay for AI usage above what the model provider charges us. 60% or more covers hosting, support and the team.',
				href: '/batches'
			}
		],
		credits: [
			{
				key: 'unused-credits',
				label: 'Unused customer credits',
				value: money(credits.unusedMinor),
				health: null,
				inputs: `${money(credits.expiringMinor)} expires in the next 30 days`,
				yardstick: 'Owed to customers as usage until it is used or expires.',
				href: '/batches'
			},
			{
				key: 'breakage',
				label: 'Breakage this month',
				value: money(broke.amountMinor),
				health: null,
				inputs: `${broke.packs.length} pack${broke.packs.length === 1 ? '' : 's'} expired with credits left`,
				yardstick: 'Revenue from credits that expired unused. Rising breakage can mean customers bought more than they need.',
				href: '/batches'
			}
		],
		market: [
			{
				key: 'pipeline',
				label: 'Weighted pipeline',
				value: money(pipe.weightedMinor),
				health: null,
				inputs: `${money(pipe.openMinor)} open in ${pipe.openCount} deals · ${pct(pipe.winRateBp)} win rate`,
				yardstick: 'Open deals times their chance of closing, from the connected CRM.',
				href: '/customers'
			},
			{
				key: 'repeat',
				label: 'Repeat customers',
				value: pct(repeat),
				health: repeat === null ? null : repeat >= 3000 ? 'good' : repeat >= 1500 ? 'watch' : 'poor',
				inputs: 'Paid in several months, expanded, signed again or bought credits again',
				yardstick: 'A rising share means customers come back on their own.',
				href: '/customers'
			},
			{
				key: 'support-sla',
				label: 'Support replies on time',
				value: pct(support.metRateBp),
				health: slaHealth(support.metRateBp),
				inputs: `${support.open} open · ${support.breached} past due${support.medianFirstResponseMin === null ? '' : ` · ${support.medianFirstResponseMin} min median first reply`}`,
				yardstick: '90% or more answered within the promised time.',
				href: '/customers'
			}
		]
	};
}
