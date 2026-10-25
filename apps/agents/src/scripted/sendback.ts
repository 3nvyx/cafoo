/**
 * How the scripted close answers a CFO send-back. It never resubmits a proposal unchanged: a note that names a reserve
 * rate or amount for an allowance is applied as an Advisor amendment (which always returns to the CFO), and any other
 * note is answered honestly with a rejection, so nothing posts that the CFO questioned. The live Advisor, with keys, can
 * revise other kinds of proposal from a note.
 */
import { applyBp, formatMinor } from '@luyten/ledger-core';
import { line, type ModuleLine } from '../snapshot';

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });

export type SendBackAnswer =
  | { action: 'amend'; payloadJson: string; rationale: string; summaryPlain: string }
  | { action: 'reject'; rationale: string; summaryPlain: string };

/** What the books say about a customer's receivable, for recomputing a reserve. */
export type ReserveFacts = { openArMinor: (customerId: bigint) => bigint; allowanceMinor: (customerId: bigint) => bigint; customerName: (customerId: bigint) => string };

/**
 * The rate or amount the CFO asks for. "reserve 50% not 75%", "use 50% instead of 75%" and "make it 50%" all mean 50%:
 * a figure after "not", "instead of", "rather than" or "from" is the one being replaced. Amounts are the allowance the
 * CFO wants on the books for the customer ("reserve $10,000").
 */
export function askedFor(note: string): { bp: bigint } | { minor: bigint } | null {
  const replaced = /(?:\bnot|\binstead of|\brather than|\bfrom)\s*$/i;
  const pick = (re: RegExp) => {
    for (const m of note.matchAll(re)) if (!replaced.test(note.slice(0, m.index))) return m;
    return undefined;
  };
  const pct = pick(/(\d{1,3}(?:\.\d{1,2})?)\s*%/g);
  if (pct) {
    const [whole, frac = ''] = pct[1]!.split('.');
    const bp = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2) || '0');
    return bp <= 10_000n ? { bp } : null;
  }
  const usd = pick(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g);
  if (usd) return { minor: BigInt(usd[1]!.replace(/,/g, '')) * 100n + BigInt(usd[2] ?? '0') };
  return null;
}

const ALLOWANCE = /^Allowance for doubtful accounts/;

export function answerSendBack(p: { kind: { tag: string }; payloadJson: string; amountMinor: bigint }, note: string, facts: ReserveFacts): SendBackAnswer {
  const quoted = `The CFO sent this back: "${note.trim()}".`;
  const cannot = (why: string): SendBackAnswer => ({
    action: 'reject',
    rationale: `${quoted} ${why} Rejected rather than resubmitted unchanged, so nothing posts that the CFO questioned. It can be proposed again at the next close, or revised by the live Advisor.`,
    summaryPlain: `Not posted: I could not apply your note automatically (${why.replace(/\.$/, '').toLowerCase()}).`,
  });
  let payload: { memo?: string; lines?: ModuleLine[]; [k: string]: unknown };
  try {
    payload = JSON.parse(p.payloadJson);
  } catch {
    return cannot('The proposal could not be read.');
  }
  const reserveLine = payload.lines?.find(l => l.accountCode === '1150' && l.customerId);
  if (p.kind.tag !== 'JournalEntry' || !ALLOWANCE.test(payload.memo ?? '') || !reserveLine) {
    return cannot('The scripted agents can only rework an allowance from a rate or an amount in the note.');
  }
  const ask = askedFor(note);
  if (!ask) return cannot('The note names no reserve rate (such as 50%) or amount (such as $10,000).');
  const customerId = BigInt(reserveLine.customerId!);
  const name = facts.customerName(customerId);
  const ar = facts.openArMinor(customerId);
  const existing = facts.allowanceMinor(customerId);
  const target = 'bp' in ask ? applyBp(ar, ask.bp) : ask.minor;
  const delta = target - existing;
  const how = 'bp' in ask ? `${money(ar)} of open receivables at ${Number(ask.bp) / 100}% is ${money(target)}` : `the CFO set the reserve at ${money(target)}`;
  if (delta === 0n) return cannot(`At that level the reserve is ${money(target)}, which is already on the books.`);
  const lines = delta > 0n
    ? [line('5700', delta, 0n, `Expected credit loss ${name}`, { customerId }), line('1150', 0n, delta, `Allowance ${name}`, { customerId })]
    : [line('1150', -delta, 0n, `Release allowance ${name}`, { customerId }), line('5700', 0n, -delta, `Release expected credit loss ${name}`, { customerId })];
  const size = delta > 0n ? delta : -delta;
  return {
    action: 'amend',
    payloadJson: JSON.stringify({ ...payload, memo: `${payload.memo} (revised at the CFO's request)`, lines }),
    rationale: `${quoted} Recomputed: ${how}; the current allowance is ${money(existing)}, so ${delta > 0n ? 'set aside' : 'release'} ${money(size)} (the original proposal was ${money(p.amountMinor)}). An amendment always returns to the CFO.`,
    summaryPlain: `Revised as you asked: ${delta > 0n ? 'set aside' : 'release'} ${money(size)} for ${name} instead of ${money(p.amountMinor)}; it needs your OK again.`,
  };
}
