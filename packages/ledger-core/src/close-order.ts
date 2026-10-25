/**
 * The order a month-end close runs in, shared by the ledger module, the agents and Demo mode so all three refuse the
 * same things in the same words. One pure file with no imports (the module imports it by path, as it does the Risk
 * Tier rules); statuses and kinds are accepted as the module writes them ('awaiting_cfo') or as the client bindings
 * do ('AwaitingCfo').
 *
 * - Months close in order: a month's close starts, and the month locks, only once every earlier month is locked.
 * - A group month locks only once consolidated: no foreign-currency balance off the month's closing rate and no
 *   intercompany balance or activity left standing, including after a correction or CFO decision posted since the
 *   consolidation (then the consolidation is stale and the lock says what to redo).
 */

export type CloseOrderPeriod = { ym: string; status: string | { tag: string } };

/** The Proposal kinds the Consolidation agent files. */
export const CONSOLIDATION_KINDS: readonly string[] = ['fx_revaluation', 'ic_elimination'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'AwaitingCfo' or { tag: 'awaiting_cfo' } → 'awaiting_cfo'. */
export function closeTag(v: string | { tag: string }): string {
  const s = typeof v === 'string' ? v : v.tag;
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** "2026-09" → "September 2026" (the input unchanged when it is not a month). */
export function closeMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : ym;
}

export const isConsolidationKind = (kind: string | { tag: string }) => CONSOLIDATION_KINDS.includes(closeTag(kind));

/** Months before `ym` that are not locked yet, earliest first. */
export function earlierUnlockedMonths(periods: readonly CloseOrderPeriod[], ym: string): string[] {
  return periods
    .filter(p => p.ym < ym && closeTag(p.status) !== 'closed')
    .map(p => p.ym)
    .sort();
}

function joinMonths(yms: readonly string[]): string {
  const labels = yms.map(closeMonthLabel);
  return labels.length <= 2 ? labels.join(' and ') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function refusedAction(ym: string, action: 'start' | 'request_lock' | 'lock'): string {
  const month = closeMonthLabel(ym);
  return action === 'start' ? `The ${month} close cannot start` : action === 'request_lock' ? `The Advisor cannot ask to lock ${month}` : `${month} cannot be locked`;
}

/**
 * Why `ym` cannot start its close ('start'), have its lock requested ('request_lock') or be locked ('lock') yet
 * because an earlier month is not locked; undefined when every earlier month is locked.
 */
export function closeOrderRefusal(periods: readonly CloseOrderPeriod[], ym: string, action: 'start' | 'request_lock' | 'lock'): string | undefined {
  const earlier = earlierUnlockedMonths(periods, ym);
  if (earlier.length === 0) return undefined;
  const what = refusedAction(ym, action);
  return `${what} while ${joinMonths(earlier)} ${earlier.length === 1 ? 'is' : 'are'} not locked: months close in order. Lock ${closeMonthLabel(earlier[0]!)} first.`;
}

/** A company as the consolidation check sees it. */
export type ConsolidationCompany = { isElimination: boolean };

/**
 * A foreign-currency asset or liability balance of a trading company at the end of the month, recomputed from the
 * posted ledger as the revaluation check does: `deltaMinor` is the balance at the month's closing rate less what is
 * booked, in the company's own currency. `problem` says why no delta could be computed.
 */
export type RevaluationDue = {
  company: string;
  accountCode: string;
  ccy: string;
  functionalCcy: string;
  deltaMinor?: bigint;
  problem?: 'no_closing_rate' | 'several_currencies';
  /** A revaluation of this company for the month already posted, so the balance moved after it. */
  revalued?: boolean;
};

/**
 * One intercompany pair kind (the source group code), recomputed as the elimination check does, in the reporting
 * currency and debit positive: `sourceMinor` is what the trading companies show (balance through the month, or
 * activity in it), `eliminatedMinor` what the elimination company carries against it. Eliminated when they cancel.
 */
export type EliminationDue = {
  label: string;
  basis: 'balance' | 'activity';
  sourceMinor: bigint;
  eliminatedMinor: bigint;
  reportingCcy: string;
  /** Balance basis: the month the elimination reverses in, when the books do not have it or it is locked. */
  reversal?: { ym: string; problem: 'missing' | 'locked' };
};

const CCY_SIGNS: Readonly<Record<string, string>> = { USD: '$', GBP: '£', EUR: '€' };

/** 1500000n, 'USD' → "$15,000.00"; a currency without a sign is written after the amount. */
function minorText(minor: bigint, ccy: string): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const units = `${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(a % 100n).toString().padStart(2, '0')}`;
  const sign = CCY_SIGNS[ccy];
  return `${neg ? '-' : ''}${sign ? `${sign}${units}` : `${units} ${ccy}`}`;
}

/** A group month: more than one trading company and an elimination company. Other months have nothing to consolidate. */
export function isGroup(companies: readonly ConsolidationCompany[]): boolean {
  return companies.filter(c => !c.isElimination).length > 1 && companies.some(c => c.isElimination);
}

/**
 * Why a group month cannot have its lock requested or be locked because its consolidation has not run, or no longer
 * matches the books: a foreign-currency balance off the closing rate, or an intercompany pair not (or no longer)
 * eliminated. Undefined for a month that is not a group month and for one whose consolidation stands.
 */
export function consolidationDueRefusal(
  companies: readonly ConsolidationCompany[],
  due: { revaluations: readonly RevaluationDue[]; eliminations: readonly EliminationDue[] },
  ym: string,
  action: 'request_lock' | 'lock',
): string | undefined {
  if (!isGroup(companies)) return undefined;
  const month = closeMonthLabel(ym);
  const reasons: string[] = [];
  for (const r of due.revaluations) {
    const where = `${r.company}'s ${r.ccy} balance on ${r.accountCode}`;
    if (r.problem === 'no_closing_rate') reasons.push(`${where} cannot be revalued because no ${r.ccy}/${r.functionalCcy} closing rate is recorded for ${month}, so record it and revalue`);
    else if (r.problem === 'several_currencies') reasons.push(`${r.company}'s ${r.accountCode} holds ${r.ccy} balances, so split it into one account per currency and revalue`);
    else if (r.deltaMinor !== undefined && r.deltaMinor !== 0n) {
      const off = minorText(r.deltaMinor < 0n ? -r.deltaMinor : r.deltaMinor, r.functionalCcy);
      reasons.push(r.revalued ? `${r.company} was revalued for ${month}, but its ${r.ccy} balance on ${r.accountCode} is ${off} off the closing rate, so something posted after it: revalue it again` : `${where} is ${off} off the closing rate, so revalue it`);
    }
  }
  for (const e of due.eliminations) {
    const left = e.sourceMinor + e.eliminatedMinor;
    if (left === 0n) continue;
    const what = `the ${e.label.toLowerCase()} pair ${e.basis === 'balance' ? 'through' : 'in'} ${month}`;
    const shows = minorText(e.sourceMinor < 0n ? -e.sourceMinor : e.sourceMinor, e.reportingCcy);
    // A balance elimination reverses the next month, so it can post only while that month is in the books and open.
    const first = e.reversal
      ? ` first ${e.reversal.problem === 'missing' ? 'add' : 'reopen'} ${closeMonthLabel(e.reversal.ym)}, where the elimination reverses (${e.reversal.problem === 'missing' ? 'the books do not have it yet' : 'it is locked'}), then`
      : '';
    reasons.push(
      e.eliminatedMinor === 0n
        ? `${what} (${shows}) is not eliminated, so${first} eliminate it`
        : `${what} now shows ${shows} but the elimination posted removed ${minorText(e.eliminatedMinor < 0n ? -e.eliminatedMinor : e.eliminatedMinor, e.reportingCcy)}, so something posted after it:${first} reverse that elimination and eliminate again`,
    );
  }
  if (reasons.length === 0) return undefined;
  return `${refusedAction(ym, action)} until its consolidation matches the books: ${reasons.join('; ')}. The Consolidation agent proposes these from the posted ledger.`;
}
