// The Board Pack derivation over the real demo group: the seed's own generator (seed/src/group.ts) builds Cafoo Inc's
// intercompany side, Cafoo Ltd in pounds and the Elimination subsidiary, turned into the UI's rows the way both data
// sources deliver them (string ids, minor units as strings).
import { describe, expect, it } from 'vitest';
import { eliminations, revaluation, ymFromString } from '@luyten/ledger-core';
import { ACCOUNTS as US_ACCOUNTS } from '../../../../../seed/src/accounts';
import { buildGroup } from '../../../../../seed/src/group';
import { boardPack, eliminationStatus, functionalNet, rateText, toCore, type GroupBooks } from './group';
import type { Account, AccountType, JournalEntry, JournalLine, Subsidiary } from './types';

const SEP = { year: 2026, month: 9 };
const group = buildGroup(SEP);

const SUBS: Subsidiary[] = [
	{ id: 's-us', code: 'US', name: 'Cafoo Inc', baseCurrency: 'USD', isElimination: false },
	{ id: 's-uk', code: 'UK', name: 'Cafoo Ltd', baseCurrency: 'GBP', parentId: 's-us', isElimination: false },
	{ id: 's-elim', code: 'ELIM', name: 'Group eliminations', baseCurrency: 'USD', parentId: 's-us', isElimination: true }
];
const subByCode = (code: string) => SUBS.find((s) => s.code === code)!;

function seedBooks(): GroupBooks {
	const accounts: Account[] = [...US_ACCOUNTS.map((a) => ({ ...a, subsidiaryCode: 'US' })), ...group.accounts].map((a) => ({
		id: `a-${a.code}`,
		subsidiaryId: subByCode(a.subsidiaryCode).id,
		code: a.code,
		name: a.name,
		type: a.accountType as AccountType,
		isIntercompany: a.isIntercompany
	}));
	const entries: JournalEntry[] = [];
	const lines: JournalLine[] = [];
	group.journalEntries.forEach((je, i) => {
		const id = `je-${i + 1}`;
		entries.push({ id, periodId: je.periodYm, postedAt: `${je.periodYm}-15T00:00:00Z`, memo: je.memo, source: 'seed', postedByRole: 'seed' });
		je.lines.forEach((l, k) => lines.push({ id: `${id}-${k}`, jeId: id, accountId: `a-${l.accountCode}`, debitMinor: l.debitMinor, creditMinor: l.creditMinor, ccy: l.ccy, fxRateE6: l.fxRateE6 }));
	});
	const rates = group.fxRates.map((r, i) => ({ id: `fx-${i}`, ...r }));
	return { subsidiaries: SUBS, accounts, entries, lines, rates, reportingCcy: 'USD' };
}

/** The September close's three Consolidation entries, computed by the engine and posted as the module would. */
function afterClose(books: GroupBooks): GroupBooks {
	const core = toCore(books);
	const uk = core.entities.find((e) => e.code === 'UK')!;
	const fx = core.accounts.find((a) => a.code === '7100-UK')!;
	const rev = revaluation({ entity: uk, lines: core.lines, accountsById: new Map(core.accounts.map((a) => [a.id, a])), rates: core.rates, ym: SEP, periodId: 0n, fxGainLossAccountId: fx.id });
	const el = eliminations({ entities: core.entities, accounts: core.accounts, lines: core.lines, rates: core.rates, reportingCcy: 'USD', ym: ymFromString('2026-09'), periodId: 0n });
	const entries = [...books.entries];
	const lines = [...books.lines];
	for (const [n, entry] of [rev.entry!, el.balance.entry!, el.activity.entry!].entries()) {
		const id = `je-close-${n}`;
		entries.push({ id, periodId: '2026-09', postedAt: '2026-10-02T00:00:00Z', memo: entry.memo, source: 'agent', postedByRole: 'advisor' });
		entry.lines.forEach((l, k) =>
			lines.push({ id: `${id}-${k}`, jeId: id, accountId: core.accountOf.get(l.accountId)!.id, debitMinor: l.debitMinor.toString(), creditMinor: l.creditMinor.toString(), ccy: l.ccy, fxRateE6: l.fxRateE6.toString() })
		);
	}
	return { ...books, entries, lines };
}

