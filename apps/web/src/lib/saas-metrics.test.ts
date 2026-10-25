import { describe, expect, it } from 'vitest';
import type { CostOfService } from './costs';
import type { Posting } from './data/dashboard';
import type { Account, Contract } from './data/types';
import { efficiencyTiles } from './kpis';
import {
	arrMovement,
	burnMultipleLabel,
	burnReading,
	burnWindowLabel,
	cacPaybackMonths,
	grrBp,
	revenuePerEmployee,
	runwayLabel,
	salesAndMarketing,
	shiftYm,
	sparkPath,
	windowGmAfterInferenceBp,
	windowRange
} from './saas-metrics';

describe('burn and runway', () => {
	const acct = (code: string, type: Account['type']): Account => ({ id: code, subsidiaryId: 's', code, name: code, type });
	const cash = acct('1000', 'asset');
	const equity = acct('3000', 'equity');
	const p = (date: string, account: Account, amount: bigint, jeId: string): Posting => ({ date, account, amount, jeId });
	// 1.2M raised in June; 100k a month of spend; a year of annual contracts (240k) collected upfront in August.
	const ps: Posting[] = [
		p('2026-06-01', cash, 120_000_000n, 'raise'),
		p('2026-06-01', equity, 120_000_000n, 'raise'),
		p('2026-07-15', cash, -10_000_000n, 'jul'),
		p('2026-08-10', cash, 24_000_000n, 'prepay'),
		p('2026-08-15', cash, -10_000_000n, 'aug'),
		p('2026-09-15', cash, -10_000_000n, 'sep')
	];

	it('averages net operating cash burn over the last three months, leaving money raised out', () => {
		const b = burnReading(ps, '2026-09', '2026-06');
		expect(b.yms).toEqual(['2026-07', '2026-08', '2026-09']);
		// 300k spent less 240k collected over the quarter: 60k, 20k a month. September alone would read 100k.
		expect(b.totalBurn).toBe(6_000_000n);
		expect(b.monthlyBurn).toBe(2_000_000n);
		expect(b.cash).toBe(114_000_000n);
		expect(b.runwayMonths).toBe(57);
		expect(runwayLabel(b)).toBe('Over 3 years');
	});

	it('uses fewer months when the books start later, and has no runway when operations add cash', () => {
		const b = burnReading(ps, '2026-08', '2026-08');
		expect(b.yms).toEqual(['2026-08']);
		expect(b.totalBurn).toBe(0n);
		expect(b.runwayMonths).toBeNull();
		expect(runwayLabel(b)).toBe('Cash not falling');
		expect(runwayLabel({ runwayMonths: 12.4, cash: 1n })).toBe('12 months');
		expect(runwayLabel({ runwayMonths: 0.5, cash: 1n })).toBe('Under a month');
	});

	it("gives the Dashboard's health tiles the same burn and runway", () => {
		const tiles = efficiencyTiles({ ps, endYm: '2026-09', firstYm: '2026-06', contracts: [], employees: [] });
		const runway = tiles.find((t) => t.key === 'runway')!;
		expect(runway.value).toBe(runwayLabel(burnReading(ps, '2026-09', '2026-06')));
		expect(runway.inputs).toBe('$20,000 a month of operating burn, averaged over Jul 2026 to Sep 2026 · $1,140,000 cash');
		expect(tiles.find((t) => t.key === 'burn-multiple')!.inputs).toBe('$60,000 burned · $0 net new ARR, over Jul 2026 to Sep 2026');
	});

	it('labels the months and a small burn multiple readably', () => {
		expect(burnWindowLabel(['2026-07', '2026-08', '2026-09'])).toBe('over Jul 2026 to Sep 2026');
		expect(burnMultipleLabel(0.03)).toBe('0.03×');
		expect(burnMultipleLabel(1.54)).toBe('1.5×');
		expect(burnMultipleLabel(0)).toBe('0.0×');
	});
});

const c = (id: string, arr: number, startAt: string, extra: Partial<Contract> = {}): Contract => ({ id, customerId: id, arrMinor: String(arr), startAt, ...extra }) as Contract;

