import { describe, expect, it } from 'vitest';
import type { BankMatch, BankTransaction, Contract, Customer, Invoice } from '#lib/data/types.js';
import { arSummary, bucketForDays, customerRows, filterRows, invoicedByMonth, paginate, paymentsFor, segmentOf, sharesBp, sortRows } from './receivables';
import { humanKey, parseCheckSummary } from './credit-summary';

const cust = (id: string, name: string, creditTier?: Customer['creditTier']): Customer => ({
	id,
	name,
	domain: `${name.toLowerCase()}.com`,
	guarantorPersonaId: 'p',
	guarantorName: `Owner of ${name}`,
	creditTier,
	paymentTermsDays: 30
});
const inv = (id: string, customerId: string, dueAt: string, amountMinor: string, status: Invoice['status'] = 'open', issuedAt = '2026-01-01'): Invoice => ({
	id,
	number: id,
	customerId,
	issuedAt,
	dueAt,
	amountMinor,
	status
});
const con = (customerId: string, arrMinor: string): Contract => ({ id: `k-${customerId}`, customerId, startAt: '2025-01-01', billing: 'annual', arrMinor });

const asOf = '2026-09-30';
const customers = [cust('c1', 'Acme', 'A'), cust('c2', 'Beta', 'D'), cust('c3', 'Gamma')];
const invoices = [
	inv('i1', 'c1', '2026-10-15', '10000'), // not yet due: 0-30
	inv('i2', 'c1', '2026-09-10', '5000'), // 20 days late: 0-30
	inv('i3', 'c2', '2026-07-25', '20000', 'overdue'), // 67 days late: 61-90
	inv('i4', 'c2', '2026-05-01', '40000', 'overdue'), // 152 days late: 90+
	inv('i5', 'c2', '2026-08-01', '99999', 'paid'), // paid: ignored
	inv('i6', 'c3', '2026-12-01', '7000', 'open', '2026-10-05') // issued after asOf: ignored
];
const contracts = [con('c1', '30000000'), con('c2', '1200000')];

describe('segmentOf', () => {
	it('reads the segment from ARR', () => {
		expect(segmentOf('0')).toBe('no_contract');
		expect(segmentOf('1200000')).toBe('self_serve');
		expect(segmentOf('1499999')).toBe('self_serve');
		expect(segmentOf('1500000')).toBe('mid_market');
		expect(segmentOf('7499999')).toBe('mid_market');
		expect(segmentOf('7500000')).toBe('enterprise');
	});

	it("classifies Quillmesh's price bands and the fixture's contracts sensibly", () => {
		const usd = (dollars: number) => String(dollars * 100);
		// Quillmesh: mid-market $18k to $40k a year, enterprise $90k to $190k.
		for (const d of [18_000, 18_240, 26_400, 39_876, 40_000]) expect(segmentOf(usd(d))).toBe('mid_market');
		for (const d of [90_000, 94_476, 176_796, 190_000]) expect(segmentOf(usd(d))).toBe('enterprise');
		// The fixture: usage plans under $1.5k a year are self-serve, $74.4k annual plans mid-market, $96k enterprise.
		expect(segmentOf(usd(1_440))).toBe('self_serve');
		expect(segmentOf(usd(74_400))).toBe('mid_market');
		expect(segmentOf(usd(96_000))).toBe('enterprise');
	});
});

describe('bucketForDays', () => {
	it('puts not-yet-due and up to 30 days late in the first bucket', () => {
		expect([0, 30, 31, 60, 61, 90, 91].map(bucketForDays)).toEqual(['0-30', '0-30', '31-60', '31-60', '61-90', '61-90', '90+']);
	});
});

describe('customerRows', () => {
	const rows = customerRows(customers, invoices, contracts, asOf);
	const by = Object.fromEntries(rows.map((r) => [r.customer.id, r]));

	it('totals what each customer owes, late amounts and the oldest late invoice', () => {
		expect(by.c1).toMatchObject({ openMinor: '15000', overdueMinor: '5000', daysOverdue: 20, segment: 'enterprise', openInvoices: 2 });
		expect(by.c2).toMatchObject({ openMinor: '60000', overdueMinor: '60000', daysOverdue: 152, segment: 'self_serve' });
		expect(by.c3).toMatchObject({ openMinor: '0', daysOverdue: 0, segment: 'no_contract' });
	});

	it('ages each open invoice into its bucket', () => {
		expect(by.c2.buckets).toEqual({ '0-30': '0', '31-60': '0', '61-90': '20000', '90+': '40000' });
	});

	it('reserves the Allowance at the Risk Tier rate, nothing without a tier', () => {
		expect(by.c1.allowanceMinor).toBe('150'); // 1% of 15000
		expect(by.c2.allowanceMinor).toBe('45000'); // 75% of 60000
		expect(by.c3.allowanceMinor).toBe('0');
	});

	it('summarizes AR across customers, with bucket shares adding to 100%', () => {
		const s = arSummary(rows);
		expect(s.openMinor).toBe('75000');
		expect(s.overdueMinor).toBe('65000');
		expect(s.buckets).toEqual({ '0-30': '15000', '31-60': '0', '61-90': '20000', '90+': '40000' });
		expect(Object.values(s.bucketShareBp).reduce((a, b) => a + b, 0)).toBe(10000);
		expect(s.byTier).toEqual({ A: 1, B: 0, C: 0, D: 1, BLOCK: 0, none: 1 });
		expect(s.overdueCustomers).toBe(2);
	});

	it('sorts by money exactly and breaks ties by name', () => {
		expect(sortRows(rows, 'open', 'desc').map((r) => r.customer.id)).toEqual(['c2', 'c1', 'c3']);
		expect(sortRows(rows, 'tier', 'asc').map((r) => r.customer.id)).toEqual(['c1', 'c2', 'c3']);
		expect(sortRows(rows, 'overdue', 'desc').map((r) => r.customer.id)).toEqual(['c2', 'c1', 'c3']);
	});

	it('filters by text, segment, tier and overdue', () => {
		expect(filterRows(rows, { q: 'gam' }).map((r) => r.customer.id)).toEqual(['c3']);
		expect(filterRows(rows, { q: 'owner of beta' }).map((r) => r.customer.id)).toEqual(['c2']);
		expect(filterRows(rows, { segment: 'enterprise' }).map((r) => r.customer.id)).toEqual(['c1']);
		expect(filterRows(rows, { tier: 'none' }).map((r) => r.customer.id)).toEqual(['c3']);
		expect(filterRows(rows, { overdueOnly: true }).map((r) => r.customer.id)).toEqual(['c1', 'c2']);
	});
});

