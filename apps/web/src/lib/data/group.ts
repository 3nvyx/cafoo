// The Board Pack for the group or for one company, computed by the ledger engine (@luyten/ledger-core): translation
// into the Reporting currency, the CTA, eliminations and the consolidated statements all come from its consolidate()
// and translateBooks(), the same code the agents and the module rely on. This file only turns the UI's rows (string
// ids, minor units as strings) into the engine's inputs and its results back into rows the page renders.
import {
	applyFx,
	ccyKey,
	FX_SCALE,
	consolidate,
	eliminations,
	fxRate,
	groupCode,
	LedgerError,
	translate,
	translateBooks,
	ymCompare,
	ymEquals,
	ymFromString,
	ymToString,
	type Account as CoreAccount,
	type ConsolidatedRow,
	type Entity,
	type FxRate as CoreRate,
	type JournalLine as CoreLine,
	type TranslatedBooks,
	type TranslatedRow
} from '@luyten/ledger-core';
import type { Account, AccountType, FxRate, JournalEntry, JournalLine, Minor, Subsidiary } from './types';

export interface GroupBooks {
	subsidiaries: Subsidiary[];
	accounts: Account[];
	entries: JournalEntry[];
	lines: JournalLine[];
	rates: FxRate[];
	reportingCcy: string;
}

/** 'group' is the consolidated view in the Reporting currency; otherwise a Subsidiary id, in that company's currency. */
export type PackScope = 'group' | string;

/** A column of figures: one company, the Eliminations, or the total of the view. */
export interface PackColumn {
	key: string;
	label: string;
	/** The company the column belongs to (unset for the consolidated total). */
	subsidiary?: Subsidiary;
	kind: 'company' | 'eliminations' | 'total';
}

/** One figure per column key, in minor units of the view's currency. */
export type Cells = Record<string, Minor>;

export interface PackRow {
	key: string;
	label: string;
	/** Group code (account rows only). */
	groupCode?: string;
	type?: AccountType;
	/** The account codes behind each column's figure, for drill-down (account rows only). */
	codes?: Record<string, string[]>;
	/** Computed figures with no journal lines of their own (the CTA). */
	computed?: boolean;
	/** Earnings rows: the months of income statement activity they sum ("yyyy-mm" bounds). */
	months?: { from?: string; to: string };
}

export interface PnlRow extends PackRow {
	month: Cells;
	ytd: Cells;
}

export interface BsRow extends PackRow {
	amount: Cells;
}

export interface RateUsed {
	subsidiary: Subsidiary;
	fromCcy: string;
	toCcy: string;
	kind: 'closing' | 'average';
	ym: string;
	rateE6: string;
	/** What the rate translated. */
	usedFor: string;
}

export interface BoardPack {
	scope: PackScope;
	/** Currency of every figure in the view. */
	ccy: string;
	periodYm: string;
	/** First month of the fiscal year (January), for year-to-date drill ranges. */
	ytdFrom: string;
	columns: PackColumn[];
	/** The column whose figure is the view's total ('total' in the consolidated view, the company otherwise). */
	totalKey: string;
	pnl: {
		revenue: PnlRow[];
		expenses: PnlRow[];
		totalRevenue: { month: Cells; ytd: Cells };
		totalExpenses: { month: Cells; ytd: Cells };
		netIncome: { month: Cells; ytd: Cells };
	};
	bs: {
		assets: BsRow[];
		liabilities: BsRow[];
		equity: BsRow[];
		totalAssets: Cells;
		totalLiabilities: Cells;
		totalEquity: Cells;
		/** Every company's own books balance and so do the totals (see ledger-core consolidate). */
		balanced: boolean;
		/** The currency translation adjustment of the view, never posted (zero for one company in its own currency). */
		ctaMinor: Minor;
	};
	/** Rates the translation used (empty for one company in its own currency). */
	rates: RateUsed[];
}

