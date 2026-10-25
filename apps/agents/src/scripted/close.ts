/**
 * Demo-mode month-end close. The accounting decisions come from the real engines
 * (@cafoo/ledger-core matching, revenue schedules, accruals, allowances; @cafoo/crs-mcp credit cascade).
 * Only the narration is scripted. Every write goes through the same role identities and reducers the
 * live agents use, so the UI, the approval gate, and the audit trail are identical in both modes.
 */
import {
  buildRevenueSchedule,
  consolidate,
  detectMissingAccruals,
  divRound,
  findDuplicatePayments,
  formatMinor,
  scoreBankMatches,
  specificReserveReasons,
  targetAllowanceMinor,
  ymAdd,
  ymFromString,
  ymLabel,
  ymToString,
  type RiskTier,
} from '@cafoo/ledger-core';
import { CrsClient, creditCheckSummaryJson, runCascade, type CascadeResult } from '@cafoo/crs-mcp';
import { collectFootprint, subjectsWithListings } from '../footprint';
import { STEP_MS } from '../env';
import { exactAmount, groupSnapshot, line, snapshot, type Snapshot } from '../snapshot';
import { monthLabel } from '../advisor-chat';
import { catchUpAmounts } from '../revenue-catchup';
import { Cast, propose, say, sleep, type RoleConn } from '../stdb';
import { ruleOpen, type Refusal } from './rulings';
import { citedBankTxIds, closeHasWork, closeOpenedAt, openingMarker, pendingBankTxIds } from '../close-state';
import { classifyOutflow, dayLabel, vendorLookup } from '../bookkeeping';
import { activeCharter } from '../charter/active';
import { CAPPED_KINDS } from '../charter/library';
import { alreadyDoneRefusal, runConsolidationStep } from './consolidate';
import { usageInvoices as usageOf } from '../usage';

export type CloseEvents = {
  onStep?: (msg: string) => void;
};

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });

/** The cascade's plain reasons of some groups, joined as its own summary joins them ("a and b"). */
function plainReasons(r: CascadeResult, groups: readonly string[]): string {
  const p = [...new Set(r.reasons.filter(x => groups.includes(x.group)).map(x => x.plain))].slice(0, 2);
  return p.length === 2 ? `${p[0]} and ${p[1]}` : (p[0] ?? '');
}

/**
 * A credit decision as one plain sentence: the cascade's summary starts with its verdict and a colon ("Decline: for
 * …"), so "<customer>: <summary>" would read as two verdicts. Lead with the verdict on the customer instead.
 */
function creditDecisionSummary(customer: string, summary: string): string {
  const m = /^(Approve|Decline|Stop|Needs a person to review|No credit history):\s*(.*)$/.exec(summary);
  if (!m) return `${customer}: ${summary}`;
  const lead: Record<string, string> = { Approve: `Approve ${customer}`, Decline: `Decline credit for ${customer}`, Stop: `Stop all credit for ${customer}`, 'Needs a person to review': `Have a person review ${customer}`, 'No credit history': `No credit history for ${customer}` };
  return `${lead[m[1]!]}: ${m[2]}`;
}

/** The dataset's persona names are upper case ("KAYLA BRENNAN"); summaries use "Kayla Brennan". */
const titleCase = (name: string) => name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());

async function pause(mult = 1) {
  await sleep(STEP_MS * mult);
}

/**
 * Is this Proposal over the amount cap its proposer's charter sets? Only the kinds whose amount is the money they move
 * (CAPPED_KINDS: entries, accruals, schedules, revaluations, eliminations) are capped: a bank match is filed at zero
 * and the module measures vendor kinds and credit decisions differently, so those are never left for a human by a cap.
 */
export function overCharterCap(kind: string, amountMinor: bigint, cap: bigint | undefined): boolean {
  return cap !== undefined && (CAPPED_KINDS as readonly string[]).includes(kind) && amountMinor > cap;
}

