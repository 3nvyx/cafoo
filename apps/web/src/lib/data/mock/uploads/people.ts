// Demo behaviour for People: Gusto's register for Cafoo Inc's October 15 pay run, a time-off report, and what keeps
// arriving from Gusto while it is connected (new time-off requests, the contractor's hours, pay runs reaching payday).
// The register leads to the Bookkeeper's payroll Proposal; nothing here posts on its own.
import type { Employee, PayRun, Payslip, PtoKind, PtoRequest } from '../../types';
import { formatMoney, toBig } from '../../money';
import { bankingDaysBefore, day, isoOf, payDatesLeftInYear, projectPto, regionOf, workingHours } from '../../../payroll';
import type { ScriptLine } from '../script';
import type { LiveTicker, MockContext, UploadHandler } from './types';

const GUSTO = 'gusto';
/** The run the sample register is for: Cafoo Inc's October 1 to 15 run, already processing in Gusto. */
export const REGISTER_RUN_ID = 'run-us-2026-10-a';
/** Theo Martins's contractor payments for the first half of October. */
const CONTRACTOR_RUN_ID = 'run-us-2026-10-c';

const money = (minor: string | bigint, ccy = 'USD') => formatMoney(String(minor), { currency: ccy });
const L = (account: string, debitMinor: string, creditMinor: string): ScriptLine => ({ account, debitMinor, creditMinor });
const longDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const nameOf = (ctx: MockContext, id: string) => ctx.t.employee.find((e) => e.id === id)?.name ?? id;

// ---------------------------------------------------------------------------------------------------------------
// The payroll entry (pure, tested)

export interface PayrollEntry {
	/** Gross pay to 6000. */
	grossMinor: string;
	/** Employer taxes and benefits to 6010. */
	employerMinor: string;
	/** Net pay to employees' bank accounts. */
	netMinor: string;
	/** Withheld taxes and deductions plus employer taxes and benefits, owed to the agencies and plans until Gusto remits them. */
	liabilitiesMinor: string;
	/** What Gusto pulls from operating cash on the debit date: net pay plus everything it remits. Equals totalMinor. */
	debitMinor: string;
	/** What the run costs the company: gross plus employer cost. */
	totalMinor: string;
	lines: ScriptLine[];
}

/**
 * The journal entry a pay run posts. Gusto debits the whole run on the debit date: net pay, the taxes it withheld,
 * employer taxes, and the 401(k) and health amounts it remits for us. So the entry books the cost and the amounts owed
 * (Dr 6000 gross, Dr 6010 employer cost / Cr 1000 net, Cr 2200 owed on), then clears 2200 with the remittance in the
 * same debit (Dr 2200 / Cr 1000). Cash falls by the full run, as the seeded months show; 2200 nets to zero.
 */
