import { describe, expect, it } from 'vitest';
import { loadSeed, type Tables } from '../seed';
import { currentOpenPeriodId, entryProblem, monthEnded } from '../periods';
import { handlers, matchStatementLine, samePayer, spreadEvenly, STATEMENT, type OpenBooks } from './books';
import type { ArrayTable, MockContext, ProposeInput, RowOf } from './types';
import type { UploadedDocument } from '../../types';

/** A context over the seed that records Proposals instead of ruling on them. */
function fakeContext(): { ctx: MockContext; proposed: ProposeInput[] } {
	const t: Tables = loadSeed();
	const proposed: ProposeInput[] = [];
	let seq = 0;
	const ctx: MockContext = {
		t,
		now: () => '2026-10-02T11:00:00.000Z',
		id: (prefix) => `${prefix}-live-${++seq}`,
		insert: <K extends ArrayTable>(table: K, row: RowOf<K>) => {
			(t[table] as unknown as RowOf<K>[]).push(row);
			return row;
		},
		update: () => {},
		message: () => {},
		activity: () => {},
		propose: (p) => {
			const problem = entryProblem(p.payload.lines ?? [], t.account, t.subsidiary);
			if (problem) throw new Error(problem);
			proposed.push(p);
			return `pr-live-${++seq}`;
		},
		later: () => {},
		openPeriodId: () => currentOpenPeriodId(t.period, '2026-10-02T11:00:00Z'),
		synced: () => {}
	};
	return { ctx, proposed };
}

const doc = { id: 'doc-1' } as UploadedDocument;
const handler = (kind: string) => handlers.find((h) => h.kind === kind)!;
const balanced = (p: ProposeInput) => {
	const lines = p.payload.lines ?? [];
	return lines.reduce((s, l) => s + BigInt(l.debitMinor) - BigInt(l.creditMinor), 0n) === 0n;
};

describe('matchStatementLine', () => {
	const books = (): OpenBooks => ({
		invoices: [
			{ id: 'i1', number: 'INV-1', customerId: 'c1', amountMinor: '80000', status: 'open', dueAt: '2026-09-30T00:00:00Z' },
			{ id: 'i2', number: 'INV-2', customerId: 'c1', amountMinor: '80000', status: 'overdue', dueAt: '2026-08-30T00:00:00Z' },
			{ id: 'i3', number: 'INV-3', customerId: 'c1', amountMinor: '80000', status: 'paid', dueAt: '2026-07-30T00:00:00Z' }
		],
		bills: [{ id: 'b1', number: 'HC-2609', vendorId: 'v1', amountMinor: '360000', status: 'open', dueAt: '2026-10-03T00:00:00Z' }],
		customers: [{ id: 'c1', name: 'Cedar & Pine Dental' }],
		vendors: [{ id: 'v1', name: 'Helpdesk Collective' }],
		taken: new Set()
	});
	const line = (amountMinor: string, description: string, counterparty: string) => ({ bookedAt: '2026-10-01T00:00:00Z', amountMinor, description, counterparty });

	it('applies a deposit without a reference to the unpaid invoice due first', () => {
		expect(matchStatementLine(line('80000', 'DEPOSIT CEDAR PINE DENTAL', 'Cedar & Pine Dental'), books())).toMatchObject({ targetId: 'i2', bucket: 'strong', scoreBp: 9400 });
	});
	it('prefers the invoice named in the memo, scored exact', () => {
		expect(matchStatementLine(line('80000', 'DEPOSIT CEDAR PINE INV-1', 'Cedar & Pine Dental'), books())).toMatchObject({ targetId: 'i1', bucket: 'exact' });
	});
	it('skips taken documents, other amounts and other payers', () => {
		const b = books();
		b.taken.add('i2');
		expect(matchStatementLine(line('80000', 'DEPOSIT', 'Cedar & Pine Dental'), b)?.targetId).toBe('i1');
		expect(matchStatementLine(line('80001', 'DEPOSIT', 'Cedar & Pine Dental'), books())).toBeNull();
		expect(matchStatementLine(line('80000', 'DEPOSIT', 'Lantern Bakery'), books())).toBeNull();
	});
	it('matches money out to bills', () => {
		expect(matchStatementLine(line('-360000', 'ACH HELPDESK COLLECTIVE HC-2609', 'Helpdesk Collective'), books())).toMatchObject({ targetKind: 'bill', targetId: 'b1', bucket: 'exact' });
		expect(matchStatementLine(line('360000', 'ACH HELPDESK COLLECTIVE HC-2609', 'Helpdesk Collective'), books())).toBeNull();
	});
	it('treats punctuation and case as the same payer', () => {
		expect(samePayer('Cedar & Pine Dental', 'CEDAR PINE DENTAL')).toBe(true);
		expect(samePayer('', 'Bank')).toBe(false);
	});
});

