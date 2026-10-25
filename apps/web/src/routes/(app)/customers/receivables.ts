// Pure maths for the Customers screens: one row per customer (ARR, what they owe, how late, Allowance), the AR summary
// tiles, sorting, filtering and paging. Money stays in integer minor units (bigint inside, strings out).
import { ALLOWANCE_RATE_BP, contractArr, daysBetween } from '#lib/data/derive.js';
import { toBig } from '#lib/data/money.js';
import type { BankMatch, BankTransaction, Contract, Customer, Invoice, Minor, RiskTier } from '#lib/data/types.js';

/** Days past due, in four buckets. An invoice not yet due counts as 0 days, so it sits in the first bucket. */
export type ArBucket = '0-30' | '31-60' | '61-90' | '90+';
export const AR_BUCKETS: ArBucket[] = ['0-30', '31-60', '61-90', '90+'];
export const AR_BUCKET_LABEL: Record<ArBucket, string> = {
	'0-30': 'Current to 30 days',
	'31-60': '31 to 60 days',
	'61-90': '61 to 90 days',
	'90+': 'Over 90 days'
};

/** Self-serve, mid-market or enterprise, read from active ARR (the customer table has no segment column). */
export type Segment = 'self_serve' | 'mid_market' | 'enterprise' | 'no_contract';
export const SEGMENTS: Segment[] = ['self_serve', 'mid_market', 'enterprise', 'no_contract'];
export const SEGMENT_LABEL: Record<Segment, string> = {
	self_serve: 'Self-serve',
	mid_market: 'Mid-market',
	enterprise: 'Enterprise',
	no_contract: 'No active contract'
};
/**
 * ARR thresholds in minor units: under $15k is self-serve, under $75k mid-market, the rest enterprise. They sit in the
 * gaps between the price bands a Series A SaaS company sells at: team plans from about $18k a year, enterprise
 * contracts from about $90k.
 */
export const MID_MARKET_FROM = 1_500_000n;
export const ENTERPRISE_FROM = 7_500_000n;

export function segmentOf(arrMinor: Minor): Segment {
	const arr = toBig(arrMinor);
	if (arr <= 0n) return 'no_contract';
	if (arr < MID_MARKET_FROM) return 'self_serve';
	if (arr < ENTERPRISE_FROM) return 'mid_market';
	return 'enterprise';
}

export function bucketForDays(daysLate: number): ArBucket {
	if (daysLate <= 30) return '0-30';
	if (daysLate <= 60) return '31-60';
	if (daysLate <= 90) return '61-90';
	return '90+';
}

/** Invoices still owed as of `asOf`: not paid and already issued by then. */
export function isOpenAt(inv: Invoice, asOf: string): boolean {
	return inv.status !== 'paid' && inv.issuedAt.slice(0, 10) <= asOf;
}

export interface CustomerRow {
	customer: Customer;
	segment: Segment;
	arrMinor: Minor;
	openMinor: Minor;
	overdueMinor: Minor;
	/** Days the oldest unpaid invoice is past due; 0 when nothing is late. */
	daysOverdue: number;
	allowanceMinor: Minor;
	buckets: Record<ArBucket, Minor>;
	openInvoices: number;
}

const zeroBuckets = (): Record<ArBucket, bigint> => ({ '0-30': 0n, '31-60': 0n, '61-90': 0n, '90+': 0n });
const toMinorBuckets = (b: Record<ArBucket, bigint>): Record<ArBucket, Minor> =>
	Object.fromEntries(AR_BUCKETS.map((k) => [k, b[k].toString()])) as Record<ArBucket, Minor>;

