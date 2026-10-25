// Payroll arithmetic for the People area: pay dates, gross per run, estimated withholding and employer cost, PTO
// accrual and projection, cost by department, and how a net amount splits across deposit accounts. Pure functions,
// money in minor-unit strings (computed with bigint), dates as "yyyy-mm-dd" (an ISO timestamp is read by its date).
//
// Withholding is an estimate, labelled as one wherever it shows: the payroll provider computes the real figures and
// its register is what posts. US: 2026 federal brackets (single, standard deduction), employee FICA, a flat state
// estimate by state; employer FICA, FUTA and SUTA on their wage bases. UK: 2026/27 PAYE and Class 1 NI at the
// standard tax code; 5% employee pension.
import type { DepositSplit, Department, Employee, Minor, PayFrequency, PtoPolicy } from './data/types';

// Dates

/** "2026-10-15" from "2026-10-15" or "2026-10-15T00:00:00Z". */
export const day = (iso: string) => iso.slice(0, 10);
/** The ISO timestamp the seed and tables use for a date. */
export const isoOf = (d: string) => `${day(d)}T00:00:00Z`;

const toDate = (d: string) => new Date(`${day(d)}T00:00:00Z`);
const fmt = (dt: Date) => dt.toISOString().slice(0, 10);
export function addDays(d: string, n: number): string {
	const dt = toDate(d);
	dt.setUTCDate(dt.getUTCDate() + n);
	return fmt(dt);
}
export function lastDayOfMonth(ym: string): string {
	const [y, m] = ym.split('-').map(Number);
	return fmt(new Date(Date.UTC(y, m, 0)));
}
const weekday = (d: string) => toDate(d).getUTCDay();

export type Region = 'US' | 'UK';

