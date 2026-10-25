/**
 * The continuous Bookkeeper: during an open month, bank lines that arrive from the live feed are matched and booked as
 * they land, instead of waiting for the month-end close. The decisions come from the same engines and wording as the
 * close's bank reconciliation (score_bank_matches, duplicate detection, outflow classification); the Red Team and the
 * Advisor rule on each batch (scripted/rulings.ts), and anything material waits for the CFO as usual.
 *
 * It reacts only to bank lines the feed ingested (feed_event rows), never to seed data, and never in a month whose
 * close has started, is running in this gateway, or is locked. Its Proposals carry no close task, so they never make
 * a month look closed; the close skips any bank line one of them already cites.
 */
import { findDuplicatePayments, formatMinor, scoreBankMatches, ymLabel, type BankTransaction, type Bill, type Invoice } from '@luyten/ledger-core';
import { classifyOutflow, dayLabel, vendorLookup } from '../bookkeeping';
import { citedBankTxIds as citedBy, closeOpenedAt, isFeedMonth } from '../close-state';
import { exactAmount, line, snapshot, type Snapshot } from '../snapshot';
import { ruleOpen, type Refusal } from '../scripted/rulings';
import { propose, say, type Cast, type RoleConn } from '../stdb';

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });
const abs = (n: bigint) => (n < 0n ? -n : n);

export interface FeedPlanParams {
  /** The open month the bank lines belong to. */
  ym: string;
  /** The root company the bank lines belong to. */
  subsidiaryId: bigint;
  /** Batch bank matches need every match at or above this confidence (the Bookkeeper charter's May 2). */
  batchMinScoreBp: number;
  /** Largest amount the Bookkeeper may propose; anything larger is left for a person. Undefined: no cap. */
  maxProposalMinor?: bigint;
  /** What a counterparty lookup found, by counterparty, for outflows the description does not explain. */
  lookups?: ReadonlyMap<string, string>;
}

export type ProposalDraft = Omit<Parameters<typeof propose>[2], 'closeTaskId'>;
export interface LeftForPerson {
  bankTxId: bigint;
  body: string;
  summaryPlain: string;
}
export interface FeedProposalPlan {
  drafts: ProposalDraft[];
  leftForPerson: LeftForPerson[];
  /** Counterparties of outflows the description does not explain and `lookups` has no finding for. */
  needsLookup: string[];
}

type Books = Pick<Snapshot, 'invoices' | 'bills' | 'customerName' | 'vendorName' | 'bankTxs'> & { vendors: readonly { id: bigint; name: string; verification: { tag: string } }[] };

const sameParty = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
};

/**
 * Proposals for bank lines that just arrived from the feed (pure). Exact matches at or above the batch threshold go in
 * one bank match; each less certain exact match gets its own; a near-amount match (a short or partial payment) and any
 * unexplained incoming money are left for a person; a second payment on the same bill reference is booked as money the
 * vendor owes back; other outflows are booked to the account their description names, payroll included. A payment to
 * a blocked vendor, or a Proposal over the amount cap, is left for a person.
 */
