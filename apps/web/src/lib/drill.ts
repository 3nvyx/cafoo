// Ledger drill-down links: every figure links to the journal lines behind it.
//
//   /ledger?drill=account:4000            one account
//   /ledger?drill=account:4000,4100       several accounts
//   /ledger?drill=type:revenue,expense    every account of these types (e.g. the income statement)
//   /ledger?drill=je:42 | customer:c05 | vendor:v01
//   &period=2026-09                       one month
//   &period=2026-07..2026-09              a range of months (either end may be left open: ..2026-09)
//   &period=all                           every month
//   &company=UK                           only that company's accounts (a Subsidiary code), e.g. one company's income statement
import type { AccountType } from './data/types';
import { ymShort } from './data/derive';

export interface DrillTarget {
	account?: string | string[];
	type?: AccountType[];
	je?: string;
	customer?: string;
	vendor?: string;
	/** Narrow an account or type drill to one company's accounts (its Subsidiary code). */
	company?: string;
}

/** A month ("yyyy-mm"), every month, or an inclusive range of months. */
export type DrillPeriod = string | { from?: string; to?: string };

export function drill(target: DrillTarget, period?: DrillPeriod): string {
	const q = new URLSearchParams();
	const [k, raw] = Object.entries(target).find(([key, v]) => key !== 'company' && (Array.isArray(v) ? v.length > 0 : !!v)) ?? [];
	if (k && raw) q.set('drill', `${k}:${Array.isArray(raw) ? raw.join(',') : raw}`);
	if (target.company) q.set('company', target.company);
	if (period) q.set('period', typeof period === 'string' ? period : `${period.from ?? ''}..${period.to ?? ''}`);
	return `/ledger?${q.toString()}`;
}

export type PeriodFilter = { kind: 'all' } | { kind: 'one'; id: string } | { kind: 'range'; from?: string; to?: string };

export function parsePeriod(value: string): PeriodFilter {
	if (value === 'all') return { kind: 'all' };
	if (value.includes('..')) {
		const [from, to] = value.split('..', 2);
		return { kind: 'range', from: from || undefined, to: to || undefined };
	}
	return { kind: 'one', id: value };
}

/** Period ids are "yyyy-mm", so string order is month order. */
export function inPeriod(periodId: string, f: PeriodFilter): boolean {
	if (f.kind === 'all') return true;
	if (f.kind === 'one') return periodId === f.id;
	return (!f.from || periodId >= f.from) && (!f.to || periodId <= f.to);
}

export function periodFilterLabel(f: PeriodFilter): string {
	if (f.kind === 'all') return 'All periods';
	if (f.kind === 'one') return ymShort(f.id);
	if (f.from && f.to) return f.from === f.to ? ymShort(f.from) : `${ymShort(f.from)} to ${ymShort(f.to)}`;
	if (f.to) return `Through ${ymShort(f.to)}`;
	if (f.from) return `From ${ymShort(f.from)}`;
	return 'All periods';
}

/** Parse ?drill=kind:value. Account and type drills may list several values, comma-separated. */
export function parseDrill(raw: string): { kind: string; values: string[] } {
	const i = raw.indexOf(':');
	if (i < 0) return { kind: '', values: [] };
	const kind = raw.slice(0, i);
	const value = raw.slice(i + 1);
	const values = kind === 'account' || kind === 'type' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value ? [value] : [];
	return { kind: values.length ? kind : '', values };
}
