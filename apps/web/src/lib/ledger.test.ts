import { describe, expect, it } from 'vitest';
import { loadSeed } from './data/mock/seed';
import type { Account, JournalEntry, JournalLine, Subsidiary } from './data/types';
import { parsePeriod } from './drill';
import { accountGroup, accountTree, beforePeriod, functionalSides, natural, runningBalances, trialBalance } from './ledger';

const us: Subsidiary = { id: 'sub-us', name: 'US', baseCurrency: 'USD', code: 'US', isElimination: false };
const uk: Subsidiary = { id: 'sub-uk', name: 'UK', baseCurrency: 'GBP', code: 'UK', parentId: 'sub-us', isElimination: false };
const acc = (code: string, type: Account['type'], sub = 'sub-us'): Account => ({ id: `acc-${code}`, subsidiaryId: sub, code, name: code, type });
const accounts = [acc('1000', 'asset'), acc('2000', 'liability'), acc('3000', 'equity'), acc('4000', 'revenue'), acc('5200', 'expense'), acc('6000', 'expense'), acc('1000-UK', 'asset', 'sub-uk'), acc('4000-UK', 'revenue', 'sub-uk')];

let n = 0;
const entries: JournalEntry[] = [];
const lines: JournalLine[] = [];
function post(periodId: string, day: string, ...ls: [string, number, number, string?][]) {
	const id = `je-${++n}`;
	entries.push({ id, periodId, postedAt: `${periodId}-${day}T09:00:00Z`, memo: id, source: 'seed', postedByRole: 'seed' });
	ls.forEach(([code, dr, cr, fx], i) => lines.push({ id: `${id}-${i}`, jeId: id, accountId: `acc-${code}`, debitMinor: String(dr), creditMinor: String(cr), fxRateE6: fx }));
}
post('2026-07', '01', ['1000', 100000, 0], ['3000', 0, 100000]);
post('2026-08', '10', ['1000', 20000, 0], ['4000', 0, 20000]);
post('2026-08', '20', ['5200', 5000, 0], ['1000', 0, 5000]);
post('2026-09', '05', ['6000', 7000, 0], ['2000', 0, 7000]);
// A UK sale invoiced in USD, booked in GBP at 0.8.
post('2026-09', '06', ['1000-UK', 1000, 0, '800000'], ['4000-UK', 0, 1000, '800000']);

const books = { subsidiaries: [us, uk], accounts, entries, lines };

describe('trialBalance', () => {
	it('splits opening, activity and closing for one month, and ties out', () => {
		const [usTb, ukTb] = trialBalance(books, parsePeriod('2026-08'));
		expect(usTb.subsidiary.id).toBe('sub-us');
		const cash = usTb.rows.find((r) => r.account.code === '1000')!;
		expect([cash.opening, cash.debits, cash.credits, cash.closing]).toEqual([100000n, 20000n, 5000n, 115000n]);
		expect(usTb.totals).toEqual({ opening: 0n, debits: 25000n, credits: 25000n, closingDebit: 120000n, closingCredit: 120000n });
		expect(usTb.ties).toBe(true);
		// September's entries are after the period: 2000 and 6000 have nothing yet and are left out.
		expect(usTb.rows.map((r) => r.account.code)).toEqual(['1000', '3000', '4000', '5200']);
		// The UK company has nothing until September.
		expect(ukTb).toBeUndefined();
	});
	it('converts lines in another currency at their recorded rate', () => {
		const tb = trialBalance(books, parsePeriod('2026-09'), { subsidiaryId: 'sub-uk' });
		expect(tb).toHaveLength(1);
		expect(tb[0].totals.debits).toBe(800n);
		expect(tb[0].totals.credits).toBe(800n);
		expect(tb[0].ties).toBe(true);
	});
	it('covers every month for "all" and a range from its start', () => {
		const all = trialBalance(books, parsePeriod('all'))[0];
		expect(all.totals.opening).toBe(0n);
		expect(all.rows.every((r) => r.opening === 0n)).toBe(true);
		const range = trialBalance(books, parsePeriod('2026-08..2026-09'))[0];
		expect(range.rows.find((r) => r.account.code === '6000')!.debits).toBe(7000n);
		expect(range.rows.find((r) => r.account.code === '3000')!.opening).toBe(-100000n);
	});
	it('ties out on the demo books for every month', () => {
		const t = loadSeed();
		const demo = { subsidiaries: t.subsidiary, accounts: t.account, entries: t.journal_entry, lines: t.journal_line };
		for (const p of t.period) for (const c of trialBalance(demo, parsePeriod(p.id))) expect(c.ties, `${c.subsidiary.code} ${p.id}`).toBe(true);
	});
});

describe('beforePeriod', () => {
	it('knows what feeds the opening balance', () => {
		expect(beforePeriod('2026-07', parsePeriod('2026-08'))).toBe(true);
		expect(beforePeriod('2026-08', parsePeriod('2026-08'))).toBe(false);
		expect(beforePeriod('2026-01', parsePeriod('..2026-08'))).toBe(false);
		expect(beforePeriod('2026-01', parsePeriod('all'))).toBe(false);
	});
});

describe('functionalSides', () => {
	it('keeps debit and credit apart', () => {
		expect(functionalSides({ debitMinor: '1000', creditMinor: '0', fxRateE6: '800000' })).toEqual({ debit: 800n, credit: 0n });
		expect(functionalSides({ debitMinor: '0', creditMinor: '250' })).toEqual({ debit: 0n, credit: 250n });
	});
});

describe('chart of accounts', () => {
	it('groups codes by their first digit, ignoring the company suffix', () => {
		expect(accountGroup('5200-UK')).toEqual({ code: '5000', label: 'Cost of revenue' });
		expect(accountGroup('6000')).toEqual({ code: '6000', label: 'Operating expenses' });
		expect(accountGroup('7300')).toEqual({ code: '7000', label: 'Other income and expense' });
	});
	it('orders types, groups and accounts', () => {
		const tree = accountTree(accounts.map((account) => ({ account })));
		expect(tree.map((t) => t.type)).toEqual(['asset', 'liability', 'equity', 'revenue', 'expense']);
		expect(tree[0].rows.map((r) => r.account.code)).toEqual(['1000', '1000-UK']);
		expect(tree[4].groups.map((g) => g.code)).toEqual(['5000', '6000']);
	});
	it('shows balances in their natural sign', () => {
		expect(natural('asset', 5n)).toBe(5n);
		expect(natural('revenue', -5n)).toBe(5n);
	});
});

describe('runningBalances', () => {
	it('accumulates in posting order from the opening balance', () => {
		const byJe = new Map<string, JournalLine[]>();
		for (const l of lines) byJe.set(l.jeId, [...(byJe.get(l.jeId) ?? []), l]);
		const run = runningBalances([...entries].reverse(), byJe, new Set(['acc-1000']), 0n);
		expect([...run]).toEqual([
			['je-1', 100000n],
			['je-2', 120000n],
			['je-3', 115000n]
		]);
	});
});
