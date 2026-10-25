// Ledger read-side maths for the Ledger screen: the trial balance per company, the chart of accounts as a tree, and
// running balances. Pure functions over the source's rows; every amount is a bigint of minor units in the account's
// company's own (Functional) currency, lines in another currency converted at their recorded rate (ledger-core's
// rounding, via functionalNet), so the figures match the Board Pack's.
import { groupCode } from '@luyten/ledger-core';
import { isDebitNormal } from './data/derive';
import { functionalNet } from './data/group';
import type { Account, AccountType, JournalEntry, JournalLine, Subsidiary } from './data/types';
import { inPeriod, type PeriodFilter } from './drill';

/** One account in the trial balance. Opening and closing are net debits (a credit balance is negative). */
export interface TbRow {
	account: Account;
	opening: bigint;
	debits: bigint;
	credits: bigint;
	closing: bigint;
}

export interface TbTotals {
	opening: bigint;
	debits: bigint;
	credits: bigint;
	closingDebit: bigint;
	closingCredit: bigint;
}

export interface TbCompany {
	subsidiary: Subsidiary;
	rows: TbRow[];
	totals: TbTotals;
	/** Debits equal credits for the period and the closing debit and credit balances agree. */
	ties: boolean;
}

/** Whether an entry falls before the period the filter starts at (it then feeds the opening balance). */
export function beforePeriod(periodId: string, f: PeriodFilter): boolean {
	if (f.kind === 'all') return false;
	if (f.kind === 'one') return periodId < f.id;
	return !!f.from && periodId < f.from;
}

/** A line's debit and credit in its company's currency, each at the line's recorded rate. */
export function functionalSides(l: Pick<JournalLine, 'debitMinor' | 'creditMinor' | 'fxRateE6'>): { debit: bigint; credit: bigint } {
	return {
		debit: functionalNet({ debitMinor: l.debitMinor, creditMinor: '0', fxRateE6: l.fxRateE6 }),
		credit: -functionalNet({ debitMinor: '0', creditMinor: l.creditMinor, fxRateE6: l.fxRateE6 })
	};
}

export const tbTotals = (rows: TbRow[]): TbTotals =>
	rows.reduce(
		(t, r) => ({
			opening: t.opening + r.opening,
			debits: t.debits + r.debits,
			credits: t.credits + r.credits,
			closingDebit: t.closingDebit + (r.closing > 0n ? r.closing : 0n),
			closingCredit: t.closingCredit + (r.closing < 0n ? -r.closing : 0n)
		}),
		{ opening: 0n, debits: 0n, credits: 0n, closingDebit: 0n, closingCredit: 0n }
	);

const byCode = (a: { account: Account }, b: { account: Account }) => a.account.code.localeCompare(b.account.code, 'en', { numeric: true });

/**
 * The trial balance for the period filter, one block per company, accounts in code order. Opening is everything
 * before the period, debits and credits are the period's activity, closing is opening plus debits less credits.
 * Accounts with no balance and no activity are left out unless `includeZero`.
 */
export function trialBalance(
	books: { subsidiaries: Subsidiary[]; accounts: Account[]; entries: JournalEntry[]; lines: JournalLine[] },
	filter: PeriodFilter,
	opts: { subsidiaryId?: string; includeZero?: boolean } = {}
): TbCompany[] {
	const where = new Map<string, 'before' | 'in'>();
	for (const e of books.entries) {
		if (inPeriod(e.periodId, filter)) where.set(e.id, 'in');
		else if (beforePeriod(e.periodId, filter)) where.set(e.id, 'before');
	}
	const rows = new Map<string, TbRow>();
	for (const a of books.accounts) {
		if (opts.subsidiaryId && a.subsidiaryId !== opts.subsidiaryId) continue;
		rows.set(a.id, { account: a, opening: 0n, debits: 0n, credits: 0n, closing: 0n });
	}
	for (const l of books.lines) {
		const at = where.get(l.jeId);
		const r = at && rows.get(l.accountId);
		if (!r) continue;
		const { debit, credit } = functionalSides(l);
		if (at === 'before') r.opening += debit - credit;
		else {
			r.debits += debit;
			r.credits += credit;
		}
	}
	const out: TbCompany[] = [];
	for (const s of books.subsidiaries) {
		if (opts.subsidiaryId && s.id !== opts.subsidiaryId) continue;
		const list = [...rows.values()]
			.filter((r) => r.account.subsidiaryId === s.id)
			.map((r) => ({ ...r, closing: r.opening + r.debits - r.credits }))
			.filter((r) => opts.includeZero || r.opening !== 0n || r.debits !== 0n || r.credits !== 0n)
			.sort(byCode);
		if (!list.length) continue;
		const totals = tbTotals(list);
		out.push({ subsidiary: s, rows: list, totals, ties: totals.debits === totals.credits && totals.closingDebit === totals.closingCredit });
	}
	return out;
}

