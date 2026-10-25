/**
 * Demo-mode rulings: the Red Team critiques each open Proposal (its scripted critique, then Gemini's scripted second
 * critique from fixtures/gemini/) and the Advisor rules on it, the same way whether a
 * close runs fresh, resumes, or the continuous Bookkeeper filed the Proposals from the live bank feed. The critiques
 * and rulings are scripted per kind; the approval reducer still decides post-now or wait-for-the-CFO, and a ruling the
 * books refuse is recorded as a refusal (the Proposal is rejected so the close can continue).
 */
import { formatMinor } from '@luyten/ledger-core';
import { scriptedGeminiCritique } from '../gemini';
import { IC_DIFFERENCE_TOLERANCE_MINOR } from '../harness/consolidation';
import type { Snapshot } from '../snapshot';
import { say, type Cast, type RoleConn } from '../stdb';

export type ProposalRow = NonNullable<ReturnType<RoleConn['db']['proposal']['id']['find']>>;

/** A Proposal the books refused (at propose or at the ruling): its close task stays open and no lock is requested. */
export type Refusal = { kind: string; summaryPlain: string; why: string; closeTaskId?: bigint };

export interface RuleOpenOptions {
  /** Thread the Red Team and the Advisor speak in (close:YYYY-MM, or the feed's thread). */
  thread: string;
  /** Materiality threshold and vendor names, from a fresh snapshot. */
  snapshot: Pick<Snapshot, 'materiality' | 'vendorName'>;
  log?: (m: string) => void;
  /** Narration pause, in multiples of the demo step. Default: none. */
  pause?: (mult?: number) => Promise<void>;
  /** Refusals are pushed here. */
  refused?: Refusal[];
  /** Write Gemini's scripted second critique after the first. Default true; false when the live critic (startCritic) already ran Gemini on these. */
  secondCritic?: boolean;
}

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });
/** A Proposal kind tag as the module stores the kind: "BankMatch" → "bank_match". */
export const kindOfTag = (tag: string) => tag.replace(/[A-Z]/g, (c, i) => `${i ? '_' : ''}${c.toLowerCase()}`);

/** The combined score does not identify which amount, date, name or reference evidence is weak. */
export function weakBankMatchCritique(scoreBp: number): { body: string; summaryPlain: string } {
  return {
    body: `Confidence ${(scoreBp / 100).toFixed(0)}% is below the auto threshold. The combined score alone does not establish which matching evidence is weak. Ask the customer for remittance detail before matching, because a wrong match would show an unpaid invoice as paid.`,
    summaryPlain: `The Red Team asks for payment details because the match confidence is too low.`,
  };
}

/**
 * The Red Team's critique of an elimination: a difference over the one-dollar tolerance is a disagreement for a person;
 * a smaller one is translation rounding (the activity pair at the average rate is usually a cent apart); none agrees.
 */
export function eliminationCritique(payload: { pairs?: unknown; basis?: unknown }): { body: string; summaryPlain: string } {
  // A balance elimination reverses next month; an activity elimination covers one month and never reverses.
  const carry = payload.basis === 'activity'
    ? `It covers this month's activity only, so confirm next month's fees are eliminated on their own and not carried over.`
    : `Confirm it reverses next month so the group does not remove the same balance twice.`;
  const pairs = (Array.isArray(payload.pairs) ? payload.pairs : []) as { label?: string; differenceMinor?: unknown }[];
  const gap = (x: { differenceMinor?: unknown }) => {
    const d = /^-?\d+$/.test(String(x.differenceMinor ?? '0')) ? BigInt(String(x.differenceMinor ?? '0')) : 0n;
    return d < 0n ? -d : d;
  };
  const off = pairs.filter(x => gap(x) > IC_DIFFERENCE_TOLERANCE_MINOR);
  const rounding = pairs.filter(x => gap(x) > 0n && gap(x) <= IC_DIFFERENCE_TOLERANCE_MINOR);
  if (off.length) {
    return {
      body: `The two companies' books disagree on ${off.map(x => `${x.label ?? 'a pair'} by ${money(gap(x))}`).join(', ')}, over the one-dollar tolerance. Eliminating the source side only leaves that difference in the group's books; confirm which side is wrong before this posts.`,
      summaryPlain: `The Red Team asks which company's books are wrong before removing the amount.`,
    };
  }
  if (rounding.length) {
    return {
      body: `The other company's side translates to within ${rounding.map(x => `${money(gap(x))} on ${x.label ?? 'a pair'}`).join(', ')}, which is rounding at the translation rate and under the one-dollar tolerance, so the elimination rightly removes the source company's own amount. ${carry}`,
      summaryPlain: `The Red Team agrees: the two companies' books match apart from a few cents of currency rounding.`,
    };
  }
  return {
    body: `Both sides agree to the cent after translating the subsidiary's side, so the elimination removes the full amount. ${carry}`,
    summaryPlain: `The Red Team agrees: both companies' books match, so the amount can be removed.`,
  };
}