/** Engine inputs built from UI rows, with maps back from the engine's bigint ids to the UI's string ids. */
export interface CoreBooks {
	entities: Entity[];
	accounts: CoreAccount[];
	lines: CoreLine[];
	rates: CoreRate[];
	subsidiaryOf: Map<bigint, Subsidiary>;
	accountOf: Map<bigint, Account>;
}

const isTrading = (s: Subsidiary) => !s.isElimination;

/** The root company: the one with no parent (the first one when the data has none marked). */
export function rootOf(subsidiaries: Subsidiary[]): Subsidiary | undefined {
	return subsidiaries.find((s) => !s.parentId && !s.isElimination) ?? subsidiaries.find(isTrading) ?? subsidiaries[0];
}

/**
 * UI rows to the engine's inputs. Ids become small bigints in the order the rows arrive. A line with no currency is
 * in its account's company's Functional currency at 1:1; its month is its Journal Entry's Period.
 */
export function toCore(books: GroupBooks): CoreBooks {
	const subIds = new Map<string, bigint>();
	const subsidiaryOf = new Map<bigint, Subsidiary>();
	books.subsidiaries.forEach((s, i) => {
		subIds.set(s.id, BigInt(i + 1));
		subsidiaryOf.set(BigInt(i + 1), s);
	});
	const entities: Entity[] = books.subsidiaries.map((s) => ({
		id: subIds.get(s.id)!,
		code: s.code,
		name: s.name,
		functionalCcy: s.baseCurrency,
		parentId: s.parentId !== undefined ? (subIds.get(s.parentId) ?? null) : null,
		isElimination: s.isElimination
	}));
	const acctIds = new Map<string, bigint>();
	const accountOf = new Map<bigint, Account>();
	const accounts: CoreAccount[] = [];
	for (const a of books.accounts) {
		const sid = subIds.get(a.subsidiaryId);
		if (sid === undefined) continue;
		const id = BigInt(accounts.length + 1);
		acctIds.set(a.id, id);
		accountOf.set(id, a);
		accounts.push({ id, subsidiaryId: sid, code: a.code, name: a.name, type: a.type, isIntercompany: a.isIntercompany ?? false });
	}
	const functionalOf = new Map(books.accounts.map((a) => [a.id, books.subsidiaries.find((s) => s.id === a.subsidiaryId)?.baseCurrency ?? books.reportingCcy]));
	const entryYm = new Map(books.entries.map((e) => [e.id, e.periodId]));
	const jeIds = new Map(books.entries.map((e, i) => [e.id, BigInt(i + 1)]));
	const lines: CoreLine[] = [];
	for (const l of books.lines) {
		const accountId = acctIds.get(l.accountId);
		const ym = entryYm.get(l.jeId);
		if (accountId === undefined || ym === undefined) continue;
		lines.push({
			id: BigInt(lines.length + 1),
			jeId: jeIds.get(l.jeId)!,
			ym: ymFromString(ym),
			postedAt: 0n,
			source: '',
			accountId,
			debitMinor: BigInt(l.debitMinor),
			creditMinor: BigInt(l.creditMinor),
			ccy: l.ccy || functionalOf.get(l.accountId)!,
			fxRateE6: l.fxRateE6 ? BigInt(l.fxRateE6) : 1_000_000n
		});
	}
	const rates: CoreRate[] = books.rates
		.filter((r) => r.kind !== 'spot')
		.map((r) => ({ fromCcy: r.fromCcy, toCcy: r.toCcy, ym: ymFromString(r.ym), rateE6: BigInt(r.rateE6), kind: r.kind }));
	return { entities, accounts, lines, rates, subsidiaryOf, accountOf };
}

const str = (v: bigint | undefined) => (v ?? 0n).toString();

/** The account codes of `sub` with a group code. */
function codesIn(core: CoreBooks, subId: bigint, gc: string): string[] {
	return core.accounts.filter((a) => a.subsidiaryId === subId && groupCode(a.code) === gc).map((a) => a.code);
}

/**
 * The Board Pack for `periodYm`: consolidated (scope 'group') in the Reporting currency with a column per trading
 * company, an Eliminations column and the consolidated total; or one company (scope = its id) in its own currency.
 * Throws LedgerError (plain English) when a rate the translation needs is not recorded.
 */
