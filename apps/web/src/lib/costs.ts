// Cost of service and batches, as pure maths over DataSource rows: what it takes to run the product for customers
// (cloud, model inference, the service share of engineering pay), the margin left after it, and what prepaid credit
// packs and stock lots are worth as they are used up or expire. No side effects; money stays in bigint minor units.
import type { Account, Batch, CloudCost, CostCategory, CostProvider, Employee, JournalEntry, JournalLine, Minor } from './data/types';
import { toBig } from './data/money';

/** The products cost and revenue are tagged with. */
export const PRODUCTS = ['Scheduling', 'Copilot', 'Insights'] as const;
export type Product = (typeof PRODUCTS)[number];

/**
 * Subscription revenue by product, in basis points, from the billing tool's price ids (Q3 2026). Revenue in the ledger
 * is not tagged by product, so per-product margin applies this mix to the month's revenue.
 */
export const REVENUE_MIX_BP: Record<Product, number> = { Scheduling: 6000, Copilot: 3000, Insights: 1000 };

export const MODEL_PROVIDERS: CostProvider[] = ['openai', 'anthropic', 'together'];
export const CATEGORIES: CostCategory[] = ['cost_of_revenue', 'r_and_d', 'g_and_a'];

/** One unit of `ccy` in US dollars for month `ym`, scaled by 1e6 (1_000_000n is 1:1). */
export type RateE6 = (ccy: string, ym: string) => bigint;
export const USD_ONLY: RateE6 = () => 1_000_000n;

const sum = (xs: Iterable<bigint>) => {
	let t = 0n;
	for (const x of xs) t += x;
	return t;
};
/** num / den in basis points, rounded down; null when den is not positive. */
export const bpOf = (num: bigint, den: bigint): number | null => (den > 0n ? Number((num * 10000n) / den) : null);
const s = (n: bigint): Minor => n.toString();

export const isModelUsage = (r: CloudCost) => MODEL_PROVIDERS.includes(r.provider);
/** Production cloud that runs the live product: what 5000 Hosting costs carries. */
export const isHosting = (r: CloudCost) => !isModelUsage(r) && r.category === 'cost_of_revenue';
/** Model calls that serve customers: what 5200 Model inference carries. */
export const isInference = (r: CloudCost) => isModelUsage(r) && r.category === 'cost_of_revenue';

/** The months the rows cover, oldest first. */
export const monthsOf = (rows: Pick<CloudCost, 'ym'>[]) => [...new Set(rows.map((r) => r.ym))].sort();

