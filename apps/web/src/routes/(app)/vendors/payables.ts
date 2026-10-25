// Pure maths for the Vendors screens: spend and open bills per vendor, the summary tiles, the spend ranking, sorting and
// filtering. Money stays in integer minor units (bigint inside, strings out).
import { daysBetween } from '#lib/data/derive.js';
import { toBig } from '#lib/data/money.js';
import type { Bill, Minor, Vendor, VendorVerification } from '#lib/data/types.js';
import { groupBy } from '../customers/receivables';

export interface VendorRow {
	vendor: Vendor;
	/** Everything billed by `asOf`, paid or not. */
	billedMinor: Minor;
	paidMinor: Minor;
	paidCount: number;
	openMinor: Minor;
	openCount: number;
	overdueMinor: Minor;
	/** Days the oldest unpaid bill is past due; 0 when nothing is late. */
	daysOverdue: number;
	lastBilledAt?: string;
}

export function vendorRows(vendors: Vendor[], bills: Bill[], asOf: string): VendorRow[] {
	const by = groupBy(bills, (b) => b.vendorId);
	return vendors.map((v) => {
		let billed = 0n, paid = 0n, open = 0n, overdue = 0n;
		let paidCount = 0, openCount = 0, daysOverdue = 0;
		let lastBilledAt: string | undefined;
		for (const b of by.get(v.id) ?? []) {
			if (b.issuedAt.slice(0, 10) > asOf) continue;
			const amt = toBig(b.amountMinor);
			billed += amt;
			if (!lastBilledAt || b.issuedAt > lastBilledAt) lastBilledAt = b.issuedAt;
			if (b.status === 'paid') {
				paid += amt;
				paidCount++;
				continue;
			}
			open += amt;
			openCount++;
			const late = daysBetween(b.dueAt, asOf);
			if (late > 0) {
				overdue += amt;
				daysOverdue = Math.max(daysOverdue, late);
			}
		}
		return {
			vendor: v,
			billedMinor: billed.toString(),
			paidMinor: paid.toString(),
			paidCount,
			openMinor: open.toString(),
			openCount,
			overdueMinor: overdue.toString(),
			daysOverdue,
			lastBilledAt
		};
	});
}

export const VERIFICATIONS: VendorVerification[] = ['verified', 'unverified', 'blocked'];

export interface VendorSummary {
	billedMinor: Minor;
	paidMinor: Minor;
	openMinor: Minor;
	overdueMinor: Minor;
	openBills: number;
	paidBills: number;
	byVerification: Record<VendorVerification, number>;
	/** Open bills owed to blocked vendors: money that must not go out. */
	blockedOpenMinor: Minor;
}

export function vendorSummary(rows: VendorRow[]): VendorSummary {
	let billed = 0n, paid = 0n, open = 0n, overdue = 0n, blockedOpen = 0n, openBills = 0, paidBills = 0;
	const byVerification: Record<VendorVerification, number> = { verified: 0, unverified: 0, blocked: 0 };
	for (const r of rows) {
		billed += toBig(r.billedMinor);
		paid += toBig(r.paidMinor);
		open += toBig(r.openMinor);
		overdue += toBig(r.overdueMinor);
		openBills += r.openCount;
		paidBills += r.paidCount;
		byVerification[r.vendor.verification]++;
		if (r.vendor.verification === 'blocked') blockedOpen += toBig(r.openMinor);
	}
	return {
		billedMinor: billed.toString(),
		paidMinor: paid.toString(),
		openMinor: open.toString(),
		overdueMinor: overdue.toString(),
		openBills,
		paidBills,
		byVerification,
		blockedOpenMinor: blockedOpen.toString()
	};
}

export interface SpendBar {
	vendor: Vendor;
	billedMinor: Minor;
	/** Width relative to the biggest vendor, in basis points (the biggest is 10000). */
	widthBp: number;
}

/** The `n` vendors we were billed most by, biggest first, with bar widths relative to the biggest. */
export function topSpend(rows: VendorRow[], n = 10): SpendBar[] {
	const ranked = rows
		.filter((r) => toBig(r.billedMinor) > 0n)
		.sort((a, b) => {
			const x = toBig(a.billedMinor), y = toBig(b.billedMinor);
			return x > y ? -1 : x < y ? 1 : a.vendor.name.localeCompare(b.vendor.name);
		})
		.slice(0, n);
	const max = ranked.length ? toBig(ranked[0].billedMinor) : 0n;
	return ranked.map((r) => ({ vendor: r.vendor, billedMinor: r.billedMinor, widthBp: max > 0n ? Number((toBig(r.billedMinor) * 10000n) / max) : 0 }));
}

export type VendorSortKey = 'name' | 'spend' | 'open' | 'status';
const STATUS_RANK: Record<VendorVerification, number> = { blocked: 0, unverified: 1, verified: 2 };

export function sortVendorRows(rows: VendorRow[], key: VendorSortKey, dir: 'asc' | 'desc'): VendorRow[] {
	const sign = dir === 'asc' ? 1 : -1;
	const big = (a: Minor, b: Minor) => {
		const x = toBig(a), y = toBig(b);
		return x < y ? -1 : x > y ? 1 : 0;
	};
	const by: Record<VendorSortKey, (a: VendorRow, b: VendorRow) => number> = {
		name: (a, b) => a.vendor.name.localeCompare(b.vendor.name),
		spend: (a, b) => big(a.billedMinor, b.billedMinor),
		open: (a, b) => big(a.openMinor, b.openMinor),
		status: (a, b) => STATUS_RANK[a.vendor.verification] - STATUS_RANK[b.vendor.verification]
	};
	return [...rows].sort((a, b) => sign * by[key](a, b) || a.vendor.name.localeCompare(b.vendor.name));
}

export function filterVendorRows(rows: VendorRow[], f: { q?: string; status?: VendorVerification | 'all'; openOnly?: boolean }): VendorRow[] {
	const q = f.q?.trim().toLowerCase() ?? '';
	return rows.filter(
		(r) =>
			(!q || r.vendor.name.toLowerCase().includes(q) || r.vendor.category.toLowerCase().includes(q)) &&
			(!f.status || f.status === 'all' || r.vendor.verification === f.status) &&
			(!f.openOnly || r.openCount > 0)
	);
}
