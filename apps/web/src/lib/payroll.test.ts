import { describe, expect, it } from 'vitest';
import type { DepositSplit, Employee } from './data/types';
import {
	bankingDaysBefore,
	costByDepartment,
	estimatePay,
	grossPerRun,
	isEmployed,
	loadedCost,
	monthlyLoadedCost,
	payDatesLeftInYear,
	projectPto,
	splitDeposit,
	sumPay,
	ukPayDate,
	usPayDates,
	workingHours
} from './payroll';

function person(o: Partial<Employee> = {}): Employee {
	return {
		id: 'e1',
		subsidiaryId: 'sub-us',
		name: 'Test Person',
		title: 'Engineer',
		department: 'engineering',
		email: 't@cafoo.example',
		location: 'San Francisco, CA',
		startAt: '2025-01-06T00:00:00Z',
		type: 'full_time',
		status: 'active',
		annualSalaryMinor: '12000000',
		ccy: 'USD',
		payFrequency: 'semi_monthly',
		retirementBp: 300,
		benefitsMonthlyMinor: '61240',
		serviceShareBp: 5000,
		deposit: [],
		pto: { accrualHoursPerRun: 5, unlimited: false, balanceHours: 40, usedHoursYtd: 0, carryoverCapHours: 180, sickBalanceHours: 40 },
		...o
	};
}

describe('pay dates', () => {
	it('pays Cafoo Inc on the 15th and the last day, a banking day earlier on weekends and holidays', () => {
		expect(usPayDates('2026-10').map((p) => p.payDate)).toEqual(['2026-10-15', '2026-10-30']); // Oct 31 is a Saturday
		expect(usPayDates('2026-08').map((p) => p.payDate)).toEqual(['2026-08-14', '2026-08-31']); // Aug 15 is a Saturday
		expect(usPayDates('2026-11').map((p) => p.payDate)).toEqual(['2026-11-13', '2026-11-30']); // Nov 15 is a Sunday
		expect(usPayDates('2026-07')[0]).toMatchObject({ periodStart: '2026-07-01', periodEnd: '2026-07-15' });
		expect(usPayDates('2026-07')[1]).toMatchObject({ periodStart: '2026-07-16', periodEnd: '2026-07-31' });
	});

	it('pays Cafoo Ltd on the last working day, skipping bank holidays', () => {
		expect(ukPayDate('2026-08').payDate).toBe('2026-08-28'); // Aug 31 is the summer bank holiday
		expect(ukPayDate('2026-10').payDate).toBe('2026-10-30');
		expect(ukPayDate('2026-09').payDate).toBe('2026-09-30');
	});

	it('debits two banking days before payday, skipping holidays', () => {
		expect(usPayDates('2026-10')[0].debitDate).toBe('2026-10-13');
		expect(bankingDaysBefore('2026-10-14', 2, 'US')).toBe('2026-10-09'); // Oct 12 is Columbus Day
		expect(bankingDaysBefore('2026-10-14', 2, 'UK')).toBe('2026-10-12');
	});

	it('lists the pay dates left in the year', () => {
		expect(payDatesLeftInYear('US', '2026-10-02')).toHaveLength(6);
		expect(payDatesLeftInYear('UK', '2026-10-02')).toHaveLength(3);
	});
});

describe('gross and withholding', () => {
	it('splits a salary across the runs of a year, and pays hourly people for their hours', () => {
		expect(grossPerRun(person())).toBe('500000');
		expect(grossPerRun(person({ annualSalaryMinor: '9600000', payFrequency: 'monthly', ccy: 'GBP' }))).toBe('800000');
		expect(grossPerRun(person({ annualSalaryMinor: '0', hourlyRateMinor: '3000', type: 'intern' }), 37.5)).toBe('112500');
	});

	it('balances: gross = net + employee tax + deductions', () => {
		for (const e of [person(), person({ ccy: 'GBP', payFrequency: 'monthly', location: 'London, UK', retirementBp: 500, benefitsMonthlyMinor: '11250', annualSalaryMinor: '9600000' })]) {
			const p = estimatePay(e, grossPerRun(e));
			expect(BigInt(p.netMinor) + BigInt(p.employeeTaxMinor) + BigInt(p.deductionsMinor)).toBe(BigInt(p.grossMinor));
			expect(BigInt(p.netMinor)).toBeGreaterThan(0n);
		}
	});

	it('charges US employer FICA, plus FUTA and SUTA only below the $7,000 wage base', () => {
		const e = person();
		const early = estimatePay(e, '500000', { ytdGrossMinor: '0' });
		const late = estimatePay(e, '500000', { ytdGrossMinor: '1000000' });
		expect(late.employerTaxMinor).toBe('38250'); // 7.65% of $5,000
		expect(early.employerTaxMinor).toBe('58750'); // plus 0.6% FUTA and 3.5% SUTA
		// Employer benefits: 3% match on $5,000 and half the monthly health premium.
		expect(late.employerBenefitsMinor).toBe(String(15000 + 30620));
		expect(loadedCost(late)).toBe(String(500000 + 38250 + 45620));
	});

	it('charges UK employer NI at 15% above £5,000 a year', () => {
		const e = person({ ccy: 'GBP', payFrequency: 'monthly', location: 'London, UK', retirementBp: 500, benefitsMonthlyMinor: '11250', annualSalaryMinor: '9600000' });
		const p = estimatePay(e, '800000');
		expect(p.employerTaxMinor).toBe('113750');
		expect(p.employerBenefitsMinor).toBe(String(40000 + 11250));
		expect(p.deductionsMinor).toBe('40000'); // 5% employee pension
	});

	it('withholds nothing from contractors', () => {
		const p = estimatePay(person({ type: 'contractor', annualSalaryMinor: '0', hourlyRateMinor: '6500' }), '78000');
		expect(p).toMatchObject({ employeeTaxMinor: '0', employerTaxMinor: '0', netMinor: '78000' });
	});

	it('keeps benefits for someone on unpaid leave', () => {
		const p = estimatePay(person({ status: 'on_leave' }), '0');
		expect(p.netMinor).toBe('0');
		expect(p.employerBenefitsMinor).toBe('30620');
	});

	it('adds payslips into run totals', () => {
		const e = person();
		const a = estimatePay(e, '500000', { ytdGrossMinor: '1000000' });
		const t = sumPay([a, a]);
		expect(t.grossMinor).toBe('1000000');
		expect(t.netMinor).toBe(String(BigInt(a.netMinor) * 2n));
	});
});