export function boardPack(books: GroupBooks, scope: PackScope, periodYm: string): BoardPack {
	const core = toCore(books);
	const asOfYm = ymFromString(periodYm);
	const ytdFrom = `${periodYm.slice(0, 4)}-01`;
	if (scope === 'group') return groupPack(core, books, asOfYm, periodYm, ytdFrom);
	const sub = books.subsidiaries.find((s) => s.id === scope);
	if (!sub) throw new LedgerError('invalid_input', `There is no company ${scope}.`);
	const entity = core.entities[books.subsidiaries.indexOf(sub)]!;
	const b = translateBooks({ entity, accounts: core.accounts, lines: core.lines, rates: core.rates, reportingCcy: entity.functionalCcy, asOfYm });
	return companyPack(core, sub, entity, b, periodYm, ytdFrom);
}

function companyPack(core: CoreBooks, sub: Subsidiary, entity: Entity, b: TranslatedBooks, periodYm: string, ytdFrom: string): BoardPack {
	const key = sub.id;
	const one = (v: bigint): Cells => ({ [key]: v.toString() });
	const accountRow = (r: TranslatedRow) => ({ key: r.code, label: r.name, groupCode: r.groupCode, type: r.type, codes: { [key]: [r.code] } });
	const month = new Map(b.monthRows.map((r) => [r.accountId, r]));
	const ytd = new Map(b.rows.filter((r) => r.type === 'revenue' || r.type === 'expense').map((r) => [r.accountId, r]));
	const plRows = (t: AccountType): PnlRow[] =>
		[...new Set([...ytd.keys(), ...month.keys()])]
			.map((id) => (ytd.get(id) ?? month.get(id))!)
			.filter((r) => r.type === t)
			.sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0))
			.map((r) => ({ ...accountRow(r), month: one(month.get(r.accountId)?.reportingMinor ?? 0n), ytd: one(ytd.get(r.accountId)?.reportingMinor ?? 0n) }));
	const revenue = plRows('revenue');
	const expenses = plRows('expense');
	const sumOf = (rows: PnlRow[], k: 'month' | 'ytd') => rows.reduce((t, r) => t + BigInt(r[k][key]!), 0n);
	const bsRows = (t: AccountType): BsRow[] => b.rows.filter((r) => r.type === t && r.reportingMinor !== 0n).map((r) => ({ ...accountRow(r), amount: one(r.reportingMinor) }));
	const equity = bsRows('equity');
	const earlier = b.retainedEarningsMinor - b.netIncomeYtdMinor;
	const prevYearEnd = `${Number(periodYm.slice(0, 4)) - 1}-12`;
	if (earlier !== 0n) equity.push({ key: 'earlier', label: "Earlier years' earnings", amount: one(earlier), months: { to: prevYearEnd } });
	equity.push({ key: 'current', label: 'Current year earnings', amount: one(b.netIncomeYtdMinor), months: { from: ytdFrom, to: periodYm } });
	if (b.ctaMinor !== 0n) equity.push({ key: 'cta', label: 'Currency translation adjustment', amount: one(b.ctaMinor), computed: true });
	return {
		scope: sub.id,
		ccy: ccyKey(entity.functionalCcy),
		periodYm,
		ytdFrom,
		columns: [{ key, label: sub.name, subsidiary: sub, kind: sub.isElimination ? 'eliminations' : 'company' }],
		totalKey: key,
		pnl: {
			revenue,
			expenses,
			totalRevenue: { month: one(sumOf(revenue, 'month')), ytd: one(sumOf(revenue, 'ytd')) },
			totalExpenses: { month: one(sumOf(expenses, 'month')), ytd: one(sumOf(expenses, 'ytd')) },
			netIncome: { month: one(b.netIncomeMonthMinor), ytd: one(b.netIncomeYtdMinor) }
		},
		bs: {
			assets: bsRows('asset'),
			liabilities: bsRows('liability'),
			equity,
			totalAssets: one(b.totals.assetsMinor),
			totalLiabilities: one(b.totals.liabilitiesMinor),
			totalEquity: one(b.totals.equityMinor),
			balanced: b.balanced && b.totals.assetsMinor === b.totals.liabilitiesMinor + b.totals.equityMinor,
			ctaMinor: b.ctaMinor.toString()
		},
		rates: []
	};
}

