import { describe, expect, it } from 'vitest';
import type { Bill, Vendor } from '#lib/data/types.js';
import { filterVendorRows, sortVendorRows, topSpend, vendorRows, vendorSummary } from './payables';

const ven = (id: string, name: string, verification: Vendor['verification'], category = 'SaaS'): Vendor => ({ id, name, category, verification });
const bill = (id: string, vendorId: string, amountMinor: string, status: Bill['status'], dueAt = '2026-09-15', issuedAt = '2026-09-01'): Bill => ({
	id,
	number: id,
	vendorId,
	issuedAt,
	dueAt,
	amountMinor,
	status
});

const asOf = '2026-09-30';
const vendors = [ven('v1', 'GPU Cloud', 'verified', 'Cloud'), ven('v2', 'Shady Supplies', 'blocked'), ven('v3', 'New Tool', 'unverified')];
const bills = [
	bill('b1', 'v1', '50000', 'paid'),
	bill('b2', 'v1', '30000', 'open', '2026-10-15'), // not yet due
	bill('b3', 'v2', '9000', 'overdue', '2026-09-10'), // 20 days late
	bill('b4', 'v2', '1000', 'open', '2026-11-01', '2026-10-02') // billed after asOf: ignored
];
const rows = vendorRows(vendors, bills, asOf);
const by = Object.fromEntries(rows.map((r) => [r.vendor.id, r]));

describe('vendorRows', () => {
	it('splits what each vendor billed into paid and open, and ages the open part', () => {
		expect(by.v1).toMatchObject({ billedMinor: '80000', paidMinor: '50000', paidCount: 1, openMinor: '30000', openCount: 1, overdueMinor: '0', daysOverdue: 0 });
		expect(by.v2).toMatchObject({ billedMinor: '9000', openMinor: '9000', overdueMinor: '9000', daysOverdue: 20 });
		expect(by.v3).toMatchObject({ billedMinor: '0', openCount: 0, lastBilledAt: undefined });
	});
});

describe('vendorSummary', () => {
	it('totals spend and counts vendors by verification, flagging money owed to blocked vendors', () => {
		expect(vendorSummary(rows)).toEqual({
			billedMinor: '89000',
			paidMinor: '50000',
			openMinor: '39000',
			overdueMinor: '9000',
			openBills: 2,
			paidBills: 1,
			byVerification: { verified: 1, unverified: 1, blocked: 1 },
			blockedOpenMinor: '9000'
		});
	});
});

describe('topSpend', () => {
	it('ranks vendors by spend with widths relative to the biggest, skipping vendors with none', () => {
		expect(topSpend(rows).map((b) => [b.vendor.id, b.widthBp])).toEqual([
			['v1', 10000],
			['v2', 1125]
		]);
		expect(topSpend(rows, 1)).toHaveLength(1);
	});
});

describe('sortVendorRows and filterVendorRows', () => {
	it('sorts by spend, open amount, status and name', () => {
		expect(sortVendorRows(rows, 'spend', 'desc').map((r) => r.vendor.id)).toEqual(['v1', 'v2', 'v3']);
		expect(sortVendorRows(rows, 'status', 'asc').map((r) => r.vendor.id)).toEqual(['v2', 'v3', 'v1']);
		expect(sortVendorRows(rows, 'name', 'asc').map((r) => r.vendor.id)).toEqual(['v1', 'v3', 'v2']);
	});

	it('filters by name or category, status and open bills', () => {
		expect(filterVendorRows(rows, { q: 'cloud' }).map((r) => r.vendor.id)).toEqual(['v1']);
		expect(filterVendorRows(rows, { status: 'blocked' }).map((r) => r.vendor.id)).toEqual(['v2']);
		expect(filterVendorRows(rows, { openOnly: true }).map((r) => r.vendor.id)).toEqual(['v1', 'v2']);
	});
});
