import { describe, expect, it } from 'vitest';
import type { Contract, Employee } from './data/types';
import { arrPerFte, burnMultiple, burnMultipleHealth, fte, grossMarginBp, ndrBp, netBurn, netNewArr, ruleOf40, ruleOf40Health, shareOfRevenueBp } from './kpis';

const person = (id: string, type: Employee['type'], startAt = '2026-01-01', extra: Partial<Employee> = {}): Employee => ({
	id,
	subsidiaryId: 'sub-us',
	name: id,
	title: 't',
	department: 'engineering',
	email: `${id}@cafoo.example`,
	location: 'Remote',
	startAt,
	type,
	status: 'active',
	annualSalaryMinor: '15000000',
	ccy: 'USD',
	payFrequency: 'semi_monthly',
	retirementBp: 0,
	benefitsMonthlyMinor: '0',
	serviceShareBp: 0,
	deposit: [],
	pto: { accrualHoursPerRun: 0, unlimited: true, balanceHours: 0, usedHoursYtd: 0, sickBalanceHours: 0 },
	...extra
});

const contract = (id: string, arr: number, startAt: string, extra: Partial<Contract> = {}): Contract => ({ id, customerId: id, startAt, billing: 'annual', arrMinor: String(arr), ...extra });

describe('fte', () => {
	it('counts full-time as one, part-time and interns as half, contractors not at all', () => {
		const team = [person('a', 'full_time'), person('b', 'part_time'), person('c', 'intern'), person('d', 'contractor'), person('e', 'full_time', '2026-10-01')];
		expect(fte(team, '2026-09-30')).toBe(2);
		expect(fte(team, '2026-10-01')).toBe(3);
	});
	it('leaves out people who have left, but counts them while they worked', () => {
		const left = person('a', 'full_time', '2026-01-01', { endAt: '2026-08-31', status: 'terminated' });
		expect(fte([left], '2026-09-15')).toBe(0);
		expect(fte([left], '2026-06-30')).toBe(1);
		expect(fte([person('b', 'full_time', '2026-01-01', { status: 'terminated' })], '2026-06-30')).toBe(0);
	});
});

describe('burn and growth', () => {
	const contracts = [contract('c1', 12_000_000, '2026-01-01'), contract('c2', 6_000_000, '2026-09-10')];
	it('reads burn from operating cash, not money raised', () => {
		expect(netBurn({ operatingCashChange: '-500000' })).toBe(500000n);
		expect(netBurn({ operatingCashChange: '100' })).toBe(0n);
	});
	it('measures ARR added in the range', () => {
		expect(netNewArr(contracts, '2026-08-31', '2026-09-30')).toBe(6_000_000n);
	});
	it('divides burn by net new ARR, and has no multiple without growth', () => {
		expect(burnMultiple(9_000_000n, 6_000_000n)).toBe(1.5);
		expect(burnMultiple(9_000_000n, 0n)).toBeNull();
		expect(burnMultipleHealth(null, 1n)).toBe('poor');
		expect(burnMultipleHealth(0.8, 1n)).toBe('good');
	});
	it('spreads ARR over full-time equivalents', () => {
		expect(arrPerFte(contracts, [person('a', 'full_time'), person('b', 'part_time')], '2026-09-30')).toBe(12_000_000n);
	});
	it('adds annualized ARR growth to the net margin for the Rule of 40', () => {
		const r = ruleOf40(contracts, '2026-08-31', '2026-09-30', 1, -2000);
		expect(r).toEqual({ score: 580, growthPct: 600, marginPct: -20 });
		expect(ruleOf40Health(r?.score ?? null)).toBe('good');
	});
	it('keeps retention at 100% when nothing expands or churns', () => {
		expect(ndrBp(contracts, '2026-08-31', '2026-09-30')).toBe(10000);
	});
});

describe('margins', () => {
	it('computes gross margin and a cost’s share of revenue', () => {
		expect(grossMarginBp('100000', 45000n)).toBe(5500);
		expect(grossMarginBp('0', 1n)).toBeNull();
		expect(shareOfRevenueBp('20000', '100000')).toBe(2000);
	});
});
