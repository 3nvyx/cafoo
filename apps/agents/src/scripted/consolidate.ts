/**
 * The Consolidation step of the close. The numbers come from ledger-core (revaluation of foreign-currency balances at
 * the month's closing rate, intercompany eliminations by basis); this module turns them into Proposals in the
 * module's wire form, with a plain summary, a technical rationale and the amount in the reporting currency, and says
 * in the close thread which intercompany pairs the two companies' books disagree on. A single-company database has
 * nothing to consolidate, and the step says nothing.
 */
import {
  applyFx,
  consolidationWireJson,
  eliminations,
  formatMinor,
  fxRevaluationPayload,
  groupCode,
  icEliminationPayload,
  plainSummary,
  revaluation,
  translate,
  ymFromString,
  ymToString,
  type Elimination,
  type EliminationPair,
  type Entity,
  type PlainSubsidiary,
  type Revaluation,
} from '@luyten/ledger-core';
import { monthLabel } from '../advisor-chat';
import { groupSnapshot, type GroupSnapshot } from '../snapshot';
import { propose, say, type Cast, type RoleConn } from '../stdb';
import type { Refusal } from './rulings';

export type ConsolidationDraft = {
  kind: 'fx_revaluation' | 'ic_elimination';
  payload: Record<string, unknown>;
  rationale: string;
  summaryPlain: string;
  amountMinor: bigint;
  periodYm: string;
};

/** An intercompany pair whose two sides differ by more than the tolerance. */
export interface IcDifference {
  label: string;
  basis: 'balance' | 'activity';
  source: string;
  counter: string;
  amountMinor: bigint;
  counterTranslatedMinor: bigint;
  differenceMinor: bigint;
}

export interface ConsolidationPlan {
  /** False on a single-company database: nothing to consolidate. */
  group: boolean;
  trading: Entity[];
  revaluations: ConsolidationDraft[];
  eliminations: ConsolidationDraft[];
  differences: IcDifference[];
}

const abs = (n: bigint) => (n < 0n ? -n : n);
const money = (n: bigint, ccy = 'USD') => formatMinor(n, ccy);
const rate = (e6: bigint) => (Number(e6) / 1e6).toString();

/** Reporting-currency amount of an entry: its functional debits at the month's closing rate (as the module counts it). */
function reportingAmount(g: GroupSnapshot, entity: Entity, lines: readonly { debitMinor: bigint; fxRateE6: bigint }[], ym: string): bigint {
  const debits = lines.reduce((a, l) => a + applyFx(l.debitMinor, l.fxRateE6), 0n);
  return translate(debits, g.rates, entity.functionalCcy, g.reportingCcy, ymFromString(ym), 'closing');
}

function revaluationRationale(rev: Revaluation, ym: string): string {
  const functional = rev.entity.functionalCcy;
  const items = rev.items.map(i =>
    `${i.code}: ${money(i.txnBalanceMinor, i.ccy)} at the ${ym} closing rate ${rate(i.closingRateE6)} is ${money(i.targetFunctionalMinor, functional)}, booked at ${money(i.bookedFunctionalMinor, functional)}, so ${i.deltaMinor >= 0n ? 'up' : 'down'} ${money(abs(i.deltaMinor), functional)}`
  );
  return `${rev.entity.name} keeps its books in ${functional} but holds balances in another currency. Restate each at the recorded ${ym} closing rate (balance at the closing rate less what is booked): ${items.join('; ')}. Net ${rev.gainMinor >= 0n ? 'gain' : 'loss'} of ${money(abs(rev.gainMinor), functional)} to the company's currency gain or loss account; income and expense lines are never restated.`;
}

function eliminationRationale(elim: Elimination, names: Map<bigint, string>, reporting: string): string {
  const pairs = elim.pairs.map((p: EliminationPair) =>
    `${p.label}: ${names.get(p.sourceSubsidiaryId)}'s ${p.sourceCode} ${elim.basis === 'balance' ? `balance through ${ymToString(elim.ym)}` : `activity in ${ymToString(elim.ym)}`} is ${money(p.amountMinor, reporting)}; ${names.get(p.counterSubsidiaryId)}'s ${p.counterCode} at the ${elim.basis === 'balance' ? 'closing' : 'average'} rate is ${money(p.counterTranslatedMinor, reporting)}; difference ${money(p.differenceMinor, reporting)}`
  );
  const tail = elim.basis === 'balance' ? `It reverses in ${elim.reversesInYm ? ymToString(elim.reversesInYm) : 'the next month'}, so next month's elimination starts from the books again.` : "It covers this month's activity only and never reverses.";
  return `Remove what the group's companies ${elim.basis === 'balance' ? 'owe each other' : 'charged each other this month'} from the combined books, posted only to the elimination subsidiary on its intercompany accounts in ${reporting}. Each amount is the source company's own figure; the other side is shown for comparison, a difference within the tolerance is translation rounding, and a larger one is raised in the close thread for a person. ${pairs.join('; ')}. ${tail}`;
}