describe('sharesBp', () => {
	it('adds to exactly 10000 by largest remainder', () => {
		expect(sharesBp([1n, 1n, 1n], ['a', 'b', 'c'])).toEqual({ a: 3334, b: 3333, c: 3333 });
		expect(sharesBp([0n, 0n], ['a', 'b'])).toEqual({ a: 0, b: 0 });
	});
});

describe('paginate', () => {
	it('clamps the page into range', () => {
		const xs = Array.from({ length: 55 }, (_, i) => i);
		expect(paginate(xs, 1, 25)).toMatchObject({ page: 1, pages: 3 });
		expect(paginate(xs, 9, 25).rows).toEqual([50, 51, 52, 53, 54]);
		expect(paginate([], 3, 25)).toEqual({ rows: [], page: 1, pages: 1 });
	});
});

describe('invoicedByMonth', () => {
	it('sums invoices per month, oldest first, keeping the last N months', () => {
		const xs = [inv('a', 'c', '', '100', 'open', '2026-01-03'), inv('b', 'c', '', '50', 'paid', '2026-01-20'), inv('c', 'c', '', '7', 'open', '2026-03-01')];
		expect(invoicedByMonth(xs)).toEqual([
			{ ym: '2026-01', amountMinor: '150' },
			{ ym: '2026-03', amountMinor: '7' }
		]);
		expect(invoicedByMonth(xs, 1)).toEqual([{ ym: '2026-03', amountMinor: '7' }]);
	});
});

describe('paymentsFor', () => {
	it('lists the bank lines matched to these targets, as positive amounts, newest first', () => {
		const tx: BankTransaction[] = [
			{ id: 't1', subsidiaryId: 's', bookedAt: '2026-09-01', ym: '2026-09', amountMinor: '5000', ccy: 'USD', description: '', counterparty: 'Acme', matched: true },
			{ id: 't2', subsidiaryId: 's', bookedAt: '2026-09-05', ym: '2026-09', amountMinor: '-300', ccy: 'USD', description: '', counterparty: 'GPU Co', matched: true }
		];
		const m: BankMatch[] = [
			{ id: 'm1', bankTransactionId: 't1', targetKind: 'invoice', targetId: 'i2', scoreBp: 10000, bucket: 'exact' },
			{ id: 'm2', bankTransactionId: 't2', targetKind: 'bill', targetId: 'b1', scoreBp: 9000, bucket: 'strong' }
		];
		expect(paymentsFor('invoice', new Set(['i2']), m, tx).map((p) => [p.matchId, p.amountMinor])).toEqual([['m1', '5000']]);
		expect(paymentsFor('bill', new Set(['b1']), m, tx).map((p) => [p.matchId, p.amountMinor])).toEqual([['m2', '300']]);
	});
});

describe('parseCheckSummary', () => {
	it('reads the demo seed shape', () => {
		const s = parseCheckSummary(JSON.stringify({ guarantor: 'Maya Ortiz', identity: 'pass', fraud: 'low', latePayments90d: 0, recommendationPlain: 'Standard terms.' }));
		expect(s.owner).toBe('Maya Ortiz');
		expect(s.headline).toBe('Standard terms.');
		expect(s.facts.map((f) => [f.label, f.value])).toEqual([
			['Identity', 'pass'],
			['Fraud risk', 'low'],
			['Late payments, 90 days', '0']
		]);
	});

	it('reads the live evidence row, flattening scalar facts and keeping reasons', () => {
		const s = parseCheckSummary(JSON.stringify({ product: 'fraud_finder', requestId: 'r1', summary: 'Owner verified.', status: 200, facts: { fraudScore: 12, reasons: ['address matches'], bureaus: { x: 1 } } }));
		expect(s.product).toBe('fraud_finder');
		expect(s.headline).toBe('Owner verified.');
		expect(s.reasons).toEqual(['address matches']);
		expect(s.facts).toEqual([{ key: 'fraudScore', label: 'Fraud score', value: '12' }]);
	});

	it('survives bad JSON', () => {
		expect(parseCheckSummary('not json')).toEqual({ reasons: [], facts: [] });
	});

	it('humanizes keys', () => {
		expect(humanKey('tu_identity_verification')).toBe('Tu identity verification');
	});
});
