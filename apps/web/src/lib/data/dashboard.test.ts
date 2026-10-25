import { describe, expect, it } from 'vitest';
import { entryDate, monthRange, monthsIn, postings, previousRange, summarize } from './dashboard';
import type { Account, JournalEntry, JournalLine } from './types';

const acc = (code: string, type: Account['type']): Account => ({ id: `acc-${code}`, subsidiaryId: 'sub-us', code, name: code, type });
const accounts = [{ ...acc('4900', 'revenue'), isIntercompany: true }, acc('1000', 'asset'), acc('1100', 'asset'), acc('1150', 'asset'), acc('2000', 'liability'), acc('3000', 'equity'), acc('4000', 'revenue'), acc('5000', 'expense'), acc('6000', 'expense')];

let n = 0;
const entries: JournalEntry[] = [];
const lines: JournalLine[] = [];
function post(periodId: string, postedAt: string, ...ls: [string, number, number][]) {
	const id = `je-${++n}`;
	entries.push({ id, periodId, postedAt: `${postedAt}T09:00:00Z`, memo: id, source: 'seed', postedByRole: 'seed' });
	ls.forEach(([code, dr, cr], i) => lines.push({ id: `${id}-${i}`, jeId: id, accountId: `acc-${code}`, debitMinor: String(dr), creditMinor: String(cr) }));
}

post('2026-07', '2026-07-01', ['1000', 100000, 0], ['3000', 0, 100000]);
post('2026-08', '2026-08-10', ['1100', 20000, 0], ['4000', 0, 20000]);
post('2026-08', '2026-08-20', ['5000', 5000, 0], ['1000', 0, 5000]);
post('2026-08', '2026-08-25', ['6000', 10000, 0], ['2000', 0, 10000]);
// A close adjustment for August, posted in September.
post('2026-08', '2026-09-02', ['6000', 1000, 0], ['1150', 0, 1000]);
post('2026-09', '2026-09-15', ['1000', 20000, 0], ['1100', 0, 20000]);
post('2026-08', '2026-08-30', ['1100', 3000, 0], ['4900', 0, 3000]);

const ps = postings(accounts, entries, lines);

describe('entryDate', () => {
	it('keeps an entry inside its own month', () => {
		expect(entryDate({ periodId: '2026-08', postedAt: '2026-09-02T09:00:00Z' })).toBe('2026-08-31');
		expect(entryDate({ periodId: '2026-08', postedAt: '2026-07-30T09:00:00Z' })).toBe('2026-08-01');
		expect(entryDate({ periodId: '2026-08', postedAt: '2026-08-12T09:00:00Z' })).toBe('2026-08-12');
	});
});

describe('previousRange', () => {
	it('compares whole months with the months before', () => {
		expect(previousRange(monthRange('2026-09'))).toEqual({ from: '2026-08-01', to: '2026-08-31' });
		expect(previousRange({ from: '2026-08-01', to: '2026-09-30' })).toEqual({ from: '2026-06-01', to: '2026-07-31' });
		expect(previousRange(monthRange('2026-01'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
	});
	it('compares other ranges with the same number of days before', () => {
		expect(previousRange({ from: '2026-09-11', to: '2026-09-20' })).toEqual({ from: '2026-09-01', to: '2026-09-10' });
	});
});

describe('summarize', () => {
	const aug = summarize(ps, [], monthRange('2026-08'));
	it('counts the month’s revenue and expenses, close adjustments included', () => {
		expect(aug.revenue).toBe('20000');
		expect(aug.intercompany).toBe('3000');
		expect(aug.costOfRevenue).toBe('5000');
		expect(aug.expenses).toBe('16000');
		expect(aug.netIncome).toBe('4000');
		expect(aug.grossMarginBp).toBe(7500);
		expect(aug.netMarginBp).toBe(2000);
	});
	it('reads balances at the range end', () => {
		expect(aug.cash).toBe('95000');
		expect(aug.cashChange).toBe('-5000');
		expect(aug.receivables).toBe('23000');
		expect(aug.allowance).toBe('1000');
		expect(aug.payables).toBe('10000');
		expect(aug.dsoDays).toBe(36);
		expect(aug.runwayMonths).toBeCloseTo(19.35, 1);
		expect(aug.byExpense.map((e) => [e.account.code, e.minor])).toEqual([['6000', '11000'], ['5000', '5000']]);
	});
	it('counts a part of a month by day', () => {
		const s = summarize(ps, [], { from: '2026-08-15', to: '2026-09-30' });
		expect(s.revenue).toBe('0');
		expect(s.expenses).toBe('16000');
		expect(s.cashChange).toBe('15000');
		expect(s.runwayMonths).toBeNull();
		expect(s.dsoDays).toBeNull();
		expect(s.intercompany).toBe('3000');
	});
});

describe('monthsIn', () => {
	it('lists every month a range touches', () => {
		expect(monthsIn({ from: '2025-11-20', to: '2026-02-03' })).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
	});
});