/**
 * The month's revaluations and eliminations as Proposal drafts (pure over a group snapshot). Differences over
 * `toleranceMinor` (reporting-currency minor units) are listed for the close thread; the elimination still removes
 * the source company's own amount.
 */
export function planConsolidation(g: GroupSnapshot, closeYm: string, opts: { toleranceMinor: bigint }): ConsolidationPlan {
  const trading = g.entities.filter(e => !e.isElimination);
  const empty: ConsolidationPlan = { group: false, trading, revaluations: [], eliminations: [], differences: [] };
  if (trading.length < 2 || !g.entities.some(e => e.isElimination)) return empty;
  const periodId = g.periodIdOf(closeYm);
  if (periodId === undefined) throw new Error(`No period ${closeYm}`);
  const ym = ymFromString(closeYm);
  const names = new Map(g.entities.map(e => [e.id, e.name]));
  const subsidiaries = new Map<bigint, PlainSubsidiary>(g.entities.map(e => [e.id, { name: e.name, functionalCcy: e.functionalCcy, parentId: e.parentId, isElimination: e.isElimination }]));

  const revaluations: ConsolidationDraft[] = [];
  for (const entity of trading) {
    const fxAccount = g.accounts.find(a => a.subsidiaryId === entity.id && groupCode(a.code) === '7100');
    if (!fxAccount) continue;
    const rev = revaluation({ entity, lines: g.lines, accountsById: g.accountsById, rates: g.rates, ym, periodId, fxGainLossAccountId: fxAccount.id });
    const payload = fxRevaluationPayload(rev);
    if (!payload) continue;
    revaluations.push({
      kind: 'fx_revaluation',
      payload: consolidationWireJson(payload, g.accountsById),
      rationale: revaluationRationale(rev, closeYm),
      summaryPlain: plainSummary(payload, { subsidiaries }),
      amountMinor: reportingAmount(g, entity, payload.lines, closeYm),
      periodYm: closeYm,
    });
  }

  const elims = eliminations({ entities: g.entities, accounts: g.accounts, lines: g.lines, rates: g.rates, reportingCcy: g.reportingCcy, ym, periodId });
  const elimination = g.entities.find(e => e.isElimination)!;
  const drafts: ConsolidationDraft[] = [];
  const differences: IcDifference[] = [];
  for (const elim of [elims.balance, elims.activity]) {
    for (const p of elim.pairs) {
      if (abs(p.differenceMinor) > opts.toleranceMinor) {
        differences.push({ label: p.label, basis: elim.basis, source: names.get(p.sourceSubsidiaryId) ?? 'the source company', counter: names.get(p.counterSubsidiaryId) ?? 'the other company', amountMinor: p.amountMinor, counterTranslatedMinor: p.counterTranslatedMinor, differenceMinor: p.differenceMinor });
      }
    }
    const payload = icEliminationPayload(elim);
    if (!payload) continue;
    drafts.push({
      kind: 'ic_elimination',
      payload: consolidationWireJson(payload, g.accountsById),
      rationale: eliminationRationale(elim, names, g.reportingCcy),
      summaryPlain: plainSummary(payload, { subsidiaries }),
      amountMinor: reportingAmount(g, elimination, payload.lines, closeYm),
      periodYm: closeYm,
    });
  }
  return { group: true, trading, revaluations, eliminations: drafts, differences };
}

/**
 * The module's refusals that mean the revaluation or elimination is already done (a resumed or repeated close): one
 * for the same company, month and basis still waits; every balance already stands at the closing rate; the month is
 * already eliminated on that basis. Not a refusal that should block the lock.
 */
export function alreadyDoneRefusal(kind: string, message: string): boolean {
  if (kind !== 'fx_revaluation' && kind !== 'ic_elimination') return false;
  return /is still waiting; decide it before proposing another/.test(message) || /already stands at the .* closing rate; there is nothing to revalue/.test(message) || /is already eliminated on the .* basis/.test(message);
}

export interface ConsolidationStepOptions {
  log: (m: string) => void;
  pause: (mult?: number) => Promise<void>;
  thread: string;
  /** The "Consolidate subsidiaries" close task the Proposals evidence. */
  taskId?: bigint;
  /** Intercompany differences above this many reporting-currency minor units are raised in the thread. Default $1. */
  toleranceMinor?: bigint;
  /** Files one Proposal (the close's wrapper records refusals); default: propose directly. */
  file?: (who: RoleConn, args: Parameters<typeof propose>[2]) => Promise<unknown>;
  /** Records a Proposal the step could not file (a balance elimination with no open month to reverse in), so the close does not ask for the lock. */
  refuse?: (r: Refusal) => void;
}

/**
 * Run the Consolidation agent's part of the close: one revaluation per company with foreign-currency balances, then
 * the balance and activity eliminations, each a Proposal through the consolidation identity. Differences over the
 * tolerance are said in the close thread before the eliminations are proposed. Returns how many were filed.
 */