export function planFeedProposals(newTxs: readonly BankTransaction[], s: Books, params: FeedPlanParams): FeedProposalPlan {
  const { ym, batchMinScoreBp } = params;
  const subId = params.subsidiaryId.toString();
  const drafts: ProposalDraft[] = [];
  const leftForPerson: LeftForPerson[] = [];
  const needsLookup = new Set<string>();
  const fresh = newTxs.filter(t => !t.matched);
  const invById = new Map<bigint, Invoice>(s.invoices.map(i => [i.id, i]));
  const billById = new Map<bigint, Bill>(s.bills.map(b => [b.id, b]));
  const blocked = s.vendors.filter(v => v.verification.tag === 'Blocked');
  const capped = (amountMinor: bigint) => params.maxProposalMinor !== undefined && amountMinor > params.maxProposalMinor;
  const leave = (t: BankTransaction, why: string, plain: string) => leftForPerson.push({ bankTxId: t.id, body: `Bank transaction ${t.id} ("${t.description}", ${money(abs(t.amountMinor))}, ${t.counterparty}): ${why}`, summaryPlain: plain });
  const add = (d: ProposalDraft, t: BankTransaction) => {
    if (capped(d.amountMinor)) leave(t, `${money(d.amountMinor)} is over the ${money(params.maxProposalMinor!)} I may propose under my charter, so I am leaving it for a human.`, `The Bookkeeper left a payment over its limit for a person to record.`);
    else drafts.push(d);
  };

  const candidates = scoreBankMatches(fresh, s.invoices, s.bills, { customers: s.customerName, vendors: s.vendorName });
  const amountOf = (c: (typeof candidates)[number]) => (c.targetKind === 'invoice' ? invById.get(c.targetId)?.amountMinor : billById.get(c.targetId)?.amountMinor) ?? 0n;
  const exact = candidates.filter(c => c.bucket !== 'unmatched' && exactAmount(c, { bankTxs: [...fresh], invoices: s.invoices, bills: s.bills }));
  const batch = exact.filter(c => c.scoreBp >= batchMinScoreBp);
  const singles = exact.filter(c => c.scoreBp < batchMinScoreBp);
  const near = candidates.filter(c => c.bucket !== 'unmatched' && !exact.includes(c));
  const explained = new Set(candidates.filter(c => c.bucket !== 'unmatched').map(c => c.bankTxId));
  const txById = new Map(fresh.map(t => [t.id, t]));

  if (batch.length) {
    const total = batch.reduce((a, c) => a + amountOf(c), 0n);
    const inflows = batch.filter(c => c.targetKind === 'invoice').length;
    const outflows = batch.length - inflows;
    const minPct = Math.floor(Math.min(...batch.map(c => c.scoreBp)) / 100);
    const pays = (n: number, who: string) => `${n} ${who} payment${n === 1 ? '' : 's'}`;
    const what = inflows && outflows ? `${pays(inflows, 'customer')} and ${pays(outflows, 'vendor')} worth ${money(total)} to the invoices and bills they pay` : inflows ? `${pays(inflows, 'customer')} worth ${money(total)} to the invoices they pay` : `${pays(outflows, 'vendor')} worth ${money(total)} to the bills they pay`;
    drafts.push({
      kind: 'bank_match',
      payload: { matches: batch.map(c => ({ bankTxId: c.bankTxId.toString(), targetKind: c.targetKind, targetId: c.targetId.toString(), scoreBp: c.scoreBp })) },
      rationale: `${batch.length} bank transaction${batch.length === 1 ? '' : 's'} from the live feed matched at ${(batchMinScoreBp / 100).toFixed(0)}% confidence or better: ${inflows} customer payments to invoices and ${outflows} vendor payments to bills. Scores combine amount, date proximity, counterparty name overlap, and invoice or bill references in the bank description. Each match is one-to-one and pays its invoice or bill to the cent.`,
      summaryPlain: `Match ${what} as they arrive from the bank; every match is at least ${minPct}% confident.`,
      amountMinor: 0n,
      periodYm: ym,
    });
  }
  for (const c of singles) {
    const tx = txById.get(c.bankTxId)!;
    const inv = c.targetKind === 'invoice' ? invById.get(c.targetId) : undefined;
    const bill = c.targetKind === 'bill' ? billById.get(c.targetId) : undefined;
    const target = inv ? `invoice ${c.targetId} for ${s.customerName.get(inv.customerId) ?? 'a customer'}` : `bill ${bill?.externalRef ?? c.targetId} from ${s.vendorName.get(bill?.vendorId ?? 0n) ?? 'a vendor'}`;
    // The summary names a bill by its vendor and month: a bill reference ("NW-202609-7019") reads as a raw number.
    const targetPlain = bill ? `${s.vendorName.get(bill.vendorId) ?? 'a vendor'}'s ${ymLabel(bill.ym)} bill` : target;
    drafts.push({
      kind: 'bank_match',
      payload: { matches: [{ bankTxId: c.bankTxId.toString(), targetKind: c.targetKind, targetId: c.targetId.toString(), scoreBp: c.scoreBp }] },
      rationale: `Likely match at ${(c.scoreBp / 100).toFixed(0)}% confidence between bank transaction "${tx.description}" and ${target}. Reasons: ${c.reasons.join('; ')}. Below the ${(batchMinScoreBp / 100).toFixed(0)}% batch threshold, so this needs its own ruling.`,
      summaryPlain: `Probably match the ${money(abs(tx.amountMinor))} bank transaction from ${tx.counterparty} to ${targetPlain}; confidence ${(c.scoreBp / 100).toFixed(0)}%.`,
      amountMinor: 0n,
      periodYm: ym,
    });
  }
  for (const c of near) {
    const tx = txById.get(c.bankTxId)!;
    const inv = c.targetKind === 'invoice' ? invById.get(c.targetId) : undefined;
    const target = inv ? `invoice ${c.targetId} for ${s.customerName.get(inv.customerId) ?? 'a customer'}` : `bill ${billById.get(c.targetId)?.externalRef ?? c.targetId}`;
    leave(tx, `looks like ${target} (${money(amountOf(c))}) at ${(c.scoreBp / 100).toFixed(0)}% confidence, but the amounts differ. A bank match must be exact, so I am leaving this short or partial payment for a person to record.`, `The Bookkeeper left a payment that does not equal its ${c.targetKind} for a person to review.`);
  }

  // A second payment on the same bill reference: money the vendor owes back.
  const newIds = new Set(fresh.map(t => t.id));
  const all = [...new Map([...s.bankTxs, ...fresh].map(t => [t.id, t])).values()];
  const dups = findDuplicatePayments(all, s.bills).filter(d => newIds.has(d.duplicateTxId) && !explained.has(d.duplicateTxId));
  for (const d of dups) {
    const bill = billById.get(d.billId)!;
    const vendor = s.vendorName.get(bill.vendorId) ?? 'vendor';
    explained.add(d.duplicateTxId);
    add({
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: ym,
        memo: `Duplicate payment to ${vendor} on ${d.externalRef}; refund requested`,
        lines: [line('1250', d.amountMinor, 0n, `Due back from ${vendor} (duplicate payment)`, { vendorId: bill.vendorId }), line('1000', 0n, d.amountMinor, 'Second payment, same reference', { vendorId: bill.vendorId })],
        bankTxIds: [d.duplicateTxId.toString()],
      },
      rationale: `Bank transactions ${d.firstTxId} and ${d.duplicateTxId} both pay ${d.externalRef} (${money(d.amountMinor)}). The first settles the bill; the second is an overpayment. Record the cash out and a receivable from the vendor (1250 Receivable from Vendors) so the expense is not doubled, and request a refund.`,
      summaryPlain: `We paid ${vendor} twice for the same ${money(d.amountMinor)} bill; record the second payment as money they owe us back.`,
      amountMinor: d.amountMinor,
      periodYm: ym,
    }, txById.get(d.duplicateTxId)!);
  }

  for (const t of fresh) {
    if (explained.has(t.id)) continue;
    if (t.amountMinor >= 0n) {
      leave(t, 'incoming money with no matching invoice. I do not guess which customer paid, so I am leaving it for a human.', `The Bookkeeper left a payment it could not tie to an invoice for a person to identify.`);
      continue;
    }
    const payee = blocked.find(v => sameParty(t.counterparty, v.name));
    if (payee) {
      leave(t, `${payee.name} is blocked, so I will not book a payment to them; a person needs to look at how this money left.`, `The Bookkeeper flagged a payment to a blocked vendor for a person to review.`);
      continue;
    }
    const amt = -t.amountMinor;
    const k = classifyOutflow(t);
    if (k.needsLookup && !params.lookups?.has(t.counterparty)) needsLookup.add(t.counterparty);
    const lookup = k.needsLookup ? (params.lookups?.get(t.counterparty) ?? `no public record found for "${t.counterparty}"; classifying from the bank description.`) : '';
    add({
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: ym,
        memo: `${k.label}: ${t.description}`,
        lines: [line(k.code, amt, 0n, t.description), line('1000', 0n, amt, `Bank: ${t.counterparty}`)],
        bankTxIds: [t.id.toString()],
      },
      rationale: `Bank outflow of ${money(amt)} to ${t.counterparty} has no invoice or bill. ${lookup || `Description "${t.description}" indicates ${k.label.toLowerCase()}.`} Booking directly to ${k.label} (${k.code}).`,
      summaryPlain: `Record the ${money(amt)} paid to ${t.counterparty} on ${dayLabel(t.bookedAt)} as ${k.label.toLowerCase()}.`,
      amountMinor: amt,
      periodYm: ym,
    }, t);
  }
  return { drafts, leftForPerson, needsLookup: [...needsLookup] };
}

