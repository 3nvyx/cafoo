import { describe, expect, it } from 'vitest';
import { loadSeed } from '../seed';
import type { PayRun } from '../../types';
import { loadedCost, payDates, splitDeposit } from '../../../payroll';
import { INCOMING_PTO, PTO_REPORT, advanceRun, nextHours, overCap, payrollEntry, REGISTER_RUN_ID } from './people';

const t = loadSeed();
const debits = (jeId: string, code: string) =>
	t.journal_line.filter((l) => l.jeId === jeId && l.accountId === `acc-${code}`).reduce((s, l) => s + BigInt(l.debitMinor), 0n);
const runsOf = (sub: string, ym: string) => t.pay_run.filter((r) => r.subsidiaryId === sub && r.payDate.startsWith(ym) && r.status === 'paid');

describe('people seed', () => {
	it('ties each paid month to the payroll entry in the ledger', () => {
		for (const [ym, jeId] of [['2026-07', 'je-0713'], ['2026-08', 'je-0812'], ['2026-09', 'je-0912']]) {
			const cost = runsOf('sub-us', ym).reduce((s, r) => s + BigInt(loadedCost(r)), 0n);
			expect(cost, ym).toBe(debits(jeId, '6000'));
		}
		for (const [ym, jeId] of [['2026-07', 'je-g014'], ['2026-08', 'je-g025'], ['2026-09', 'je-g035']]) {
			const cost = runsOf('sub-uk', ym).reduce((s, r) => s + BigInt(loadedCost(r)), 0n);
			expect(cost, ym).toBe(debits(jeId, '5300-UK'));
		}
	});

	it('gives every paid run payslips that add up to its totals, and every payslip balances', () => {
		for (const run of t.pay_run.filter((r) => r.status !== 'scheduled')) {
			const slips = t.payslip.filter((p) => p.payRunId === run.id);
			expect(slips.length, run.id).toBe(run.employeeCount);
			for (const k of ['grossMinor', 'employeeTaxMinor', 'deductionsMinor', 'netMinor'] as const) {
				expect(slips.reduce((s, p) => s + BigInt(p[k]), 0n), `${run.id} ${k}`).toBe(BigInt(run[k]));
			}
			for (const p of slips) expect(BigInt(p.netMinor) + BigInt(p.employeeTaxMinor) + BigInt(p.deductionsMinor)).toBe(BigInt(p.grossMinor));
		}
	});

	it('pays on the calendar each company runs', () => {
		for (const run of t.pay_run.filter((r) => r.status !== 'draft')) {
			const region = run.subsidiaryId === 'sub-uk' ? 'UK' : 'US';
			const dates = payDates(region, run.payDate.slice(0, 7));
			expect(dates.some((d) => d.payDate === run.payDate.slice(0, 10) && d.debitDate === run.debitDate.slice(0, 10)), run.id).toBe(true);
		}
	});

	it('links people to managers that exist and keeps deposit details to the last four digits', () => {
		const ids = new Set(t.employee.map((e) => e.id));
		for (const e of t.employee) {
			if (e.managerId) expect(ids.has(e.managerId), e.id).toBe(true);
			expect(e.email.endsWith('@cafoo.example')).toBe(true);
			for (const d of e.deposit) expect(d.accountLast4).toMatch(/^\d{4}$/);
			expect(e.deposit.filter((d) => d.remainder).length, e.id).toBe(1);
		}
		const slip = t.payslip.find((p) => p.employeeId === 'emp-04')!;
		const split = splitDeposit(slip.netMinor, t.employee.find((e) => e.id === 'emp-04')!.deposit);
		expect(split.reduce((s, x) => s + BigInt(x.amountMinor), 0n)).toBe(BigInt(slip.netMinor));
	});

	it('has the time-off report and incoming requests point at real people', () => {
		const ids = new Set(t.employee.map((e) => e.id));
		for (const id of Object.keys(PTO_REPORT)) expect(ids.has(id)).toBe(true);
		for (const r of INCOMING_PTO) expect(ids.has(r.employeeId)).toBe(true);
	});
});

describe('payroll entry', () => {
	it('balances and splits gross, employer cost, net and liabilities', () => {
		const run = t.pay_run.find((r) => r.id === REGISTER_RUN_ID)!;
		const e = payrollEntry(run);
		const dr = e.lines.reduce((s, l) => s + BigInt(l.debitMinor), 0n);
		const cr = e.lines.reduce((s, l) => s + BigInt(l.creditMinor), 0n);
		expect(dr).toBe(cr);
		expect(e.lines.map((l) => l.account)).toEqual(['6000', '6010', '1000', '2200']);
		expect(e.totalMinor).toBe(loadedCost(run));
		expect(payrollEntry({ ...run, subsidiaryId: 'sub-uk' }).lines.map((l) => l.account)).toEqual(['5300-UK', '6010-UK', '1000-UK', '2200-UK']);
	});
});

describe('live from Gusto', () => {
	const run = { status: 'scheduled', payDate: '2026-10-30T00:00:00Z', debitDate: '2026-10-28T00:00:00Z', subsidiaryId: 'sub-us' } as PayRun;
	it('moves runs along their dates', () => {
		expect(advanceRun(run, '2026-10-02T11:00:00Z')).toBe('scheduled');
		expect(advanceRun(run, '2026-10-26T09:00:00Z')).toBe('processing');
		expect(advanceRun({ ...run, status: 'processing' }, '2026-10-30T09:00:00Z')).toBe('paid');
	});

	it('logs contractor hours a quarter hour at a time', () => {
		expect(nextHours(12)).toBe(12.75);
		expect(nextHours(12.75) % 0.25).toBe(0);
	});

	it('flags whoever would go past their carryover cap by year end', () => {
		const names = overCap(t.employee, t.pto_request, '2026-10-02').map((x) => x.e.name);
		expect(names).toContain('Oliver Hughes');
		expect(names).not.toContain('Grace Liu');
	});
});