export async function runConsolidationStep(cast: Cast, closeYm: string, opts: ConsolidationStepOptions): Promise<{ proposed: number; differences: number }> {
  const A = cast.advisor;
  const C = cast.consolidation;
  const tolerance = opts.toleranceMinor ?? 100n;
  const g = groupSnapshot(A);
  const plan = planConsolidation(g, closeYm, { toleranceMinor: tolerance });
  if (!plan.group) {
    opts.log('consolidation skipped: one company, nothing to consolidate');
    return { proposed: 0, differences: 0 };
  }
  const file =
    opts.file ??
    (async (who: RoleConn, args: Parameters<typeof propose>[2]) => {
      try {
        return await propose(who, A, args);
      } catch (e) {
        if (alreadyDoneRefusal(args.kind, (e as Error).message)) return undefined;
        throw e;
      }
    });
  // A revaluation or elimination of this month already waiting or posted is not proposed again (the books refuse it).
  const periodId = g.periodIdOf(closeYm);
  const filedBefore = [...A.db.proposal.iter()]
    .filter(p => p.periodId === periodId && ['Open', 'AwaitingCfo', 'SentBack', 'Approved', 'Amended'].includes(p.status.tag))
    .map(p => {
      try {
        const x = JSON.parse(p.payloadJson) as { subsidiaryId?: string; basis?: string };
        return `${p.kind.tag}|${x.subsidiaryId ?? ''}|${x.basis ?? ''}`;
      } catch {
        return '';
      }
    });
  const fresh = (d: ConsolidationDraft) => {
    const key = `${d.kind === 'fx_revaluation' ? 'FxRevaluation' : 'IcElimination'}|${String(d.payload.subsidiaryId ?? '')}|${String(d.payload.basis ?? '')}`;
    if (!filedBefore.includes(key)) return true;
    opts.log(`consolidation: ${d.kind} for subsidiary ${String(d.payload.subsidiaryId)}${d.payload.basis ? ` (${String(d.payload.basis)})` : ''} already filed for ${closeYm}`);
    return false;
  };
  const month = monthLabel(closeYm);
  const names = plan.trading.map(e => e.name);
  const foreign = plan.trading.filter(e => e.functionalCcy.toUpperCase() !== g.reportingCcy.toUpperCase()).map(e => e.name);
  await say(C, opts.thread, `Consolidating ${names.join(' and ')} for ${closeYm} in ${g.reportingCcy}: restating ${foreign.length ? foreign.join(' and ') : 'any company'}'s foreign-currency balances at the ${closeYm} closing rate, then removing what the companies owe and charged each other, posted only to the elimination subsidiary.`,
    `The Consolidation agent is combining ${names.join(' and ')} for ${month}.`);
  await opts.pause();
  let proposed = 0;
  for (const d of plan.revaluations.filter(fresh)) if (await file(C, { ...d, closeTaskId: opts.taskId })) proposed++;
  for (const d of plan.differences) {
    const gap = money(abs(d.differenceMinor), g.reportingCcy);
    await say(C, opts.thread, `${d.label}: the two companies' books differ by ${gap}. ${d.source}'s side is ${money(d.amountMinor, g.reportingCcy)}; ${d.counter}'s side translates to ${money(d.counterTranslatedMinor, g.reportingCcy)} at the ${d.basis === 'balance' ? 'closing' : 'average'} rate, over the ${money(tolerance, g.reportingCcy)} tolerance. I am eliminating ${d.source}'s own figure; a person should find which side is wrong.`,
      `The two companies' books differ on the ${d.label.toLowerCase()} by ${gap}, so a person should check which side is wrong.`);
  }
  await opts.pause();
  for (const d of plan.eliminations.filter(fresh)) {
    // A balance elimination reverses next month; without that month in the books it cannot be filed yet.
    const reverses = typeof d.payload.reversesInYm === 'string' ? d.payload.reversesInYm : undefined;
    const next = reverses ? [...A.db.period.iter()].find(p => p.ym === reverses) : undefined;
    if (reverses && next?.status.tag !== 'Open') {
      const why = `${reverses} is ${next ? 'not open' : 'not in the books yet'}, so the elimination cannot reverse there.`;
      opts.log(`consolidation: balance elimination held back: ${why}`);
      opts.refuse?.({ kind: d.kind, summaryPlain: d.summaryPlain, why, closeTaskId: opts.taskId });
      await say(C, opts.thread, `The balance elimination for ${closeYm} reverses in ${reverses}, which ${next ? 'is not open' : 'the books do not have yet'}, so I am not proposing it now: "${d.summaryPlain}" A person should open ${reverses} and run the consolidation again before relying on the group's combined balance sheet.`,
        `The Consolidation agent could not remove what the companies owe each other because ${monthLabel(reverses)} is not open in the books yet.`);
      continue;
    }
    if (await file(C, { ...d, closeTaskId: opts.taskId })) proposed++;
  }
  opts.log(`consolidation: ${proposed} proposal(s), ${plan.differences.length} difference(s) raised`);
  return { proposed, differences: plan.differences.length };
}
