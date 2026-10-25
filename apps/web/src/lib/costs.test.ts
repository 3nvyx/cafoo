import { describe, expect, it } from 'vitest';
import type { Batch, CloudCost, Employee } from './data/types';
import { loadSeed } from './data/mock/seed';
import {
	batchStatus,
	breakage,
	costByProvider,
	costOfService,
	costPerMTokens,
	creditPricePerM,
	creditTotals,
	expiringSoon,
	grossMarginAfterInference,
	hostingTieOut,
	ledgerByMonth,
	marginByProduct,
	serviceEngineering,
	unusedValue,
	usedValue
} from './costs';
import { toBig } from './data/money';
import { monthlyLoadedCost } from './payroll';

const cc = (p: Partial<CloudCost>): CloudCost => ({
	id: 'x',
	subsidiaryId: 'sub-us',
	provider: 'aws',
	service: 'EC2',
	ym: '2026-09',
	environment: 'production',
	category: 'cost_of_revenue',
	amountMinor: '0',
	ccy: 'USD',
	usageQuantity: 0,
	usageUnit: 'units',
	...p
});

const person = (p: Partial<Employee>): Employee => ({
	id: 'e',
	subsidiaryId: 'sub-us',
	name: 'Test Person',
	title: 'Engineer',
	department: 'engineering',
	email: 'e@example.com',
	location: 'Remote',
	startAt: '2025-01-01T00:00:00Z',
	type: 'full_time',
	status: 'active',
	annualSalaryMinor: '12000000',
	ccy: 'USD',
	payFrequency: 'semi_monthly',
	retirementBp: 400,
	benefitsMonthlyMinor: '50000',
	serviceShareBp: 2500,
	deposit: [],
	pto: { accrualHoursPerRun: 0, unlimited: true, balanceHours: 0, usedHoursYtd: 0, sickBalanceHours: 0 },
	...p
});

const pack = (p: Partial<Batch>): Batch => ({
	id: 'b',
	subsidiaryId: 'sub-us',
	kind: 'credit_pack',
	sku: 'CR',
	name: 'Credits',
	quantity: 200,
	remaining: 50,
	unit: 'M tokens',
	amountMinor: '260000',
	ccy: 'USD',
	acquiredAt: '2026-04-01T00:00:00Z',
	status: 'active',
	...p
});

describe('seeded cost of service', () => {
	const t = loadSeed();

	it('production cloud ties out to 5000 Hosting costs for July to September', () => {
		const ledger = ledgerByMonth(t.account, t.journal_entry, t.journal_line, '5000');
		const tie = hostingTieOut(t.cloud_cost, ledger, ['2026-07', '2026-08', '2026-09']);
		expect(tie.map((x) => x.cloudMinor)).toEqual(['980000', '1840000', '1120000']);
		expect(tie.every((x) => x.gapMinor === '0')).toBe(true);
	});

	it('September inference, its share of revenue and the margin after it', () => {
		const cos = costOfService(t.cloud_cost, [], '2026-09');
		expect(cos.hostingMinor).toBe('1120000');
		expect(cos.inferenceMinor).toBe('808800');
		// Ledger revenue for September: 24,000 + 3,200 + 43,600 + 6,500.
		const m = grossMarginAfterInference('7730000', cos);
		expect(m.inferenceShareBp).toBe(1046);
		expect(m.beforeInferenceBp).toBe(8551);
		expect(m.afterInferenceBp).toBe(7504);
	});

	it('Copilot costs about $3.60 per million tokens against credits sold at about $12.05', () => {
		expect(costPerMTokens(t.cloud_cost, '2026-09', 'Copilot').perMMinor).toBe('360');
		expect(creditPricePerM(t.batch)).toBe('1205');
	});
});