export interface ContinuousOptions {
  /** Quiet time after the last insert before the Bookkeeper acts (FEED_DEBOUNCE_MS). */
  debounceMs: number;
  /** Is a close running in this gateway for that month? Then the close handles the month. */
  isClosing?: (ym: string) => boolean;
  /** Batch threshold and amount cap from the Bookkeeper's active charter. */
  params?: () => { batchMinScoreBp: number; maxProposalMinor?: bigint };
  onStep?: (m: string) => void;
}

/** Bank lines any Proposal ever cited (pending, approved or rejected): the continuous Bookkeeper files each line once. */
export const citedBankTxIds = (c: RoleConn) => citedBy(c);

/**
 * Feed bank lines waiting for the Bookkeeper, by month: ingested by the feed, unmatched, never cited by a Proposal, in
 * a feed month (open, the month before it locked by the CFO, its own close not opened) whose close is not running here.
 */
export function waitingFeedLines(c: RoleConn, opts: { isClosing?: (ym: string) => boolean; skip?: ReadonlySet<bigint> } = {}): Map<string, bigint[]> {
  const fed = new Set([...c.db.feedEvent.iter()].filter(e => e.kind.tag === 'BankTx').map(e => e.rowId));
  const cited = citedBankTxIds(c);
  const periods = new Map([...c.db.period.iter()].map(p => [p.ym, p]));
  // A line already left for a person (said in its month's close thread) is not announced again after a restart.
  const announced = new Set(
    [...c.db.agentMessage.iter()]
      .filter(m => m.senderRole === 'bookkeeper' && m.threadId.startsWith('close:'))
      .map(m => /^Bank transaction (\d+) \(/.exec(m.body)?.[1])
      .filter((x): x is string => x !== undefined)
  );
  const byYm = new Map<string, bigint[]>();
  for (const t of c.db.bankTransaction.iter()) {
    if (!fed.has(t.id) || t.matched || cited.has(t.id) || announced.has(t.id.toString()) || opts.skip?.has(t.id)) continue;
    if (!periods.has(t.ym) || opts.isClosing?.(t.ym)) continue;
    byYm.set(t.ym, [...(byYm.get(t.ym) ?? []), t.id]);
  }
  for (const ym of [...byYm.keys()]) if (!isFeedMonth(c, ym)) byYm.delete(ym);
  return byYm;
}

/**
 * Propose for every waiting feed line of one month, then have the Red Team and the Advisor rule on what was filed.
 * The month's close takes over the moment it opens (or starts in this gateway): no further Proposal is filed, and any
 * filed before the close opened is left for the close to rule on. Returns the Proposals filed and the lines left for
 * a person.
 */
export async function bookFeedLines(cast: Cast, ym: string, ids: readonly bigint[], opts: Pick<ContinuousOptions, 'params' | 'onStep' | 'isClosing'> = {}) {
  const A = cast.advisor;
  const B = cast.bookkeeper;
  const thread = `close:${ym}`;
  const log = (m: string) => {
    opts.onStep?.(m);
    console.log(`[feed bookkeeper ${ym}] ${m}`);
  };
  const s = snapshot(A, ym);
  const want = new Set(ids);
  const newTxs = s.bankTxs.filter(t => want.has(t.id));
  if (!newTxs.length) return { proposed: 0, left: 0 };
  const params = { batchMinScoreBp: 7500, ...opts.params?.() };
  const base = { ym, subsidiaryId: s.subsidiary.id, ...params };
  // Look up the payees the descriptions do not explain first, and say what was found in the close thread.
  const lookups = new Map<string, string>();
  for (const who of planFeedProposals(newTxs, s, base).needsLookup) {
    const found = await vendorLookup(who);
    lookups.set(who, found);
    await say(B, thread, `Unknown counterparty "${who}". Looked them up: ${found}`, `The Bookkeeper looked up ${who} on the web.`);
  }
  const plan = planFeedProposals(newTxs, s, { ...base, lookups });
  await say(B, thread, `${newTxs.length} new bank transaction${newTxs.length === 1 ? '' : 's'} arrived from the live feed for ${ym}. Matching and booking them now; nothing posts until the Advisor rules.`, `The Bookkeeper is handling ${newTxs.length} new bank transaction${newTxs.length === 1 ? '' : 's'} from the live feed.`);
  for (const l of plan.leftForPerson) await say(B, thread, l.body, l.summaryPlain);
  const filed: Awaited<ReturnType<typeof propose>>[] = [];
  const refused: Refusal[] = [];
  const closeTookOver = () => closeOpenedAt(A, ym) !== undefined || opts.isClosing?.(ym) === true;
  for (const d of plan.drafts) {
    if (closeTookOver()) {
      log(`the ${ym} close started; leaving the remaining ${plan.drafts.length - filed.length - refused.length} proposal(s) to it`);
      break;
    }
    try {
      filed.push(await propose(B, A, d));
    } catch (e) {
      const why = (e as Error).message;
      log(`proposal refused: ${why}`);
      refused.push({ kind: d.kind, summaryPlain: d.summaryPlain, why });
      await say(B, thread, `The books refused my ${d.kind.replace(/_/g, ' ')} proposal "${d.summaryPlain}": ${why} Leaving it for a person to review.`, `The Bookkeeper could not file one proposal and left it for a person to review.`).catch(() => undefined);
    }
  }
  // One ruler per Proposal: what was filed before the close opened is the close's to rule on once it has opened.
  const openedAt = closeOpenedAt(A, ym);
  const mine = filed.filter(p => openedAt === undefined || p.createdAt.microsSinceUnixEpoch >= openedAt).sort((a, b) => Number(a.id - b.id));
  if (mine.length < filed.length) log(`${filed.length - mine.length} proposal(s) left for the ${ym} close to rule on`);
  if (mine.length) await ruleOpen(cast, mine, { thread, snapshot: snapshot(A, ym), log, refused });
  log(`${filed.length} proposal(s) filed, ${plan.leftForPerson.length} line(s) left for a person, ${refused.length} refused`);
  return { proposed: filed.length, left: plan.leftForPerson.length };
}

export interface ContinuousBookkeeper {
  stop(): void;
  /** Resolves once no batch is in flight (the gateway waits for it before starting a close). */
  idle(): Promise<void>;
}

/**
 * Watch the bank feed and book what arrives: debounced on bank_transaction inserts (and once at start, to pick up
 * lines that arrived while the gateway was down).
 */
export function startContinuousBookkeeper(cast: Cast, opts: ContinuousOptions): ContinuousBookkeeper {
  const A = cast.advisor;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  /** Lines this process already handled, so a line left for a person is not announced again on every insert. */
  const handled = new Set<bigint>();
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      try {
        for (const [ym, ids] of waitingFeedLines(A, { isClosing: opts.isClosing, skip: handled })) {
          if (stopped) return;
          ids.forEach(id => handled.add(id));
          await bookFeedLines(cast, ym, ids, opts);
        }
      } catch (e) {
        console.error('continuous bookkeeper failed:', e);
        opts.onStep?.(`continuous bookkeeper failed: ${(e as Error).message}`);
      }
    })();
    await running;
    running = undefined;
    if (again && !stopped) {
      again = false;
      schedule();
    }
  };
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), opts.debounceMs);
  };
  const onInsert = () => schedule();
  A.db.bankTransaction.onInsert(onInsert);
  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      A.db.bankTransaction.removeOnInsert(onInsert);
    },
    async idle() {
      while (running) await running;
    },
  };
}