describe('cost', () => {
	it('gives a month of fully loaded cost', () => {
		// Two runs of $5,000 + $382.50 FICA + $150 match + $306.20 health.
		expect(monthlyLoadedCost(person())).toBe(String(2 * (500000 + 38250 + 15000 + 30620)));
	});

	it('groups cost by department, with the service share as cost of revenue', () => {
		const rows = costByDepartment(
			[person({ id: 'a' }), person({ id: 'b', department: 'sales', serviceShareBp: 0 }), person({ id: 'c', startAt: '2026-11-01T00:00:00Z' })],
			'2026-10-02'
		);
		expect(rows.map((r) => r.department)).toEqual(['engineering', 'sales']);
		expect(rows[0].headcount).toBe(1);
		expect(rows[0].serviceMinor).toBe(String(BigInt(rows[0].monthlyMinor) / 2n));
		expect(rows[1].serviceMinor).toBe('0');
	});

	it('knows who is employed on a date', () => {
		expect(isEmployed(person({ startAt: '2026-10-01T00:00:00Z' }), '2026-10-02')).toBe(true);
		expect(isEmployed(person({ startAt: '2026-10-01T00:00:00Z' }), '2026-09-30')).toBe(false);
		expect(isEmployed(person({ endAt: '2026-09-30T00:00:00Z' }), '2026-10-02')).toBe(false);
	});
});

describe('deposits', () => {
	const checking: DepositSplit = { bankName: 'Chase', accountLast4: '0193', accountType: 'checking', remainder: true };
	const savings: DepositSplit = { bankName: 'Ally', accountLast4: '7710', accountType: 'savings', amountMinor: '100000', remainder: false };

	it('takes fixed amounts first and puts the rest in the remainder account', () => {
		expect(splitDeposit('350000', [checking, savings]).map((s) => s.amountMinor)).toEqual(['250000', '100000']);
	});

	it('never sends more than the net', () => {
		expect(splitDeposit('60000', [checking, savings]).map((s) => s.amountMinor)).toEqual(['0', '60000']);
	});

	it('puts the rest in the last account when none is marked remainder', () => {
		expect(splitDeposit('150000', [savings]).map((s) => s.amountMinor)).toEqual(['150000']);
	});
});

describe('time off', () => {
	it('counts working hours, skipping weekends and bank holidays', () => {
		expect(workingHours('2026-11-23', '2026-11-27', 'US')).toBe(32); // Thanksgiving
		expect(workingHours('2026-10-26', '2026-10-30', 'UK')).toBe(40);
	});

	it('projects the year-end balance and flags hours over the carryover cap', () => {
		const pto = { accrualHoursPerRun: 5, unlimited: false, balanceHours: 172, usedHoursYtd: 24, carryoverCapHours: 180, sickBalanceHours: 40 };
		expect(projectPto(pto, 6, 40)).toEqual({ projectedHours: 162, overCapHours: 0 });
		expect(projectPto(pto, 6, 0)).toEqual({ projectedHours: 202, overCapHours: 22 });
	});

	it('never flags an unlimited policy', () => {
		expect(projectPto({ accrualHoursPerRun: 0, unlimited: true, balanceHours: 0, usedHoursYtd: 80, sickBalanceHours: 40 }, 6, 0).overCapHours).toBe(0);
	});
});