/** One row per customer. Groups invoices and contracts once, so 300 customers and thousands of invoices stay cheap. */
export function customerRows(customers: Customer[], invoices: Invoice[], contracts: Contract[], asOf: string): CustomerRow[] {
	const invBy = groupBy(invoices, (i) => i.customerId);
	const conBy = groupBy(contracts, (c) => c.customerId);
	return customers.map((c) => {
		const arrMinor = contractArr(conBy.get(c.id) ?? [], c.id, asOf);
		const b = zeroBuckets();
		let open = 0n;
		let overdue = 0n;
		let daysOverdue = 0;
		let openInvoices = 0;
		for (const inv of invBy.get(c.id) ?? []) {
			if (!isOpenAt(inv, asOf)) continue;
			const amt = toBig(inv.amountMinor);
			const late = Math.max(0, daysBetween(inv.dueAt, asOf));
			open += amt;
			openInvoices++;
			b[bucketForDays(late)] += amt;
			if (late > 0) {
				overdue += amt;
				daysOverdue = Math.max(daysOverdue, late);
			}
		}
		const allowance = c.creditTier ? (open * BigInt(ALLOWANCE_RATE_BP[c.creditTier])) / 10000n : 0n;
		return {
			customer: c,
			segment: segmentOf(arrMinor),
			arrMinor,
			openMinor: open.toString(),
			overdueMinor: overdue.toString(),
			daysOverdue,
			allowanceMinor: allowance.toString(),
			buckets: toMinorBuckets(b),
			openInvoices
		};
	});
}

export type TierKey = RiskTier | 'none';
export const TIER_KEYS: TierKey[] = ['A', 'B', 'C', 'D', 'BLOCK', 'none'];

export interface ArSummary {
	openMinor: Minor;
	overdueMinor: Minor;
	allowanceMinor: Minor;
	buckets: Record<ArBucket, Minor>;
	/** Each bucket's share of open AR in basis points; they add to 10000 when anything is owed (largest remainder). */
	bucketShareBp: Record<ArBucket, number>;
	byTier: Record<TierKey, number>;
	overdueCustomers: number;
}

export function arSummary(rows: CustomerRow[]): ArSummary {
	const b = zeroBuckets();
	let open = 0n, overdue = 0n, allowance = 0n, overdueCustomers = 0;
	const byTier = Object.fromEntries(TIER_KEYS.map((t) => [t, 0])) as Record<TierKey, number>;
	for (const r of rows) {
		open += toBig(r.openMinor);
		overdue += toBig(r.overdueMinor);
		allowance += toBig(r.allowanceMinor);
		for (const k of AR_BUCKETS) b[k] += toBig(r.buckets[k]);
		byTier[r.customer.creditTier ?? 'none']++;
		if (r.daysOverdue > 0) overdueCustomers++;
	}
	return {
		openMinor: open.toString(),
		overdueMinor: overdue.toString(),
		allowanceMinor: allowance.toString(),
		buckets: toMinorBuckets(b),
		bucketShareBp: sharesBp(AR_BUCKETS.map((k) => b[k]), AR_BUCKETS),
		byTier,
		overdueCustomers
	};
}

/** Shares of a total in basis points that add up to exactly 10000 (largest remainder). All zero when the total is 0. */
export function sharesBp<K extends string>(values: bigint[], keys: K[]): Record<K, number> {
	const total = values.reduce((t, v) => t + (v > 0n ? v : 0n), 0n);
	const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
	if (total <= 0n) return out;
	const parts = values.map((v, i) => {
		const scaled = (v > 0n ? v : 0n) * 10000n;
		return { i, floor: Number(scaled / total), rem: scaled % total };
	});
	let left = 10000 - parts.reduce((t, p) => t + p.floor, 0);
	for (const p of [...parts].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i))) {
		if (left <= 0) break;
		p.floor++;
		left--;
	}
	for (const p of parts) out[keys[p.i]] = p.floor;
	return out;
}

export type SortKey = 'name' | 'arr' | 'open' | 'overdue' | 'tier' | 'allowance';
export type SortDir = 'asc' | 'desc';
const TIER_RANK: Record<TierKey, number> = { A: 0, B: 1, C: 2, D: 3, BLOCK: 4, none: 5 };