describe('cost of service maths', () => {
	const rows = [
		cc({ amountMinor: '1000', product: 'Copilot' }),
		cc({ provider: 'openai', amountMinor: '600', usageQuantity: 2, usageUnit: 'M tokens', product: 'Copilot' }),
		cc({ provider: 'openai', amountMinor: '400', environment: 'development', category: 'r_and_d', usageQuantity: 5, usageUnit: 'M tokens' }),
		cc({ provider: 'github', amountMinor: '100', environment: 'shared', category: 'g_and_a' }),
		cc({ ym: '2026-08', amountMinor: '9999' })
	];

	it('splits by category and adds the service share of loaded pay', () => {
		const svc = (toBig(monthlyLoadedCost(person({}))) * 2500n) / 10000n;
		const cos = costOfService(rows, [person({})], '2026-09');
		expect(cos.serviceEngineeringMinor).toBe(svc.toString());
		expect(cos.costOfRevenueMinor).toBe((1600n + svc).toString());
		expect(cos.rAndDMinor).toBe('400');
		expect(cos.gAndAMinor).toBe('100');
		expect(cos.totalMinor).toBe((2100n + svc).toString());
	});

	it('converts foreign pay, skips people not on payroll that month, and can leave out contractors', () => {
		const gbp = person({ id: 'uk', ccy: 'GBP', serviceShareBp: 10000 });
		const later = person({ id: 'new', startAt: '2026-10-05T00:00:00Z' });
		const gone = person({ id: 'gone', endAt: '2026-08-31T00:00:00Z' });
		const contractor = person({ id: 'c', type: 'contractor' });
		const r = serviceEngineering([gbp, later, gone, contractor], '2026-09', (ccy) => (ccy === 'GBP' ? 1_270_000n : 1_000_000n));
		expect(r.people.map((p) => p.employee.id)).toEqual(['uk', 'c']);
		expect(r.people[0].serviceMinor).toBe(((toBig(monthlyLoadedCost(gbp)) * 1_270_000n) / 1_000_000n).toString());
		expect(serviceEngineering([gbp, contractor], '2026-09', undefined, { payrollOnly: true }).people.map((p) => p.employee.id)).toEqual(['uk']);
	});

	it('counts the service share only for the part of a month in progress', () => {
		const full = toBig(costOfService([], [person({})], '2026-09').serviceEngineeringMinor);
		expect(costOfService([], [person({})], '2026-09', undefined, '2026-09-16T00:00:00Z').serviceEngineeringMinor).toBe(((full * 500_000n) / 1_000_000n).toString());
		expect(costOfService([], [person({})], '2026-09', undefined, '2026-10-02T00:00:00Z').serviceEngineeringMinor).toBe(full.toString());
	});

	it('margin without revenue is null, not a division by zero', () => {
		const m = grossMarginAfterInference('0', costOfService(rows, [], '2026-09'));
		expect(m.afterInferenceBp).toBeNull();
		expect(m.inferenceShareBp).toBeNull();
	});

	it('ranks providers and computes per-product margin and token cost', () => {
		const p = costByProvider(rows, '2026-09');
		expect(p[0]).toEqual({ key: 'aws', amountMinor: '1000', shareBp: 4761 });
		const copilot = marginByProduct(rows, '2026-09', '10000').find((x) => x.product === 'Copilot')!;
		expect(copilot.revenueMinor).toBe('3000');
		expect(copilot.marginBp).toBe(4666);
		expect(costPerMTokens(rows, '2026-09')).toEqual({ tokensM: 2, costMinor: '600', perMMinor: '300' });
		expect(costPerMTokens(rows, '2026-07').perMMinor).toBeNull();
	});
});

describe('batches', () => {
	const now = '2026-10-02T11:00:00Z';

	it('derives status from remaining and expiry', () => {
		expect(batchStatus(pack({ remaining: 0 }), now)).toBe('depleted');
		expect(batchStatus(pack({ expiresAt: '2026-10-02T10:59:00Z' }), now)).toBe('expired');
		expect(batchStatus(pack({ expiresAt: '2026-10-20T00:00:00Z' }), now)).toBe('expiring');
		expect(batchStatus(pack({ expiresAt: '2027-01-01T00:00:00Z' }), now)).toBe('active');
		expect(batchStatus(pack({}), now)).toBe('active');
	});

	it('values used and unused credits and the breakage of a month', () => {
		const b = pack({ expiresAt: '2026-10-15T00:00:00Z' });
		expect(unusedValue(b)).toBe('65000');
		expect(usedValue(b)).toBe('195000');
		const br = breakage([b, pack({ id: 'gone', remaining: 0, expiresAt: '2026-10-10T00:00:00Z' }), pack({ id: 'sep', expiresAt: '2026-09-30T00:00:00Z' })], '2026-10', '2026-10-31T00:00:00Z');
		expect(br.packs.map((x) => x.id)).toEqual(['b']);
		expect(br.amountMinor).toBe('65000');
	});

	it('does not count a pack as breakage before it has expired', () => {
		const b = pack({ expiresAt: '2026-10-15T00:00:00Z' });
		expect(breakage([b], '2026-10', '2026-10-02T11:00:00Z').packs).toEqual([]);
		expect(breakage([b], '2026-10', '2026-10-15T00:00:00Z').amountMinor).toBe('65000');
	});

	it('lists what expires soon and totals the credits', () => {
		const list = [pack({ id: 'late', expiresAt: '2026-10-30T00:00:00Z' }), pack({ id: 'soon', expiresAt: '2026-10-05T00:00:00Z' }), pack({ id: 'far', expiresAt: '2027-05-01T00:00:00Z' })];
		expect(expiringSoon(list, now).map((b) => b.id)).toEqual(['soon', 'late']);
		const tot = creditTotals(list, now);
		expect(tot.soldMinor).toBe('780000');
		expect(tot.unusedMinor).toBe('195000');
		expect(tot.expiringMinor).toBe('130000');
	});

	it('seeds packs with October expiries and one already lapsed in September', () => {
		const t = loadSeed();
		expect(breakage(t.batch, '2026-09', '2026-10-02T11:00:00Z').amountMinor).toBe('102000');
		// On the demo's first morning neither October pack has expired; Willow Street Vet's lapses at 11:02.
		expect(breakage(t.batch, '2026-10', '2026-10-02T11:00:00Z').packs).toEqual([]);
		expect(breakage(t.batch, '2026-10', '2026-10-02T11:03:00Z').packs.map((b) => b.customerId)).toEqual(['c07']);
		expect(breakage(t.batch, '2026-10', '2026-11-01T00:00:00Z').packs.map((b) => b.customerId).sort()).toEqual(['c04', 'c07']);
	});
});
