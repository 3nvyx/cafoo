// Pure rules the mock applies before new demo data books: which month it goes into, and whether a Proposal's lines
// make one postable entry. Shared by the mock and its tests.
import type { Account, Period, Subsidiary } from '../types';
import { formatMoney, toBig } from '../money';
import type { ScriptLine } from './script';

/**
 * The month the clock is in while that month is open; otherwise the earliest month not locked. On the demo's
 * October 2 that is "2026-10", so uploads and connected tools book into October while September closes.
 * Undefined when every month is locked.
 */
export function currentOpenPeriodId(periods: Pick<Period, 'id' | 'status'>[], nowIso: string): string | undefined {
	const ym = nowIso.slice(0, 7);
	const current = periods.find((p) => p.id === ym && p.status !== 'closed');
	if (current) return current.id;
	return periods
		.filter((p) => p.status !== 'closed')
		.map((p) => p.id)
		.sort()[0];
}

/** Whether month "yyyy-mm" has ended by `nowIso`. */
export function monthEnded(ym: string, nowIso: string): boolean {
	return nowIso.slice(0, 7) > ym;
}

/**
 * Why these Proposal lines could not post as one Journal Entry, in plain words, or null when they can (no lines is
 * fine: the Proposal changes no balance). Every account must exist, all of them in one company, every amount must be
 * a whole, non-negative number of minor units, and debits must equal credits.
 */
export function entryProblem(lines: ScriptLine[], accounts: Pick<Account, 'code' | 'subsidiaryId'>[], subsidiaries: Pick<Subsidiary, 'id' | 'name'>[] = []): string | null {
	if (!lines.length) return null;
	const byCode = new Map(accounts.map((a) => [a.code, a]));
	const missing = [...new Set(lines.map((l) => l.account).filter((code) => !byCode.has(code)))];
	if (missing.length) return `The proposed entry uses ${missing.length === 1 ? `account ${missing[0]}, which is` : `accounts ${missing.join(', ')}, which are`} not in the chart of accounts.`;
	const companies = [...new Set(lines.map((l) => byCode.get(l.account)!.subsidiaryId))];
	if (companies.length > 1) {
		const names = companies.map((id) => subsidiaries.find((s) => s.id === id)?.name ?? id);
		return `The proposed entry mixes accounts of ${names.join(' and ')}; each entry posts to one company.`;
	}
	const whole = /^\d+$/;
	if (lines.some((l) => !whole.test(String(l.debitMinor)) || !whole.test(String(l.creditMinor)))) return 'The proposed entry has an amount that is not a whole, positive number of cents.';
	const debits = lines.reduce((s, l) => s + toBig(l.debitMinor), 0n);
	const credits = lines.reduce((s, l) => s + toBig(l.creditMinor), 0n);
	if (debits !== credits) return `The proposed entry does not balance: debits are ${formatMoney(debits.toString())} and credits are ${formatMoney(credits.toString())}.`;
	if (debits === 0n) return 'The proposed entry has no amounts.';
	return null;
}
