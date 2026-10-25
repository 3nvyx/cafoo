import { describe, expect, it } from 'vitest';
import type { Employee, PayRun } from '#lib/data/types.js';
import { countryOf, headcountByMonth, monthsBetween, onTeamAt, payrollByMonth } from './headcount';

const person = (id: string, startAt: string, over: Partial<Employee> = {}) => ({ id, startAt, type: 'full_time', ccy: 'USD', location: 'New York, NY', department: 'engineering', ...over }) as Employee;

describe('monthsBetween', () => {
	it('lists months across a year end', () => {
		expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
		expect(monthsBetween('2026-03-15T00:00:00Z', '2026-03-31')).toEqual(['2026-03']);
		expect(monthsBetween('2026-04', '2026-03')).toEqual([]);
	});
});

describe('headcount', () => {
	it('counts people on the team at each month end, without contractors', () => {
		const team = [
			person('a', '2026-01-10T00:00:00Z'),
			person('b', '2026-02-28T00:00:00Z', { ccy: 'GBP', location: 'London, UK' }),
			person('c', '2026-01-01T00:00:00Z', { endAt: '2026-02-15T00:00:00Z' }),
			person('d', '2026-01-01T00:00:00Z', { type: 'contractor' })
		];
		const h = headcountByMonth(team, ['2026-01', '2026-02', '2026-03'], countryOf);
		expect(h.map((x) => x.total)).toEqual([2, 2, 2]);
		expect(h.map((x) => x.by.get('UK') ?? 0)).toEqual([0, 1, 1]);
		expect(onTeamAt(team[2], '2026-02')).toBe(false);
		expect(headcountByMonth([], ['2026-01'], countryOf)).toEqual([{ ym: '2026-01', total: 0, by: new Map() }]);
	});
});

describe('payrollByMonth', () => {
	it('adds loaded cost per pay month in the reporting currency and keeps the journal entries', () => {
		const run = (id: string, payDate: string, ccy: string, gross: number, jeId?: string, status: PayRun['status'] = 'paid') =>
			({ id, payDate, ccy, status, grossMinor: String(gross), employerTaxMinor: '100', employerBenefitsMinor: '50', jeId }) as PayRun;
		const toUsd = (minor: string, ccy: string) => (ccy === 'GBP' ? String((BigInt(minor) * 5n) / 4n) : minor);
		const p = payrollByMonth([run('1', '2026-01-15', 'USD', 1000, 'je1'), run('2', '2026-01-30', 'USD', 1000, 'je1'), run('3', '2026-01-30', 'GBP', 800, 'je2'), run('4', '2026-02-15', 'USD', 1000, undefined, 'draft')], toUsd);
		// USD runs: 1,150 + 1,150; GBP run: (800 + 150) x 1.25 = 1,187.5, rounded down to 1,187.
		expect(p).toHaveLength(1);
		expect(p[0].loadedMinor).toBe(1150n + 1150n + 1187n);
		expect(p[0].grossMinor).toBe(3000n);
		expect(p[0].jeIds).toEqual(['je1', 'je2']);
	});
});
