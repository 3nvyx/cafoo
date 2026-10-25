import { describe, expect, it } from 'vitest';
import { cell, columnLabel, columnsOf, compareCells, stringify } from './cell';
import { tableLabel } from './data-sets';

describe('cell', () => {
	it('leaves empty values empty', () => {
		for (const v of [null, undefined, '']) expect(cell(v)).toMatchObject({ kind: 'empty', text: '' });
	});

	it('formats minor units as money in both modes, with the row currency', () => {
		expect(cell(1234567n, 'amountMinor', { ccy: 'GBP' })).toMatchObject({ kind: 'money', text: '12,345.67 GBP', full: '', sort: 1234567n });
		expect(cell('-8400', 'amountMinor')).toMatchObject({ kind: 'money', text: '-84.00', sort: -8400n });
	});

	it('groups other integers and keeps the full value', () => {
		expect(cell(1000000n, 'count')).toMatchObject({ kind: 'number', text: '1,000,000', full: '' });
		expect(cell(42, 'sortOrder')).toMatchObject({ kind: 'number', text: '42' });
	});

	it('shows keys and foreign keys as written, not as quantities', () => {
		expect(cell(1042n, 'id')).toMatchObject({ kind: 'id', text: '1042', sort: 1042n });
		expect(cell(7n, 'journalEntryId')).toMatchObject({ kind: 'id', text: '7' });
		expect(cell('acc-1000', 'account_id')).toMatchObject({ kind: 'id', text: 'acc-1000' });
		expect(cell(5n, 'paid')).toMatchObject({ kind: 'number' });
	});

	it('reads SpacetimeDB timestamps, ISO strings and identities', () => {
		const ts = { toISOString: () => '2026-09-30T12:00:00.000Z' };
		expect(cell(ts)).toMatchObject({ kind: 'date', full: '2026-09-30T12:00:00.000Z' });
		expect(cell('2026-10-02T11:00:00Z', 'at')).toMatchObject({ kind: 'date', full: '2026-10-02T11:00:00Z' });
		expect(cell('2026-09-01T00:00:00Z', 'bookedAt').text).toBe('Sep 1, 2026');
		expect(cell('2026-09-01T00:00:00.000Z', 'bookedAt').text).toBe('Sep 1, 2026');
		const id = { toHexString: () => 'c2009f3a5b1e77d0aa11' };
		expect(cell(id)).toMatchObject({ kind: 'id', text: 'c2009f3a…aa11', full: 'c2009f3a5b1e77d0aa11' });
	});

	it('shows tagged enums by their tag', () => {
		expect(cell({ tag: 'Open' })).toMatchObject({ kind: 'enum', text: 'Open' });
		expect(cell({ tag: 'AwaitingCfo' })).toMatchObject({ kind: 'enum', text: 'Awaiting CFO' });
		expect(cell({ tag: 'Blocked', value: 'missing W-9' })).toMatchObject({ kind: 'enum', text: 'Blocked · missing W-9' });
	});

	it('shows a unit variant, which SpacetimeDB sends with an empty value, by its tag alone', () => {
		expect(cell({ tag: 'Asset', value: {} })).toMatchObject({ kind: 'enum', text: 'Asset' });
		expect(cell({ tag: 'BankMatch', value: {} })).toMatchObject({ kind: 'enum', text: 'Bank match' });
		expect(cell({ tag: 'Blocked', value: null })).toMatchObject({ kind: 'enum', text: 'Blocked' });
	});

	it('shows the identity that acted as the role recorded beside it, keeping the hash in full', () => {
		const id = { toHexString: () => 'c2009f3a5b1e77d0aa11' };
		expect(cell(id, 'proposedBy', { proposedBy: id, proposerRole: 'consolidation' })).toMatchObject({ kind: 'text', text: 'Consolidation', full: 'c2009f3a5b1e77d0aa11' });
		expect(cell(id, 'postedBy', { postedByRole: 'advisor' })).toMatchObject({ text: 'Advisor' });
		expect(cell(id, 'cfoConfirmedBy', {})).toMatchObject({ text: 'CFO' });
		expect(cell(id, 'decidedBy', {})).toMatchObject({ kind: 'id', text: 'c2009f3a…aa11' });
	});

	it('pretty-prints JSON columns and nested values, bigint included', () => {
		expect(cell('{"a":1}', 'detailJson')).toMatchObject({ kind: 'json', full: '{\n  "a": 1\n}' });
		expect(cell('not json', 'detailJson')).toMatchObject({ kind: 'text' });
		expect(cell(['x', 2n])).toMatchObject({ kind: 'json', text: '["x","2"]' });
		expect(stringify({ n: 5n })).toBe('{"n":"5"}');
	});

	it('says Yes and No for booleans', () => {
		expect(cell(true).text).toBe('Yes');
		expect(cell(false).text).toBe('No');
	});
});

describe('columns and sorting', () => {
	it('collects every key in first-seen order', () => {
		expect(columnsOf([{ a: 1, b: 2 }, { b: 3, c: 4 }])).toEqual(['a', 'b', 'c']);
	});

	it('compares numbers numerically and text naturally', () => {
		expect(compareCells(cell(9n), cell(10n))).toBeLessThan(0);
		expect(compareCells(cell('item 9'), cell('item 10'))).toBeLessThan(0);
	});

	it('names columns and tables in sentence case', () => {
		expect(columnLabel('journalEntryId')).toBe('Journal entry ID');
		expect(columnLabel('jeId')).toBe('Journal entry ID');
		expect(columnLabel('ccy')).toBe('Currency');
		expect(columnLabel('amount_minor')).toBe('Amount');
		expect(columnLabel('debitMinor')).toBe('Debit');
		expect(columnLabel('minor')).toBe('Minor');
		expect(columnLabel('fxRateE6')).toBe('FX rate e6');
		expect(tableLabel('revenueScheduleLine')).toBe('Revenue schedule line');
		expect(tableLabel('fx_rate')).toBe('FX rate');
	});
});