describe('spreadEvenly', () => {
	it('puts leftover cents in the last month and rolls over the year', () => {
		expect(spreadEvenly('1000', 3, '2026-11')).toEqual([
			{ ym: '2026-11', amountMinor: '333' },
			{ ym: '2026-12', amountMinor: '333' },
			{ ym: '2027-01', amountMinor: '334' }
		]);
	});
});

describe('periods', () => {
	const periods = [
		{ id: '2026-08', status: 'closed' as const },
		{ id: '2026-09', status: 'open' as const },
		{ id: '2026-10', status: 'open' as const }
	];
	it('books new data into the month the clock is in while it is open', () => {
		expect(currentOpenPeriodId(periods, '2026-10-02T11:00:00Z')).toBe('2026-10');
		expect(currentOpenPeriodId(periods, '2026-12-02T11:00:00Z')).toBe('2026-09');
		expect(currentOpenPeriodId([{ id: '2026-08', status: 'closed' }], '2026-08-02T00:00:00Z')).toBeUndefined();
	});
	it('knows when a month has ended', () => {
		expect(monthEnded('2026-09', '2026-10-02T11:00:00Z')).toBe(true);
		expect(monthEnded('2026-10', '2026-10-02T11:00:00Z')).toBe(false);
	});
});

describe('Books uploads over the seed', () => {
	it('bank statement: five October lines, four matches proposed, the card charge left for a person', () => {
		const { ctx, proposed } = fakeContext();
		const h = handler('bank_statement');
		const reading = h.read(ctx);
		expect(reading.flagsPlain).toHaveLength(1);
		expect(reading.flagsPlain?.[0]).toContain('CARD 4471 HOTEL');
		const before = ctx.t.bank_transaction.length;
		const ids = h.apply(ctx, doc);
		expect(ctx.t.bank_transaction.length - before).toBe(STATEMENT.length);
		expect(ctx.t.bank_transaction.slice(-5).every((b) => b.ym === '2026-10' && !b.matched)).toBe(true);
		expect(ids).toHaveLength(4);
		expect(proposed.map((p) => [p.payload.invoiceId ?? p.payload.billId, p.amountMinor])).toEqual([
			['i28', '600000'],
			['i09', '80000'],
			['b06', '360000'],
			['i29', '2387400']
		]);
		expect(proposed.every((p) => p.kind === 'bank_match' && p.periodId === '2026-10' && balanced(p))).toBe(true);
		// A second upload of the same file imports nothing.
		expect(h.apply(ctx, doc)).toEqual([]);
		expect(h.read(ctx).flagsPlain ?? []).toEqual([]);
	});

	it('invoices: three usage invoices and one balanced revenue entry', () => {
		const { ctx, proposed } = fakeContext();
		const h = handler('invoices');
		h.read(ctx);
		expect(h.apply(ctx, doc)).toHaveLength(1);
		expect(ctx.t.invoice.filter((i) => ['i31', 'i32', 'i33'].includes(i.id))).toHaveLength(3);
		expect(proposed[0]).toMatchObject({ kind: 'journal_entry', proposerRole: 'revenue', amountMinor: '542750' });
		expect(balanced(proposed[0])).toBe(true);
		expect(h.apply(ctx, doc)).toEqual([]);
	});

	it('bills: an October bill and a quarter of rent spread as an accrual', () => {
		const { ctx, proposed } = fakeContext();
		expect(handler('bills').apply(ctx, doc)).toHaveLength(2);
		expect(proposed.map((p) => p.kind)).toEqual(['journal_entry', 'accrual']);
		expect(proposed.every(balanced)).toBe(true);
		expect(proposed[1].payload.lines?.find((l) => l.account === '6200')?.debitMinor).toBe('650000');
	});

	it('contracts: a new customer, contract and invoice, scheduled over 12 months by the Revenue agent', () => {
		const { ctx, proposed } = fakeContext();
		const h = handler('contracts');
		expect(h.read(ctx).flagsPlain).toHaveLength(1);
		expect(h.apply(ctx, doc)).toHaveLength(1);
		expect(ctx.t.customer.some((c) => c.id === 'c21')).toBe(true);
		expect(ctx.t.contract.some((k) => k.id === 'k21')).toBe(true);
		expect(proposed[0]).toMatchObject({ kind: 'revenue_schedule', proposerRole: 'revenue', amountMinor: '1800000' });
		expect(balanced(proposed[0])).toBe(true);
		expect(h.apply(ctx, doc)).toEqual([]);
	});

	it('every account the Books Proposals post to exists', () => {
		const { ctx, proposed } = fakeContext();
		for (const kind of ['bank_statement', 'invoices', 'bills', 'contracts']) handler(kind).apply(ctx, doc);
		const codes = new Set(ctx.t.account.map((a) => a.code));
		expect(proposed.flatMap((p) => p.payload.lines ?? []).filter((l) => !codes.has(l.account))).toEqual([]);
	});
});