function groupPack(core: CoreBooks, books: GroupBooks, asOfYm: { year: number; month: number }, periodYm: string, ytdFrom: string): BoardPack {
	const c = consolidate({ entities: core.entities, accounts: core.accounts, lines: core.lines, rates: core.rates, reportingCcy: books.reportingCcy, asOfYm });
	const trading = c.entities.filter((e) => !e.isElimination);
	const elim = c.entities.find((e) => e.isElimination);
	const subOf = (e: Entity) => core.subsidiaryOf.get(e.id)!;
	const columns: PackColumn[] = [
		...trading.map((e): PackColumn => ({ key: subOf(e).id, label: subOf(e).name, subsidiary: subOf(e), kind: 'company' })),
		...(elim ? [{ key: subOf(elim).id, label: 'Eliminations', subsidiary: subOf(elim), kind: 'eliminations' as const }] : []),
		{ key: 'total', label: 'Consolidated', kind: 'total' }
	];
	const cellsOf = (r: ConsolidatedRow | undefined): Cells => {
		const out: Cells = {};
		for (const e of trading) out[subOf(e).id] = str(r?.byEntity.get(e.id));
		if (elim) out[subOf(elim).id] = str(r?.eliminationsMinor);
		out.total = str(r?.consolidatedMinor);
		return out;
	};
	const byEntity = (m: Map<bigint, bigint>, total: bigint): Cells => {
		const out: Cells = {};
		for (const e of c.entities) out[subOf(e).id] = str(m.get(e.id));
		out.total = total.toString();
		return out;
	};
	const codesOf = (gc: string): Record<string, string[]> => {
		const out: Record<string, string[]> = {};
		for (const e of c.entities) out[subOf(e).id] = codesIn(core, e.id, gc);
		out.total = c.entities.flatMap((e) => codesIn(core, e.id, gc));
		return out;
	};
	const base = (r: ConsolidatedRow) => ({ key: r.groupCode, label: r.name, groupCode: r.groupCode, type: r.type, codes: codesOf(r.groupCode) });
	const month = new Map(c.incomeStatement.month.map((r) => [r.groupCode, r]));
	const ytd = new Map(c.incomeStatement.ytd.map((r) => [r.groupCode, r]));
	const plRows = (t: AccountType): PnlRow[] =>
		[...new Set([...ytd.keys(), ...month.keys()])]
			.sort()
			.map((gc) => (ytd.get(gc) ?? month.get(gc))!)
			.filter((r) => r.type === t)
			.map((r) => ({ ...base(r), month: cellsOf(month.get(r.groupCode)), ytd: cellsOf(ytd.get(r.groupCode)) }));
	const revenue = plRows('revenue');
	const expenses = plRows('expense');
	const sumCells = (rows: { cells: Cells }[]): Cells => {
		const out: Cells = {};
		for (const col of columns) out[col.key] = rows.reduce((t, r) => t + BigInt(r.cells[col.key] ?? '0'), 0n).toString();
		return out;
	};
	const total = (rows: PnlRow[], k: 'month' | 'ytd') => sumCells(rows.map((r) => ({ cells: r[k] })));
	const bsRows = (t: AccountType): BsRow[] =>
		c.balanceSheet.rows.filter((r) => r.type === t && (r.consolidatedMinor !== 0n || [...r.byEntity.values()].some((v) => v !== 0n) || r.eliminationsMinor !== 0n)).map((r) => ({ ...base(r), amount: cellsOf(r) }));
	const assets = bsRows('asset');
	const liabilities = bsRows('liability');
	const equity = bsRows('equity');
	const retained = c.balanceSheet.retainedEarningsByEntity;
	const ytdNi = c.incomeStatement.netIncomeYtdByEntity;
	const earlierBy = new Map([...retained].map(([id, v]) => [id, v - (ytdNi.get(id) ?? 0n)]));
	const earlier = c.balanceSheet.retainedEarningsMinor - c.incomeStatement.netIncomeYtdMinor;
	const prevYearEnd = `${Number(periodYm.slice(0, 4)) - 1}-12`;
	if ([...earlierBy.values()].some((v) => v !== 0n)) equity.push({ key: 'earlier', label: "Earlier years' earnings", amount: byEntity(earlierBy, earlier), months: { to: prevYearEnd } });
	equity.push({ key: 'current', label: 'Current year earnings', amount: byEntity(ytdNi, c.incomeStatement.netIncomeYtdMinor), months: { from: ytdFrom, to: periodYm } });
	equity.push({ key: 'cta', label: 'Currency translation adjustment', amount: byEntity(c.balanceSheet.ctaByEntity, c.balanceSheet.ctaMinor), computed: true });
	const bsTotal = (rows: BsRow[]) => sumCells(rows.map((r) => ({ cells: r.amount })));
	const niCells = (m: Map<bigint, bigint>, t: bigint) => byEntity(m, t);
	return {
		scope: 'group',
		ccy: ccyKey(books.reportingCcy),
		periodYm,
		ytdFrom,
		columns,
		totalKey: 'total',
		pnl: {
			revenue,
			expenses,
			totalRevenue: { month: total(revenue, 'month'), ytd: total(revenue, 'ytd') },
			totalExpenses: { month: total(expenses, 'month'), ytd: total(expenses, 'ytd') },
			netIncome: { month: niCells(c.incomeStatement.netIncomeMonthByEntity, c.incomeStatement.netIncomeMonthMinor), ytd: niCells(ytdNi, c.incomeStatement.netIncomeYtdMinor) }
		},
		bs: {
			assets,
			liabilities,
			equity,
			totalAssets: bsTotal(assets),
			totalLiabilities: bsTotal(liabilities),
			totalEquity: bsTotal(equity),
			balanced: c.balanceSheet.balanced,
			ctaMinor: c.balanceSheet.ctaMinor.toString()
		},
		rates: ratesUsed(core, c.books, books.reportingCcy, periodYm)
	};
}

