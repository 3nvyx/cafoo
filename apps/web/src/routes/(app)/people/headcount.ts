// Headcount and payroll over time for the People page. Pure; money is minor units.
import type { Employee, PayRun } from '#lib/data/types.js';
import { loadedCost } from '#lib/payroll.js';
import { toBig } from '#lib/data/money.js';

/** Every month from `from` to `to` inclusive, as "YYYY-MM". Empty when `from` is after `to`. */
export function monthsBetween(from: string, to: string): string[] {
	const out: string[] = [];
	let y = Number(from.slice(0, 4));
	let m = Number(from.slice(5, 7));
	const end = to.slice(0, 7);
	for (let k = 0; k < 600; k++) {
		const ym = `${y}-${String(m).padStart(2, '0')}`;
		if (ym > end) break;
		out.push(ym);
		m += 1;
		if (m > 12) [y, m] = [y + 1, 1];
	}
	return out;
}

/** The last day of a month, "YYYY-MM-DD". */
const monthEnd = (ym: string) => {
	const [y, m] = ym.split('-').map(Number);
	return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** On the team at the end of the month: started on or before it and not gone before it. Contractors are left out. */
export function onTeamAt(e: Pick<Employee, 'startAt' | 'endAt' | 'type'>, ym: string): boolean {
	if (e.type === 'contractor') return false;
	const end = monthEnd(ym);
	return e.startAt.slice(0, 10) <= end && (!e.endAt || e.endAt.slice(0, 10) > end);
}

/** Headcount at each month end, split by a key (country, department). */
export function headcountByMonth<K extends string>(employees: Employee[], months: string[], key: (e: Employee) => K): { ym: string; total: number; by: Map<K, number> }[] {
	return months.map((ym) => {
		const by = new Map<K, number>();
		let total = 0;
		for (const e of employees) {
			if (!onTeamAt(e, ym)) continue;
			total++;
			by.set(key(e), (by.get(key(e)) ?? 0) + 1);
		}
		return { ym, total, by };
	});
}

/** Country from where the person is employed: UK companies pay in pounds. */
export const countryOf = (e: Pick<Employee, 'ccy' | 'location'>) => (e.ccy === 'GBP' || /\bUK\b|United Kingdom/.test(e.location) ? 'UK' : 'US');

export interface PayrollMonth {
	ym: string;
	/** Pay, employer taxes and benefits, in the reporting currency. */
	loadedMinor: bigint;
	grossMinor: bigint;
	runs: PayRun[];
	/** Journal entries the month's runs posted. */
	jeIds: string[];
}

/** Payroll by the month runs pay out, in the reporting currency, oldest first. Draft runs are left out. */
export function payrollByMonth(runs: PayRun[], toReporting: (minor: string, ccy: string) => string): PayrollMonth[] {
	const by = new Map<string, PayrollMonth>();
	for (const r of runs) {
		if (r.status === 'draft') continue;
		const ym = r.payDate.slice(0, 7);
		const m = by.get(ym) ?? { ym, loadedMinor: 0n, grossMinor: 0n, runs: [], jeIds: [] };
		m.loadedMinor += toBig(toReporting(loadedCost(r), r.ccy));
		m.grossMinor += toBig(toReporting(r.grossMinor, r.ccy));
		m.runs.push(r);
		if (r.jeId && !m.jeIds.includes(r.jeId)) m.jeIds.push(r.jeId);
		by.set(ym, m);
	}
	return [...by.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}
