// Pure read-side maths over DataSource rows: one account's balance, ARR, aging, Allowance. No side effects, so the
// same code works on any source. The Board Pack's statements, which need translation and consolidation, are group.ts.
import type { Account, AccountType, Contract, Customer, Invoice, JournalEntry, JournalLine, Minor, Period, RiskTier } from './types';
import { toBig } from './money';

export interface Books {
	accounts: Account[];
	entries: JournalEntry[];
	lines: JournalLine[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const monthName = (m: number) => MONTHS[m - 1] ?? '';
export const periodLabel = (p: Pick<Period, 'year' | 'month'>) => `${monthName(p.month)} ${p.year}`;
export const periodShort = (p: Pick<Period, 'year' | 'month'>) => `${monthName(p.month).slice(0, 3)} ${p.year}`;
/** "2026-09" to "Sep 2026". */
export function ymShort(ym: string): string {
	const [y, m] = ym.split('-').map(Number);
	return y && m ? periodShort({ year: y, month: m }) : ym;
}

/** Last instant of a Period, as an ISO date (yyyy-mm-dd). */
export function periodEnd(p: Pick<Period, 'year' | 'month'>): string {
	const d = new Date(Date.UTC(p.year, p.month, 0));
	return d.toISOString().slice(0, 10);
}

/** Natural sign per account type: assets and expenses are debit-normal. */
export function isDebitNormal(t: AccountType) {
	return t === 'asset' || t === 'expense';
}

/** Net balance per account id (natural sign, positive is normal) over the entries in `periodIds`. */
export function balances(books: Books, periodIds?: Set<string>): Map<string, bigint> {
	const inScope = new Set(books.entries.filter((e) => !periodIds || periodIds.has(e.periodId)).map((e) => e.id));
	const types = new Map(books.accounts.map((a) => [a.id, a.type]));
	const out = new Map<string, bigint>();
	for (const l of books.lines) {
		if (!inScope.has(l.jeId)) continue;
		const t = types.get(l.accountId);
		if (!t) continue;
		const dr = toBig(l.debitMinor) - toBig(l.creditMinor);
		out.set(l.accountId, (out.get(l.accountId) ?? 0n) + (isDebitNormal(t) ? dr : -dr));
	}
	return out;
}

export function periodsThrough(periods: Period[], periodId: string): Set<string> {
	return new Set(periods.filter((p) => p.id <= periodId).map((p) => p.id));
}

export function accountBalance(books: Books, periods: Period[], periodId: string, code: string): Minor {
	const a = books.accounts.find((x) => x.code === code);
	if (!a) return '0';
	return (balances(books, periodsThrough(periods, periodId)).get(a.id) ?? 0n).toString();
}

// ARR
const active = (c: Contract, at: string) => c.startAt.slice(0, 10) <= at && (!c.endAt || c.endAt.slice(0, 10) > at);

export function arrAt(contracts: Contract[], at: string): Minor {
	let t = 0n;
	for (const c of contracts) {
		if (!active(c, at)) continue;
		const usePrior = c.changedAt && c.priorArrMinor && c.changedAt.slice(0, 10) > at;
		t += toBig(usePrior ? c.priorArrMinor : c.arrMinor);
	}
	return t.toString();
}

export interface ArrWaterfall {
	start: Minor;
	added: Minor;
	expansion: Minor;
	contraction: Minor;
	churned: Minor;
	end: Minor;
	from: string;
	to: string;
}

/** Movement in ARR between two dates (exclusive start, inclusive end). */
export function arrWaterfall(contracts: Contract[], from: string, to: string): ArrWaterfall {
	let added = 0n, expansion = 0n, contraction = 0n, churned = 0n;
	for (const c of contracts) {
		const start = c.startAt.slice(0, 10);
		const end = c.endAt?.slice(0, 10);
		const arr = toBig(c.arrMinor);
		const prior = toBig(c.priorArrMinor ?? c.arrMinor);
		const changed = c.changedAt?.slice(0, 10);
		if (start > from && start <= to) {
			added += arr;
			continue;
		}
		if (start > to) continue;
		if (end && end > from && end <= to) {
			churned += changed && changed > from && changed <= to ? prior : arr;
			continue;
		}
		if (changed && changed > from && changed <= to) {
			const d = arr - prior;
			if (d > 0n) expansion += d;
			else contraction += -d;
		}
	}
	return {
		start: arrAt(contracts, from),
		added: added.toString(),
		expansion: expansion.toString(),
		contraction: contraction.toString(),
		churned: churned.toString(),
		end: arrAt(contracts, to),
		from,
		to
	};
}

// Aging
export type AgingBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';
export const AGING_BUCKETS: AgingBucket[] = ['current', '1-30', '31-60', '61-90', '90+'];
export const AGING_LABEL: Record<AgingBucket, string> = {
	current: 'Not yet due',
	'1-30': '1 to 30 days late',
	'31-60': '31 to 60 days late',
	'61-90': '61 to 90 days late',
	'90+': 'Over 90 days late'
};

export function daysBetween(a: string, b: string): number {
	return Math.floor((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);
}

export function bucketOf(inv: Invoice, asOf: string): AgingBucket {
	const late = daysBetween(inv.dueAt, asOf);
	if (late <= 0) return 'current';
	if (late <= 30) return '1-30';
	if (late <= 60) return '31-60';
	if (late <= 90) return '61-90';
	return '90+';
}

export function aging(invoices: Invoice[], asOf: string) {
	const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0n])) as Record<AgingBucket, bigint>;
	const byCustomer = new Map<string, Record<AgingBucket, bigint>>();
	for (const inv of invoices) {
		if (inv.status === 'paid' || inv.issuedAt.slice(0, 10) > asOf) continue;
		const b = bucketOf(inv, asOf);
		totals[b] += toBig(inv.amountMinor);
		let row = byCustomer.get(inv.customerId);
		if (!row) byCustomer.set(inv.customerId, (row = Object.fromEntries(AGING_BUCKETS.map((k) => [k, 0n])) as Record<AgingBucket, bigint>));
		row[b] += toBig(inv.amountMinor);
	}
	const total = AGING_BUCKETS.reduce((t, b) => t + totals[b], 0n);
	return { totals, byCustomer, total };
}

export function openReceivable(invoices: Invoice[], customerId: string): Minor {
	return invoices
		.filter((i) => i.customerId === customerId && i.status !== 'paid')
		.reduce((t, i) => t + toBig(i.amountMinor), 0n)
		.toString();
}

/** Expected-credit-loss rate by Risk Tier, in basis points. */
export const ALLOWANCE_RATE_BP: Record<RiskTier, number> = { A: 100, B: 200, C: 1000, D: 7500, BLOCK: 10000 };

export function allowanceFor(customer: Customer, invoices: Invoice[]): Minor {
	if (!customer.creditTier) return '0';
	const open = toBig(openReceivable(invoices, customer.id));
	return ((open * BigInt(ALLOWANCE_RATE_BP[customer.creditTier])) / 10000n).toString();
}

export function contractArr(contracts: Contract[], customerId: string, at: string): Minor {
	return arrAt(contracts.filter((c) => c.customerId === customerId), at);
}