/**
 * The rates a translation used, per company not already in the Reporting currency: the closing rate for its assets and
 * liabilities, and each month's average rate for the income, expense and equity it carries through the month.
 */
function ratesUsed(core: CoreBooks, translated: TranslatedBooks[], reportingCcy: string, periodYm: string): RateUsed[] {
	const out: RateUsed[] = [];
	const reporting = ccyKey(reportingCcy);
	for (const b of translated) {
		const functional = ccyKey(b.entity.functionalCcy);
		if (functional === reporting) continue;
		const sub = core.subsidiaryOf.get(b.entity.id)!;
		const asOf = ymFromString(periodYm);
		if (b.rows.some((r) => r.method === 'closing')) {
			out.push({ subsidiary: sub, fromCcy: functional, toCcy: reporting, kind: 'closing', ym: periodYm, rateE6: fxRate(core.rates, functional, reporting, asOf, 'closing').toString(), usedFor: 'assets and liabilities' });
		}
		const accts = new Set(core.accounts.filter((a) => a.subsidiaryId === b.entity.id && !(a.type === 'asset' || a.type === 'liability')).map((a) => a.id));
		const months = [...new Set(core.lines.filter((l) => accts.has(l.accountId)).map((l) => ymToString(l.ym)))].filter((m) => m <= periodYm).sort();
		for (const m of months) {
			out.push({ subsidiary: sub, fromCcy: functional, toCcy: reporting, kind: 'average', ym: m, rateE6: fxRate(core.rates, functional, reporting, ymFromString(m), 'average').toString(), usedFor: m === periodYm ? 'income and expense of the month' : 'income, expense and equity of the month' });
		}
	}
	return out;
}