describe('boardPack, consolidated', () => {
	const pack = boardPack(afterClose(seedBooks()), 'group', '2026-09');
	const cell = (rows: { key: string; amount: Record<string, string> }[], key: string, col = 'total') => rows.find((r) => r.key === key)?.amount[col];

	it('has a column per trading company, an Eliminations column and the consolidated total', () => {
		expect(pack.ccy).toBe('USD');
		expect(pack.columns.map((c) => [c.key, c.label, c.kind])).toEqual([
			['s-us', 'Cafoo Inc', 'company'],
			['s-uk', 'Cafoo Ltd', 'company'],
			['s-elim', 'Eliminations', 'eliminations'],
			['total', 'Consolidated', 'total']
		]);
	});

	it('balances, with a CTA of -$239.56 that no journal line carries', () => {
		expect(pack.bs.balanced).toBe(true);
		expect(pack.bs.ctaMinor).toBe('-23956');
		const cta = pack.bs.equity.find((r) => r.key === 'cta')!;
		expect(cta.computed).toBe(true);
		expect(cta.amount).toEqual({ 's-us': '0', 's-uk': '-23956', 's-elim': '0', total: '-23956' });
		expect(BigInt(pack.bs.totalAssets.total!)).toBe(BigInt(pack.bs.totalLiabilities.total!) + BigInt(pack.bs.totalEquity.total!));
	});

	it('removes what the companies owe each other: each company keeps its side, the Eliminations column takes it out', () => {
		expect(pack.bs.assets.find((r) => r.key === '1950')!.amount).toEqual({ 's-us': '20000000', 's-uk': '0', 's-elim': '-20000000', total: '0' });
		// Cafoo Ltd owes $200,000 in dollars: £156,250.00 after the revaluation, $200,000.00 at the 1.28 closing rate.
		expect(cell(pack.bs.liabilities, '2950', 's-uk')).toBe('20000000');
		expect(cell(pack.bs.liabilities, '2950')).toBe('0');
		expect(cell(pack.bs.assets, '1900')).toBe('0');
	});

	it('removes the month of intercompany service fees, leaving the one cent of translation rounding', () => {
		const fees = pack.pnl.revenue.find((r) => r.key === '4900')!;
		expect(fees.month).toEqual({ 's-us': '1500000', 's-uk': '0', 's-elim': '-1500000', total: '0' });
		const charged = pack.pnl.expenses.find((r) => r.key === '5900')!;
		expect(charged.month).toEqual({ 's-us': '0', 's-uk': '1500001', 's-elim': '-1500000', total: '1' });
	});

	it('drills each figure to its own company\'s account codes', () => {
		const loan = pack.bs.liabilities.find((r) => r.key === '2950')!;
		expect(loan.codes).toEqual({ 's-us': [], 's-uk': ['2950-UK'], 's-elim': ['2950-ELIM'], total: ['2950-UK', '2950-ELIM'] });
	});

	it('reports the rates it translated Cafoo Ltd at', () => {
		expect(pack.rates.map((r) => [r.kind, r.ym, rateText(r.rateE6)])).toEqual([
			['closing', '2026-09', '1.280000'],
			['average', '2026-07', '1.250000'],
			['average', '2026-08', '1.250000'],
			['average', '2026-09', '1.270000']
		]);
	});
});

describe('boardPack, one company in its own currency', () => {
	it('shows Cafoo Ltd in pounds, balanced, with no CTA', () => {
		const pack = boardPack(afterClose(seedBooks()), 's-uk', '2026-09');
		expect(pack.ccy).toBe('GBP');
		expect(pack.bs.balanced).toBe(true);
		expect(pack.bs.ctaMinor).toBe('0');
		expect(pack.bs.equity.some((r) => r.key === 'cta')).toBe(false);
		// The loan is booked in dollars; in Cafoo Ltd's books it is £156,250.00 once revalued.
		expect(pack.bs.liabilities.find((r) => r.key === '2950-UK')!.amount).toEqual({ 's-uk': '15625000' });
		expect(pack.pnl.expenses.find((r) => r.key === '7100-UK')!.month).toEqual({ 's-uk': '-440478' });
		expect(pack.rates).toEqual([]);
	});

	it('throws a plain sentence when a rate the translation needs is missing', () => {
		const books = afterClose(seedBooks());
		expect(() => boardPack({ ...books, rates: books.rates.filter((r) => !(r.ym === '2026-09' && r.kind === 'closing')) }, 'group', '2026-09')).toThrow(/no closing rate from GBP to USD for 2026-09/);
	});
});

describe('eliminationStatus', () => {
	/** One more Cafoo Inc entry in September: a $1,000 service fee charged to Cafoo Ltd after the close ran. */
	function lateFee(books: GroupBooks): GroupBooks {
		const id = 'je-late-fee';
		return {
			...books,
			entries: [...books.entries, { id, periodId: '2026-09', postedAt: '2026-10-03T00:00:00Z', memo: 'Late service fee', source: 'manual', postedByRole: 'cfo' }],
			lines: [
				...books.lines,
				{ id: `${id}-0`, jeId: id, accountId: 'a-1900', debitMinor: '100000', creditMinor: '0', ccy: 'USD', fxRateE6: '1000000' },
				{ id: `${id}-1`, jeId: id, accountId: 'a-4900', debitMinor: '0', creditMinor: '100000', ccy: 'USD', fxRateE6: '1000000' }
			]
		};
	}

	it('is pending while the month has intercompany balances and no Elimination has posted', () => {
		expect(eliminationStatus(seedBooks(), '2026-09')).toBe('pending');
	});

	it('is current once the balance and activity Eliminations post, before the lock', () => {
		expect(eliminationStatus(afterClose(seedBooks()), '2026-09')).toBe('current');
	});

	it('is pending when only one basis has posted', () => {
		const books = afterClose(seedBooks());
		const activityJe = 'je-close-2';
		expect(eliminationStatus({ ...books, entries: books.entries.filter((e) => e.id !== activityJe), lines: books.lines.filter((l) => l.jeId !== activityJe) }, '2026-09')).toBe('pending');
	});

	it('is stale when intercompany activity posts after the Eliminations', () => {
		expect(eliminationStatus(lateFee(afterClose(seedBooks())), '2026-09')).toBe('stale');
	});

	it('is none for a single company', () => {
		const books = seedBooks();
		expect(eliminationStatus({ ...books, subsidiaries: SUBS.filter((s) => s.code === 'US') }, '2026-09')).toBe('none');
	});

	it('is unknown when a rate the eliminations need is missing', () => {
		const books = afterClose(seedBooks());
		expect(eliminationStatus({ ...books, rates: books.rates.filter((r) => !(r.ym === '2026-09' && r.kind === 'closing')) }, '2026-09')).toBe('unknown');
	});
});

describe('functionalNet', () => {
	it('converts a line at its own rate, rounding half away from zero', () => {
		expect(functionalNet({ debitMinor: '1500000', creditMinor: '0', fxRateE6: '787402' })).toBe(1181103n);
		expect(functionalNet({ debitMinor: '0', creditMinor: '5', fxRateE6: '1500000' })).toBe(-8n);
		expect(functionalNet({ debitMinor: '250', creditMinor: '0' })).toBe(250n);
	});
});
