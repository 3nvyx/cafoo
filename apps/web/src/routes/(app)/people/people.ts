// Words and small helpers shared by the People screens.
import type { Department, Employee, EmploymentType, FxRate, Minor, PayRun, PtoKind, PtoRequest, Subsidiary } from '#lib/data/types.js';
import { formatMoney, toBig } from '#lib/data/money.js';
import type { Tone } from '#lib/labels.js';

export const DEPARTMENT: Record<Department, string> = {
	leadership: 'Leadership',
	engineering: 'Engineering',
	research: 'Research',
	product: 'Product',
	design: 'Design',
	sales: 'Sales',
	marketing: 'Marketing',
	customer_success: 'Customer success',
	operations: 'Operations',
	finance: 'Finance',
	people: 'People'
};

export const EMPLOYMENT: Record<EmploymentType, string> = {
	full_time: 'Full time',
	part_time: 'Part time',
	contractor: 'Contractor',
	intern: 'Intern'
};

export const EMPLOYEE_STATUS: Record<Employee['status'], { label: string; tone: Tone }> = {
	active: { label: 'Active', tone: 'pos' },
	on_leave: { label: 'On leave', tone: 'warn' },
	notice: { label: 'Leaving', tone: 'warn' },
	terminated: { label: 'Left', tone: 'muted' }
};

export const PTO_KIND: Record<PtoKind, string> = {
	vacation: 'Vacation',
	sick: 'Sick',
	parental: 'Parental leave',
	bereavement: 'Bereavement',
	jury_duty: 'Jury duty',
	unpaid: 'Unpaid leave'
};

export const PTO_STATUS: Record<PtoRequest['status'], { label: string; tone: Tone }> = {
	pending: { label: 'Waiting for you', tone: 'warn' },
	approved: { label: 'Approved', tone: 'pos' },
	declined: { label: 'Declined', tone: 'muted' },
	taken: { label: 'Taken', tone: 'neutral' }
};

export const RUN_STATUS: Record<PayRun['status'], { label: string; tone: Tone }> = {
	draft: { label: 'Collecting hours', tone: 'neutral' },
	scheduled: { label: 'Scheduled', tone: 'muted' },
	processing: { label: 'Processing', tone: 'warn' },
	paid: { label: 'Paid', tone: 'pos' }
};

/** "Sep 30, 2026" style dates read better without the year in a demo that spans one year. */
export const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
export const range = (a: string, b: string) => {
	const f = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	return a.slice(0, 10) === b.slice(0, 10) ? f(a) : `${f(a)} to ${f(b)}`;
};

export const money = (minor: Minor, ccy: string, whole = true) => formatMoney(minor, { currency: ccy, whole });

/** "$145,000 a year" or "$30 an hour". */
export function payText(e: Employee): string {
	if (e.hourlyRateMinor && toBig(e.annualSalaryMinor) === 0n) return `${formatMoney(e.hourlyRateMinor, { currency: e.ccy, whole: toBig(e.hourlyRateMinor) % 100n === 0n })} an hour`;
	return `${money(e.annualSalaryMinor, e.ccy)} a year`;
}

export const SCHEDULE: Record<Employee['payFrequency'], string> = {
	semi_monthly: 'Twice a month, on the 15th and the last day',
	biweekly: 'Every other Friday',
	monthly: 'Monthly, on the last working day'
};
export const scheduleText = (e: Employee) => (e.type === 'contractor' ? 'On invoice, twice a month' : SCHEDULE[e.payFrequency]);

export const companyName = (subs: Subsidiary[], id: string) => subs.find((s) => s.id === id)?.name ?? id;

/** The latest recorded closing rate from `ccy` to `to`, scaled by 1e6 (1:1 when none). */
export function latestRate(rates: FxRate[], ccy: string, to: string): bigint {
	if (ccy === to) return 1_000_000n;
	const r = rates.filter((x) => x.fromCcy === ccy && x.toCcy === to && x.kind === 'closing').sort((a, b) => a.ym.localeCompare(b.ym)).at(-1);
	return r ? BigInt(r.rateE6) : 1_000_000n;
}
export const convert = (minor: Minor, rateE6: bigint) => ((toBig(minor) * rateE6) / 1_000_000n).toString();

/** PTO balance in words. */
export function ptoText(e: Employee): string {
	if (e.type === 'contractor') return 'None';
	if (e.pto.unlimited) return 'Flexible';
	const d = Math.round((e.pto.balanceHours / 8) * 10) / 10;
	return `${d} day${d === 1 ? '' : 's'}`;
}

export const initials = (name: string) =>
	name
		.split(' ')
		.map((p) => p[0])
		.slice(0, 2)
		.join('');