export function sortRows(rows: CustomerRow[], key: SortKey, dir: SortDir): CustomerRow[] {
	const sign = dir === 'asc' ? 1 : -1;
	const cmpBig = (a: Minor, b: Minor) => {
		const x = toBig(a), y = toBig(b);
		return x < y ? -1 : x > y ? 1 : 0;
	};
	const by: Record<SortKey, (a: CustomerRow, b: CustomerRow) => number> = {
		name: (a, b) => a.customer.name.localeCompare(b.customer.name),
		arr: (a, b) => cmpBig(a.arrMinor, b.arrMinor),
		open: (a, b) => cmpBig(a.openMinor, b.openMinor),
		overdue: (a, b) => a.daysOverdue - b.daysOverdue || cmpBig(a.overdueMinor, b.overdueMinor),
		tier: (a, b) => TIER_RANK[a.customer.creditTier ?? 'none'] - TIER_RANK[b.customer.creditTier ?? 'none'],
		allowance: (a, b) => cmpBig(a.allowanceMinor, b.allowanceMinor)
	};
	// Ties fall back to the name so the order is stable across renders.
	return [...rows].sort((a, b) => sign * by[key](a, b) || a.customer.name.localeCompare(b.customer.name));
}

export interface RowFilter {
	q?: string;
	segment?: Segment | 'all';
	tier?: TierKey | 'all';
	/** Only customers with something past due. */
	overdueOnly?: boolean;
}

export function filterRows(rows: CustomerRow[], f: RowFilter): CustomerRow[] {
	const q = f.q?.trim().toLowerCase() ?? '';
	return rows.filter(
		(r) =>
			(!q || r.customer.name.toLowerCase().includes(q) || r.customer.domain.toLowerCase().includes(q) || r.customer.guarantorName.toLowerCase().includes(q)) &&
			(!f.segment || f.segment === 'all' || r.segment === f.segment) &&
			(!f.tier || f.tier === 'all' || (r.customer.creditTier ?? 'none') === f.tier) &&
			(!f.overdueOnly || r.daysOverdue > 0)
	);
}

/** One page of rows (pages count from 1; an out-of-range page clamps to the nearest real one). */
export function paginate<T>(rows: T[], page: number, size: number): { rows: T[]; page: number; pages: number } {
	const pages = Math.max(1, Math.ceil(rows.length / size));
	const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
	return { rows: rows.slice((p - 1) * size, p * size), page: p, pages };
}

/** Invoiced per month ("yyyy-mm"), oldest first, for the last `months` months that have any invoice. */
export function invoicedByMonth(invoices: Invoice[], months = 12): { ym: string; amountMinor: Minor }[] {
	const by = new Map<string, bigint>();
	for (const i of invoices) {
		const ym = i.issuedAt.slice(0, 7);
		by.set(ym, (by.get(ym) ?? 0n) + toBig(i.amountMinor));
	}
	return [...by.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.slice(-months)
		.map(([ym, v]) => ({ ym, amountMinor: v.toString() }));
}

export interface Payment {
	matchId: string;
	targetId: string;
	bankTransactionId: string;
	bookedAt: string;
	amountMinor: Minor;
	counterparty: string;
	scoreBp: number;
	proposalId?: string;
	paymentJeId?: string;
}

/** Bank lines matched to these invoices or bills, newest first. */
export function paymentsFor(targetKind: 'invoice' | 'bill', targetIds: Set<string>, matches: BankMatch[], txns: BankTransaction[]): Payment[] {
	const tx = new Map(txns.map((t) => [t.id, t]));
	const out: Payment[] = [];
	for (const m of matches) {
		if (m.targetKind !== targetKind || !targetIds.has(m.targetId)) continue;
		const t = tx.get(m.bankTransactionId);
		if (!t) continue;
		out.push({
			matchId: m.id,
			targetId: m.targetId,
			bankTransactionId: t.id,
			bookedAt: t.bookedAt,
			amountMinor: (toBig(t.amountMinor) < 0n ? -toBig(t.amountMinor) : toBig(t.amountMinor)).toString(),
			counterparty: t.counterparty,
			scoreBp: m.scoreBp,
			proposalId: m.proposalId,
			paymentJeId: m.paymentJeId
		});
	}
	return out.sort((a, b) => b.bookedAt.localeCompare(a.bookedAt));
}

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const x of xs) {
		const k = key(x);
		const arr = m.get(k);
		if (arr) arr.push(x);
		else m.set(k, [x]);
	}
	return m;
}