/** Days the banks are shut besides weekends: Federal Reserve holidays (US) and England and Wales bank holidays (UK). */
export const BANK_HOLIDAYS: Record<Region, ReadonlySet<string>> = {
	US: new Set([
		'2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
		'2027-01-01', '2027-01-18', '2027-02-15'
	]),
	UK: new Set(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28', '2027-01-01'])
};

export function isBankingDay(d: string, region: Region): boolean {
	const w = weekday(d);
	return w !== 0 && w !== 6 && !BANK_HOLIDAYS[region].has(day(d));
}
/** The day itself if the banks are open, else the banking day before it. */
export function onOrBeforeBankingDay(d: string, region: Region): string {
	let x = day(d);
	while (!isBankingDay(x, region)) x = addDays(x, -1);
	return x;
}
/** `n` banking days before `d` (the provider pulls the money this long before payday). */
export function bankingDaysBefore(d: string, n: number, region: Region): string {
	let x = day(d);
	for (let i = 0; i < n; ) {
		x = addDays(x, -1);
		if (isBankingDay(x, region)) i++;
	}
	return x;
}

export interface PayDate {
	periodStart: string;
	periodEnd: string;
	payDate: string;
	/** When the provider debits the company's bank: two banking days before payday. */
	debitDate: string;
}

/** Cafoo Inc pays semi-monthly: the 15th (for the 1st to 15th) and the last day (16th to end), a banking day earlier when either falls on a weekend or holiday. */
export function usPayDates(ym: string): PayDate[] {
	const mid = `${ym}-15`;
	const end = lastDayOfMonth(ym);
	return [
		{ periodStart: `${ym}-01`, periodEnd: mid, payDate: onOrBeforeBankingDay(mid, 'US') },
		{ periodStart: `${ym}-16`, periodEnd: end, payDate: onOrBeforeBankingDay(end, 'US') }
	].map((p) => ({ ...p, debitDate: bankingDaysBefore(p.payDate, 2, 'US') }));
}
/** Cafoo Ltd pays monthly on the last working day. */
export function ukPayDate(ym: string): PayDate {
	const payDate = onOrBeforeBankingDay(lastDayOfMonth(ym), 'UK');
	return { periodStart: `${ym}-01`, periodEnd: lastDayOfMonth(ym), payDate, debitDate: bankingDaysBefore(payDate, 2, 'UK') };
}
export function payDates(region: Region, ym: string): PayDate[] {
	return region === 'US' ? usPayDates(ym) : [ukPayDate(ym)];
}
/** Pay dates strictly after `after`, through the end of that year. */
export function payDatesLeftInYear(region: Region, after: string): PayDate[] {
	const y = day(after).slice(0, 4);
	const out: PayDate[] = [];
	for (let m = 1; m <= 12; m++) for (const p of payDates(region, `${y}-${String(m).padStart(2, '0')}`)) if (p.payDate > day(after)) out.push(p);
	return out;
}

// Money

const big = (m: Minor | undefined | null) => {
	try {
		return BigInt(m || '0');
	} catch {
		return 0n;
	}
};
/** x * bp / 10000, rounded half up (x >= 0). */
const pct = (x: bigint, bp: number) => (x * BigInt(Math.round(bp * 100)) + 500_000n) / 1_000_000n;
const max0 = (x: bigint) => (x > 0n ? x : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** Tax on `income` (major units as minor) through progressive brackets [upperBoundMinor | null, rateBp]. */
function bracketTax(income: bigint, brackets: [bigint | null, number][]): bigint {
	let tax = 0n;
	let lower = 0n;
	for (const [upper, bp] of brackets) {
		if (income <= lower) break;
		const top = upper === null ? income : min(income, upper);
		tax += pct(top - lower, bp);
		if (upper === null) break;
		lower = upper;
	}
	return tax;
}

export const RUNS_PER_YEAR: Record<PayFrequency, number> = { semi_monthly: 24, biweekly: 26, monthly: 12 };
export const isHourly = (e: Employee) => !!e.hourlyRateMinor && big(e.annualSalaryMinor) === 0n;
export const regionOf = (e: Employee): Region => (e.ccy === 'GBP' ? 'UK' : 'US');

/** Gross pay for one run: salary over the runs in a year, or hours times the hourly rate. */
export function grossPerRun(e: Employee, hours = 0): Minor {
	if (isHourly(e)) return pct(big(e.hourlyRateMinor), hours * 10000).toString();
	const runs = BigInt(RUNS_PER_YEAR[e.payFrequency]);
	return ((big(e.annualSalaryMinor) + runs / 2n) / runs).toString();
}

/** One person's pay for one run: what is withheld, what the company adds on top, and what lands in the bank. */
export interface RunPay {
	grossMinor: Minor;
	/** Income tax and the employee's share of social taxes. */
	employeeTaxMinor: Minor;
	/** Retirement deferral and the employee's share of health premiums. */
	deductionsMinor: Minor;
	/** Employer payroll taxes: FICA, FUTA, SUTA (US) or employer NI (UK). */
	employerTaxMinor: Minor;
	/** Employer retirement match or pension and the employer's health or medical premium. */
	employerBenefitsMinor: Minor;
	netMinor: Minor;
}

// US 2026, single filer, standard withholding.
const US_STD_DEDUCTION = 1_610_000n;
const US_FED: [bigint | null, number][] = [
	[1_240_000n, 1000],
	[5_040_000n, 1200],
	[10_570_000n, 2200],
	[20_177_500n, 2400],
	[25_622_500n, 3200],
	[64_060_000n, 3500],
	[null, 3700]
];
const SS_WAGE_BASE = 18_450_000n;
const FUTA_SUTA_BASE = 700_000n;
/** Employer rates in basis points. SUTA is California's new-employer rate plus its training tax. */
export const US_EMPLOYER_BP = { socialSecurity: 620, medicare: 145, futa: 60, suta: 350 };
/** Flat state income tax estimate by state, plus California's SDI. */
const STATE_BP: Record<string, number> = { CA: 600, NY: 600, WA: 0, TX: 0 };
const stateOf = (location: string) => /,\s*([A-Z]{2})\b/.exec(location)?.[1] ?? '';

// UK 2026/27, tax code 1257L, category A NI.
const UK_ALLOWANCE = 1_257_000n;
const UK_PAYE: [bigint | null, number][] = [
	[3_770_000n, 2000],
	[11_257_000n, 4000],
	[null, 4500]
];
const UK_NI_PT = 1_257_000n;
const UK_NI_UEL = 5_027_000n;
const UK_NI_ST = 500_000n;
export const UK_RATES_BP = { employeeNi: 800, employeeNiAbove: 200, employerNi: 1500, employeePension: 500 };

export interface PayOptions {
	/** Gross paid earlier in the calendar year, for the wage bases (US) — default 0. */
	ytdGrossMinor?: Minor;
}

/** Estimated withholding and employer cost for one person on one run. */
export function estimatePay(e: Employee, grossMinor: Minor, opts: PayOptions = {}): RunPay {
	const g = big(grossMinor);
	const runs = BigInt(RUNS_PER_YEAR[e.payFrequency]);
	const zero = { grossMinor: g.toString(), employeeTaxMinor: '0', deductionsMinor: '0', employerTaxMinor: '0', employerBenefitsMinor: '0', netMinor: g.toString() };
	if (e.type === 'contractor') return zero; // paid gross on invoice; they handle their own taxes
	// Health premiums are monthly; a semi-monthly run carries half. The employee pays a quarter of what the company pays (80/20).
	const healthEr = g === 0n && e.status !== 'on_leave' ? 0n : (big(e.benefitsMonthlyMinor) * 12n) / runs;
	const retirementEr = pct(g, e.retirementBp);

	if (regionOf(e) === 'UK') {
		const annual = g * runs;
		const incomeTax = bracketTax(max0(annual - UK_ALLOWANCE), UK_PAYE) / runs;
		const pt = UK_NI_PT / runs;
		const uel = UK_NI_UEL / runs;
		const eeNi = pct(max0(min(g, uel) - pt), UK_RATES_BP.employeeNi) + pct(max0(g - uel), UK_RATES_BP.employeeNiAbove);
		const erNi = pct(max0(g - (UK_NI_ST + runs / 2n) / runs), UK_RATES_BP.employerNi);
		const pension = g === 0n ? 0n : pct(g, UK_RATES_BP.employeePension);
		const employeeTax = incomeTax + eeNi;
		return {
			grossMinor: g.toString(),
			employeeTaxMinor: employeeTax.toString(),
			deductionsMinor: pension.toString(),
			employerTaxMinor: erNi.toString(),
			employerBenefitsMinor: (retirementEr + healthEr).toString(),
			netMinor: (g - employeeTax - pension).toString()
		};
	}

	const ytd = big(opts.ytdGrossMinor);
	const deferral = retirementEr; // employees defer at least what the company matches
	const healthEe = healthEr / 4n;
	const deductions = g === 0n ? 0n : deferral + healthEe;
	const taxable = max0(g - deductions);
	const fed = bracketTax(max0(taxable * runs - US_STD_DEDUCTION), US_FED) / runs;
	const ssWages = max0(min(g, SS_WAGE_BASE - ytd));
	const fica = pct(ssWages, US_EMPLOYER_BP.socialSecurity) + pct(g, US_EMPLOYER_BP.medicare);
	const state = stateOf(e.location);
	const stateTax = pct(taxable, STATE_BP[state] ?? 450) + (state === 'CA' ? pct(g, 130) : 0n);
	const employeeTax = fed + fica + stateTax;
	const capped = max0(min(g, FUTA_SUTA_BASE - ytd));
	const employerTax = fica + pct(capped, US_EMPLOYER_BP.futa) + pct(capped, US_EMPLOYER_BP.suta);
	return {
		grossMinor: g.toString(),
		employeeTaxMinor: employeeTax.toString(),
		deductionsMinor: deductions.toString(),
		employerTaxMinor: employerTax.toString(),
		employerBenefitsMinor: (retirementEr + healthEr).toString(),
		netMinor: (g - employeeTax - deductions).toString()
	};
}

/** What one run costs the company for one person: gross plus employer taxes and benefits. */
export const loadedCost = (p: RunPay): Minor => (big(p.grossMinor) + big(p.employerTaxMinor) + big(p.employerBenefitsMinor)).toString();

/** Adds RunPay rows field by field: a pay run's totals from its payslips. */
export function sumPay(rows: RunPay[]): RunPay {
	const keys = ['grossMinor', 'employeeTaxMinor', 'deductionsMinor', 'employerTaxMinor', 'employerBenefitsMinor', 'netMinor'] as const;
	const out = Object.fromEntries(keys.map((k) => [k, rows.reduce((t, r) => t + big(r[k]), 0n).toString()]));
	return out as unknown as RunPay;
}

/** Hours a week assumed for hourly people when projecting a month. */
export const typicalHoursPerWeek = (e: Employee) => (e.type === 'full_time' ? 40 : e.type === 'contractor' ? 15 : 20);

/**
 * A month of this person's fully loaded cost in their own currency, at steady state (past the FUTA and SUTA wage
 * bases): gross, employer taxes, retirement and health. Hourly people at their typical hours. People on leave are
 * unpaid by the company (state leave pay covers them) while their benefits continue.
 */
export function monthlyLoadedCost(e: Employee): Minor {
	const runs = RUNS_PER_YEAR[e.payFrequency];
	const runsPerMonth = runs / 12;
	const hours = isHourly(e) ? (typicalHoursPerWeek(e) * 52) / runs : 0;
	const gross = grossPerRun(e, hours);
	const pay = estimatePay(e, e.status === 'on_leave' ? '0' : gross, { ytdGrossMinor: FUTA_SUTA_BASE.toString() });
	const perRun = big(loadedCost(pay));
	return ((perRun * BigInt(Math.round(runsPerMonth * 1000))) / 1000n).toString();
}

/** On the books on `asOf`: started, not yet gone. */
export function isEmployed(e: Employee, asOf: string): boolean {
	return day(e.startAt) <= day(asOf) && (!e.endAt || day(e.endAt) >= day(asOf)) && e.status !== 'terminated';
}

export interface DepartmentCost {
	department: Department;
	headcount: number;
	/** In the reporting currency. */
	monthlyMinor: Minor;
	/** The service share of it: running the live product, so cost of revenue. */
	serviceMinor: Minor;
}

/** Fully loaded monthly cost by department for everyone employed on `asOf`, converted by `toReporting`. Largest first. */
export function costByDepartment(employees: Employee[], asOf: string, toReporting: (minor: Minor, ccy: string) => Minor = (m) => m): DepartmentCost[] {
	const by = new Map<Department, { headcount: number; monthly: bigint; service: bigint }>();
	for (const e of employees) {
		if (!isEmployed(e, asOf)) continue;
		const cost = big(toReporting(monthlyLoadedCost(e), e.ccy));
		const row = by.get(e.department) ?? { headcount: 0, monthly: 0n, service: 0n };
		row.headcount++;
		row.monthly += cost;
		row.service += pct(cost, e.serviceShareBp);
		by.set(e.department, row);
	}
	return [...by]
		.map(([department, r]) => ({ department, headcount: r.headcount, monthlyMinor: r.monthly.toString(), serviceMinor: r.service.toString() }))
		.sort((a, b) => (big(b.monthlyMinor) > big(a.monthlyMinor) ? 1 : big(b.monthlyMinor) < big(a.monthlyMinor) ? -1 : a.department.localeCompare(b.department)));
}

/** How a net amount lands: fixed amounts first in order (as much as is left), then the remainder account takes the rest. */
export function splitDeposit(netMinor: Minor, splits: DepositSplit[]): { split: DepositSplit; amountMinor: Minor }[] {
	let left = max0(big(netMinor));
	const out = splits.map((split) => ({ split, amount: 0n }));
	for (const o of out) {
		if (o.split.remainder) continue;
		const take = min(left, max0(big(o.split.amountMinor)));
		o.amount = take;
		left -= take;
	}
	const rest = out.find((o) => o.split.remainder) ?? out.at(-1);
	if (rest) rest.amount += left;
	return out.map((o) => ({ split: o.split, amountMinor: o.amount.toString() }));
}

/** "Chase checking ••4821". */
export const maskedAccount = (s: DepositSplit) => `${s.bankName} ${s.accountType} ••${s.accountLast4}`;

// Time off

/** Working hours between two dates inclusive (8 a day, weekends and the region's bank holidays off). */
export function workingHours(start: string, end: string, region: Region): number {
	let h = 0;
	for (let d = day(start); d <= day(end); d = addDays(d, 1)) if (isBankingDay(d, region)) h += 8;
	return h;
}

export interface PtoProjection {
	/** Balance at year end: today's, plus what accrues, less the time off already booked. */
	projectedHours: number;
	/** Hours over the carryover cap at year end, which would be lost. 0 when under it or the policy is unlimited. */
	overCapHours: number;
}

/** Year-end PTO balance given the runs left this year and the hours already booked (approved or pending). */
export function projectPto(policy: PtoPolicy, runsLeft: number, bookedHours: number): PtoProjection {
	if (policy.unlimited) return { projectedHours: 0, overCapHours: 0 };
	const projectedHours = round2(policy.balanceHours + policy.accrualHoursPerRun * runsLeft - bookedHours);
	const cap = policy.carryoverCapHours;
	return { projectedHours, overCapHours: cap === undefined ? 0 : round2(Math.max(0, projectedHours - cap)) };
}
/** Hours accrued over a year at this policy. */
export const accrualPerYear = (policy: PtoPolicy, freq: PayFrequency) => round2(policy.accrualHoursPerRun * RUNS_PER_YEAR[freq]);
const round2 = (x: number) => Math.round(x * 100) / 100;
/** Hours as days ("3.5 days"), 8 hours a day. */
export function hoursAsDays(h: number): string {
	const d = Math.round((h / 8) * 10) / 10;
	return `${d} day${d === 1 ? '' : 's'}`;
}
