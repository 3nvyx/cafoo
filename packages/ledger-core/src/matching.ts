import { absMinor } from './money.js';
import type { BankMatchCandidate, BankTransaction, Bill, Invoice, MatchBucket } from './types.js';
import { DAY_MICROS } from './ym.js';

export const MATCH_AUTO_BP = 7500;
export const MATCH_REVIEW_BP = 5000;

const STOPWORDS = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'the', 'co', 'corp', 'corporation', 'company', 'plc', 'gmbh', 'and', 'of', 'llp',
]);

/** Display names for counterparty comparison. */
export interface MatchNames {
  customers?: ReadonlyMap<bigint, string>;
  vendors?: ReadonlyMap<bigint, string>;
}

export function isBill(c: Invoice | Bill): c is Bill {
  return 'vendorId' in c;
}

export function matchBucket(scoreBp: number): MatchBucket {
  return scoreBp >= MATCH_AUTO_BP ? 'auto' : scoreBp >= MATCH_REVIEW_BP ? 'review' : 'unmatched';
}

/** Lowercase word tokens with business stopwords removed, de-duplicated, in first-seen order. */
export function nameTokens(s: string): string[] {
  const seen = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t && !STOPWORDS.has(t)) seen.add(t);
  }
  return [...seen];
}

function normRef(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * True when `ref` (>= 3 alphanumerics) appears in `text` as a whole token, case-insensitive,
 * tolerating one separator between characters ("INV-77" matches "inv77" and "INV 77", not "INV-770").
 */
export function refInText(ref: string, text: string): boolean {
  const n = normRef(ref);
  if (n.length < 3) return false;
  return new RegExp(`(^|[^A-Z0-9])${n.split('').join('[^A-Z0-9]?')}($|[^A-Z0-9])`).test(text.toUpperCase());
}

function numberInText(id: bigint, text: string): boolean {
  return new RegExp(`(^|[^0-9])0*${id.toString()}([^0-9]|$)`).test(text);
}

/** True when the bill's externalRef (normalized, >= 3 chars) or the document id appears in the text. */
export function referenceInText(candidate: Invoice | Bill, text: string): string | null {
  if (isBill(candidate)) {
    if (refInText(candidate.externalRef, text)) return candidate.externalRef;
  }
  return numberInText(candidate.id, text) ? candidate.id.toString() : null;
}

function plural(n: number | bigint, word: string): string {
  return `${n} ${word}${n === 1 || n === 1n ? '' : 's'}`;
}

/**
 * Score 0..10000bp: amount exact 5000 / within 1% 3000; date (bookedAt vs dueAt) <= 3 days 2000,
 * linear to 0 at 10 days; counterparty name words found up to 2000; reference in description 1000.
 * Invoices expect inflows and bills outflows; the wrong direction scores 0 on amount.
 */
export function scoreBankMatch(tx: BankTransaction, candidate: Invoice | Bill, names: MatchNames = {}): BankMatchCandidate {
  const reasons: string[] = [];
  let score = 0;
  const bill = isBill(candidate);
  const directionOk = bill ? tx.amountMinor < 0n : tx.amountMinor > 0n;
  const amt = absMinor(tx.amountMinor);
  const diff = absMinor(amt - candidate.amountMinor);
  if (!directionOk) {
    reasons.push(bill ? 'money came in, but a bill is paid with money going out' : 'money went out, but an invoice is paid with money coming in');
  } else if (diff === 0n) {
    score += 5000;
    reasons.push('amount matches exactly');
  } else if (diff * 100n <= candidate.amountMinor) {
    score += 3000;
    reasons.push('amount within 1%');
  }

  const dt = absMinor(tx.bookedAt - candidate.dueAt);
  const days = dt / DAY_MICROS;
  if (dt <= 3n * DAY_MICROS) {
    score += 2000;
    reasons.push(`paid ${plural(days, 'day')} from the due date`);
  } else if (dt < 10n * DAY_MICROS) {
    const pts = Number((2000n * (10n * DAY_MICROS - dt)) / (7n * DAY_MICROS));
    score += pts;
    if (pts > 0) reasons.push(`paid ${plural(days, 'day')} from the due date`);
  }

  const name = bill ? names.vendors?.get(candidate.vendorId) : names.customers?.get(candidate.customerId);
  if (name) {
    const want = nameTokens(name);
    const have = new Set(nameTokens(tx.counterparty));
    const hit = want.filter((t) => have.has(t)).length;
    if (want.length > 0 && hit > 0) {
      score += Math.floor((2000 * hit) / want.length);
      reasons.push(`counterparty name matches ${hit} of ${want.length} words`);
    }
  }

  const ref = referenceInText(candidate, tx.description);
  if (ref !== null) {
    score += 1000;
    reasons.push(`reference ${ref} found in the description`);
  }

  return {
    bankTxId: tx.id,
    targetKind: bill ? 'bill' : 'invoice',
    targetId: candidate.id,
    scoreBp: score,
    reasons,
    bucket: matchBucket(score),
  };
}

function cmpCandidate(a: BankMatchCandidate, b: BankMatchCandidate): number {
  if (a.scoreBp !== b.scoreBp) return b.scoreBp - a.scoreBp;
  if (a.bankTxId !== b.bankTxId) return a.bankTxId < b.bankTxId ? -1 : 1;
  if (a.targetKind !== b.targetKind) return a.targetKind < b.targetKind ? -1 : 1;
  return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
}

/**
 * Best candidate per unmatched transaction, one-to-one. Inflows are scored against unpaid invoices,
 * outflows against unpaid bills. Pairs scoring >= 5000 are assigned greedily, highest first
 * (ties: lower tx id, then kind, then target id); each target is consumed once. Transactions left
 * over get their best remaining candidate with bucket 'unmatched' (not consumed). Transactions with
 * no candidate scoring above 0 are omitted. Output follows input transaction order.
 */
export function scoreBankMatches(
  txs: readonly BankTransaction[],
  invoices: readonly Invoice[],
  bills: readonly Bill[],
  names: MatchNames = {},
): BankMatchCandidate[] {
  const openInv = invoices.filter((i) => i.status !== 'paid');
  const openBills = bills.filter((b) => b.status !== 'paid');
  const pairs: BankMatchCandidate[] = [];
  for (const tx of txs) {
    if (tx.matched || tx.amountMinor === 0n) continue;
    const pool: readonly (Invoice | Bill)[] = tx.amountMinor > 0n ? openInv : openBills;
    for (const c of pool) {
      const s = scoreBankMatch(tx, c, names);
      if (s.scoreBp > 0) pairs.push(s);
    }
  }
  pairs.sort(cmpCandidate);
  const key = (p: BankMatchCandidate) => `${p.targetKind}:${p.targetId}`;
  const consumed = new Set<string>();
  const chosen = new Map<bigint, BankMatchCandidate>();
  for (const p of pairs) {
    if (p.scoreBp < MATCH_REVIEW_BP) break;
    if (chosen.has(p.bankTxId) || consumed.has(key(p))) continue;
    chosen.set(p.bankTxId, p);
    consumed.add(key(p));
  }
  for (const p of pairs) {
    if (chosen.has(p.bankTxId) || consumed.has(key(p))) continue;
    chosen.set(p.bankTxId, { ...p, reasons: [...p.reasons], bucket: 'unmatched' });
  }
  const out: BankMatchCandidate[] = [];
  for (const tx of txs) {
    const c = chosen.get(tx.id);
    if (c) out.push(c);
  }
  return out;
}

export interface DuplicatePayment {
  billId: bigint;
  externalRef: string;
  /** The earliest payment. */
  firstTxId: bigint;
  duplicateTxId: bigint;
  /** Positive amount of the duplicate outflow. */
  amountMinor: bigint;
  daysApart: number;
}

export const DUPLICATE_WINDOW_DAYS = 45;

/**
 * Outflows whose description carries the same bill externalRef within 45 days of an earlier outflow
 * for that bill. Each duplicate is paired with the earliest payment in its window. Sorted by bill id,
 * then duplicate booking time.
 */
export function findDuplicatePayments(txs: readonly BankTransaction[], bills: readonly Bill[]): DuplicatePayment[] {
  const outflows = txs
    .filter((t) => t.amountMinor < 0n)
    .slice()
    .sort((a, b) => (a.bookedAt === b.bookedAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.bookedAt < b.bookedAt ? -1 : 1));
  const window = BigInt(DUPLICATE_WINDOW_DAYS) * DAY_MICROS;
  const out: DuplicatePayment[] = [];
  const sortedBills = bills.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const bill of sortedBills) {
    if (normRef(bill.externalRef).length < 3) continue;
    const hits = outflows.filter((t) => refInText(bill.externalRef, t.description));
    let anchor: BankTransaction | undefined;
    for (const t of hits) {
      if (anchor && t.bookedAt - anchor.bookedAt <= window) {
        out.push({
          billId: bill.id,
          externalRef: bill.externalRef,
          firstTxId: anchor.id,
          duplicateTxId: t.id,
          amountMinor: -t.amountMinor,
          daysApart: Number((t.bookedAt - anchor.bookedAt) / DAY_MICROS),
        });
      } else {
        anchor = t;
      }
    }
  }
  return out;
}