export async function runScriptedClose(cast: Cast, closeYm: string, events: CloseEvents = {}) {
  const log = (m: string) => {
    events.onStep?.(m);
    console.log(`[close ${closeYm}] ${m}`);
  };
  const thread = `close:${closeYm}`;
  const A = cast.advisor;
  const roleName: Record<string, string> = { bookkeeper: 'Bookkeeper', revenue: 'Revenue agent', credit: 'Credit & Risk agent', consolidation: 'Consolidation agent' };
  const month = monthLabel(closeYm);
  /** Proposals the module refused: their close task stays open and the month is not offered for locking. */
  const refused: Refusal[] = [];
  /** Proposals this run filed: the rulings cover these, plus those already open when the close opened. */
  const mine = new Set<bigint>();
  /** When this run opened the close (server time); undefined on a resume, which rules every open Proposal. */
  let openedAt: bigint | undefined;
  /**
   * Propose through a worker. When the module refuses one (a bank match that is no longer exact or unpaid, a vendor
   * check whose evidence does not hold), say so in the close thread and carry on instead of aborting the close.
   */
  const file = async (who: RoleConn, args: Parameters<typeof propose>[2]) => {
    // A charter may cap what a worker proposes; a larger amount is left for a human, not filed.
    const cap = caps.get(who.role);
    if (cap !== undefined && overCharterCap(args.kind, args.amountMinor, cap)) {
      log(`${who.role} proposal over its ${money(cap)} cap left for a human: ${args.summaryPlain}`);
      await say(who, thread, `"${args.summaryPlain}" is ${money(args.amountMinor)}, over the ${money(cap)} my charter lets me propose, so I am leaving it for a human instead of filing it.`, `The ${roleName[who.role] ?? who.role} left one item over its limit for a person to handle.`).catch(() => undefined);
      return undefined;
    }
    try {
      const p = await propose(who, A, args);
      mine.add(p.id);
      return p;
    } catch (e) {
      const why = (e as Error).message;
      // A revaluation or elimination the books already hold (a repeated close) is done, not refused.
      if (alreadyDoneRefusal(args.kind, why)) {
        log(`${who.role} ${args.kind} already done: ${why}`);
        return undefined;
      }
      log(`${who.role} proposal refused: ${why}`);
      refused.push({ kind: args.kind, summaryPlain: args.summaryPlain, why, closeTaskId: args.closeTaskId });
      await say(who, thread, `The books refused my ${args.kind.replace(/_/g, ' ')} proposal "${args.summaryPlain}": ${why} Leaving it for a person to review; the close continues.`, `The ${roleName[who.role] ?? who.role} could not file one proposal and left it for a person to review.`).catch(() => undefined);
      return undefined;
    }
  };
  let s = snapshot(A, closeYm);
  const task = (n: number) => s.closeTasks[n - 1]?.id;
  /** The "Consolidate subsidiaries" task, by owner: a single-company database has none, and task 6 is the board pack. */
  const consolidationTask = s.closeTasks.find(t => t.ownerRole === 'consolidation')?.id;
  /** A group (another trading company and an elimination subsidiary) also gets the Consolidation step. */
  const isGroup = (() => {
    const entities = groupSnapshot(A).entities;
    return entities.filter(e => !e.isElimination).length > 1 && entities.some(e => e.isElimination);
  })();
  // Thresholds the active charters set (built-in: batch at 75%, no amount cap, $1 intercompany tolerance).
  const bookkeeperParams = activeCharter(A, 'bookkeeper').params;
  const batchMin = bookkeeperParams.batchMinScoreBp;
  const caps = new Map<string, bigint>();
  for (const r of ['bookkeeper', 'revenue', 'credit', 'consolidation'] as const) {
    const cap = activeCharter(A, r).params.maxProposalMinor;
    if (cap !== undefined) caps.set(r, cap);
  }
  const subId = s.subsidiary.id.toString();
  const period = s.period;
  const noWait = process.env.CLOSE_NO_WAIT === '1';

  /**
   * With any proposal refused, the month must not be offered for locking: say in the close thread what was refused and
   * why (the full reason, which the CFO otherwise sees only in Expert mode) and leave it for a person.
   */
  const reportRefusals = async (): Promise<boolean> => {
    if (!refused.length) return false;
    const n = refused.length;
    await say(
      A,
      thread,
      `${n === 1 ? 'One proposal was' : `${n} proposals were`} refused by the books, so I am not asking to lock ${closeYm}. ${refused.map(r => `${r.kind.replace(/_/g, ' ')} "${r.summaryPlain}": ${r.why}`).join(' | ')} A person needs to fix ${n === 1 ? 'it' : 'them'} and resubmit before the month can be locked.`,
      `${n === 1 ? 'One proposal was' : `${n} proposals were`} refused by the books, so ${month} stays open until a person fixes ${n === 1 ? 'it' : 'them'}.`,
      'ruling'
    );
    // A refusal after the rulings (the revenue catch-up) comes after its task was marked done: reopen it as blocked.
    for (const t of new Set(refused.map(r => r.closeTaskId).filter((x): x is bigint => x !== undefined))) {
      await A.reducers.updateCloseTask({ taskId: t, status: 'blocked', note: 'A proposal was refused by the books; a person must fix and resubmit' }).catch(() => undefined);
    }
    log(`lock not requested: ${n} proposal(s) refused`);
    return true;
  };

  /**
   * Ask the CFO to lock the month, unless something is left for a person: a refused proposal (this run), or a blocked
   * close task (any run; refusals from an earlier run live on as blocked tasks). The books refuse too, for example
   * while subscription revenue through the month is still unrecognized; that refusal is explained in the thread.
   */
  const requestLock = async (rationale: string): Promise<boolean> => {
    if (await reportRefusals()) return false;
    const current = [...A.db.period.iter()].find(p => p.id === period.id);
    if (current && current.status.tag !== 'Open') return false;
    const blocked = [...A.db.closeTask.iter()].filter(t => t.periodId === period.id && t.status.tag === 'Blocked');
    if (blocked.length) {
      const n = blocked.length;
      await say(A, thread, `Not asking to lock ${closeYm}: ${n === 1 ? 'one close task is' : `${n} close tasks are`} blocked (${blocked.map(t => `"${t.title}"`).join(', ')}), usually because the books refused a proposal for it. A person needs to resolve ${n === 1 ? 'it' : 'them'} first.`,
        `${month} stays open because ${n === 1 ? 'one close task is blocked and needs' : `${n} close tasks are blocked and need`} a person.`, 'ruling');
      log(`lock not requested: ${n} blocked task(s)`);
      return false;
    }
    const summary = boardSummary(snapshot(A, closeYm), A);
    try {
      await A.reducers.requestPeriodLock({ periodYm: closeYm, rationale: `${rationale} ${summary.technical}`, summaryPlain: `${month} is ready to lock ${summary.plain}.` });
      log('lock requested; CFO confirms in the app');
      return true;
    } catch (e) {
      const why = (e as Error).message;
      log(`lock not requested: ${why}`);
      await say(A, thread, `I asked to lock ${closeYm} and the books refused: ${why} The month stays open until that is resolved.`, `The books would not lock ${month} yet, so it stays open for a person to check.`, 'ruling');
      return false;
    }
  };

  /**
   * Recognize revenue for customers whose new revenue schedule was approved during this close: the main recognition
   * entry had to leave them out while their schedule waited for a ruling. Revenue proposes it, the Red Team critiques
   * and the Advisor rules, like the main entry. Returns true when it now waits for the CFO.
   */
  const catchUpRecognition = async (): Promise<boolean> => {
    const fresh = snapshot(A, closeYm);
    const byCust = catchUpAmounts(A, fresh);
    const total = [...byCust.values()].reduce((a, b) => a + b, 0n);
    if (total === 0n) return false;
    const names = [...byCust.keys()].map(c => fresh.customerName.get(c) ?? 'a customer');
    const p = await file(cast.revenue, {
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `Revenue recognition catch-up ${closeYm}`,
        lines: [...byCust.entries()].flatMap(([cid, amt]) => [
          line('2400', amt, 0n, `Release deferred revenue ${closeYm} (catch-up)`, { customerId: cid }),
          line('4000', 0n, amt, `Subscription revenue ${closeYm} (catch-up)`, { customerId: cid }),
        ]),
        recognizeScheduleYm: closeYm,
      },
      rationale: `The revenue schedule for ${names.join(', ')} was approved during this close, after the ${closeYm} recognition entry had to leave it out. Recognize its ${money(total)} of schedule lines through ${closeYm} now so ${closeYm} revenue is complete; the lines are flagged recognized and linked to this entry.`,
      summaryPlain: `Recognize ${money(total)} of subscription revenue earned through ${month} for ${names.length === 1 ? names[0] : `${names.length} customers`}, whose schedule was just approved.`,
      amountMinor: total,
      periodYm: closeYm,
      closeTaskId: task(2),
    });
    if (!p) return false;
    await cast.redteam.reducers
      .critique({ proposalId: p.id, body: `Catch-up is right: the schedule was approved after the main recognition entry. Confirm none of these customers' lines was already recognized in the main entry, so the revenue is not counted twice.`, summaryPlain: `The Red Team agrees and checks this revenue is not counted twice.` })
      .catch(() => undefined);
    try {
      await A.reducers.approveProposal({ proposalId: p.id, rationale: `Catch-up approved. Only the newly approved schedule's lines through ${closeYm} are flipped, and the books tie the revenue credit to those lines customer by customer.`, summaryPlain: `Approved: count the revenue from the newly approved schedule in ${month}.`, amendedPayloadJson: undefined });
    } catch (e) {
      const why = (e as Error).message;
      log(`ruling on catch-up ${p.id} failed: ${why}`);
      refused.push({ kind: 'journal_entry', summaryPlain: p.summaryPlain, why, closeTaskId: p.closeTaskId });
      await A.reducers.rejectProposal({ proposalId: p.id, rationale: `Could not apply this proposal: ${why}. Rejected so the close can continue; the proposer should resubmit.`, summaryPlain: `Not posted: the books refused this entry (${why.slice(0, 80)}).` }).catch(() => undefined);
    }
    return A.db.proposal.id.find(p.id)?.status.tag === 'AwaitingCfo';
  };
  /**
   * The Red Team critiques the month's open Proposals and the Advisor rules on each: the same logic whether the close
   * runs fresh or resumes (scripted/rulings.ts). A fresh run rules what it filed itself plus what was already open when
   * it opened (a feed Proposal its Bookkeeper left to the close), never a Proposal someone else filed meanwhile, which
   * that filer rules. A ruling the books refuse is recorded as a refusal (task blocked, no lock request). Returns how
   * many Proposals were ruled.
   */
  const ruleOpenProposals = async (): Promise<number> => {
    s = snapshot(A, closeYm);
    const ours = (p: { id: bigint; createdAt: { microsSinceUnixEpoch: bigint } }) => openedAt === undefined || mine.has(p.id) || p.createdAt.microsSinceUnixEpoch < openedAt;
    const open = [...A.db.proposal.iter()].filter(p => p.periodId === period.id && p.status.tag === 'Open' && ours(p)).sort((a, b) => Number(a.id - b.id));
    return ruleOpen(cast, open, { thread, snapshot: s, log, pause, refused });
  };

  if (period.status.tag === 'Closed') throw new Error(`${closeYm} is already closed.`);
  const already = [...A.db.proposal.iter()].filter(p => p.periodId === period.id);
  // Resume only a close with work of its own (src/close-state.ts): the continuous Bookkeeper files Proposals from the
  // live bank feed during an open month, and a close that failed right after opening has nothing to resume.
  if (closeHasWork(A, closeYm)) {
    // The close already ran for this month (or is mid-flight): do not propose twice. Resume at the CFO gate.
    // Open proposals get the same critique and ruling as in a fresh run (a weak bank match is still rejected).
    if (already.some(p => p.status.tag === 'Open')) await ruleOpenProposals();
    const pending = [...A.db.proposal.iter()].filter(p => p.periodId === period.id && (p.status.tag === 'AwaitingCfo' || p.status.tag === 'SentBack'));
    await say(A, thread, `The ${closeYm} close already has ${already.length} proposals. ${pending.length ? `${pending.length} still need a decision; I will ask to lock as soon as they are done.` : 'Everything is decided; I will ask to lock it unless something is left for a person.'}`, `The ${month} close is already under way.`, 'ruling');
    log(`resuming: ${pending.length} pending`);
    if (pending.length && !noWait) await waitForCfo(A, period.id);
    if (!(pending.length && noWait) && (await catchUpRecognition()) && !noWait) await waitForCfo(A, period.id);
    if (pending.length && noWait) await reportRefusals();
    else await requestLock('All proposals are decided.');
    return { proposals: already.length, awaitingCfo: pending.length, refused: refused.length };
  }

  await say(A, thread, `${openingMarker(closeYm)} for ${s.subsidiary.name}. ${isGroup ? 'Bookkeeper, Revenue, Credit & Risk, and Consolidation' : 'Bookkeeper, Revenue, and Credit & Risk'}: work your tasks and propose; nothing posts until I rule, and anything material waits for the CFO.`,
    `The Advisor started the ${closeYm} close.`, 'ruling');
  openedAt = closeOpenedAt(A, closeYm, 'last') ?? BigInt(Date.now()) * 1000n;
  for (const t of s.closeTasks) if (t.status.tag === 'Todo') await A.reducers.updateCloseTask({ taskId: t.id, status: 'in_progress', note: 'Close started' });
  await pause();

  // ---------------- Bookkeeper: bank reconciliation ----------------
  const B = cast.bookkeeper;
  // A transaction already proposed is not proposed again: one still waiting (any month), or one the live feed's
  // Bookkeeper filed during this month, whatever its ruling (a rejected weak match stays for a person).
  const inFlight = new Set([...pendingBankTxIds(A), ...citedBankTxIds(A, { periodId: period.id })]);
  const closeTxs = s.bankTxs.filter(t => !t.matched && !inFlight.has(t.id) && s.bankTxRows.find(r => r.id === t.id)?.ym === closeYm);
  await say(B, thread, `Reconciling ${closeTxs.length} bank transactions for ${closeYm}. Scoring each against open invoices and bills on amount, date, counterparty, and reference.`,
    `The Bookkeeper is matching ${closeTxs.length} bank transactions.`);
  const names = { customers: s.customerName, vendors: s.vendorName };
  const candidates = scoreBankMatches(closeTxs, s.invoices, s.bills, names);
  // A bank match must pay its invoice or bill to the cent (the module refuses anything else); a near-amount
  // candidate is a short or partial payment, left for a person rather than matched. Exact matches at or above the
  // Bookkeeper charter's batch threshold (75% built in, the auto bucket) go in one batch; each weaker one on its own.
  const auto = candidates.filter(c => c.bucket !== 'unmatched' && c.scoreBp >= batchMin && exactAmount(c, s));
  const review = candidates.filter(c => c.bucket !== 'unmatched' && c.scoreBp < batchMin && exactAmount(c, s));
  const near = candidates.filter(c => c.bucket !== 'unmatched' && !exactAmount(c, s));
  const matchedTxIds = new Set(candidates.filter(c => c.bucket !== 'unmatched').map(c => c.bankTxId));
  const txById = new Map(s.bankTxs.map(t => [t.id, t]));
  const invById = new Map(s.invoices.map(i => [i.id, i]));
  const billById = new Map(s.bills.map(b => [b.id, b]));
  const amountOf = (c: (typeof candidates)[number]) => (c.targetKind === 'invoice' ? invById.get(c.targetId)?.amountMinor : billById.get(c.targetId)?.amountMinor) ?? 0n;
  const autoTotal = auto.reduce((acc, c) => acc + amountOf(c), 0n);
  await pause();

  if (auto.length) {
    const inflows = auto.filter(c => c.targetKind === 'invoice').length;
    const outflows = auto.length - inflows;
    const minPct = Math.floor(Math.min(...auto.map(c => c.scoreBp)) / 100);
    const pays = (n: number, who: string) => `${n} ${who} payment${n === 1 ? '' : 's'}`;
    // Say exactly what the bundle holds: customer payments to invoices, vendor payments to bills, or both.
    const what = inflows && outflows ? `${pays(inflows, 'customer')} and ${pays(outflows, 'vendor')} worth ${money(autoTotal)} to the invoices and bills they pay` : inflows ? `${pays(inflows, 'customer')} worth ${money(autoTotal)} to the invoices they pay` : `${pays(outflows, 'vendor')} worth ${money(autoTotal)} to the bills they pay`;
    const p = await file(B, {
      kind: 'bank_match',
      payload: { matches: auto.map(c => ({ bankTxId: c.bankTxId.toString(), targetKind: c.targetKind, targetId: c.targetId.toString(), scoreBp: c.scoreBp })) },
      rationale: `${auto.length} transactions matched at ${(batchMin / 100).toFixed(0)}% confidence or better: ${inflows} customer payments to invoices and ${auto.length - inflows} vendor payments to bills. Scores combine amount, date proximity, counterparty name overlap, and invoice or bill references in the bank description. Each match is one-to-one; no invoice or bill is consumed twice.`,
      summaryPlain: `Match ${what}; every match is at least ${minPct}% confident.`,
      amountMinor: 0n,
      periodYm: closeYm,
      closeTaskId: task(1),
    });
    if (p) log(`proposal ${p.id}: auto matches`);
  }
  for (const c of near) {
    const tx = txById.get(c.bankTxId)!;
    const target = c.targetKind === 'invoice' ? `invoice ${c.targetId} for ${s.customerName.get(invById.get(c.targetId)?.customerId ?? 0n) ?? 'a customer'}` : `bill ${billById.get(c.targetId)?.externalRef ?? c.targetId}`;
    await say(B, thread, `Bank transaction ${c.bankTxId} ("${tx.description}", ${money(tx.amountMinor < 0n ? -tx.amountMinor : tx.amountMinor)}) looks like ${target} (${money(amountOf(c))}) at ${(c.scoreBp / 100).toFixed(0)}% confidence, but the amounts differ. A bank match must be exact, so I am leaving this short or partial payment for a person to record.`,
      `The Bookkeeper left a payment that does not equal its ${c.targetKind} for a person to review.`);
  }
  for (const c of review) {
    const tx = txById.get(c.bankTxId)!;
    const target = c.targetKind === 'invoice' ? `invoice ${c.targetId} for ${s.customerName.get(invById.get(c.targetId)!.customerId)}` : `bill ${billById.get(c.targetId)?.externalRef} from ${s.vendorName.get(billById.get(c.targetId)!.vendorId)}`;
    // The summary names a bill by its vendor and month: a bill reference ("NW-202609-7019") reads as a raw number.
    const bill = c.targetKind === 'bill' ? billById.get(c.targetId) : undefined;
    const targetPlain = bill ? `${s.vendorName.get(bill.vendorId) ?? 'a vendor'}'s ${ymLabel(bill.ym)} bill` : target;
    await file(B, {
      kind: 'bank_match',
      payload: { matches: [{ bankTxId: c.bankTxId.toString(), targetKind: c.targetKind, targetId: c.targetId.toString(), scoreBp: c.scoreBp }] },
      rationale: `Likely match at ${(c.scoreBp / 100).toFixed(0)}% confidence between bank transaction "${tx.description}" and ${target}. Reasons: ${c.reasons.join('; ')}. Below the ${(batchMin / 100).toFixed(0)}% auto threshold, so this needs a ruling.`,
      summaryPlain: `Probably match the ${money(tx.amountMinor < 0n ? -tx.amountMinor : tx.amountMinor)} bank transaction from ${tx.counterparty} to ${targetPlain}; confidence ${(c.scoreBp / 100).toFixed(0)}%.`,
      amountMinor: 0n,
      periodYm: closeYm,
      closeTaskId: task(1),
    });
  }
  await pause();

  // Duplicate payments
  const dups = findDuplicatePayments(closeTxs, s.bills);
  for (const d of dups) {
    const bill = billById.get(d.billId)!;
    const vendor = s.vendorName.get(bill.vendorId) ?? 'vendor';
    matchedTxIds.add(d.duplicateTxId);
    matchedTxIds.add(d.firstTxId);
    await say(B, thread, `Two outflows carry the same reference ${d.externalRef} to ${vendor}, ${d.daysApart} days apart. The second one is a duplicate payment.`, `The Bookkeeper found a duplicate payment to ${vendor}.`);
    await file(B, {
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `Duplicate payment to ${vendor} on ${d.externalRef}; refund requested`,
        lines: [line('1250', d.amountMinor, 0n, `Due back from ${vendor} (duplicate payment)`, { vendorId: bill.vendorId }), line('1000', 0n, d.amountMinor, 'Second payment, same reference', { vendorId: bill.vendorId })],
        bankTxIds: [d.duplicateTxId.toString()],
      },
      rationale: `Bank transactions ${d.firstTxId} and ${d.duplicateTxId} both pay ${d.externalRef} (${money(d.amountMinor)}). The first settles the bill; the second is an overpayment. Record the cash out and a receivable from the vendor (1250 Receivable from Vendors) so the expense is not doubled, and request a refund.`,
      summaryPlain: `We paid ${vendor} twice for the same ${money(d.amountMinor)} bill; record the second payment as money they owe us back.`,
      amountMinor: d.amountMinor,
      periodYm: closeYm,
      closeTaskId: task(3),
    });
  }
  await pause();

  // Quick entries for everything still unexplained (payroll runs, fees, card purchases, unknown subscriptions)
  const unexplained = closeTxs.filter(t => !matchedTxIds.has(t.id));
  for (const t of unexplained) {
    if (t.amountMinor >= 0n) continue; // unexplained inflows are left for a human
    const amt = -t.amountMinor;
    const k = classifyOutflow(t);
    let lookup = '';
    if (k.needsLookup) {
      lookup = await vendorLookup(t.counterparty);
      await say(B, thread, `Unknown counterparty "${t.counterparty}". Looked them up: ${lookup}`, `The Bookkeeper looked up ${t.counterparty} on the web.`);
    }
    await file(B, {
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `${k.label}: ${t.description}`,
        lines: [line(k.code, amt, 0n, t.description), line('1000', 0n, amt, `Bank: ${t.counterparty}`)],
        bankTxIds: [t.id.toString()],
      },
      rationale: `Bank outflow of ${money(amt)} to ${t.counterparty} has no invoice or bill. ${lookup || `Description "${t.description}" indicates ${k.label.toLowerCase()}.`} Booking directly to ${k.label} (${k.code}).`,
      // The date tells apart repeat payments to one payee (two payroll runs a month), which would otherwise read alike.
      summaryPlain: `Record the ${money(amt)} paid to ${t.counterparty} on ${dayLabel(t.bookedAt)} as ${k.label.toLowerCase()}.`,
      amountMinor: amt,
      periodYm: closeYm,
      closeTaskId: task(1),
    });
  }
  await pause();

  // Accruals: work done in the close month, billed after month end
  const expenseAccountByVendor = new Map<bigint, bigint>();
  for (const b of [...A.db.bill.iter()]) {
    const acct = s.accountByCode.get(b.expenseAccountCode);
    if (acct) expenseAccountByVendor.set(b.vendorId, acct.id);
  }
  const accruals = detectMissingAccruals(s.bills, s.close, {
    subsidiaryId: s.subsidiary.id,
    periodId: period.id,
    expenseAccountId: s.accountByCode.get('5600')!.id,
    accruedLiabilitiesAccountId: s.accountByCode.get('2100')!.id,
    expenseAccountByVendor,
  });
  for (const acc of accruals) {
    const bill = acc.billId ? billById.get(acc.billId) : undefined;
    const vendor = bill ? s.vendorName.get(bill.vendorId) ?? 'a vendor' : 'a vendor';
    const total = acc.lines.reduce((a, l) => a + l.debitMinor, 0n);
    await file(B, {
      kind: 'accrual',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `Accrue ${vendor} work for ${closeYm}, invoiced ${bill ? 'after month end' : 'later'}`,
        lines: acc.lines.map(l => line(s.accountById.get(l.accountId)!.code, l.debitMinor, l.creditMinor, l.memo ?? '', { vendorId: bill?.vendorId })),
        reversesInYm: ymToString(acc.reversesInYm),
      },
      rationale: `${vendor}'s bill ${bill?.externalRef ?? ''} covers ${closeYm} work but is dated after month end, so without an accrual ${closeYm} expenses are understated by ${money(total)}. Book the expense and an accrued liability now; it reverses in ${ymToString(acc.reversesInYm)} when the bill posts.`,
      summaryPlain: `Count ${money(total)} of ${vendor}'s ${month} work in this month even though their bill arrived later.`,
      amountMinor: total,
      periodYm: closeYm,
      closeTaskId: task(3),
    });
  }
  await pause();

  // ---------------- Revenue ----------------
  const R = cast.revenue;
  s = snapshot(A, closeYm);
  const subItems = s.items.filter(i => i.kind === 'subscription');
  const contractsWithoutSchedule = s.contracts.filter(k => k.plan === 'annual' && !s.scheduleLines.some(sl => subItems.some(i => i.id === sl.contractItemId && i.contractId === k.id)));
  await say(R, thread, `Reviewing ${s.contracts.length} contracts. Checking that every subscription has a recognition schedule and that ${closeYm} revenue and deferred revenue tie out.`, `Revenue is checking every contract's schedule.`);
  for (const k of contractsWithoutSchedule) {
    const item = subItems.find(i => i.contractId === k.id)!;
    const row = s.contractRows.find(r => r.id === k.id)!;
    const customer = s.customerName.get(k.customerId) ?? 'customer';
    const sched = buildRevenueSchedule(item, k);
    await file(R, {
      kind: 'revenue_schedule',
      payload: { lines: sched.map(l => ({ contractItemId: item.id.toString(), customerId: k.customerId.toString(), ym: ymToString(l.ym), amountMinor: l.amountMinor.toString() })) },
      rationale: `Contract ${row.code} (${customer}) was invoiced for ${money(k.totalMinor)} covering ${ymToString(k.startYm)} to ${ymToString(k.endYm)} but has no recognition schedule, so its revenue has never been recognized and deferred revenue is overstated. Straight-line over ${sched.length} months, ${money(sched[0].amountMinor)} per month.`,
      summaryPlain: `Spread ${customer}'s ${money(k.totalMinor)} annual contract evenly across its ${sched.length} months so revenue is counted as it is earned.`,
      amountMinor: 0n,
      periodYm: closeYm,
      closeTaskId: task(2),
    });
  }
  await pause();

  // Recognition entry for the close month: unrecognized subscription schedule lines through the close month. The module
  // requires the 4000 credit per customer to equal exactly the lines it flips, and refuses a customer whose schedule is
  // still waiting for a ruling (a schedule just proposed above included), so those customers are recognized once their
  // schedule is approved, by a later close's catch-up.
  const pendingScheduleCustomers = new Set(
    [...A.db.proposal.iter()]
      .filter(p => p.kind.tag === 'RevenueSchedule' && ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag))
      .flatMap(p => (JSON.parse(p.payloadJson).lines as { customerId: string }[]).map(l => BigInt(l.customerId)))
  );
  const subItemIds = new Set(subItems.map(i => i.id));
  const byCustomer = new Map<bigint, bigint>();
  for (const sl of s.scheduleLines) {
    if (sl.ym <= closeYm && !sl.recognized && subItemIds.has(sl.contractItemId) && !pendingScheduleCustomers.has(sl.customerId)) {
      byCustomer.set(sl.customerId, (byCustomer.get(sl.customerId) ?? 0n) + sl.amountMinor);
    }
  }
  if (pendingScheduleCustomers.size) {
    const names = [...pendingScheduleCustomers].map(c => s.customerName.get(c) ?? 'a customer');
    await say(R, thread, `${names.join(', ')} ${names.length > 1 ? 'have new schedules' : 'has a new schedule'} waiting for a ruling, so ${names.length > 1 ? 'their' : 'its'} revenue is left out of the ${closeYm} recognition entry. It is recognized as a catch-up once the schedule is approved: later in this close, or in the next close if the approval comes after.`,
      `Revenue from a schedule still waiting for a ruling will be counted once it is approved.`);
  }
  const recognizeTotal = [...byCustomer.values()].reduce((a, b) => a + b, 0n);
  if (recognizeTotal > 0n) {
    const lines = [...byCustomer.entries()].flatMap(([cid, amt]) => [
      line('2400', amt, 0n, `Release deferred revenue ${closeYm}`, { customerId: cid }),
      line('4000', 0n, amt, `Subscription revenue ${closeYm}`, { customerId: cid }),
    ]);
    const deferredOpening = -s.balance('2400', ymAdd(s.close, -1) && ymToString(ymAdd(s.close, -1)));
    await file(R, {
      kind: 'journal_entry',
      payload: { subsidiaryId: subId, periodYm: closeYm, memo: `Revenue recognition ${closeYm}`, lines, recognizeScheduleYm: closeYm },
      rationale: `${byCustomer.size} subscription customers have schedule lines through ${closeYm} still to recognize, totaling ${money(recognizeTotal)} (including catch-up for any schedule approved since the last close). Deferred revenue opened ${closeYm} at ${money(deferredOpening)}; this release moves the earned portion to subscription revenue. Schedule lines are flagged recognized and linked to this entry.`,
      summaryPlain: `Recognize ${money(recognizeTotal)} of subscription revenue earned through ${month} across ${byCustomer.size} customers.`,
      amountMinor: recognizeTotal,
      periodYm: closeYm,
      closeTaskId: task(2),
    });
  }
  // Usage revenue for close-month usage invoices
  // Seed and feed invoices alike (src/usage.ts): the feed books no receivable at ingest, this entry does.
  const usageInvoices = usageOf(A.db.invoice.iter(), s.contractRows, closeYm);
  const usageTotal = usageInvoices.reduce((a, i) => a + i.amountMinor, 0n);
  if (usageInvoices.length) {
    await file(R, {
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `Usage revenue ${closeYm}`,
        lines: usageInvoices.flatMap(i => [line('1100', i.amountMinor, 0n, `Invoice ${i.number}`, { customerId: i.customerId }), line('4100', 0n, i.amountMinor, `Metered usage ${closeYm}`, { customerId: i.customerId })]),
      },
      rationale: `${usageInvoices.length} usage invoices were issued for ${closeYm} consumption (${money(usageTotal)}). Usage revenue is recognized in the month of use, so book the receivable and revenue now.`,
      summaryPlain: `Record ${money(usageTotal)} of usage revenue billed to ${usageInvoices.length} customers for ${month}.`,
      amountMinor: usageTotal,
      periodYm: closeYm,
      closeTaskId: task(2),
    });
  }
  await pause();

  // ---------------- Credit & Risk ----------------
  const C = cast.credit;
  const crs = new CrsClient();
  s = snapshot(A, closeYm);
  const openAr = new Map<bigint, bigint>();
  for (const i of s.invoices) if (i.status !== 'paid') openAr.set(i.customerId, (openAr.get(i.customerId) ?? 0n) + i.amountMinor);
  const exposed = s.customers.filter(c => (openAr.get(c.id) ?? 0n) > 0n).sort((a, b) => Number((openAr.get(b.id) ?? 0n) - (openAr.get(a.id) ?? 0n)));
  await say(C, thread, `${exposed.length} customers carry open receivables totaling ${money([...openAr.values()].reduce((a, b) => a + b, 0n))}. Running the credit cascade (identity, fraud, three bureaus, public records) on each guarantor, then checking any vendor due a first payment.`,
    `Credit & Risk is checking the guarantor behind every open invoice.`);
  // Public footprint first: what a logged-out visitor can see about each business with a listing on file.
  for (const subject of subjectsWithListings(cast)) {
    try {
      const rows = await collectFootprint(cast, subject.subjectKind, subject.subjectId);
      const okRows = rows.filter(r => r.status === 'ok');
      if (okRows.length) await say(C, thread, `Public footprint for ${subject.name}: ${okRows.map(r => r.summaryPlain).join(' ')}`, `Credit & Risk looked up ${subject.name}'s public listing.`);
    } catch (e) {
      log(`footprint ${subject.name}: ${(e as Error).message}`);
    }
  }
  for (const cust of exposed) {
    const result = await runCascade(crs, cust.guarantorPersonaId, { subjectKind: 'customer_guarantor' });
    for (const ev of result.evidence) {
      // The row carries the cascade's facts; the books derive its tier and decision from them, never from us.
      await C.reducers.recordCreditCheck({ subjectKind: 'customer', subjectId: cust.id, personaId: cust.guarantorPersonaId, product: ev.product, requestId: ev.requestId ?? '', summaryJson: creditCheckSummaryJson(result, ev) });
    }
    const ar = openAr.get(cust.id) ?? 0n;
    const tier = result.tier as RiskTier;
    await file(C, {
      kind: 'credit_decision',
      // Cites every row just recorded (the latest among them), each of which the books derived at this tier.
      payload: { customerId: cust.id.toString(), tier: result.tier, paymentTermsDays: result.paymentTermsDays ?? 0, creditCheckIds: result.evidence.map(e => e.requestId).filter(Boolean) },
      rationale: result.summaryTechnical,
      summaryPlain: creditDecisionSummary(cust.name, result.summaryPlain),
      amountMinor: 0n,
      periodYm: closeYm,
      closeTaskId: task(4),
    });
    const target = targetAllowanceMinor(ar, tier);
    const existing = existingAllowance(s, cust.id);
    const delta = target - existing;
    if (delta !== 0n) {
      const reasonCode = result.allowanceReasonCodes[0] as keyof typeof specificReserveReasons | undefined;
      const because = reasonCode
        ? specificReserveReasons[reasonCode]
        : tier === 'D' ? `their guarantor's credit profile is weak`
        : tier === 'C' ? `their guarantor's credit file is thin or incomplete`
        : `every healthy account carries a small routine reserve`;
      await file(C, {
        kind: 'journal_entry',
        payload: {
          subsidiaryId: subId,
          periodYm: closeYm,
          memo: `Allowance for doubtful accounts: ${cust.name} (tier ${tier})`,
          lines: delta > 0n
            ? [line('5700', delta, 0n, `Expected credit loss ${cust.name}`, { customerId: cust.id }), line('1150', 0n, delta, `Allowance ${cust.name}`, { customerId: cust.id })]
            : [line('1150', -delta, 0n, `Release allowance ${cust.name}`, { customerId: cust.id }), line('5700', 0n, -delta, `Release expected credit loss ${cust.name}`, { customerId: cust.id })],
        },
        rationale: `Open receivables from ${cust.name}: ${money(ar)}. Risk tier ${tier} carries a ${tier === 'BLOCK' ? '100' : tier === 'D' ? '50' : tier === 'C' ? '10' : tier === 'B' ? '5' : '1'}% expected-credit-loss reserve, target ${money(target)}; the current allowance is ${money(existing)}. Evidence: ${result.evidence.map(e => `${e.product} ${e.requestId}`).join(', ')}.`,
        summaryPlain: `Set aside ${money(delta > 0n ? delta : -delta)} against ${cust.name}'s unpaid invoices because ${because}.`,
        amountMinor: delta > 0n ? delta : -delta,
        periodYm: closeYm,
        closeTaskId: task(4),
      });
    }
    await pause(0.4);
  }
  // Vendors due a first payment or never verified. A clean owner check becomes a vendor check Proposal and only its
  // approval verifies the vendor, so verified vendors drop out of this list on later closes; blocked ones stay
  // blocked. A vendor whose vendor check is still undecided is not checked again.
  const canonical = (v: unknown) => (/^\d+$/.test(String(v)) ? BigInt(String(v)).toString() : String(v));
  const pendingCheck = new Set([...A.db.proposal.iter()].filter(p => p.kind.tag === 'VendorVerify' && ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag)).map(p => canonical(JSON.parse(p.payloadJson).vendorId)));
  const unverified = s.vendors.filter(v => v.verification.tag === 'Unverified' && v.ownerPersonaId && !pendingCheck.has(v.id.toString()));
  for (const v of unverified) {
    const result = await runCascade(crs, v.ownerPersonaId!, { subjectKind: 'vendor_owner' });
    for (const ev of result.evidence) {
      await C.reducers.recordCreditCheck({ subjectKind: 'vendor', subjectId: v.id, personaId: v.ownerPersonaId!, product: ev.product, requestId: ev.requestId ?? '', summaryJson: creditCheckSummaryJson(result, ev) });
    }
    const openBills = s.bills.filter(b => b.vendorId === v.id && b.status !== 'paid');
    const exposure = openBills.reduce((a, b) => a + b.amountMinor, 0n);
    if (result.tier === 'BLOCK') {
      await file(C, {
        kind: 'vendor_block',
        payload: { vendorId: v.id.toString(), reasonPlain: result.summaryPlain },
        rationale: `${v.name} is owned by a person whose identity and fraud checks fail: ${result.summaryTechnical}. ${openBills.length ? `${openBills.length} open bill(s) worth ${money(exposure)} must not be paid.` : 'No payment has gone out yet.'} Evidence: ${result.evidence.map(e => `${e.product} ${e.requestId}`).join(', ')}.`,
        summaryPlain: plainReasons(result, ['block']) ? `Block payments to ${v.name}: for its owner, ${titleCase(result.personaName)}, ${plainReasons(result, ['block'])}.` : `Block payments to ${v.name} because its owner failed the identity and fraud checks.`,
        amountMinor: exposure,
        periodYm: closeYm,
        closeTaskId: task(5),
      });
    } else if (result.decision === 'APPROVE' && (result.tier === 'A' || result.tier === 'B')) {
      // A vendor check cites the request ids of the owner's checks just recorded; the module requires identity and
      // fraud among them, each a clean APPROVE at tier A or B.
      await file(C, {
        kind: 'vendor_verify',
        payload: { vendorId: v.id.toString(), creditCheckIds: result.evidence.map(e => e.requestId).filter(Boolean), reasonPlain: result.summaryPlain },
        rationale: `${v.name}'s owner passed identity and fraud checks: ${result.summaryTechnical}. ${openBills.length ? `${openBills.length} open bill(s) worth ${money(exposure)} can be paid once this is approved.` : 'No bill is waiting yet.'} Evidence: ${result.evidence.map(e => `${e.product} ${e.requestId}`).join(', ')}.`,
        summaryPlain: `Mark ${v.name} as checked so their bills can be paid because their owner's identity and fraud checks came back clean.`,
        amountMinor: exposure,
        periodYm: closeYm,
        closeTaskId: task(5),
      });
    } else {
      await say(C, thread, `${v.name}'s owner check came back ${result.decision} at tier ${result.tier}: ${result.summaryTechnical} Leaving the vendor unverified for a human to review before any payment.`, `${v.name} needs a closer look before we pay them.`);
    }
  }
  await pause();

  // ---------------- Consolidation ----------------
  // Revalue the foreign subsidiary's balances and eliminate what the companies owe and charge each other.
  if (isGroup) {
    await runConsolidationStep(cast, closeYm, { log, pause, thread, taskId: consolidationTask, toleranceMinor: activeCharter(A, 'consolidation').params.icDifferenceToleranceMinor, file, refuse: r => refused.push(r) });
    await pause();
  }

  // ---------------- Red Team (scripted) then Advisor rulings ----------------
  const ruled = await ruleOpenProposals();
  for (const t of [...[1, 2, 3, 4, 5].map(task), consolidationTask]) {
    if (t === undefined) continue;
    const blocked = refused.filter(r => r.closeTaskId === t).length;
    await A.reducers.updateCloseTask(blocked ? { taskId: t, status: 'blocked', note: `${blocked} proposal(s) refused by the books; a person must fix and resubmit` } : { taskId: t, status: 'done', note: 'Rulings issued' });
  }

  const awaiting = [...A.db.proposal.iter()].filter(p => p.periodId === period.id && p.status.tag === 'AwaitingCfo');
  if (awaiting.length) {
    await say(A, thread, `${awaiting.length} material item(s) are waiting for the CFO's confirmation. I will ask to lock ${closeYm} as soon as they are decided.`, `${awaiting.length} items need the CFO's OK before the month can close.`, 'ruling');
    log(`waiting for CFO on ${awaiting.length} proposals`);
    if (noWait) {
      if (pendingScheduleCustomers.size) {
        await say(R, thread, `Not waiting for the CFO in this run, so the revenue catch-up for schedules still waiting for approval rolls into the next close's recognition entry.`, `Revenue from schedules waiting for approval will be counted in the next close.`);
      }
      await reportRefusals();
      return { proposals: ruled, awaitingCfo: awaiting.length, refused: refused.length };
    }
    await waitForCfo(A, period.id);
  }
  if (await catchUpRecognition()) {
    await say(A, thread, `The revenue catch-up is material and waits for the CFO's confirmation; I will ask to lock ${closeYm} once it is decided.`, `One more revenue item needs the CFO's OK before the month can close.`, 'ruling');
    if (noWait) {
      await reportRefusals();
      return { proposals: ruled + 1, awaitingCfo: 1, refused: refused.length };
    }
    await waitForCfo(A, period.id);
  }
  // Request the lock, unless something is left for a person (a refusal, a blocked task) or the books refuse it.
  await requestLock(`All ${ruled} proposals are decided and the bank feed is reconciled.`);
  return { proposals: ruled, awaitingCfo: awaiting.length, refused: refused.length };
}