// Chart of accounts

export const TYPE_ORDER: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
export const TYPE_LABEL: Record<AccountType, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Revenue', expense: 'Expenses' };

/** Account groups by the first digit of the group code (the code without its company suffix). */
const GROUPS: Record<string, string> = {
	'1': 'Assets',
	'2': 'Liabilities',
	'3': 'Equity',
	'4': 'Revenue',
	'5': 'Cost of revenue',
	'6': 'Operating expenses',
	'7': 'Other income and expense',
	'8': 'Other income and expense',
	'9': 'Other'
};

/** The group an account code sits in: "5200-UK" is in 5000, Cost of revenue. */
export function accountGroup(code: string): { code: string; label: string } {
	const d = groupCode(code).charAt(0);
	return /\d/.test(d) ? { code: `${d}000`, label: GROUPS[d] } : { code: '', label: 'Other' };
}

export interface TreeGroup<R> {
	code: string;
	label: string;
	rows: R[];
}
export interface TreeType<R> {
	type: AccountType;
	label: string;
	groups: TreeGroup<R>[];
	rows: R[];
}

/** Rows arranged as the chart of accounts: type, then group code, then account code. */
export function accountTree<R extends { account: Account }>(rows: R[]): TreeType<R>[] {
	return TYPE_ORDER.map((type) => {
		const ofType = rows.filter((r) => r.account.type === type).sort(byCode);
		const groups = new Map<string, TreeGroup<R>>();
		for (const r of ofType) {
			const g = accountGroup(r.account.code);
			let entry = groups.get(g.code);
			if (!entry) groups.set(g.code, (entry = { ...g, rows: [] }));
			entry.rows.push(r);
		}
		return { type, label: TYPE_LABEL[type], groups: [...groups.values()], rows: ofType };
	}).filter((t) => t.rows.length > 0);
}

/** A balance in the account's natural sign (positive is normal: debit for assets and expenses, credit otherwise). */
export const natural = (type: AccountType, netDebit: bigint) => (isDebitNormal(type) ? netDebit : -netDebit);

// Running balance

/** Posting order: month, then the time posted, then id. */
export function chronological(a: JournalEntry, b: JournalEntry): number {
	return a.periodId.localeCompare(b.periodId) || a.postedAt.localeCompare(b.postedAt) || a.id.localeCompare(b.id, 'en', { numeric: true });
}

/**
 * The net debit balance of the given accounts after each entry, in posting order, starting from `opening`. Only
 * meaningful when the accounts share one currency (one company). Entries that do not touch the accounts are skipped.
 */
export function runningBalances(entries: JournalEntry[], linesByJe: Map<string, JournalLine[]>, accountIds: Set<string>, opening = 0n): Map<string, bigint> {
	const out = new Map<string, bigint>();
	let bal = opening;
	for (const e of [...entries].sort(chronological)) {
		const ls = (linesByJe.get(e.id) ?? []).filter((l) => accountIds.has(l.accountId));
		if (!ls.length) continue;
		for (const l of ls) bal += functionalNet(l);
		out.set(e.id, bal);
	}
	return out;
}