export function payrollEntry(run: Pick<PayRun, 'grossMinor' | 'employeeTaxMinor' | 'deductionsMinor' | 'employerTaxMinor' | 'employerBenefitsMinor' | 'netMinor' | 'subsidiaryId'>): PayrollEntry {
	const uk = run.subsidiaryId === 'sub-uk';
	const code = (c: string) => (uk ? `${c === '6000' ? '5300' : c}-UK` : c);
	const gross = toBig(run.grossMinor);
	const employer = toBig(run.employerTaxMinor) + toBig(run.employerBenefitsMinor);
	const net = toBig(run.netMinor);
	const liabilities = toBig(run.employeeTaxMinor) + toBig(run.deductionsMinor) + employer;
	const s = (x: bigint) => x.toString();
	return {
		grossMinor: s(gross),
		employerMinor: s(employer),
		netMinor: s(net),
		liabilitiesMinor: s(liabilities),
		debitMinor: s(net + liabilities),
		totalMinor: s(gross + employer),
		lines: [
			L(code('6000'), s(gross), '0'),
			L(code('6010'), s(employer), '0'),
			L(code('1000'), '0', s(net)),
			L(code('2200'), '0', s(liabilities)),
			L(code('2200'), s(liabilities), '0'),
			L(code('1000'), '0', s(liabilities))
		]
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Payroll register: Gusto's register for Cafoo Inc's October 15 run, one row per person.

function registerRows(ctx: MockContext) {
	return ctx.t.payslip
		.filter((p) => p.payRunId === REGISTER_RUN_ID)
		.map((p) => ({ employee: nameOf(ctx, p.employeeId), employeeId: p.employeeId, hours: p.hours, grossMinor: p.grossMinor, employeeTaxMinor: p.employeeTaxMinor, deductionsMinor: p.deductionsMinor, netMinor: p.netMinor }));
}

const payrollRegister: UploadHandler = {
	kind: 'payroll_register',
	fileName: 'gusto-payroll-register-2026-10-15.csv',
	sizeBytes: 3_912,
	readByRole: 'bookkeeper',
	read(ctx) {
		const run = ctx.t.pay_run.find((r) => r.id === REGISTER_RUN_ID);
		if (!run) return { extracted: {}, summaryPlain: 'This register is for a pay run Luyten does not have, so nothing was booked.' };
		const e = payrollEntry(run);
		const extracted = {
			provider: 'Gusto',
			company: 'Cafoo Inc',
			payPeriod: { from: day(run.periodStart), to: day(run.periodEnd) },
			payDate: day(run.payDate),
			debitDate: day(run.debitDate),
			rows: registerRows(ctx),
			totals: { grossMinor: run.grossMinor, employeeTaxMinor: run.employeeTaxMinor, deductionsMinor: run.deductionsMinor, employerTaxMinor: run.employerTaxMinor, employerBenefitsMinor: run.employerBenefitsMinor, netMinor: run.netMinor }
		};
		if (run.proposalId) return { extracted, summaryPlain: 'This register was already booked, so nothing new was proposed.' };
		const starters = ctx.t.employee.filter((x) => x.subsidiaryId === run.subsidiaryId && day(x.startAt) >= day(run.periodStart) && day(x.startAt) <= day(run.periodEnd) && x.type !== 'contractor');
		return {
			extracted,
			summaryPlain: `Gusto's register for Cafoo Inc's October 15 pay run: ${run.employeeCount} people, ${money(run.grossMinor)} of gross pay and ${money(e.employerMinor)} of employer taxes and benefits. Gusto draws ${money(e.debitMinor)} from the bank on ${longDay(run.debitDate)}.${starters.length ? ` First paycheck for ${starters.map((x) => x.name).join(' and ')}.` : ''}`
		};
	},
	apply(ctx) {
		const run = ctx.t.pay_run.find((r) => r.id === REGISTER_RUN_ID);
		if (!run || run.proposalId) return [];
		const e = payrollEntry(run);
		const rows = registerRows(ctx);
		const sumRows = rows.reduce((t, r) => t + toBig(r.grossMinor), 0n);
		const id = ctx.propose({
			kind: 'payroll_run',
			proposerRole: 'bookkeeper',
			amountMinor: e.totalMinor,
			periodId: ctx.openPeriodId(),
			summaryPlain: `Book Cafoo Inc's October 15 payroll: ${money(e.grossMinor)} of pay for ${run.employeeCount} people and ${money(e.employerMinor)} of employer taxes and benefits. Gusto draws ${money(e.debitMinor)} on ${longDay(run.debitDate)}: ${money(e.netMinor)} of take-home pay and ${money(e.liabilitiesMinor)} it pays on to the tax agencies and benefit plans.`,
			rationale: `Gusto register for ${day(run.periodStart)} to ${day(run.periodEnd)}, pay date ${day(run.payDate)}. Gross splits to 6000, employer FICA, FUTA, SUTA, 401(k) match and health premiums to 6010; Gusto debits the full run on ${day(run.debitDate)} (net pay plus withholdings, employer taxes, 401(k) and health it remits for us), so cash is credited ${money(e.debitMinor)}, matching how Jul to Sep were booked. Withholdings and employer amounts pass through 2200 and are cleared by that same debit, so 2200 nets to zero for the run.`,
			payload: {
				payRunId: run.id,
				subsidiaryId: run.subsidiaryId,
				payDate: run.payDate,
				memo: `Payroll ${day(run.periodStart)} to ${day(run.periodEnd)}, Gusto, paid ${day(run.payDate)}`,
				lines: e.lines
			},
			body: `${run.id} Gusto register, ${rows.length} payslips, gross ${money(e.grossMinor).slice(1)} (payslips sum ${money(sumRows).slice(1)}). EE tax ${money(run.employeeTaxMinor).slice(1)}, deductions ${money(run.deductionsMinor).slice(1)}, ER tax ${money(run.employerTaxMinor).slice(1)}, ER benefits ${money(run.employerBenefitsMinor).slice(1)}, net ${money(run.netMinor).slice(1)}. Dr 6000 ${money(e.grossMinor).slice(1)}, Dr 6010 ${money(e.employerMinor).slice(1)} / Cr 1000 ${money(e.netMinor).slice(1)}, Cr 2200 ${money(e.liabilitiesMinor).slice(1)}; remittance Dr 2200 / Cr 1000 ${money(e.liabilitiesMinor).slice(1)}. Cash out ${money(e.debitMinor).slice(1)} = Gusto debit.`,
			critique: {
				body: `Ties: payslips sum to the register gross, and gross = net + EE tax + deductions. Two things to know. First, Jul to Sep booked the whole cost to 6000; from this run employer cost sits in 6010, so 6000 alone drops about 12% month over month while total payroll rises with two new hires. Second, Gusto pulls the whole ${money(e.debitMinor).slice(1)} on ${day(run.debitDate)}, before payday, so the bank line lands then, not on the 15th; 2200 clears inside the entry.`,
				summary: 'Red Team checked the register adds up and noted payroll now splits across two expense lines, so the pay line alone looks lower than September.'
			},
			// A send-back resubmits under a new id: link whichever Proposal was finally approved.
			onApproved(c, approved) {
				const r = c.t.pay_run.find((x) => x.id === REGISTER_RUN_ID);
				if (!r) return;
				r.proposalId = approved.id;
				const je = c.t.journal_entry.find((j) => j.proposalId === approved.id);
				if (je) r.jeId = je.id;
				c.update('pay_run', r);
			}
		});
		run.proposalId = id;
		ctx.update('pay_run', run);
		return [id];
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Time-off report: balances as of September 30 from Gusto, after the September accruals and time taken.

/** Balance, used this year and sick hours per person, as the report states them. */
export const PTO_REPORT: Record<string, { balanceHours: number; usedHoursYtd: number; sickBalanceHours: number }> = {
	'emp-07': { balanceHours: 51, usedHoursYtd: 40, sickBalanceHours: 40 },
	'emp-08': { balanceHours: 177, usedHoursYtd: 24, sickBalanceHours: 32 },
	'emp-09': { balanceHours: 58, usedHoursYtd: 40, sickBalanceHours: 40 },
	'emp-11': { balanceHours: 0, usedHoursYtd: 0, sickBalanceHours: 1.75 },
	'emp-13': { balanceHours: 141.67, usedHoursYtd: 75, sickBalanceHours: 80 },
	'emp-14': { balanceHours: 21, usedHoursYtd: 141.67, sickBalanceHours: 72 }
};

/** Hours already booked from `after` on: approved or pending, not yet taken. */
export function bookedHours(requests: PtoRequest[], employeeId: string, after: string): number {
	return requests.filter((r) => r.employeeId === employeeId && (r.status === 'approved' || r.status === 'pending') && r.kind === 'vacation' && day(r.endAt) > day(after)).reduce((h, r) => h + r.hours, 0);
}

/** People whose balance at year end, after accruals and booked time, goes over their carryover cap. */
export function overCap(employees: Employee[], requests: PtoRequest[], asOf: string) {
	return employees
		.filter((e) => !e.pto.unlimited && e.pto.carryoverCapHours !== undefined && e.status !== 'terminated')
		.map((e) => ({ e, ...projectPto(e.pto, payDatesLeftInYear(regionOf(e), asOf).length, bookedHours(requests, e.id, asOf)) }))
		.filter((x) => x.overCapHours > 0);
}

const days = (h: number) => {
	const d = Math.round((h / 8) * 10) / 10;
	return `${d} day${d === 1 ? '' : 's'}`;
};

const ptoReport: UploadHandler = {
	kind: 'pto_report',
	fileName: 'gusto-time-off-balances-2026-09-30.csv',
	sizeBytes: 1_406,
	readByRole: 'bookkeeper',
	read(ctx) {
		const rows = Object.entries(PTO_REPORT).map(([employeeId, r]) => ({ employee: nameOf(ctx, employeeId), employeeId, ...r }));
		const after = ctx.t.employee.map((e) => (PTO_REPORT[e.id] ? { ...e, pto: { ...e.pto, ...PTO_REPORT[e.id] } } : e));
		const flagged = overCap(after, ctx.t.pto_request, ctx.now());
		return {
			extracted: { provider: 'Gusto', asOf: '2026-09-30', rows },
			summaryPlain: `Time-off balances for ${rows.length} people on accrual policies, as of September 30. Everyone on the flexible policy is left out, as Gusto tracks no balance for them.`,
			flagsPlain: flagged.map(
				(x) =>
					`${x.e.name} is on course to end the year with ${days(x.projectedHours)} off unused, ${days(x.overCapHours)} over the ${days(x.e.pto.carryoverCapHours ?? 0)} that carry over. Suggest they book the time before December.`
			)
		};
	},
	apply(ctx) {
		for (const [id, r] of Object.entries(PTO_REPORT)) {
			const e = ctx.t.employee.find((x) => x.id === id);
			if (!e) continue;
			e.pto = { ...e.pto, ...r };
			ctx.update('employee', e);
		}
		ctx.synced(GUSTO, Object.keys(PTO_REPORT).length);
		return [];
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Live from Gusto

/** Time-off requests people file while the demo runs, in order. */
export const INCOMING_PTO: { id: string; employeeId: string; kind: PtoKind; start: string; end: string; notePlain?: string }[] = [
	{ id: 'pto-g1', employeeId: 'emp-09', kind: 'vacation', start: '2026-11-25', end: '2026-11-25', notePlain: 'Travel day before Thanksgiving.' },
	{ id: 'pto-g2', employeeId: 'emp-04', kind: 'vacation', start: '2026-12-28', end: '2026-12-31' },
	{ id: 'pto-g3', employeeId: 'emp-15', kind: 'vacation', start: '2026-12-29', end: '2026-12-31', notePlain: 'Between Christmas and New Year.' },
	{ id: 'pto-g4', employeeId: 'emp-07', kind: 'sick', start: '2026-10-05', end: '2026-10-05', notePlain: 'Doctor appointment.' },
	{ id: 'pto-g5', employeeId: 'emp-13', kind: 'vacation', start: '2026-12-14', end: '2026-12-18', notePlain: 'Using up days before year end.' },
	{ id: 'pto-g6', employeeId: 'emp-03', kind: 'jury_duty', start: '2026-11-16', end: '2026-11-17', notePlain: 'Summons for San Francisco Superior Court.' }
];

const ptoRequests: LiveTicker = {
	name: 'Gusto time-off requests',
	everyMs: 40_000,
	integrationId: GUSTO,
	tick(ctx) {
		const next = INCOMING_PTO.find((r) => !ctx.t.pto_request.some((x) => x.id === r.id));
		if (!next) return;
		const e = ctx.t.employee.find((x) => x.id === next.employeeId);
		if (!e) return;
		ctx.insert('pto_request', {
			id: next.id,
			employeeId: next.employeeId,
			kind: next.kind,
			startAt: isoOf(next.start),
			endAt: isoOf(next.end),
			hours: workingHours(next.start, next.end, regionOf(e)),
			status: 'pending',
			...(next.notePlain ? { notePlain: next.notePlain } : {})
		});
		ctx.synced(GUSTO);
	}
};

/** The contractor's logged hours grow through the day, a quarter hour at a time. */
export function nextHours(hours: number): number {
	return hours + [0.75, 1.25, 0.5, 1][Math.floor(hours * 4) % 4];
}

const contractorHours: LiveTicker = {
	name: 'Gusto contractor hours',
	everyMs: 15_000,
	integrationId: GUSTO,
	tick(ctx) {
		const run = ctx.t.pay_run.find((r) => r.id === CONTRACTOR_RUN_ID);
		const slip = ctx.t.payslip.find((p) => p.payRunId === CONTRACTOR_RUN_ID);
		if (!run || !slip || run.status !== 'draft') return;
		const e = ctx.t.employee.find((x) => x.id === slip.employeeId);
		if (!e?.hourlyRateMinor) return;
		const hours = nextHours(slip.hours ?? 0);
		// A part-time contractor caps out around 60 hours a half month.
		if (hours > 60) return;
		const gross = ((toBig(e.hourlyRateMinor) * BigInt(Math.round(hours * 100))) / 100n).toString();
		Object.assign(slip, { hours, grossMinor: gross, netMinor: gross } satisfies Partial<Payslip>);
		Object.assign(run, { grossMinor: gross, netMinor: gross } satisfies Partial<PayRun>);
		ctx.update('payslip', slip);
		ctx.update('pay_run', run);
		ctx.synced(GUSTO);
	}
};

/** Moves runs along as the clock passes their dates: scheduled runs process two banking days before the debit, and runs are paid on payday. */
export function advanceRun(run: PayRun, now: string): PayRun['status'] {
	const region = run.subsidiaryId === 'sub-uk' ? 'UK' : 'US';
	if ((run.status === 'processing' || run.status === 'scheduled') && day(now) >= day(run.payDate)) return 'paid';
	if (run.status === 'scheduled' && day(now) >= bankingDaysBefore(run.debitDate, 2, region)) return 'processing';
	return run.status;
}

const payRuns: LiveTicker = {
	name: 'Gusto pay runs',
	everyMs: 30_000,
	integrationId: GUSTO,
	tick(ctx) {
		for (const run of ctx.t.pay_run) {
			if (run.status === 'draft') continue;
			const next = advanceRun(run, ctx.now());
			if (next === run.status) continue;
			run.status = next;
			ctx.update('pay_run', run);
			ctx.synced(GUSTO);
		}
	}
};

export const handlers: UploadHandler[] = [payrollRegister, ptoReport];
export const tickers: LiveTicker[] = [ptoRequests, contractorHours, payRuns];