async function waitForCfo(A: RoleConn, periodId: bigint, timeoutMs = 45 * 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Only the CFO's queue: a proposal left Open (a ruling the books refused) is a refusal for a person, not a wait.
    const pending = [...A.db.proposal.iter()].filter(p => p.periodId === periodId && (p.status.tag === 'AwaitingCfo' || p.status.tag === 'SentBack'));
    if (pending.length === 0) return;
    // Re-propose anything the CFO sent back: the Advisor re-approves with the CFO's note acknowledged.
    for (const p of pending.filter(x => x.status.tag === 'SentBack')) {
      const note = [...A.db.agentMessage.iter()].filter(m => m.proposalId === p.id && m.senderRole === 'cfo').pop();
      await A.reducers.approveProposal({ proposalId: p.id, rationale: `The CFO sent this back: "${note?.body ?? ''}". Re-reviewed the evidence; the proposal stands as written, resubmitting for confirmation.`, summaryPlain: `Resubmitting after the CFO's note: ${note?.summaryPlain ?? 'please take another look.'}`, amendedPayloadJson: undefined });
    }
    await sleep(1000);
  }
}

/** Current allowance for one customer: credit balance of 1150 tagged with the customer. */
function existingAllowance(s: Snapshot, customerId: bigint): bigint {
  const acct = s.accountByCode.get('1150');
  if (!acct) return 0n;
  let v = 0n;
  for (const l of s.journalLines) if (l.accountId === acct.id && l.customerId === customerId) v += l.creditMinor - l.debitMinor;
  return v;
}

