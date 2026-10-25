// The Overview's figures for any date range: what one company earned and spent between two days, and where its
// balance sheet stood on the last one. Pure maths over DataSource rows, like derive.ts; the group view (translation,
// eliminations) is the Board Pack's, in group.ts.
import type { Account, Contract, JournalEntry, JournalLine, Minor } from './types';
import { arrAt, daysBetween, isDebitNormal } from './derive';
import { functionalNet } from './group';

/** Inclusive calendar days, "yyyy-mm-dd". */
export interface DateRange {
	from: string;
	to: string;
}

/** One journal line, dated and signed: positive is the account's normal side, in the company's own currency. */
export interface Posting {
	date: string;
	account: Account;
	amount: bigint;
	/** The journal entry the line belongs to; tells operating cash from money raised. */
	jeId?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-09" to the first and last day of that month. */
export function monthRange(ym: string): DateRange {
	const [y, m] = ym.split('-').map(Number);
	return { from: `${ym}-01`, to: `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
}

/** "yyyy-mm-dd" moved by `days`. */
export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Days in the range, both ends included. */
export const rangeDays = (r: DateRange) => daysBetween(r.from, r.to) + 1;

/**
 * The day an entry counts on: its posting day, held inside its own month. Close adjustments post after the month has
 * ended but belong to it, so a September accrual posted on October 2 counts on September 30.
 */
export function entryDate(e: Pick<JournalEntry, 'postedAt' | 'periodId'>): string {
	const day = e.postedAt.slice(0, 10);
	const { from, to } = monthRange(e.periodId);
	return day < from ? from : day > to ? to : day;
}

/** Every line on `accounts` (one company's chart), dated by its entry and signed by its account's normal side. */
export function postings(accounts: Account[], entries: JournalEntry[], lines: JournalLine[]): Posting[] {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	const dates = new Map(entries.map((e) => [e.id, entryDate(e)]));
	const out: Posting[] = [];
	for (const l of lines) {
		const account = byId.get(l.accountId);
		const date = dates.get(l.jeId);
		if (!account || !date) continue;
		const net = functionalNet(l);
		out.push({ date, account, amount: isDebitNormal(account.type) ? net : -net, jeId: l.jeId });
	}
	return out;
}

/** Whether the range starts on a month's first day and ends on a month's last. */
export const isWholeMonths = (r: DateRange) => r.from.endsWith('-01') && monthRange(r.to.slice(0, 7)).to === r.to;

/**
 * The range before `r` to compare it with: the same number of whole months when `r` is whole months (August for
 * September), otherwise the same number of days just before it.
 */
export function previousRange(r: DateRange): DateRange {
	const end = addDays(r.from, -1);
	if (isWholeMonths(r)) {
		const months = (Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 + Number(r.to.slice(5, 7)) - Number(r.from.slice(5, 7)) + 1;
		const [y, m] = r.from.split('-').map(Number);
		const start = new Date(Date.UTC(y, m - 1 - months, 1));
		return { from: start.toISOString().slice(0, 10), to: end };
	}
	return { from: addDays(end, -(rangeDays(r) - 1)), to: end };
}

// The chart of accounts the seed and the module share: 5xxx is the cost of delivering the product, 6xxx running the
// business. Balance sheet lines by their codes.
const isCostOfRevenue = (a: Account) => a.type === 'expense' && a.code.startsWith('5');
// Fees between group companies are real for the company but not for the business: the Board Pack eliminates them,
// so the Overview leaves them out of revenue and expenses and reports them on their own.
const isOperating = (a: Account) => (a.type === 'revenue' || a.type === 'expense') && !a.isIntercompany;
const CASH = ['1000'];
const RECEIVABLES = ['1100'];
const ALLOWANCE = ['1150'];
const PAYABLES = ['2000', '2100'];
const DEFERRED = ['2400'];

const inRange = (d: string, r: DateRange) => d >= r.from && d <= r.to;

/**
 * Entries that raise or return money rather than run the business: any entry touching SAFEs, notes and their interest
 * (26xx), equity (3xxx) or subscriptions receivable (1060). Their cash is not income, and it does not offset burn.
 */
const isFinancingAccount = (a: Account) => a.type === 'equity' || a.code.startsWith('26') || a.code === '1060';
export function financingEntries(ps: Posting[]): Set<string> {
	const out = new Set<string>();
	for (const p of ps) if (p.jeId && isFinancingAccount(p.account)) out.add(p.jeId);
	return out;
}

function sum(ps: Posting[], keep: (p: Posting) => boolean): bigint {
	let t = 0n;
	for (const p of ps) if (keep(p)) t += p.amount;
	return t;
}

/** Balance of the accounts with these codes at the end of `date`. */
export function balanceAt(ps: Posting[], codes: string[], date: string): bigint {
	return sum(ps, (p) => p.date <= date && codes.includes(p.account.code));
}

export interface ExpenseLine {
	account: Account;
	minor: Minor;
}

export interface Summary {
	range: DateRange;
	/** Revenue from customers; intercompany fees are in `intercompany`. */
	revenue: Minor;
	/** Net intercompany fees earned (charged to other group companies, less those charged to us). */
	intercompany: Minor;
	costOfRevenue: Minor;
	expenses: Minor;
	netIncome: Minor;
	/** (revenue - cost of revenue) / revenue, in basis points; null without revenue. */
	grossMarginBp: number | null;
	/** Net income over revenue, in basis points; null without revenue. */
	netMarginBp: number | null;
	cash: Minor;
	/** Cash at the end of the range minus cash the day before it began. */
	cashChange: Minor;
	/** Cash the day before the range began. */
	openingCash: Minor;
	/**
	 * Operating money into cash over the range, and out of it (a positive amount). Money raised or returned (SAFEs,
	 * notes, shares) is not income and sits in `financingCash`: opening + in - out + financing = cash.
	 */
	cashIn: Minor;
	cashOut: Minor;
	/** Net cash from raising money (or repaying it) over the range. */
	financingCash: Minor;
	/** Cash change without money raised: what running the business did to cash. Burn and runway read this. */
	operatingCashChange: Minor;
	/** Receivables before the Allowance. */
	receivables: Minor;
	/** The Allowance for credit losses, as a positive amount. */
	allowance: Minor;
	payables: Minor;
	deferredRevenue: Minor;
	arr: Minor;
	/** Days sales outstanding: receivables over the range's revenue, times its days. Null without revenue. */
	dsoDays: number | null;
	/** Months of cash at the range's rate of operating cash outflow; null when operations did not use cash. */
	runwayMonths: number | null;
	/** Expense accounts by amount, largest first. */
	byExpense: ExpenseLine[];
}

const AVG_MONTH_DAYS = 365.25 / 12;
const bp = (num: bigint, den: bigint) => (den > 0n ? Number((num * 10000n) / den) : null);

export function summarize(ps: Posting[], contracts: Contract[], range: DateRange): Summary {
	const flow = ps.filter((p) => inRange(p.date, range));
	const revenue = sum(flow, (p) => isOperating(p.account) && p.account.type === 'revenue');
	const cogs = sum(flow, (p) => isOperating(p.account) && isCostOfRevenue(p.account));
	const expenses = sum(flow, (p) => isOperating(p.account) && p.account.type === 'expense');
	const intercompany = sum(flow, (p) => !!p.account.isIntercompany && p.account.type === 'revenue') - sum(flow, (p) => !!p.account.isIntercompany && p.account.type === 'expense');
	const netIncome = revenue - expenses;
	const cash = balanceAt(ps, CASH, range.to);
	const openingCash = balanceAt(ps, CASH, addDays(range.from, -1));
	const cashChange = cash - openingCash;
	const financing = financingEntries(ps);
	const isCash = (p: Posting) => CASH.includes(p.account.code);
	const raised = (p: Posting) => !!p.jeId && financing.has(p.jeId);
	const cashIn = sum(flow, (p) => isCash(p) && !raised(p) && p.amount > 0n);
	const cashOut = -sum(flow, (p) => isCash(p) && !raised(p) && p.amount < 0n);
	const financingCash = sum(flow, (p) => isCash(p) && raised(p));
	const operatingCashChange = cashChange - financingCash;
	const receivables = balanceAt(ps, RECEIVABLES, range.to);
	const days = rangeDays(range);

	const perAccount = new Map<string, { account: Account; amount: bigint }>();
	for (const p of flow) {
		if (!isOperating(p.account) || p.account.type !== 'expense') continue;
		const row = perAccount.get(p.account.id) ?? { account: p.account, amount: 0n };
		row.amount += p.amount;
		perAccount.set(p.account.id, row);
	}
	const burnPerMonth = operatingCashChange < 0n ? (Number(-operatingCashChange) / days) * AVG_MONTH_DAYS : 0;

	return {
		range,
		revenue: revenue.toString(),
		intercompany: intercompany.toString(),
		costOfRevenue: cogs.toString(),
		expenses: expenses.toString(),
		netIncome: netIncome.toString(),
		grossMarginBp: bp(revenue - cogs, revenue),
		netMarginBp: bp(netIncome, revenue),
		cash: cash.toString(),
		cashChange: cashChange.toString(),
		openingCash: openingCash.toString(),
		cashIn: cashIn.toString(),
		cashOut: cashOut.toString(),
		financingCash: financingCash.toString(),
		operatingCashChange: operatingCashChange.toString(),
		receivables: receivables.toString(),
		allowance: (-balanceAt(ps, ALLOWANCE, range.to)).toString(),
		payables: balanceAt(ps, PAYABLES, range.to).toString(),
		deferredRevenue: balanceAt(ps, DEFERRED, range.to).toString(),
		arr: arrAt(contracts, range.to),
		dsoDays: revenue > 0n ? Math.round((Number(receivables) / Number(revenue)) * days) : null,
		runwayMonths: burnPerMonth > 0 && cash > 0n ? Number(cash) / burnPerMonth : null,
		byExpense: [...perAccount.values()]
			.filter((r) => r.amount !== 0n)
			.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
			.map((r) => ({ account: r.account, minor: r.amount.toString() }))
	};
}

export interface MonthPoint {
	ym: string;
	revenue: number;
	expenses: number;
	netIncome: number;
	/** Cash at the month's last day. */
	cash: number;
	arr: number;
}

/** One point per month, in major units for drawing. Exact figures come from summarize(). */
export function monthly(ps: Posting[], contracts: Contract[], yms: string[]): MonthPoint[] {
	const major = (v: Minor) => Number(v) / 100;
	return yms.map((ym) => {
		const s = summarize(ps, contracts, monthRange(ym));
		return { ym, revenue: major(s.revenue), expenses: major(s.expenses), netIncome: major(s.netIncome), cash: major(s.cash), arr: major(s.arr) };
	});
}

/** The months ("yyyy-mm") a range touches. */
export function monthsIn(r: DateRange): string[] {
	const out: string[] = [];
	let ym = r.from.slice(0, 7);
	const last = r.to.slice(0, 7);
	while (ym <= last) {
		out.push(ym);
		const [y, m] = ym.split('-').map(Number);
		ym = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
	}
	return out;
}