describe('windows', () => {
	it('moves across years', () => {
		expect(shiftYm('2026-01', -1)).toBe('2025-12');
		expect(shiftYm('2025-11', 14)).toBe('2027-01');
	});
	it('ends at the month and stops at the first month of the books', () => {
		expect(windowRange('2026-09', 3, '2025-04')).toEqual({ from: '2026-07-01', to: '2026-09-30', before: '2026-06-30', months: 3, yms: ['2026-07', '2026-08', '2026-09'] });
		const ttm = windowRange('2025-06', 12, '2025-04');
		expect(ttm.from).toBe('2025-04-01');
		expect(ttm.months).toBe(3);
	});
});

describe('ARR movement and retention', () => {
	const contracts = [
		c('a', 120000, '2026-01-01T00:00:00Z'),
		c('b', 60000, '2026-01-01T00:00:00Z', { changedAt: '2026-08-15T00:00:00Z', priorArrMinor: '40000' }),
		c('d', 30000, '2026-01-01T00:00:00Z', { changedAt: '2026-08-10T00:00:00Z', priorArrMinor: '50000' }),
		c('e', 24000, '2026-01-01T00:00:00Z', { endAt: '2026-08-20T00:00:00Z' }),
		c('f', 12000, '2026-08-05T00:00:00Z')
	];
	it('splits a month into new, expansion, contraction and churn', () => {
		const [aug] = arrMovement(contracts, ['2026-08']);
		expect(aug).toEqual({ ym: '2026-08', added: 12000n, expansion: 20000n, contraction: 20000n, churned: 24000n, net: -12000n });
	});
	it('gross retention leaves expansion out', () => {
		// Start 234000 (120000 + 40000 + 50000 + 24000); lost 20000 contraction and 24000 churn.
		const w = { start: '234000', added: '12000', expansion: '20000', contraction: '20000', churned: '24000', end: '222000', from: '', to: '' };
		expect(grrBp(w)).toBe(Math.floor((190000 * 10000) / 234000));
		expect(grrBp({ ...w, start: '0' })).toBeNull();
	});
});

describe('efficiency', () => {
	it('computes CAC payback in months', () => {
		// $30k of S&M bought $120k of ARR at 75% margin: $7.5k gross profit a month, so 4 months.
		expect(cacPaybackMonths(3_000_000n, 12_000_000n, 7500)).toBe(4);
		expect(cacPaybackMonths(3_000_000n, 0n, 7500)).toBeNull();
		expect(cacPaybackMonths(3_000_000n, 12_000_000n, null)).toBeNull();
	});
	it('annualizes revenue per employee', () => {
		expect(revenuePerEmployee(30_000_000n, 3, 10)).toBe(12_000_000n);
		expect(revenuePerEmployee(30_000_000n, 3, 0)).toBeNull();
		expect(revenuePerEmployee(10_000_000n, 1, 2.5)).toBe(48_000_000n);
	});
	it('adds up gross margin after inference across months', () => {
		const cos = (h: number, s: number, i: number) => ({ hostingMinor: String(h), serviceEngineeringMinor: String(s), inferenceMinor: String(i) }) as CostOfService;
		expect(windowGmAfterInferenceBp([{ revenue: 1000n, cos: cos(100, 100, 100) }, { revenue: 1000n, cos: cos(100, 100, 300) }])).toBe(6000);
		expect(windowGmAfterInferenceBp([])).toBeNull();
	});
	it('finds sales and marketing spend by account name', () => {
		const acc = (name: string, type: Account['type'] = 'expense'): Account => ({ id: name, subsidiaryId: 's', code: '6300', name, type });
		const ps: Posting[] = [
			{ date: '2026-09-02', account: acc('Marketing'), amount: 500n },
			{ date: '2026-09-03', account: acc('Rent'), amount: 900n },
			{ date: '2026-08-31', account: acc('Marketing'), amount: 700n },
			{ date: '2026-09-04', account: acc('Sales Commissions'), amount: 100n }
		];
		expect(salesAndMarketing(ps, '2026-09-01', '2026-09-30')).toBe(600n);
	});
});

describe('sparkPath', () => {
	it('scales to the box with the top as the highest value', () => {
		expect(sparkPath([1, 2, 3], 100, 20)).toBe('M0 20L50 10L100 0');
	});
	it('breaks the line at missing values and draws a flat line through the middle', () => {
		expect(sparkPath([1, null, 3], 100, 20)).toBe('M0 20M100 0');
		expect(sparkPath([5, 5], 10, 20)).toBe('M0 10L10 10');
		expect(sparkPath([null], 10, 20)).toBe('');
	});
});
