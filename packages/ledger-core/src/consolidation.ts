import { LedgerError } from './errors.js';
import { ccyKey, fxRate, groupCode, type FxRate } from './fx.js';
import { absMinor, applyFx, FX_SCALE } from './money.js';
import { functionalAmounts, normalBalance } from './posting.js';
import type {
  Account, AccountType, FxRevaluationItem, FxRevaluationPayload, IcBasis, IcEliminationPair, IcEliminationPayload,
  JournalEntryInput, JournalLine, JournalLineInput, Ym,
} from './types.js';
import { ymAdd, ymCompare, ymEquals, ymLabel, ymToString } from './ym.js';

/** A subsidiary as consolidation sees it. The elimination subsidiary holds only eliminations and never trades. */
export interface Entity {
  id: bigint;
  code: string;
  name: string;
  functionalCcy: string;
  /** Unset (or null, as a database option may arrive) for the root company. */
  parentId?: bigint | null;
  isElimination: boolean;
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normal-signed amount (positive = the type's normal side) from a debit-positive one. */
function normal(type: AccountType, debitPositive: bigint): bigint {
  return normalBalance(type) === 'debit' ? debitPositive : -debitPositive;
}

function lineNet(l: JournalLineInput): bigint {
  const f = functionalAmounts(l);
  return f.debitMinor - f.creditMinor;
}

function accountOf(accountsById: ReadonlyMap<bigint, Account>, l: JournalLine): Account {
  const acct = accountsById.get(l.accountId);
  if (!acct) throw new LedgerError('unknown_account', `Journal line ${l.id} uses account ${l.accountId}, which does not exist.`);
  return acct;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const CCY_WORDS: Readonly<Record<string, string>> = { USD: 'dollar', GBP: 'pound', EUR: 'euro' };

// ---------- foreign balances and revaluation ----------

/** A balance-sheet account of one subsidiary that holds lines in a currency other than the subsidiary's own. */
export interface ForeignBalance {
  accountId: bigint;
  code: string;
  ccy: string;
  /** Debit-positive sum of the account's lines in `ccy`, in `ccy` minor units. */
  txnBalanceMinor: bigint;
  /** Debit-positive functional sum of all the account's lines (foreign lines plus functional adjustments). */
  bookedFunctionalMinor: bigint;
}

interface Position {
  booked: bigint;
  foreign: Map<string, bigint>;
}

function position(acct: Account, lines: readonly JournalLine[], functional: string): { booked: bigint; ccy?: string; txn: bigint } {
  const p: Position = { booked: 0n, foreign: new Map() };
  for (const l of lines) {
    p.booked += lineNet(l);
    const c = ccyKey(l.ccy);
    if (c !== functional) p.foreign.set(c, (p.foreign.get(c) ?? 0n) + l.debitMinor - l.creditMinor);
  }
  if (p.foreign.size > 1) {
    throw new LedgerError(
      'invalid_input',
      `Account "${acct.name}" holds balances in more than one foreign currency (${[...p.foreign.keys()].sort(cmpStr).join(', ')}); split it into one account per currency before revaluing.`,
    );
  }
  const first = [...p.foreign.entries()][0];
  return first ? { booked: p.booked, ccy: first[0], txn: first[1] } : { booked: p.booked, txn: 0n };
}

function linesByAccount(
  lines: readonly JournalLine[],
  accountsById: ReadonlyMap<bigint, Account>,
  keep: (acct: Account, l: JournalLine) => boolean,
): Map<bigint, { acct: Account; lines: JournalLine[] }> {
  const out = new Map<bigint, { acct: Account; lines: JournalLine[] }>();
  for (const l of lines) {
    const acct = accountOf(accountsById, l);
    if (!keep(acct, l)) continue;
    let row = out.get(acct.id);
    if (!row) {
      row = { acct, lines: [] };
      out.set(acct.id, row);
    }
    row.lines.push(l);
  }
  return out;
}

/**
 * Asset and liability accounts of `entity` holding lines in one foreign currency, through `throughYm` inclusive.
 * Income and expense lines are never revalued. An account with lines in two foreign currencies throws.
 * Accounts whose foreign and functional balances are both zero are omitted. Sorted by code, then id.
 */
export function foreignBalances(
  lines: readonly JournalLine[],
  accountsById: ReadonlyMap<bigint, Account>,
  opts: { entity: Entity; throughYm: Ym },
): ForeignBalance[] {
  const functional = ccyKey(opts.entity.functionalCcy);
  const groups = linesByAccount(
    lines,
    accountsById,
    (a, l) => a.subsidiaryId === opts.entity.id && (a.type === 'asset' || a.type === 'liability') && ymCompare(l.ym, opts.throughYm) <= 0,
  );
  const out: ForeignBalance[] = [];
  for (const { acct, lines: ls } of groups.values()) {
    const p = position(acct, ls, functional);
    if (p.ccy === undefined) continue;
    if (p.txn === 0n && p.booked === 0n) continue;
    out.push({ accountId: acct.id, code: acct.code, ccy: p.ccy, txnBalanceMinor: p.txn, bookedFunctionalMinor: p.booked });
  }
  return out.sort((a, b) => cmpStr(a.code, b.code) || cmpBig(a.accountId, b.accountId));
}

export interface RevaluationItem extends FxRevaluationItem {
  code: string;
}

export interface Revaluation {
  entity: Entity;
  ym: Ym;
  items: RevaluationItem[];
  /** Dr/Cr each restated account by its delta in functional currency, offset on the FX gain or loss account; null when nothing moves. */
  entry: JournalEntryInput | null;
  /** Sum of deltas: positive is a gain (credit to FX gain or loss), negative a loss. */
  gainMinor: bigint;
}

/**
 * Restate every foreign-currency balance of `entity` at the closing rate of `ym`: target = txnBalance at the closing
 * rate (rounded half away from zero), delta = target - booked. Lines are in functional currency at rate 1.
 * Running it again after the entry posts gives zero deltas and a null entry.
 */
export function revaluation(opts: {
  entity: Entity;
  lines: readonly JournalLine[];
  accountsById: ReadonlyMap<bigint, Account>;
  rates: readonly FxRate[];
  ym: Ym;
  periodId: bigint;
  fxGainLossAccountId: bigint;
}): Revaluation {
  const { entity, ym } = opts;
  const functional = ccyKey(entity.functionalCcy);
  const fxAcct = opts.accountsById.get(opts.fxGainLossAccountId);
  if (!fxAcct) throw new LedgerError('unknown_account', `The FX gain or loss account ${opts.fxGainLossAccountId} does not exist.`);
  if (fxAcct.subsidiaryId !== entity.id) {
    throw new LedgerError('wrong_subsidiary', `The FX gain or loss account "${fxAcct.name}" belongs to a different subsidiary than ${entity.name}.`);
  }
  const items: RevaluationItem[] = foreignBalances(opts.lines, opts.accountsById, { entity, throughYm: ym }).map((fb) => {
    const closingRateE6 = fxRate(opts.rates, fb.ccy, functional, ym, 'closing');
    const targetFunctionalMinor = applyFx(fb.txnBalanceMinor, closingRateE6);
    return {
      accountId: fb.accountId,
      code: fb.code,
      ccy: fb.ccy,
      txnBalanceMinor: fb.txnBalanceMinor,
      closingRateE6,
      bookedFunctionalMinor: fb.bookedFunctionalMinor,
      targetFunctionalMinor,
      deltaMinor: targetFunctionalMinor - fb.bookedFunctionalMinor,
    };
  });
  const line = (accountId: bigint, debitPositive: bigint): JournalLineInput => ({
    accountId,
    debitMinor: debitPositive > 0n ? debitPositive : 0n,
    creditMinor: debitPositive < 0n ? -debitPositive : 0n,
    ccy: functional,
    fxRateE6: FX_SCALE,
  });
  const lines = items.filter((i) => i.deltaMinor !== 0n).map((i) => line(i.accountId, i.deltaMinor));
  const gainMinor = items.reduce((s, i) => s + i.deltaMinor, 0n);
  if (gainMinor !== 0n) lines.push(line(fxAcct.id, -gainMinor));
  const ccys = [...new Set(items.map((i) => i.ccy))].sort(cmpStr).map((c) => CCY_WORDS[c] ?? c);
  const entry: JournalEntryInput | null = lines.length === 0
    ? null
    : {
        subsidiaryId: entity.id,
        periodId: opts.periodId,
        memo: `Revalue ${entity.name} ${joinNames(ccys)} balances at the ${ymLabel(ym)} closing rate`,
        lines,
      };
  return { entity, ym: { ...ym }, items, entry, gainMinor };
}

/** The fx_revaluation proposal payload for a revaluation, or null when nothing moves. */
export function fxRevaluationPayload(rev: Revaluation): FxRevaluationPayload | null {
  if (!rev.entry) return null;
  return {
    kind: 'fx_revaluation',
    ...rev.entry,
    periodYm: { ...rev.ym },
    rateYm: { ...rev.ym },
    items: rev.items.map((i) => ({
      accountId: i.accountId,
      ccy: i.ccy,
      txnBalanceMinor: i.txnBalanceMinor,
      closingRateE6: i.closingRateE6,
      bookedFunctionalMinor: i.bookedFunctionalMinor,
      targetFunctionalMinor: i.targetFunctionalMinor,
      deltaMinor: i.deltaMinor,
    })),
  };
}

// ---------- intercompany eliminations ----------

/** Which group codes mirror each other across companies. The source side must keep its books in the reporting currency. */
export interface IcPairDef {
  label: string;
  basis: IcBasis;
  sourceGroupCode: string;
  counterGroupCode: string;
}

export const IC_PAIRS: readonly IcPairDef[] = [
  { label: 'Intercompany balance', basis: 'balance', sourceGroupCode: '1900', counterGroupCode: '2900' },
  { label: 'Loan', basis: 'balance', sourceGroupCode: '1950', counterGroupCode: '2950' },
  { label: 'Service fees', basis: 'activity', sourceGroupCode: '4900', counterGroupCode: '5900' },
];

export interface EliminationPair extends IcEliminationPair {
  basis: IcBasis;
  sourceCode: string;
  counterCode: string;
}

export interface Elimination {
  basis: IcBasis;
  ym: Ym;
  pairs: EliminationPair[];
  /** Posted to the elimination subsidiary in the reporting currency; null when there is nothing to remove. */
  entry: JournalEntryInput | null;
  /** Balance basis only: the month the entry reverses in (the next month). */
  reversesInYm?: Ym;
}

function eliminationEntity(entities: readonly Entity[], reporting: string): Entity {
  const elims = entities.filter((e) => e.isElimination);
  if (elims.length !== 1) {
    throw new LedgerError(
      'invalid_input',
      elims.length === 0 ? 'There is no elimination subsidiary to post eliminations to.' : 'There is more than one elimination subsidiary; keep exactly one.',
    );
  }
  const elim = elims[0]!;
  if (ccyKey(elim.functionalCcy) !== reporting) {
    throw new LedgerError('invalid_input', `The elimination subsidiary keeps its books in ${ccyKey(elim.functionalCcy)}, not the reporting currency ${reporting}.`);
  }
  return elim;
}

/**
 * Intercompany eliminations for `ym`. For every pair definition and every source company holding the source group
 * code, the counterparty is the one other trading company holding the counter group code (two throws as ambiguous).
 * Balance basis: amount = |source balance through ym|; the counter side is its balance after revaluation at the
 * closing rate, translated at the closing rate. Activity basis: amount = |source activity in ym|; the counter side is
 * its activity in ym translated at the month's average rate. Each pair posts two lines on the elimination company's
 * accounts for the same group codes, at the source amount, so the entry always balances; the difference is reported.
 * Not idempotent: it reads only the trading companies' books, never what the elimination company already holds, so
 * after the entries post it returns the same entries again. Whether a month is already eliminated is the caller's
 * check (the module refuses a second elimination of the same month and basis as "already eliminated").
 */
export function eliminations(opts: {
  entities: readonly Entity[];
  accounts: readonly Account[];
  lines: readonly JournalLine[];
  rates: readonly FxRate[];
  reportingCcy: string;
  ym: Ym;
  periodId: bigint;
  pairs?: readonly IcPairDef[];
}): { balance: Elimination; activity: Elimination } {
  const reporting = ccyKey(opts.reportingCcy);
  const elim = eliminationEntity(opts.entities, reporting);
  const accountsById = new Map(opts.accounts.map((a) => [a.id, a]));
  const trading = opts.entities.filter((e) => !e.isElimination).slice().sort((a, b) => cmpBig(a.id, b.id));
  const accountIn = (entity: Entity, gc: string): Account | undefined =>
    opts.accounts
      .filter((a) => a.subsidiaryId === entity.id && groupCode(a.code) === gc)
      .sort((a, b) => cmpStr(a.code, b.code) || cmpBig(a.id, b.id))[0];
  const linesOf = linesByAccount(opts.lines, accountsById, (_a, l) => ymCompare(l.ym, opts.ym) <= 0);
  const acctLines = (a: Account, basis: IcBasis): JournalLine[] =>
    (linesOf.get(a.id)?.lines ?? []).filter((l) => basis === 'balance' || ymEquals(l.ym, opts.ym));

  const result: Record<IcBasis, { pairs: EliminationPair[]; lines: JournalLineInput[]; names: string[]; labels: string[] }> = {
    balance: { pairs: [], lines: [], names: [], labels: [] },
    activity: { pairs: [], lines: [], names: [], labels: [] },
  };
  for (const def of opts.pairs ?? IC_PAIRS) {
    const elimSource = accountIn(elim, def.sourceGroupCode);
    const elimCounter = accountIn(elim, def.counterGroupCode);
    for (const src of trading) {
      const sa = accountIn(src, def.sourceGroupCode);
      if (!sa) continue;
      const counters = trading.filter((e) => e.id !== src.id && accountIn(e, def.counterGroupCode) !== undefined);
      if (counters.length === 0) continue;
      if (counters.length > 1) {
        throw new LedgerError('invalid_input', `${def.label}: ${src.name} could mirror more than one company (${joinNames(counters.map((c) => c.name))}); pair them explicitly.`);
      }
      const cnt = counters[0]!;
      const ca = accountIn(cnt, def.counterGroupCode)!;
      if (ccyKey(src.functionalCcy) !== reporting) {
        throw new LedgerError('invalid_input', `${def.label}: ${src.name} keeps its books in ${ccyKey(src.functionalCcy)}; the source side of an elimination must be in the reporting currency ${reporting}.`);
      }
      const sourceMinor = acctLines(sa, def.basis).reduce((s, l) => s + lineNet(l), 0n);
      const cntFunctional = ccyKey(cnt.functionalCcy);
      let counterFunctional: bigint;
      if (def.basis === 'balance') {
        const p = position(ca, acctLines(ca, 'balance'), cntFunctional);
        counterFunctional = p.ccy === undefined ? p.booked : applyFx(p.txn, fxRate(opts.rates, p.ccy, cntFunctional, opts.ym, 'closing'));
      } else {
        counterFunctional = acctLines(ca, 'activity').reduce((s, l) => s + lineNet(l), 0n);
      }
      const counterReporting = applyFx(counterFunctional, fxRate(opts.rates, cntFunctional, reporting, opts.ym, def.basis === 'balance' ? 'closing' : 'average'));
      if (sourceMinor === 0n && counterReporting === 0n) continue;
      const amountMinor = absMinor(sourceMinor);
      const counterTranslatedMinor = sourceMinor > 0n ? -counterReporting : sourceMinor < 0n ? counterReporting : absMinor(counterReporting);
      const bucket = result[def.basis];
      bucket.pairs.push({
        label: def.label,
        basis: def.basis,
        sourceSubsidiaryId: src.id,
        sourceAccountId: sa.id,
        sourceCode: sa.code,
        counterSubsidiaryId: cnt.id,
        counterAccountId: ca.id,
        counterCode: ca.code,
        amountMinor,
        counterTranslatedMinor,
        differenceMinor: amountMinor - counterTranslatedMinor,
      });
      for (const n of [src.name, cnt.name]) if (!bucket.names.includes(n)) bucket.names.push(n);
      if (!bucket.labels.includes(def.label)) bucket.labels.push(def.label);
      if (amountMinor === 0n) continue;
      if (!elimSource || !elimCounter) {
        throw new LedgerError('unknown_account', `The elimination subsidiary has no account for group code ${elimSource ? def.counterGroupCode : def.sourceGroupCode}.`);
      }
      // The source carries a debit balance (asset, expense) or a credit balance (liability, revenue); undo it on the
      // elimination company's matching account and undo the mirror on the counter group code.
      const dr = sourceMinor < 0n ? elimSource : elimCounter;
      const cr = sourceMinor < 0n ? elimCounter : elimSource;
      bucket.lines.push(
        { accountId: dr.id, debitMinor: amountMinor, creditMinor: 0n, ccy: reporting, fxRateE6: FX_SCALE },
        { accountId: cr.id, debitMinor: 0n, creditMinor: amountMinor, ccy: reporting, fxRateE6: FX_SCALE },
      );
    }
  }
  const month = ymLabel(opts.ym);
  const build = (basis: IcBasis): Elimination => {
    const b = result[basis];
    const memo = basis === 'balance'
      ? `Remove balances ${joinNames(b.names)} owe each other at the end of ${month}`
      : `Remove ${month} ${joinNames(b.labels.map((l) => l.toLowerCase()))} between ${joinNames(b.names)}`;
    const out: Elimination = {
      basis,
      ym: { ...opts.ym },
      pairs: b.pairs,
      entry: b.lines.length === 0 ? null : { subsidiaryId: elim.id, periodId: opts.periodId, memo, lines: b.lines },
    };
    if (basis === 'balance') out.reversesInYm = ymAdd(opts.ym, 1);
    return out;
  };
  return { balance: build('balance'), activity: build('activity') };
}

/** The ic_elimination proposal payload for an elimination, or null when there is nothing to remove. */
export function icEliminationPayload(elim: Elimination): IcEliminationPayload | null {
  if (!elim.entry) return null;
  const p: IcEliminationPayload = {
    kind: 'ic_elimination',
    ...elim.entry,
    periodYm: { ...elim.ym },
    basis: elim.basis,
    pairs: elim.pairs.map((x) => ({
      label: x.label,
      sourceSubsidiaryId: x.sourceSubsidiaryId,
      sourceAccountId: x.sourceAccountId,
      counterSubsidiaryId: x.counterSubsidiaryId,
      counterAccountId: x.counterAccountId,
      amountMinor: x.amountMinor,
      counterTranslatedMinor: x.counterTranslatedMinor,
      differenceMinor: x.differenceMinor,
    })),
  };
  if (elim.reversesInYm) p.reversesInYm = { ...elim.reversesInYm };
  return p;
}

// ---------- translation ----------

export type TranslationMethod = 'closing' | 'average' | 'historical';

/** One account in reporting currency. Amounts are normal-signed (positive = the type's normal side). */
export interface TranslatedRow {
  accountId: bigint;
  code: string;
  groupCode: string;
  name: string;
  type: AccountType;
  functionalMinor: bigint;
  reportingMinor: bigint;
  method: TranslationMethod;
  lineIds: bigint[];
}

export interface TranslatedBooks {
  entity: Entity;
  asOfYm: Ym;
  reportingCcy: string;
  /** Assets and liabilities through asOfYm at its closing rate; posted equity at each posting month's average rate;
   *  income and expense for the fiscal year to date at each month's average rate. Sorted by code, then id. */
  rows: TranslatedRow[];
  /** Income and expense of the asOfYm month alone, at its average rate. */
  monthRows: TranslatedRow[];
  netIncomeMonthMinor: bigint;
  netIncomeYtdMinor: bigint;
  /** All income less expense through asOfYm (prior years and this year), each month at its average rate. */
  retainedEarningsMinor: bigint;
  /** Currency translation adjustment: the computed plug that balances the translated balance sheet. Never posted. */
  ctaMinor: bigint;
  totals: { assetsMinor: bigint; liabilitiesMinor: bigint; equityMinor: bigint };
  /**
   * The functional books balance (assets = liabilities + posted equity + retained earnings, all in the company's own
   * currency) and, for a company already in the reporting currency, the CTA is zero. The translated totals always
   * agree because the CTA is their plug, so they prove nothing on their own.
   */
  balanced: boolean;
}

function fyStartOf(asOfYm: Ym, fiscalYearStartMonth = 1): Ym {
  return { year: asOfYm.month >= fiscalYearStartMonth ? asOfYm.year : asOfYm.year - 1, month: fiscalYearStartMonth };
}

/**
 * Current-rate translation of one subsidiary's books into the reporting currency. Each account-month is converted
 * once (rounded half away from zero) and the results are summed, so month, year-to-date and retained earnings agree.
 * A subsidiary already in the reporting currency translates 1:1 with a zero CTA.
 */
export function translateBooks(opts: {
  entity: Entity;
  accounts: readonly Account[];
  lines: readonly JournalLine[];
  rates: readonly FxRate[];
  reportingCcy: string;
  asOfYm: Ym;
  fiscalYearStartMonth?: number;
}): TranslatedBooks {
  const { entity, asOfYm } = opts;
  const reporting = ccyKey(opts.reportingCcy);
  const functional = ccyKey(entity.functionalCcy);
  const fyStart = fyStartOf(asOfYm, opts.fiscalYearStartMonth);
  const accountsById = new Map(opts.accounts.map((a) => [a.id, a]));
  const groups = linesByAccount(opts.lines, accountsById, (a, l) => a.subsidiaryId === entity.id && ymCompare(l.ym, asOfYm) <= 0);
  // Looked up only when a balance-sheet account has lines, so a company with no books yet needs no rate.
  let closingRate: bigint | undefined;
  const closing = () => (closingRate ??= fxRate(opts.rates, functional, reporting, asOfYm, 'closing'));
  const avgCache = new Map<string, bigint>();
  const average = (ym: Ym): bigint => {
    const k = ymToString(ym);
    let r = avgCache.get(k);
    if (r === undefined) {
      r = fxRate(opts.rates, functional, reporting, ym, 'average');
      avgCache.set(k, r);
    }
    return r;
  };
  /** Debit-positive functional activity per month, each translated at that month's average rate. */
  const byMonth = (ls: readonly JournalLine[]) => {
    const m = new Map<string, { ym: Ym; functional: bigint; ids: bigint[] }>();
    for (const l of ls) {
      const k = ymToString(l.ym);
      let row = m.get(k);
      if (!row) {
        row = { ym: l.ym, functional: 0n, ids: [] };
        m.set(k, row);
      }
      row.functional += lineNet(l);
      row.ids.push(l.id);
    }
    return [...m.values()].map((r) => ({ ...r, reporting: applyFx(r.functional, average(r.ym)) }));
  };

  const rows: TranslatedRow[] = [];
  const monthRows: TranslatedRow[] = [];
  let retained = 0n;
  let retainedFunctional = 0n;
  for (const { acct, lines: ls } of groups.values()) {
    const base = { accountId: acct.id, code: acct.code, groupCode: groupCode(acct.code), name: acct.name, type: acct.type };
    const sortIds = (ids: bigint[]) => ids.slice().sort(cmpBig);
    if (acct.type === 'asset' || acct.type === 'liability') {
      const f = ls.reduce((s, l) => s + lineNet(l), 0n);
      rows.push({ ...base, functionalMinor: normal(acct.type, f), reportingMinor: normal(acct.type, applyFx(f, closing())), method: 'closing', lineIds: sortIds(ls.map((l) => l.id)) });
      continue;
    }
    const months = byMonth(ls);
    if (acct.type === 'equity') {
      const f = months.reduce((s, m) => s + m.functional, 0n);
      const r = months.reduce((s, m) => s + m.reporting, 0n);
      rows.push({ ...base, functionalMinor: normal(acct.type, f), reportingMinor: normal(acct.type, r), method: 'historical', lineIds: sortIds(ls.map((l) => l.id)) });
      continue;
    }
    // Income and expense: credit-positive net income contribution feeds retained earnings.
    retained -= months.reduce((s, m) => s + m.reporting, 0n);
    retainedFunctional -= months.reduce((s, m) => s + m.functional, 0n);
    const ytd = months.filter((m) => ymCompare(m.ym, fyStart) >= 0);
    if (ytd.length > 0) {
      rows.push({
        ...base,
        functionalMinor: normal(acct.type, ytd.reduce((s, m) => s + m.functional, 0n)),
        reportingMinor: normal(acct.type, ytd.reduce((s, m) => s + m.reporting, 0n)),
        method: 'average',
        lineIds: sortIds(ytd.flatMap((m) => m.ids)),
      });
    }
    const cur = months.find((m) => ymEquals(m.ym, asOfYm));
    if (cur) {
      monthRows.push({ ...base, functionalMinor: normal(acct.type, cur.functional), reportingMinor: normal(acct.type, cur.reporting), method: 'average', lineIds: sortIds(cur.ids) });
    }
  }
  const byCode = (a: TranslatedRow, b: TranslatedRow) => cmpStr(a.code, b.code) || cmpBig(a.accountId, b.accountId);
  rows.sort(byCode);
  monthRows.sort(byCode);
  const sum = (rs: readonly TranslatedRow[], t: AccountType) => rs.filter((r) => r.type === t).reduce((s, r) => s + r.reportingMinor, 0n);
  const sumF = (t: AccountType) => rows.filter((r) => r.type === t).reduce((s, r) => s + r.functionalMinor, 0n);
  const functionalBalanced = sumF('asset') === sumF('liability') + sumF('equity') + retainedFunctional;
  const netIncome = (rs: readonly TranslatedRow[]) => sum(rs, 'revenue') - sum(rs, 'expense');
  const assetsMinor = sum(rows, 'asset');
  const liabilitiesMinor = sum(rows, 'liability');
  const postedEquity = sum(rows, 'equity');
  const ctaMinor = assetsMinor - liabilitiesMinor - postedEquity - retained;
  const equityMinor = postedEquity + retained + ctaMinor;
  return {
    entity,
    asOfYm: { ...asOfYm },
    reportingCcy: reporting,
    rows,
    monthRows,
    netIncomeMonthMinor: netIncome(monthRows),
    netIncomeYtdMinor: netIncome(rows),
    retainedEarningsMinor: retained,
    ctaMinor,
    totals: { assetsMinor, liabilitiesMinor, equityMinor },
    balanced: functionalBalanced && (functional !== reporting || ctaMinor === 0n),
  };
}

// ---------- consolidation ----------

/** One group code across the group. byEntity holds trading companies only; the elimination company's amount is eliminationsMinor. */
export interface ConsolidatedRow {
  groupCode: string;
  name: string;
  type: AccountType;
  byEntity: Map<bigint, bigint>;
  eliminationsMinor: bigint;
  consolidatedMinor: bigint;
  lineIds: bigint[];
}

export interface Consolidation {
  asOfYm: Ym;
  reportingCcy: string;
  /** Root companies first, then the other trading companies by id, then the elimination company. */
  entities: Entity[];
  books: TranslatedBooks[];
  incomeStatement: {
    month: ConsolidatedRow[];
    ytd: ConsolidatedRow[];
    netIncomeMonthMinor: bigint;
    netIncomeYtdMinor: bigint;
    /** Every company, including the elimination company. */
    netIncomeMonthByEntity: Map<bigint, bigint>;
    netIncomeYtdByEntity: Map<bigint, bigint>;
  };
  balanceSheet: {
    rows: ConsolidatedRow[];
    retainedEarningsMinor: bigint;
    ctaMinor: bigint;
    retainedEarningsByEntity: Map<bigint, bigint>;
    ctaByEntity: Map<bigint, bigint>;
    totals: { assetsMinor: bigint; liabilitiesMinor: bigint; equityMinor: bigint };
    /** Every company's books balance (see TranslatedBooks.balanced) and so do the consolidated totals. */
    balanced: boolean;
  };
  /** Absolute consolidated amounts left on intercompany group codes (balance sheet and the fiscal year-to-date income
   *  statement, which includes the month); zero once all is eliminated. */
  unmatchedIcMinor: bigint;
}

function orderEntities(entities: readonly Entity[]): Entity[] {
  const rank = (e: Entity) => (e.isElimination ? 2 : e.parentId === undefined || e.parentId === null ? 0 : 1);
  return entities.slice().sort((a, b) => rank(a) - rank(b) || cmpBig(a.id, b.id));
}

function combine(entities: readonly Entity[], pick: (b: TranslatedBooks) => readonly TranslatedRow[], books: readonly TranslatedBooks[]): ConsolidatedRow[] {
  const rows = new Map<string, ConsolidatedRow>();
  books.forEach((b, i) => {
    const e = entities[i]!;
    for (const r of pick(b)) {
      let row = rows.get(r.groupCode);
      if (!row) {
        row = { groupCode: r.groupCode, name: r.name, type: r.type, byEntity: new Map(), eliminationsMinor: 0n, consolidatedMinor: 0n, lineIds: [] };
        rows.set(r.groupCode, row);
      }
      if (e.isElimination) row.eliminationsMinor += r.reportingMinor;
      else row.byEntity.set(e.id, (row.byEntity.get(e.id) ?? 0n) + r.reportingMinor);
      row.consolidatedMinor += r.reportingMinor;
      row.lineIds.push(...r.lineIds);
    }
  });
  const out = [...rows.values()];
  for (const r of out) r.lineIds.sort(cmpBig);
  return out.sort((a, b) => cmpStr(a.groupCode, b.groupCode));
}

/**
 * Consolidated income statement (month and fiscal year to date) and balance sheet in the reporting currency: every
 * company translated with translateBooks, summed by group code, eliminations shown in their own column. Retained
 * earnings and CTA are the sums of each company's; `balanced` holds only when every company's own books balance.
 */
export function consolidate(opts: {
  entities: readonly Entity[];
  accounts: readonly Account[];
  lines: readonly JournalLine[];
  rates: readonly FxRate[];
  reportingCcy: string;
  asOfYm: Ym;
  fiscalYearStartMonth?: number;
}): Consolidation {
  const entities = orderEntities(opts.entities);
  const known = new Set(opts.accounts.map((a) => a.id));
  for (const l of opts.lines) {
    if (!known.has(l.accountId)) throw new LedgerError('unknown_account', `Journal line ${l.id} uses account ${l.accountId}, which does not exist.`);
  }
  const books = entities.map((entity) => translateBooks({ ...opts, entity }));
  const month = combine(entities, (b) => b.monthRows, books);
  const ytd = combine(entities, (b) => b.rows.filter((r) => r.type === 'revenue' || r.type === 'expense'), books);
  const bsRows = combine(entities, (b) => b.rows.filter((r) => r.type === 'asset' || r.type === 'liability' || r.type === 'equity'), books);
  const total = (rs: readonly ConsolidatedRow[], t: AccountType) => rs.filter((r) => r.type === t).reduce((s, r) => s + r.consolidatedMinor, 0n);
  const netIncome = (rs: readonly ConsolidatedRow[]) => total(rs, 'revenue') - total(rs, 'expense');
  const byEntity = (f: (b: TranslatedBooks) => bigint) => new Map(books.map((b) => [b.entity.id, f(b)]));
  const retainedEarningsMinor = books.reduce((s, b) => s + b.retainedEarningsMinor, 0n);
  const ctaMinor = books.reduce((s, b) => s + b.ctaMinor, 0n);
  const assetsMinor = total(bsRows, 'asset');
  const liabilitiesMinor = total(bsRows, 'liability');
  const equityMinor = total(bsRows, 'equity') + retainedEarningsMinor + ctaMinor;
  const icCodes = new Set(opts.accounts.filter((a) => a.isIntercompany).map((a) => groupCode(a.code)));
  const unmatchedIcMinor = [...bsRows, ...ytd].filter((r) => icCodes.has(r.groupCode)).reduce((s, r) => s + absMinor(r.consolidatedMinor), 0n);
  return {
    asOfYm: { ...opts.asOfYm },
    reportingCcy: ccyKey(opts.reportingCcy),
    entities,
    books,
    incomeStatement: {
      month,
      ytd,
      netIncomeMonthMinor: netIncome(month),
      netIncomeYtdMinor: netIncome(ytd),
      netIncomeMonthByEntity: byEntity((b) => b.netIncomeMonthMinor),
      netIncomeYtdByEntity: byEntity((b) => b.netIncomeYtdMinor),
    },
    balanceSheet: {
      rows: bsRows,
      retainedEarningsMinor,
      ctaMinor,
      retainedEarningsByEntity: byEntity((b) => b.retainedEarningsMinor),
      ctaByEntity: byEntity((b) => b.ctaMinor),
      totals: { assetsMinor, liabilitiesMinor, equityMinor },
      balanced: books.every((b) => b.balanced) && assetsMinor === liabilitiesMinor + equityMinor,
    },
    unmatchedIcMinor,
  };
}