/** An amount in `fromCcy` in the Reporting currency at the month's closing rate (receivables and ARR in the group view). */
export function atClosingRate(amountMinor: bigint, rates: FxRate[], fromCcy: string, toCcy: string, periodYm: string): bigint {
	const core = rates.filter((r) => r.kind !== 'spot').map((r) => ({ fromCcy: r.fromCcy, toCcy: r.toCcy, ym: ymFromString(r.ym), rateE6: BigInt(r.rateE6), kind: r.kind }));
	return translate(amountMinor, core, fromCcy, toCcy, ymFromString(periodYm), 'closing');
}

/** A rate scaled by 1e6 as a decimal ("1280000" is "1.280000"). */
export function rateText(rateE6: string): string {
	const v = BigInt(rateE6);
	return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`;
}

/** The functional amount of a UI journal line, debit-positive, in its company's currency (ledger-core's rounding). */
export function functionalNet(l: Pick<JournalLine, 'debitMinor' | 'creditMinor' | 'fxRateE6'>): bigint {
	const rate = l.fxRateE6 ? BigInt(l.fxRateE6) : FX_SCALE;
	return applyFx(BigInt(l.debitMinor), rate) - applyFx(BigInt(l.creditMinor), rate);
}

/**
 * Whether a month's Eliminations are on the books and still match them:
 * - 'none': the group companies have nothing to eliminate this month (or there is no group);
 * - 'pending': something should be eliminated and no Elimination has posted;
 * - 'stale': Eliminations posted, but the intercompany books have moved since, so they no longer match what the
 *   engine would eliminate now;
 * - 'current': the posted Eliminations match the books exactly;
 * - 'unknown': the engine cannot compute them (a missing rate, an ambiguous pair).
 * The comparison is per elimination-company account: balance accounts through the month (each month's balance
 * elimination reverses the next month, so only this month's remains), income and expense within the month.
 */
export type EliminationStatus = 'none' | 'pending' | 'stale' | 'current' | 'unknown';

export function eliminationStatus(books: GroupBooks, periodYm: string): EliminationStatus {
	if (!books.subsidiaries.some((s) => s.isElimination) || books.subsidiaries.filter(isTrading).length < 2) return 'none';
	const core = toCore(books);
	const ym = ymFromString(periodYm);
	let el: ReturnType<typeof eliminations>;
	try {
		el = eliminations({ entities: core.entities, accounts: core.accounts, lines: core.lines, rates: core.rates, reportingCcy: books.reportingCcy, ym, periodId: 0n });
	} catch {
		return 'unknown';
	}
	const elimIds = new Set(core.entities.filter((e) => e.isElimination).map((e) => e.id));
	const accountsById = new Map(core.accounts.map((a) => [a.id, a]));
	const add = (m: Map<bigint, bigint>, id: bigint, v: bigint) => m.set(id, (m.get(id) ?? 0n) + v);
	const expected = new Map<bigint, bigint>();
	for (const entry of [el.balance.entry, el.activity.entry]) for (const l of entry?.lines ?? []) add(expected, l.accountId, l.debitMinor - l.creditMinor);
	const posted = new Map<bigint, bigint>();
	for (const l of core.lines) {
		const a = accountsById.get(l.accountId);
		if (!a || !elimIds.has(a.subsidiaryId) || ymCompare(l.ym, ym) > 0) continue;
		const pnl = a.type === 'revenue' || a.type === 'expense';
		if (pnl && !ymEquals(l.ym, ym)) continue;
		add(posted, a.id, applyFx(l.debitMinor, l.fxRateE6) - applyFx(l.creditMinor, l.fxRateE6));
	}
	const nonZero = (m: Map<bigint, bigint>) => [...m].filter(([, v]) => v !== 0n);
	const want = nonZero(expected);
	const have = nonZero(posted);
	if (want.length === 0 && have.length === 0) return 'none';
	// A posted figure that differs from today's books is stale; one basis posted and the other still to come is pending.
	if (have.some(([id, v]) => (expected.get(id) ?? 0n) !== v)) return 'stale';
	return want.length > have.length ? 'pending' : 'current';
}