function boardSummary(s: Snapshot, A: RoleConn) {
  const rev = -(s.balance('4000') + s.balance('4100'));
  const cash = s.balance('1000');
  const deferred = -s.balance('2400');
  const ar = s.balance('1100');
  const plain = `with ${money(cash)} in the bank, ${money(ar)} owed to us by customers, ${money(deferred)} of prepaid subscriptions still to earn, and ${money(rev)} of revenue so far this year`;
  const technical = `Trial balance ties; cash ${money(cash)}, AR ${money(ar)}, deferred revenue ${money(deferred)}, cumulative revenue ${money(rev)}.`;
  const group = groupSummary(A, s.closeYm);
  return group ? { plain: `${plain}; ${group.plain}`, technical: `${technical} ${group.technical}` } : { plain, technical };
}

/**
 * The consolidated group in one clause (whole dollars, so the plain summary stays one sentence) and its technical
 * figures; undefined on a single-company database or when the group's books cannot be consolidated.
 */
function groupSummary(A: RoleConn, closeYm: string): { plain: string; technical: string } | undefined {
  try {
    const g = groupSnapshot(A);
    const trading = g.entities.filter(e => !e.isElimination);
    if (trading.length < 2) return undefined;
    const c = consolidate({ entities: g.entities, accounts: g.accounts, lines: g.lines, rates: g.rates, reportingCcy: g.reportingCcy, asOfYm: ymFromString(closeYm) });
    const dollars = (n: bigint) => formatMinor(divRound(n, 100n) * 100n, g.reportingCcy, { trimZeroCents: true });
    const cents = (n: bigint) => formatMinor(n, g.reportingCcy);
    const groupCash = c.balanceSheet.rows.filter(r => r.groupCode === '1000').reduce((a, r) => a + r.consolidatedMinor, 0n);
    const t = c.balanceSheet.totals;
    return {
      plain: `across ${trading.map(e => e.name).join(' and ')} together the group holds ${dollars(groupCash)} in the bank and its combined balance sheet ${c.balanceSheet.balanced ? 'balances' : 'does not balance yet'}`,
      technical: `Consolidated in ${g.reportingCcy} at ${closeYm} closing rates: assets ${cents(t.assetsMinor)}, liabilities ${cents(t.liabilitiesMinor)}, equity ${cents(t.equityMinor)} including CTA ${cents(c.balanceSheet.ctaMinor)}; ${c.balanceSheet.balanced ? 'balanced' : 'NOT balanced'}; net income ${cents(c.incomeStatement.netIncomeMonthMinor)} for the month, ${cents(c.incomeStatement.netIncomeYtdMinor)} year to date; intercompany left after eliminations ${cents(c.unmatchedIcMinor)}.`,
    };
  } catch (e) {
    console.warn(`group summary skipped: ${(e as Error).message}`);
    return undefined;
  }
}