describe('entryProblem', () => {
	const accounts = [
		{ code: '1000', subsidiaryId: 'sub-us' },
		{ code: '1100', subsidiaryId: 'sub-us' },
		{ code: '1000-UK', subsidiaryId: 'sub-uk' }
	];
	const subs = [
		{ id: 'sub-us', name: 'Cafoo Inc' },
		{ id: 'sub-uk', name: 'Cafoo Ltd' }
	];
	const L = (account: string, debitMinor: string, creditMinor: string) => ({ account, debitMinor, creditMinor });
	it('accepts a balanced entry in one company, and no lines at all', () => {
		expect(entryProblem([L('1000', '500', '0'), L('1100', '0', '500')], accounts, subs)).toBeNull();
		expect(entryProblem([], accounts, subs)).toBeNull();
	});
	it('refuses unbalanced, unknown, mixed-company, negative and empty entries in plain words', () => {
		expect(entryProblem([L('1000', '500', '0'), L('1100', '0', '400')], accounts, subs)).toBe('The proposed entry does not balance: debits are $5.00 and credits are $4.00.');
		expect(entryProblem([L('1000', '500', '0'), L('9999', '0', '500')], accounts, subs)).toContain('account 9999, which is not in the chart');
		expect(entryProblem([L('1000', '500', '0'), L('1000-UK', '0', '500')], accounts, subs)).toContain('Cafoo Inc and Cafoo Ltd');
		expect(entryProblem([L('1000', '-500', '0'), L('1100', '-500', '0')], accounts, subs)).toContain('not a whole, positive');
		expect(entryProblem([L('1000', '0', '0'), L('1100', '0', '0')], accounts, subs)).toBe('The proposed entry has no amounts.');
	});
});

describe('Books uploads with every month locked', () => {
	it('refuses before any row lands', () => {
		const { ctx, proposed } = fakeContext();
		for (const p of ctx.t.period) p.status = 'closed';
		const before = { bank: ctx.t.bank_transaction.length, invoices: ctx.t.invoice.length, bills: ctx.t.bill.length };
		for (const kind of ['bank_statement', 'invoices', 'bills', 'contracts']) expect(() => handler(kind).apply(ctx, doc)).toThrow('Every month is locked; unlock one to post.');
		expect({ bank: ctx.t.bank_transaction.length, invoices: ctx.t.invoice.length, bills: ctx.t.bill.length }).toEqual(before);
		expect(proposed).toEqual([]);
	});
});