/**
 * The Red Team critiques every given Proposal and the Advisor rules on each. Returns how many Proposals were ruled.
 * Proposals are taken in the order given (callers pass them by id).
 */
export async function ruleOpen(cast: Cast, proposals: readonly ProposalRow[], opts: RuleOpenOptions): Promise<number> {
  const { thread, snapshot: s } = opts;
  const log = opts.log ?? (() => undefined);
  const pause = opts.pause ?? (async () => undefined);
  const refused = opts.refused ?? [];
  const A = cast.advisor;
  const RT = cast.redteam;
  const open = proposals;
  await say(RT, thread, `Reviewing ${open.length} proposals before the Advisor rules. I will challenge anything that leans on a weak match, an assumed rate, or a single data source.`, `The Red Team is reviewing ${open.length} proposals.`);
  const rulings: { id: bigint; action: 'approve' | 'reject'; rationale: string; plain: string }[] = [];
  /** Gemini's scripted second critique, after the first one on the same Proposal. */
  const second = async (p: ProposalRow) => {
    if (opts.secondCritic === false) return;
    const g = scriptedGeminiCritique(p, s.materiality, id => s.vendorName.get(id));
    if (g) await RT.reducers.critique({ proposalId: p.id, ...g });
  };
  for (const p of open) {
    // A plain string: the consolidation kinds arrive with the multi-entity bindings.
    const kind: string = p.kind.tag;
    const payload = JSON.parse(p.payloadJson);
    if (kind === 'BankMatch' && payload.matches?.length === 1 && payload.matches[0].scoreBp < 7500) {
      await RT.reducers.critique({ proposalId: p.id, ...weakBankMatchCritique(payload.matches[0].scoreBp) });
      await second(p);
      rulings.push({ id: p.id, action: 'reject', rationale: `The Red Team is right: at ${(payload.matches[0].scoreBp / 100).toFixed(0)}% confidence this match is a guess. Leave the transaction unmatched, request remittance detail, and revisit next week.`, plain: `Not matching this one yet; we will ask the customer what the payment was for.` });
      continue;
    }
    if (kind === 'JournalEntry' && /Allowance for doubtful/.test(payload.memo) && p.amountMinor >= s.materiality) {
      const bankruptcy = /bankruptcy/i.test(p.summaryPlain);
      if (bankruptcy) {
        await RT.reducers.critique({ proposalId: p.id, body: `The proposal cites bankruptcy risk. Before posting, confirm that the recorded bankruptcy belongs to this guarantor, check whether any debt is secured or prepaid, and reconcile payments not yet matched. The summary alone does not establish those facts.`, summaryPlain: `The Red Team asks the CFO to check the bankruptcy evidence and any payments before confirming this reserve.` });
        await second(p);
        rulings.push({ id: p.id, action: 'approve', rationale: `Reserve approved as proposed, pending the CFO's confirmation because it is material. The CFO must check the cited bankruptcy evidence, collateral, prepayments and unmatched receipts before deciding whether the proposed reserve is appropriate.`, plain: `The CFO must check the evidence and unpaid balance before this reserve posts.` });
      } else {
        await RT.reducers.critique({ proposalId: p.id, body: `Check the proposed reserve against the customer's recorded risk tier and confirm the open balance excludes payments received but not yet matched. Reconcile those receipts before deciding whether the proposed reserve is appropriate; the proposal alone does not establish a payment history.`, summaryPlain: `The Red Team asks to confirm the unpaid balance before reserving against it.` });
        await second(p);
        rulings.push({ id: p.id, action: 'approve', rationale: `Reserve approved as proposed, subject to the CFO's confirmation because it is material. Matched invoices are excluded from the recorded open balance, but unmatched receipts still need reconciliation before the CFO decides whether this reserve is appropriate.`, plain: `The CFO must confirm the unpaid balance before this reserve posts.` });
      }
      continue;
    }
    if (kind === 'RevenueSchedule') {
      await RT.reducers.critique({ proposalId: p.id, body: `Straight-line is appropriate for a flat annual subscription. Check that the invoice date, not the signature date, starts the schedule, and that the term is 12 months inclusive.`, summaryPlain: `The Red Team agrees with straight-line and asks to confirm the start month.` });
      await second(p);
      rulings.push({ id: p.id, action: 'approve', rationale: `Schedule approved. The term runs from the invoice month for 12 months inclusive, which matches the contract.`, plain: `Approved: the schedule follows the contract's twelve months.` });
      continue;
    }
    if (kind === 'VendorVerify') {
      const vendor = s.vendorName.get(BigInt(payload.vendorId)) ?? 'this vendor';
      await RT.reducers.critique({ proposalId: p.id, body: `The owner's identity and fraud checks are clean, so verification is reasonable. Before the first payment, confirm the bank account on the bill belongs to ${vendor} and not to a look-alike.`, summaryPlain: `The Red Team agrees and asks to confirm the bank details before the first payment.` });
      await second(p);
      rulings.push({ id: p.id, action: 'approve', rationale: `Vendor check approved. The cited identity and fraud checks on the owner came back APPROVE at tier A or B; the Red Team's bank-detail check goes to whoever releases the first payment.`, plain: `Approved: ${vendor} can be paid now that their owner checks out.` });
      continue;
    }
    if (kind === 'VendorBlock') {
      await RT.reducers.critique({ proposalId: p.id, body: `Agree with the block. One caution: notify procurement before the bill's due date so the engagement is cancelled, not just unpaid.`, summaryPlain: `The Red Team agrees and asks that procurement be told.` });
      await second(p);
      rulings.push({ id: p.id, action: 'approve', rationale: `Block approved. Identity and fraud checks fail on the owner; no payment leaves until a verified owner is on file. Procurement will be notified.`, plain: `Approved: no money goes to this vendor until a real owner is verified.` });
      continue;
    }
    if (kind === 'FxRevaluation') {
      const material = p.amountMinor >= s.materiality;
      await RT.reducers.critique({ proposalId: p.id, body: `The rate is the recorded closing rate for ${String(payload.periodYm ?? 'the month')} and only balances held in another currency are restated, which is right. One check: nothing in these balances should have been settled after month end, or the gain or loss is overstated.`, summaryPlain: `The Red Team agrees with the rate and asks whether anything was paid after month end.` });
      await second(p);
      rulings.push({ id: p.id, action: 'approve', rationale: `Revaluation approved. The books re-check each balance and the closing rate at apply, and the difference lands on the company's own currency gain or loss account. ${material ? 'Material, so it waits for the CFO.' : 'Below the materiality threshold, so it posts now.'}`, plain: `Approved: restate the foreign-currency balances at the month's closing rate${material ? '; the CFO gets the final say because it is large' : ''}.` });
      continue;
    }
    if (kind === 'IcElimination') {
      await RT.reducers.critique({ proposalId: p.id, ...eliminationCritique(payload) });
      await second(p);
      const material = p.amountMinor >= s.materiality;
      const what = payload.basis === 'activity' ? `the fees the two companies charged each other from the group's combined results` : `what the two companies owe each other from the group's combined balance sheet`;
      rulings.push({
        id: p.id,
        action: 'approve',
        rationale: `Elimination approved. Each pair's amount is the source company's own ${payload.basis === 'activity' ? "activity this month" : 'balance'} on its intercompany account (the books re-check it at apply), the entry posts only to the elimination subsidiary, and ${payload.reversesInYm ? `it reverses in ${String(payload.reversesInYm)}` : "it covers this month's activity only, so nothing carries over"}. ${material ? 'Material, so it waits for the CFO.' : 'Below the materiality threshold, so it posts now.'}`,
        plain: `Approved: remove ${what}${material ? '; the CFO gets the final say because it is large' : ''}.`,
      });
      continue;
    }
    rulings.push({ id: p.id, action: 'approve', rationale: `Reviewed the evidence and the Red Team raised no objection. Approved as proposed.`, plain: `Approved as proposed.` });
  }
  await pause();

  await say(A, thread, `Ruling on ${rulings.length} proposals. Anything at or above ${money(s.materiality)} waits for the CFO.`, `The Advisor is ruling on ${rulings.length} proposals.`, 'ruling');
  for (const r of rulings) {
    try {
      if (r.action === 'approve') await A.reducers.approveProposal({ proposalId: r.id, rationale: r.rationale, summaryPlain: r.plain, amendedPayloadJson: undefined });
      else await A.reducers.rejectProposal({ proposalId: r.id, rationale: r.rationale, summaryPlain: r.plain });
    } catch (e) {
      const why = (e as Error).message;
      log(`ruling on ${r.id} failed: ${why}`);
      const row = A.db.proposal.id.find(r.id);
      refused.push({ kind: row ? kindOfTag(row.kind.tag) : 'proposal', summaryPlain: row?.summaryPlain ?? `proposal ${r.id}`, why, closeTaskId: row?.closeTaskId });
      await A.reducers.rejectProposal({ proposalId: r.id, rationale: `Could not apply this proposal: ${why}. Rejected so the close can continue; the proposer should resubmit.`, summaryPlain: `Not posted: the books refused this entry (${why.slice(0, 80)}).` }).catch(() => undefined);
    }
    await pause(0.25);
  }
  return rulings.length;
}