/** "2026-10" to the first and last instants' dates ("2026-10-01", "2026-10-31"). */
function monthBounds(ym: string) {
	const [y, m] = ym.split('-').map(Number);
	return { from: `${ym}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

// ---------- Engineering service share ----------

/** Whether the person was on the payroll for any part of the month. */
export function employedIn(e: Pick<Employee, 'startAt' | 'endAt' | 'status'>, ym: string): boolean {
	const { from, to } = monthBounds(ym);
	if (e.startAt.slice(0, 10) > to) return false;
	if (e.endAt && e.endAt.slice(0, 10) < from) return false;
	return !(e.status === 'terminated' && !e.endAt);
}

/** A month's employer cost of one person in their own currency: salary (or 160 hours at the hourly rate), retirement, benefits. */
export function monthlyEmployerCost(e: Pick<Employee, 'annualSalaryMinor' | 'hourlyRateMinor' | 'retirementBp' | 'benefitsMonthlyMinor'>): bigint {
	const salary = toBig(e.annualSalaryMinor) > 0n ? toBig(e.annualSalaryMinor) / 12n : toBig(e.hourlyRateMinor) * 160n;
	return salary + (salary * BigInt(e.retirementBp)) / 10000n + toBig(e.benefitsMonthlyMinor);
}

export interface ServicePerson {
	employee: Employee;
	/** Employer cost for the month, in US dollars. */
	monthlyMinor: Minor;
	/** The share of it that runs the live service (cost of revenue), in US dollars. */
	serviceMinor: Minor;
}

/** Each person's service share of their pay for the month (employees × serviceShareBp), largest first, in US dollars. */
export function serviceEngineering(employees: Employee[], ym: string, rate: RateE6 = USD_ONLY): { totalMinor: Minor; people: ServicePerson[] } {
	const people = employees
		.filter((e) => e.serviceShareBp > 0 && employedIn(e, ym))
		.map((e) => {
			const usd = (monthlyEmployerCost(e) * rate(e.ccy, ym)) / 1_000_000n;
			return { employee: e, monthly: usd, service: (usd * BigInt(e.serviceShareBp)) / 10000n };
		})
		.sort((a, b) => (b.service > a.service ? 1 : b.service < a.service ? -1 : 0));
	return {
		totalMinor: s(sum(people.map((p) => p.service))),
		people: people.map((p) => ({ employee: p.employee, monthlyMinor: s(p.monthly), serviceMinor: s(p.service) }))
	};
}

// ---------- Cost of service ----------

export interface CostOfService {
	ym: string;
	/** Production cloud (5000). */
	hostingMinor: Minor;
	/** Production model calls (5200). */
	inferenceMinor: Minor;
	/** Service share of engineering and support pay (5250). */
	serviceEngineeringMinor: Minor;
	/** hosting + inference + service engineering. */
	costOfRevenueMinor: Minor;
	/** Staging, development and evals: building the next product. */
	rAndDMinor: Minor;
	/** Shared tooling the company runs on. */
	gAndAMinor: Minor;
	totalMinor: Minor;
}

/** What it took to run, build and support the product in month `ym`, split cost of revenue / R&D / G&A. */
export function costOfService(cloudCosts: CloudCost[], employees: Employee[], ym: string, rate: RateE6 = USD_ONLY): CostOfService {
	const month = cloudCosts.filter((r) => r.ym === ym);
	const usd = (r: CloudCost) => (toBig(r.amountMinor) * rate(r.ccy, ym)) / 1_000_000n;
	const of = (pred: (r: CloudCost) => boolean) => sum(month.filter(pred).map(usd));
	const hosting = of(isHosting);
	const inference = of(isInference);
	const svc = toBig(serviceEngineering(employees, ym, rate).totalMinor);
	const rAndD = of((r) => r.category === 'r_and_d');
	const gAndA = of((r) => r.category === 'g_and_a');
	const cor = hosting + inference + svc;
	return {
		ym,
		hostingMinor: s(hosting),
		inferenceMinor: s(inference),
		serviceEngineeringMinor: s(svc),
		costOfRevenueMinor: s(cor),
		rAndDMinor: s(rAndD),
		gAndAMinor: s(gAndA),
		totalMinor: s(cor + rAndD + gAndA)
	};
}

export interface MarginAfterInference {
	revenueMinor: Minor;
	/** Gross margin counting hosting and service engineering only. */
	beforeInferenceBp: number | null;
	/** Gross margin once model inference is counted too: the AI startup's real gross margin. */
	afterInferenceBp: number | null;
	/** Inference cost as a share of revenue. */
	inferenceShareBp: number | null;
}

export function grossMarginAfterInference(revenueMinor: Minor, cos: CostOfService): MarginAfterInference {
	const rev = toBig(revenueMinor);
	const before = rev - toBig(cos.hostingMinor) - toBig(cos.serviceEngineeringMinor);
	const after = before - toBig(cos.inferenceMinor);
	return { revenueMinor, beforeInferenceBp: bpOf(before, rev), afterInferenceBp: bpOf(after, rev), inferenceShareBp: bpOf(toBig(cos.inferenceMinor), rev) };
}

export interface Slice<K extends string> {
	key: K;
	amountMinor: Minor;
	/** Share of the month's total, basis points. */
	shareBp: number;
}

function slices<K extends string>(rows: CloudCost[], key: (r: CloudCost) => K): Slice<K>[] {
	const by = new Map<K, bigint>();
	for (const r of rows) by.set(key(r), (by.get(key(r)) ?? 0n) + toBig(r.amountMinor));
	const total = sum(by.values());
	return [...by]
		.map(([k, v]) => ({ key: k, amountMinor: s(v), shareBp: bpOf(v, total) ?? 0 }))
		.sort((a, b) => (toBig(b.amountMinor) > toBig(a.amountMinor) ? 1 : toBig(b.amountMinor) < toBig(a.amountMinor) ? -1 : 0));
}

/** The month's cloud and model spend by provider, largest first. */
export const costByProvider = (cloudCosts: CloudCost[], ym: string) => slices(cloudCosts.filter((r) => r.ym === ym), (r) => r.provider);

/** The month's spend by service line, largest first ("aws · EC2 app servers"). */
export const costByService = (cloudCosts: CloudCost[], ym: string) => slices(cloudCosts.filter((r) => r.ym === ym), (r) => `${r.provider}|${r.service}`);

export interface ProductMargin {
	product: Product;
	revenueMinor: Minor;
	hostingMinor: Minor;
	inferenceMinor: Minor;
	/** (revenue - hosting - inference) / revenue; service engineering is not tagged by product. */
	marginBp: number | null;
}

/** Revenue (by REVENUE_MIX_BP) against the production cloud and inference tagged to each product. */
export function marginByProduct(cloudCosts: CloudCost[], ym: string, revenueMinor: Minor): ProductMargin[] {
	const month = cloudCosts.filter((r) => r.ym === ym && r.category === 'cost_of_revenue');
	return PRODUCTS.map((product) => {
		const revenue = (toBig(revenueMinor) * BigInt(REVENUE_MIX_BP[product])) / 10000n;
		const mine = month.filter((r) => r.product === product);
		const hosting = sum(mine.filter(isHosting).map((r) => toBig(r.amountMinor)));
		const inference = sum(mine.filter(isInference).map((r) => toBig(r.amountMinor)));
		return { product, revenueMinor: s(revenue), hostingMinor: s(hosting), inferenceMinor: s(inference), marginBp: bpOf(revenue - hosting - inference, revenue) };
	});
}

export interface TokenCost {
	tokensM: number;
	costMinor: Minor;
	/** Cost per million tokens, minor units; null without tokens. */
	perMMinor: Minor | null;
}

/** What a million tokens cost us in production for the month, optionally for one product. Embeddings count too. */
export function costPerMTokens(cloudCosts: CloudCost[], ym: string, product?: string): TokenCost {
	const rows = cloudCosts.filter((r) => r.ym === ym && isInference(r) && r.usageUnit === 'M tokens' && (!product || r.product === product));
	const tokensM = rows.reduce((t, r) => t + r.usageQuantity, 0);
	const cost = sum(rows.map((r) => toBig(r.amountMinor)));
	return { tokensM, costMinor: s(cost), perMMinor: tokensM > 0 ? s((cost * 1000n) / BigInt(Math.round(tokensM * 1000))) : null };
}

/** What customers pay per million tokens across the credit packs sold (total paid / total tokens); null without packs. */
export function creditPricePerM(batches: Batch[]): Minor | null {
	const packs = batches.filter((b) => b.kind === 'credit_pack' && b.unit === 'M tokens' && b.quantity > 0);
	const qty = packs.reduce((t, b) => t + b.quantity, 0);
	return qty > 0 ? s(sum(packs.map((b) => toBig(b.amountMinor))) / BigInt(qty)) : null;
}

// ---------- Ledger tie-out ----------

/** Net debits on the account with `code`, per Period ("yyyy-mm"), for the company that owns it. */
export function ledgerByMonth(accounts: Account[], entries: JournalEntry[], lines: JournalLine[], code: string): Map<string, bigint> {
	const ids = new Set(accounts.filter((a) => a.code === code).map((a) => a.id));
	const period = new Map(entries.map((e) => [e.id, e.periodId]));
	const out = new Map<string, bigint>();
	for (const l of lines) {
		if (!ids.has(l.accountId)) continue;
		const ym = period.get(l.jeId);
		if (!ym) continue;
		out.set(ym, (out.get(ym) ?? 0n) + toBig(l.debitMinor) - toBig(l.creditMinor));
	}
	return out;
}

export interface HostingTie {
	ym: string;
	cloudMinor: Minor;
	ledgerMinor: Minor;
	/** cloud - ledger: positive means usage not yet booked. */
	gapMinor: Minor;
}

/** Production cloud by month against what 5000 Hosting costs carries. */
export function hostingTieOut(cloudCosts: CloudCost[], ledger5000: Map<string, bigint>, yms: string[]): HostingTie[] {
	return yms.map((ym) => {
		const cloud = sum(cloudCosts.filter((r) => r.ym === ym && isHosting(r)).map((r) => toBig(r.amountMinor)));
		const ledger = ledger5000.get(ym) ?? 0n;
		return { ym, cloudMinor: s(cloud), ledgerMinor: s(ledger), gapMinor: s(cloud - ledger) };
	});
}

// ---------- Batches: credit packs and stock lots ----------

export type BatchStatus = Batch['status'];
const DAY = 86_400_000;

/** The status as of `now`: depleted, expired, expiring (within `soonDays`), or active. Ignores the stored status. */
export function batchStatus(b: Pick<Batch, 'remaining' | 'expiresAt'>, now: string, soonDays = 30): BatchStatus {
	if (b.remaining <= 0) return 'depleted';
	if (!b.expiresAt) return 'active';
	const left = Date.parse(b.expiresAt) - Date.parse(now);
	if (left <= 0) return 'expired';
	return left <= soonDays * DAY ? 'expiring' : 'active';
}

/** What the unused part is worth: for a credit pack the customer's money we still owe as usage, for a lot its cost on hand. */
export const unusedValue = (b: Pick<Batch, 'amountMinor' | 'quantity' | 'remaining'>): Minor =>
	b.quantity > 0 ? s((toBig(b.amountMinor) * BigInt(Math.round(b.remaining * 1000))) / BigInt(Math.round(b.quantity * 1000))) : '0';

/** What has been used: credits consumed (earned as revenue) or units sold. */
export const usedValue = (b: Pick<Batch, 'amountMinor' | 'quantity' | 'remaining'>): Minor => s(toBig(b.amountMinor) - toBig(unusedValue(b)));

/** Share of the batch used up, basis points. */
export const usedBp = (b: Pick<Batch, 'quantity' | 'remaining'>) => (b.quantity > 0 ? Math.round(((b.quantity - b.remaining) / b.quantity) * 10000) : 0);

export interface Breakage {
	ym: string;
	packs: Batch[];
	/** Unused value of the packs that expired in the month: revenue the customer paid for and will never use (4300). */
	amountMinor: Minor;
}

/** Credit packs that expired in month `ym` with credits left, and the breakage revenue they leave behind. */
export function breakage(batches: Batch[], ym: string): Breakage {
	const packs = batches.filter((b) => b.kind === 'credit_pack' && b.remaining > 0 && !!b.expiresAt && b.expiresAt.slice(0, 7) === ym);
	return { ym, packs, amountMinor: s(sum(packs.map((b) => toBig(unusedValue(b))))) };
}

/** Batches with something left that expire within `days` of `now`, soonest first. */
export function expiringSoon(batches: Batch[], now: string, days = 30): Batch[] {
	return batches
		.filter((b) => batchStatus(b, now, days) === 'expiring')
		.sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''));
}

export interface CreditTotals {
	soldMinor: Minor;
	/** Unused credits the company still owes as usage (2450 Customer credits). */
	unusedMinor: Minor;
	usedMinor: Minor;
	/** Unused value of packs that expire within 30 days. */
	expiringMinor: Minor;
}

export function creditTotals(batches: Batch[], now: string): CreditTotals {
	const live = batches.filter((b) => b.kind === 'credit_pack');
	const open = live.filter((b) => batchStatus(b, now) !== 'expired');
	return {
		soldMinor: s(sum(live.map((b) => toBig(b.amountMinor)))),
		unusedMinor: s(sum(open.map((b) => toBig(unusedValue(b))))),
		usedMinor: s(sum(live.map((b) => toBig(usedValue(b))))),
		expiringMinor: s(sum(expiringSoon(live, now).map((b) => toBig(unusedValue(b)))))
	};
}
