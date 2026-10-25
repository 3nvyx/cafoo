/**
 * "Ask the books": answers chat questions from the live ledger.
 * Demo mode answers deterministic questions from the tables; live mode hands the question to the Advisor.
 * A close starts only on an explicit command ("start the close") at the start of the CFO's latest message, never
 * because a question or a chat client's background prompt happens to mention the close.
 */
import { applyFx, closeOrderRefusal, dateLabel, formatMinor, isGroup, LedgerError, targetAllowanceMinor, ymEndMicros, ymFromString, ymToString } from '@luyten/ledger-core';
import { z } from 'zod';
import { agentsLive, GATEWAY_PORT } from './env';
import { snapshot } from './snapshot';
import { bankExceptionsOf, closeHasWork } from './close-state';
import type { Cast } from './stdb';
import { advisorReport } from './advisor-report';
import { searchPolicies } from './redteam';
import { matchesTerm, queryTerms, stems } from './moss';

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });
/** Whole minor units as the module's parseLines reads them: a string or number of digits; absent or "" is the default. */
const minor = (fallback: bigint) => z.union([z.string(), z.number()]).optional().transform((x, ctx) => {
  const s = x === undefined ? '' : String(x).trim();
  if (s === '') return fallback;
  if (!/^-?\d+$/.test(s)) {
    ctx.addIssue({ code: 'custom', message: 'not whole minor units' });
    return z.NEVER;
  }
  return BigInt(s);
});
const pendingEntry = z.object({ lines: z.array(z.object({ accountCode: z.string(), debitMinor: minor(0n), creditMinor: minor(0n), fxRateE6: minor(1_000_000n) })) });
/**
 * Revenue a pending journal entry would post, in the functional currency, the way the module posts it: each side
 * converted on its own, and a zero rate read as 1.0. A payload the module would refuse counts as nothing.
 */
function pendingRevenue(payloadJson: string, isRevenue: (code: string) => boolean): bigint {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    return 0n;
  }
  const parsed = pendingEntry.safeParse(raw);
  if (!parsed.success) return 0n;
  let total = 0n;
  for (const l of parsed.data.lines) {
    if (!isRevenue(l.accountCode)) continue;
    const rate = l.fxRateE6 === 0n ? 1_000_000n : l.fxRateE6;
    if (rate < 0n) return 0n;
    total += applyFx(l.creditMinor, rate) - applyFx(l.debitMinor, rate);
  }
  return total;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** Month words that are also everyday words or names ("may", "march", "Jan from audit"): a month only next to a year or after a preposition (or "lock", as in "can we lock August"). */
const AMBIGUOUS = new Set(['jan', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'aug', 'august']);
const MONTH_RE = new RegExp(`(\\b(?:in|for|of|during|since|through|until|from|to|by|lock)\\s+)?\\b(${MONTH_WORD})\\b\\.?(?:\\s+(?:of\\s+)?(\\d{4}))?`, 'gi');
/** A month slot inside a close command: YYYY-MM, or a month name with an optional year. */
const MONTH_SLOT = `(?:\\d{4}-\\d{2}|${MONTH_WORD}\\.?(?:\\s+\\d{4})?)`;
/**
 * The whole message is the command: an optional "please", start/run/begin/kick off, an optional month slot, "close",
 * an optional trailing "for <month>", then only "please"/"now" and full stops or exclamation marks. No question mark,
 * no second sentence, nothing else ("run the close report" and "start the close? no, …" are not commands).
 */
const CLOSE_COMMAND = new RegExp(
  // The tail is one character class, so a long run of spaces cannot make the match backtrack quadratically.
  `^\\s*(?:please\\s+)?(?:start|run|begin|kick\\s+off)\\s+(?:the\\s+)?(?:(?<slot>${MONTH_SLOT})(?:'s)?\\s+)?(?:month.?end\\s+)?close(?:\\s+for\\s+(?:the\\s+month\\s+of\\s+)?(?<for>${MONTH_SLOT}))?(?:[\\s,]+(?:please|now)\\b)*[\\s.!]*$`,
  'i'
);

/** The policy's sentences that share the most words with the question, in their original order (at most three). */
/** Words every policy question uses, which say nothing about which passage answers it. */
const POLICY_QUESTION_WORDS = new Set(stems('policy policies luyten account house rule'));

export function policyExcerpt(text: string, question: string): string {
  // Stems, so "reserves" finds "reserve" and "accrued" finds "accrual"; synonyms, so "bad debt" finds the allowance.
  const terms = queryTerms(question).filter(t => !POLICY_QUESTION_WORDS.has(t));
  const sentences = text.replace(/^#.*$/gm, '').split(/(?<=[.!?])\s+|\n+/).map(s => s.replace(/^[-*\d.\s]+/, '').trim()).filter(s => s.length > 20);
  const scored = sentences.map((s, i) => {
    const words = stems(s);
    return { s, i, n: terms.filter(t => matchesTerm(words, t)).length };
  });
  const best = scored.filter(x => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 3).sort((a, b) => a.i - b.i);
  // Nothing shared with the question: a semantic hit, not a passage that answers it. Quote nothing rather than guess.
  return best.map(x => x.s).join(' ');
}

/** "September 2026" for "2026-09". */
export const monthLabel = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(0, 4)}`;
const ymOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const prevYm = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const monthNumber = (word: string) => MONTH_NAMES.findIndex(n => n.toLowerCase().startsWith(word.toLowerCase().slice(0, 3))) + 1;

type MonthRef = { month: number; year?: number };

/** A month slot's text ("2026-09", "may", "Sept 2026") as month and optional year. */
function slotMonth(text: string): MonthRef | undefined {
  const iso = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text.trim());
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };
  const m = new RegExp(`^(${MONTH_WORD})\\.?(?:\\s+(\\d{4}))?$`, 'i').exec(text.trim());
  return m ? { month: monthNumber(m[1]!), ...(m[2] ? { year: Number(m[2]) } : {}) } : undefined;
}

/**
 * An explicit request to run month-end, as the whole message: "start the close", "please run the September close",
 * "start the close for August now". `month` is the command's own month, from its slot or a trailing "for <month>".
 */
/** The command pattern's source, exported so tests can check it stays linear without the length guard. */
export const CLOSE_COMMAND_SOURCE = CLOSE_COMMAND.source;
/** A real close command is a few words; anything longer is a question or a paste, never parsed as one. */
const MAX_COMMAND_LENGTH = 200;

export function closeCommand(text: string): { month?: MonthRef } | undefined {
  if (text.length > MAX_COMMAND_LENGTH) return undefined;
  const m = CLOSE_COMMAND.exec(text);
  if (!m) return undefined;
  const slot = m.groups?.slot ?? m.groups?.for;
  return slot ? { month: slotMonth(slot) } : {};
}
export const isCloseCommand = (text: string) => closeCommand(text) !== undefined;

/**
 * The month a question names: YYYY-MM, "last month" / "this month" (by today's date), or a month name with or without
 * a year. Words that are also everyday words or names (may, march, jan, june, …) count only next to a year or after a
 * preposition.
 */
export function monthIn(full: string, now: Date = new Date()): MonthRef | undefined {
  // Questions are short; reading only the start keeps a huge paste from costing anything.
  const text = full.slice(0, 1000);
  const iso = /\b(20\d{2})-(0[1-9]|1[0-2])\b/.exec(text);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };
  const relative = /\b(last|this|previous|current)\s+month\b/i.exec(text);
  if (relative) {
    const ym = /^(last|previous)$/i.test(relative[1]!) ? prevYm(ymOf(now)) : ymOf(now);
    return { year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)) };
  }
  for (const m of text.matchAll(MONTH_RE)) {
    const word = m[2]!.toLowerCase();
    // "is August ready to lock", "the June lock": a month right before the lock ("we may lock" stays the verb).
    const beforeLock = word !== 'may' && /^\s+(?:is\s+)?(?:ready\s+(?:to|for)\s+(?:be\s+)?)?lock/i.test(text.slice(m.index! + m[0].length));
    if (AMBIGUOUS.has(word) && !m[1] && !m[3] && !beforeLock) continue;
    return { month: monthNumber(word), ...(m[3] ? { year: Number(m[3]) } : {}) };
  }
  return undefined;
}

/**
 * The period a month refers to. Without a year: the close month's year if that period exists, else the latest period
 * of that month up to the close month. `missing` names a month the books have no period for.
 */
function periodFor(m: MonthRef, periodYms: readonly string[], closeYm: string): { ym: string } | { missing: string } {
  const mm = String(m.month).padStart(2, '0');
  if (m.year) {
    const ym = `${m.year}-${mm}`;
    return periodYms.includes(ym) ? { ym } : { missing: monthLabel(ym) };
  }
  const sameYear = `${closeYm.slice(0, 4)}-${mm}`;
  if (periodYms.includes(sameYear)) return { ym: sameYear };
  const latest = periodYms.filter(y => y.endsWith(`-${mm}`) && y <= closeYm).sort().pop();
  return latest ? { ym: latest } : { missing: monthLabel(sameYear) };
}

/** The period a question asks about, or undefined when it names no month. */
export function resolveYm(text: string, periodYms: readonly string[], closeYm: string, now: Date = new Date()): { ym: string } | { missing: string } | undefined {
  const m = monthIn(text, now);
  return m ? periodFor(m, periodYms, closeYm) : undefined;
}

export type CloseStart = { status: 'started' | 'running' | 'failed'; error?: string };
export type AnswerOptions = { startClose?: (periodYm: string) => Promise<CloseStart>; now?: Date };

/** Fallback when the caller does not hand in the gateway's own starter: POST /close and read the answer. */
async function startCloseOverHttp(periodYm: string): Promise<CloseStart> {
  const res = await fetch(`http://localhost:${GATEWAY_PORT}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodYm }) }).catch(() => null);
  if (!res) return { status: 'failed', error: 'the close runner is not reachable' };
  const body = (await res.json().catch(() => ({}))) as { started?: boolean; status?: string; error?: string };
  if (!res.ok) return { status: 'failed', error: body.error ?? `the gateway answered ${res.status}` };
  return { status: body.started === false && body.status === 'running' ? 'running' : 'started' };
}

/**
 * What stands between a resumed close and its lock request, as the module sees it: undecided proposals, blocked close
 * tasks, and subscription revenue through the month that is not recognized yet.
 */
function lockOutlook(A: Cast['advisor'], ym: string, periodId: bigint): string {
  const { left, bankNote } = lockState(A, ym, periodId);
  const note = bankNote ? ` ${bankNote}` : '';
  if (!left.length) return `everything is decided, so I will ask to lock it.${note}`;
  return `${left.join('; ')}. I will ask to lock only once ${left.length === 1 ? 'that is' : 'those are'} resolved.${note}`;
}

/**
 * The lock gate's checks for `ym`, as the module's lockPeriod runs them: undecided proposals, blocked close tasks,
 * subscription revenue through the month not recognized yet, and unmatched bank lines the CFO has not accepted.
 * `bankNote` says when the CFO's current acceptance covers the unmatched lines, so they do not block.
 */
function lockState(A: Cast['advisor'], ym: string, periodId: bigint): { left: string[]; bankNote: string } {
  const undecided = [...A.db.proposal.iter()].filter(p => p.periodId === periodId && ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag)).length;
  const blocked = [...A.db.closeTask.iter()].filter(t => t.periodId === periodId && t.status.tag === 'Blocked');
  const subscription = new Set([...A.db.contractItem.iter()].filter(i => i.kind.tag === 'Subscription').map(i => i.id));
  const unrecognized = [...A.db.revenueScheduleLine.iter()].filter(l => l.ym <= ym && !l.recognized && subscription.has(l.contractItemId)).reduce((a, l) => a + l.amountMinor, 0n);
  const bank = bankExceptionsOf(A, ym);
  const left = [
    undecided ? `${undecided} item${undecided === 1 ? '' : 's'} still need${undecided === 1 ? 's' : ''} a decision` : '',
    blocked.length ? `${blocked.length === 1 ? 'one close task is' : `${blocked.length} close tasks are`} blocked (${blocked.map(t => `"${t.title}"`).join(', ')}) and need${blocked.length === 1 ? 's' : ''} a person` : '',
    unrecognized > 0n ? `${money(unrecognized)} of subscription revenue through ${monthLabel(ym)} is not recognized yet` : '',
    bank.rows.length && !bank.accepted ? `${bank.rows.length} unmatched bank line${bank.rows.length === 1 ? '' : 's'} through ${monthLabel(ym)} need${bank.rows.length === 1 ? 's' : ''} reconciling or your explicit acceptance` : '',
  ].filter(Boolean);
  let bankNote = '';
  if (bank.rows.length && bank.accepted) {
    const n = bank.rows.length;
    const acceptance = latestAcceptance(A, ym);
    bankNote = `${n} unmatched bank line${n === 1 ? '' : 's'} through ${monthLabel(ym)} ${n === 1 ? 'was' : 'were'} accepted by the CFO as exceptions${acceptance ? ` on ${dateLabel(acceptance.at)}${acceptance.reason ? ` ("${acceptance.reason}")` : ''}` : ''}, so ${n === 1 ? 'it does' : 'they do'} not block the lock; ${n === 1 ? 'it is' : 'they are'} still unreconciled.`;
  }
  return { left, bankNote };
}

/** The CFO's latest acceptance of bank exceptions for `ym` (when and why), from the audit trail. */
function latestAcceptance(A: Cast['advisor'], ym: string): { at: bigint; reason: string } | undefined {
  let best: { at: bigint; reason: string } | undefined;
  for (const e of A.db.auditEvent.iter()) {
    if (e.action !== 'accept_bank_exceptions' || e.actorRole !== 'cfo') continue;
    let detail: { periodYm?: unknown; reasonPlain?: unknown };
    try {
      detail = JSON.parse(e.detail) as typeof detail;
    } catch {
      continue;
    }
    if (detail?.periodYm !== ym) continue;
    const at = e.at.microsSinceUnixEpoch;
    if (!best || at > best.at) best = { at, reason: typeof detail.reasonPlain === 'string' ? detail.reasonPlain.trim() : '' };
  }
  return best;
}

/** "Can we lock September?", "is September ready to lock", "what blocks the lock". */
const LOCK_QUESTION = /\b(?:can|could|may|should|shall)\s+(?:we|i|you)\s+(?:now\s+)?lock\b|\bready\s+(?:to|for)\s+(?:be\s+)?(?:the\s+)?lock|\b(?:block|stopp?|prevent|hold)(?:s|ing|ed)?\s+(?:up\s+)?(?:us\s+from\s+locking|(?:the\s+)?(?:period\s+|month\s+)?lock)\b|\bin\s+the\s+way\s+of\s+(?:the\s+)?lock|\block\s+(?:gate|status|outlook)\b/;
export const isLockQuestion = (q: string) => LOCK_QUESTION.test(q.toLowerCase().slice(0, 1000));

/** Risk tiers, worst first. */
const TIER_ORDER = ['BLOCK', 'D', 'C', 'B', 'A'] as const;
type Tier = (typeof TIER_ORDER)[number];
const TIER_RATE: Record<Tier, string> = { A: '1%', B: '5%', C: '10%', D: '50%', BLOCK: '100%' };
/** "Which customers are high risk?", "risky customers", "risk tiers", "credit risk by customer". */
const RISK_QUESTION = /\b(?:high|higher|highest|elevated)[\s-]+risk\b|\brisk(?:y|iest|ier)\b|\brisk\s+tiers?\b|\bcredit\s+(?:risk|tiers?|checks?)\b|\btier\s+(?:d|block)\b|\bat[\s-]+risk\b/;
export const isRiskQuestion = (q: string) => RISK_QUESTION.test(q.toLowerCase().slice(0, 1000));

/**
 * The customers' Risk Tiers from the recorded credit checks (the latest check per customer sets its tier, as on the
 * dashboard; a customer never checked keeps the tier on its record), and for the highest-risk ones the open balance
 * (unpaid invoices) and the reserve posted against them (allowance lines on account 1150), with the policy rate.
 */
function* riskAnswer(A: Cast['advisor']): Generator<string> {
  const subs = new Map([...A.db.subsidiary.iter()].map(s => [s.id, s]));
  const customers = [...A.db.customer.iter()].filter(c => !subs.get(c.subsidiaryId)?.isElimination);
  const latest = new Map<bigint, { tier: string; requestId: string; at: bigint; id: bigint }>();
  for (const r of A.db.creditCheck.iter()) {
    if (r.subjectKind.tag.toLowerCase() !== 'customer') continue;
    const at = r.createdAt.microsSinceUnixEpoch;
    const prev = latest.get(r.subjectId);
    if (!prev || at > prev.at || (at === prev.at && r.id > prev.id)) latest.set(r.subjectId, { tier: r.tier, requestId: r.requestId, at, id: r.id });
  }
  const isTier = (t: string | undefined): t is Tier => (TIER_ORDER as readonly string[]).includes(t ?? '');
  const open = new Map<bigint, { minor: bigint; count: number }>();
  for (const i of A.db.invoice.iter()) {
    if (i.status.tag.toLowerCase() === 'paid') continue;
    const o = open.get(i.customerId) ?? { minor: 0n, count: 0 };
    open.set(i.customerId, { minor: o.minor + i.amountMinor, count: o.count + 1 });
  }
  const allowanceAccounts = new Set([...A.db.account.iter()].filter(a => a.code === '1150' || a.code.startsWith('1150-')).map(a => a.id));
  const reserve = new Map<bigint, bigint>();
  for (const l of A.db.journalLine.iter()) {
    if (l.customerId === undefined || !allowanceAccounts.has(l.accountId)) continue;
    reserve.set(l.customerId, (reserve.get(l.customerId) ?? 0n) + l.creditMinor - l.debitMinor);
  }
  const rated = customers.map(c => {
    const check = latest.get(c.id);
    const tier = check && isTier(check.tier) ? check.tier : isTier(c.creditTier) ? c.creditTier : undefined;
    return { c, tier, check: check && isTier(check.tier) ? check : undefined };
  });
  const counts = TIER_ORDER.slice().reverse().map(t => `${t} ${rated.filter(r => r.tier === t).length}`).join(', ');
  const unrated = rated.filter(r => !r.tier).length;
  const checked = rated.filter(r => r.check).length;
  if (!rated.some(r => r.tier)) {
    yield 'No customer has a Risk Tier yet: no credit check is recorded. The Credit & Risk agent runs the checks during the close.';
    return;
  }
  yield `Risk Tiers: ${counts}${unrated ? ` (${unrated} customer${unrated === 1 ? '' : 's'} not rated)` : ''}. Source: the latest recorded credit check per customer${checked < rated.filter(r => r.tier).length ? ', or the tier on the customer record where none is recorded' : ''}.\n`;
  const worst = rated.filter(r => r.tier === 'BLOCK' || r.tier === 'D');
  if (!worst.length) {
    yield 'No customer is in Risk Tier D or BLOCK. Open Customers for each tier and its evidence.';
    return;
  }
  const ccy = (c: (typeof customers)[number]) => subs.get(c.subsidiaryId)?.functionalCcy ?? 'USD';
  const fmt = (n: bigint, code: string) => formatMinor(n, code, { trimZeroCents: true });
  worst.sort((a, b) => TIER_ORDER.indexOf(a.tier!) - TIER_ORDER.indexOf(b.tier!) || Number((open.get(b.c.id)?.minor ?? 0n) - (open.get(a.c.id)?.minor ?? 0n)) || Number(a.c.id - b.c.id));
  const SHOWN = 6;
  yield `Highest risk (${worst.length} in D or BLOCK):\n`;
  for (const { c, tier, check } of worst.slice(0, SHOWN)) {
    const o = open.get(c.id) ?? { minor: 0n, count: 0 };
    const r = reserve.get(c.id) ?? 0n;
    const source = check ? `credit check ${check.requestId ? `${check.requestId} ` : ''}on ${dateLabel(check.at)}` : 'customer record';
    const target = targetAllowanceMinor(o.minor, tier!);
    yield `- ${c.name}: ${tier} (${source}); open balance ${fmt(o.minor, ccy(c))} (${o.count} unpaid invoice${o.count === 1 ? '' : 's'}); reserve ${fmt(r, ccy(c))} posted to account 1150 (policy target ${fmt(target, ccy(c))} at ${TIER_RATE[tier!]}).\n`;
  }
  if (worst.length > SHOWN) yield `- and ${worst.length - SHOWN} more on the Customers page.\n`;
  yield 'Tier rates come from the credit and allowance policy. Open Customers for the evidence behind each tier.';
}

export async function* answerQuestion(cast: Cast, question: string, _history: { role: string; content: string }[], opts: AnswerOptions = {}): AsyncGenerator<string> {
  const q = question.toLowerCase();
  const A = cast.advisor;
  const periods = [...A.db.period.iter()].sort((a, b) => a.ym.localeCompare(b.ym));
  if (periods.length === 0 || ![...A.db.subsidiary.iter()].length) {
    yield 'The books are not seeded yet. Run the seed loader first.';
    return;
  }
  const openPeriod = periods.find(p => p.status.tag !== 'Closed') ?? periods[periods.length - 1]!;
  const periodYms = periods.map(p => p.ym);
  const now = opts.now ?? new Date();
  const span = `they run from ${monthLabel(periods[0]!.ym)} to ${monthLabel(periods[periods.length - 1]!.ym)}`;

  const command = closeCommand(question);
  if (command) {
    const target = command.month ? periodFor(command.month, periodYms, openPeriod.ym) : { ym: openPeriod.ym };
    if ('missing' in target) {
      yield `There is no ${target.missing} period in the books to close; ${span}.`;
      return;
    }
    const ym = target.ym;
    const period = periods.find(p => p.ym === ym)!;
    if (ym >= ymOf(now)) {
      yield `${monthLabel(ym)} has not ended yet, so it cannot be closed.`;
      return;
    }
    if (period.status.tag === 'Closed') {
      yield `${monthLabel(ym)} is already closed and locked, so there is nothing to run.`;
      return;
    }
    if (period.status.tag === 'Closing') {
      yield `The ${monthLabel(ym)} close is done and the lock has been requested; confirm the lock in the app when you are ready.`;
      return;
    }
    const resumes = closeHasWork(A, ym);
    const r = await (opts.startClose ?? startCloseOverHttp)(ym);
    if (r.status === 'failed') yield `I could not start the ${monthLabel(ym)} close: ${r.error ?? 'unknown error'}.`;
    else if (r.status === 'running') yield `The ${monthLabel(ym)} close is already running. Watch the Agents page for progress; anything material will wait for your OK.`;
    else if (resumes) yield `The ${monthLabel(ym)} close already ran, so I am picking it up where it stopped instead of proposing again: ${lockOutlook(A, ym, period.id)}`;
    else yield `Starting the ${monthLabel(ym)} close. Watch the Agents page: the Bookkeeper, Revenue, and Credit & Risk will propose, the Red Team will challenge, and I will rule. Anything material will wait for your OK.`;
    return;
  }

  const asked = resolveYm(question, periodYms, openPeriod.ym, now);
  if (asked && 'missing' in asked) {
    yield `There is no ${asked.missing} period in the books; ${span}.`;
    return;
  }
  const closeYm = asked?.ym ?? openPeriod.ym;
  const period = periods.find(p => p.ym === closeYm)!;
  const s = snapshot(A, closeYm);

  if (agentsLive()) {
    const { liveAnswer } = await import('./live/orchestrator');
    yield* liveAnswer(cast, question);
    return;
  }

  // "What is our policy on…", "how do we account for…": quote the house policy (Moss, else local search) instead of a figure.
  if (/\bpolic(?:y|ies)\b|accounting (?:rule|treatment)|how (?:should|do|does) (?:we|luyten) (?:account|treat|book|recogni[sz]e|reserve|reconcile)/.test(q)) {
    const hits = await searchPolicies(question, 2);
    if (!hits.length) {
      yield 'No house policy covers that. The policies cover accruals, bank reconciliation, revenue recognition, credit and allowances, consolidation, and materiality.';
      return;
    }
    const quoted = hits.map(h => ({ name: h.id.replace(/-/g, ' '), excerpt: policyExcerpt(h.text, question) }));
    if (!quoted.some(h => h.excerpt)) {
      yield `No passage in the house policies answers that directly; the closest is the ${quoted[0]!.name} policy, on the Charters page. `;
    } else {
      for (const h of quoted) if (h.excerpt) yield `From the ${h.name} policy: ${h.excerpt} `;
    }
    yield 'The Red Team checks every Proposal against these same policies before the Advisor rules.';
    return;
  }

  // "Can we lock September?": the lock gate's own checks for that month (the open month by default).
  if (isLockQuestion(question)) {
    const label = monthLabel(closeYm);
    if (period.status.tag === 'Closed') {
      yield `${label} is already locked.`;
      return;
    }
    const requested = period.status.tag === 'Closing';
    if (!requested && closeYm >= ymOf(now)) {
      yield `Not yet: ${label} has not ended, so it cannot be locked.`;
      return;
    }
    const order = closeOrderRefusal(periods.map(p => ({ ym: p.ym, status: p.status })), closeYm, 'lock');
    if (order) {
      yield `Not yet: ${order}`;
      return;
    }
    // The gate rechecks everything at the lock, so a requested lock is checked again too: something may have changed since.
    const { left, bankNote } = lockState(A, closeYm, period.id);
    if (left.length) {
      yield `Not yet. ${left.join('; ')}.${bankNote ? ` ${bankNote}` : ''} These are the checks the lock runs.`;
      return;
    }
    if (!requested && !closeHasWork(A, closeYm)) {
      yield `Not yet: the ${label} close has not run. Say "start the close" to run it; I will tell you what is left before the lock.`;
      return;
    }
    const passed = `Every item for ${label} is decided, no close task is blocked, and subscription revenue through ${label} is recognized. ${bankNote || 'Every bank line through the month is matched.'}`;
    const confirm = requested ? 'The lock has been requested; confirm it on the Close page when you are ready.' : 'The lock is yours to confirm on the Close page.';
    if (isGroup([...A.db.subsidiary.iter()].map(s => ({ isElimination: s.isElimination === true })))) {
      // The consolidation check is the module's own; this answer does not recompute it, so it does not say a plain yes.
      yield `Nothing in these checks blocks the ${label} lock. ${passed} As a group month, the lock also checks that the consolidation (revaluation at closing rates and intercompany eliminations) still matches the books; I do not recompute that here, and the lock will refuse with the reason if it does not. ${confirm}`;
    } else {
      yield `Yes. ${passed} ${confirm}`;
    }
    return;
  }

  if (isRiskQuestion(question)) {
    yield* riskAnswer(A);
    return;
  }

  const pending = [...A.db.proposal.iter()].filter(p => p.status.tag === 'AwaitingCfo');
  const asOf = asked ? closeYm < ymOf(now) ? ` at the end of ${monthLabel(closeYm)}` : ` as of ${dateLabel(BigInt(now.getTime()) * 1000n)}` : '';
  const reportFor = (ym: string) => {
    const report = advisorReport(A, ym);
    const named = report.companies.filter(company => {
      if (q.includes(company.entity.name.toLowerCase())) return true;
      const code = company.entity.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // "us" is normally a pronoun. Only an explicitly capitalized US names that subsidiary.
      return new RegExp(`\\b${code}\\b`, company.entity.code.toUpperCase() === 'US' ? '' : 'i').test(question);
    });
    const companies = /consolidat|\bgroup\b|by company|per company/.test(q) || !named.length ? report.companies : named;
    return { ...report, companies, includeGroup: companies.length > 1 && companies.length === report.companies.length };
  };
  const wantsBank = /unmatched|unresolved.*(?:receipt|bank)|(?:bank|receipts?|payments?).{0,25}reconcil|reconcil.{0,25}(?:bank|receipts?|payments?)/.test(q);
  const wantsPnl = /\bp\s*(?:&|and|\/)\s*l\b|profit|loss|income statement|expenses?/.test(q);
  const requested: string[] = [];
  if (/cash|runway|bank balance/.test(q)) requested.push(/runway/.test(q) ? 'cash runway' : 'cash');
  if (/\barr\b|annual recurring/.test(q)) requested.push('ARR');
  if (wantsPnl) requested.push('P&L');
  else if (/deferred|recogni[sz]e|revenue/.test(q)) requested.push('recognized revenue');
  if (/allowance|reserve|adequacy/.test(q)) requested.push('allowance adequacy');
  if (/receivable|\bar\b|overdue|owe us|customers owe/.test(q)) requested.push('overdue receivables');
  if (/payable|\bap\b|vendor|supplier|bills?/.test(q)) requested.push('payables');
  if (wantsBank) requested.push('unmatched bank receipts');
  if (requested.length > 1) {
    const scope = reportFor(closeYm);
    const prefix = /consolidat|\bgroup\b/.test(q) ? 'consolidated group' : scope.companies.map(company => company.entity.name).join(' and ');
    for (const intent of requested) {
      yield* answerQuestion(cast, `${prefix} ${intent}${asked ? ` for ${closeYm}` : ''}`, [], opts);
      yield '\n\n';
    }
    return;
  }

  if (wantsBank) {
    const report = reportFor(closeYm);
    let count = 0;
    yield `Current unmatched bank lines through ${monthLabel(closeYm)}. `;
    for (const company of report.companies) {
      // Every unmatched line of the month or earlier, dated or not yet: exactly what the lock gate counts.
      const unmatched = company.books.bankTxRows.filter(tx => !tx.matched && tx.ym <= closeYm);
      count += unmatched.length;
      const totals = (rows: typeof unmatched) => {
        const byCcy = new Map<string, bigint>();
        for (const row of rows) byCcy.set(row.ccy.toUpperCase(), (byCcy.get(row.ccy.toUpperCase()) ?? 0n) + (row.amountMinor < 0n ? -row.amountMinor : row.amountMinor));
        return [...byCcy].sort(([a], [b]) => a.localeCompare(b)).map(([ccy, amount]) => formatMinor(amount, ccy, { trimZeroCents: true })).join(' and ');
      };
      const receipts = unmatched.filter(tx => tx.amountMinor > 0n);
      const outflows = unmatched.filter(tx => tx.amountMinor < 0n);
      yield `${company.entity.name}: ${receipts.length} unmatched receipt${receipts.length === 1 ? '' : 's'}${receipts.length ? ` totaling ${totals(receipts)}` : ''}; ${outflows.length} unmatched outflow${outflows.length === 1 ? '' : 's'}${outflows.length ? ` totaling ${totals(outflows)}` : ''}. `;
    }
    yield count ? 'The bank is not fully reconciled. Resolve these lines or explicitly accept the exceptions as CFO before locking; accepting exceptions does not match the receipts. ' : 'No unmatched bank lines are recorded in this scope. ';
    yield 'Open the Ledger and close checklist for the details.';
    return;
  }

  if (/allowance|reserve|adequacy/.test(q)) {
    const report = reportFor(closeYm);
    yield `Receivables through ${monthLabel(closeYm)}. `;
    for (const company of report.companies) {
      const gross = company.balance('1100');
      const reserved = -company.balance('1150');
      const fmt = (amount: bigint) => formatMinor(amount, company.entity.functionalCcy, { trimZeroCents: true });
      yield `${company.entity.name}: gross receivables ${fmt(gross)}, allowance ${fmt(reserved)}, net receivables ${fmt(gross - reserved)}. `;
    }
    yield 'I cannot conclude reserve adequacy from balances alone: review the latest credit checks, specific exposures and unmatched receipts before changing the allowance. Open Customers and the Ledger for the evidence.';
    return;
  }

  if (/\barr\b|annual recurring/.test(q)) {
    const report = reportFor(closeYm);
    yield `ARR from active subscription contracts for ${monthLabel(closeYm)}: ${report.companies.map(company => `${company.entity.name}: ${formatMinor(company.arr, company.entity.functionalCcy, { trimZeroCents: true })}`).join('; ')}. `;
    if (report.includeGroup) {
      try {
        yield `Consolidated group ARR: ${formatMinor(report.groupArr(), report.group.reportingCcy, { trimZeroCents: true })}, translated at the month's closing rates. `;
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        yield `I cannot calculate consolidated ARR: ${error.message} `;
      }
    }
    const missing = report.companies.filter(company => company.books.contracts.length === 0);
    if (missing.length) yield `${missing.map(company => `${company.entity.name}: no contracts on file`).join('; ')}. Contract coverage is incomplete, so group ARR reflects recorded contracts only. `;
    yield 'Usage contracts are excluded. Open the Board Pack for the ARR waterfall.';
    return;
  }

  if (wantsPnl) {
    const ym = asked?.ym ?? periods.filter(p => p.ym < ymOf(now)).at(-1)?.ym ?? closeYm;
    const report = reportFor(ym);
    const figures = (revenue: bigint, expenses: bigint, ccy: string) => {
      const net = revenue - expenses;
      const fmt = (amount: bigint) => formatMinor(amount, ccy, { trimZeroCents: true });
      return `revenue ${fmt(revenue)}, expenses ${fmt(expenses)}, net ${net < 0n ? 'loss' : 'income'} ${fmt(net < 0n ? -net : net)}`;
    };
    yield `P&L for ${monthLabel(ym)}. `;
    for (const company of report.companies) yield `${company.entity.name}: ${figures(company.pnl.totalRevenueMinor, company.pnl.totalExpensesMinor, company.entity.functionalCcy)}. `;
    if (report.includeGroup) {
      try {
        const rows = report.consolidated().incomeStatement.month;
        const revenue = rows.filter(row => row.type === 'revenue').reduce((total, row) => total + row.consolidatedMinor, 0n);
        const expenses = rows.filter(row => row.type === 'expense').reduce((total, row) => total + row.consolidatedMinor, 0n);
        yield `Consolidated group: ${figures(revenue, expenses, report.group.reportingCcy)}, including posted eliminations and translation at monthly average rates. `;
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        yield `I cannot calculate the consolidated P&L: ${error.message} `;
      }
    }
    yield 'Open the Board Pack for the full statement and Ledger drill-down.';
    return;
  }

  if (/cash|runway|bank balance/.test(q)) {
    const report = reportFor(closeYm);
    const atMicros = asked && closeYm < ymOf(now) ? ymEndMicros(ymFromString(closeYm)) - 1n : BigInt(now.getTime()) * 1000n;
    yield `Book cash as of ${dateLabel(atMicros)}: ${report.companies.map(company => `${company.entity.name}: ${formatMinor(company.balance('1000'), company.entity.functionalCcy, { trimZeroCents: true })}`).join('; ')}. `;
    if (report.includeGroup && /consolidat|\bgroup\b/.test(q)) {
      try {
        yield `Consolidated group cash: ${formatMinor(report.groupBalance('1000'), report.group.reportingCcy, { trimZeroCents: true })}, translated at ${monthLabel(closeYm)} closing rates. `;
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        yield `I cannot calculate consolidated cash: ${error.message} `;
      }
    }
    yield 'These are posted book balances; unmatched bank lines still need reconciliation. ';
    if (/runway/.test(q)) yield 'I cannot estimate runway reliably from the recorded bills alone; that needs a complete cash-flow forecast.';
    yield 'Open the Ledger for the entries.';
    return;
  }
  if (/receivable|\bar\b|overdue|owe us|collect/.test(q)) {
    const report = reportFor(closeYm);
    const cutoff = asked && closeYm < ymOf(now) ? ymEndMicros(ymFromString(closeYm)) - 1n : BigInt(now.getTime()) * 1000n;
    yield `Receivables through ${monthLabel(closeYm)}; overdue evaluated as of ${dateLabel(cutoff)} using current unpaid invoice status. `;
    for (const company of report.companies) {
      const overdue = company.books.invoices.filter(invoice => invoice.status !== 'paid' && ymToString(invoice.ym) <= closeYm && invoice.dueAt < cutoff);
      const total = overdue.reduce((sum, invoice) => sum + invoice.amountMinor, 0n);
      const fmt = (amount: bigint) => formatMinor(amount, company.entity.functionalCcy, { trimZeroCents: true });
      yield `${company.entity.name}: ${overdue.length} overdue invoice${overdue.length === 1 ? '' : 's'}${overdue.length ? ` totaling ${fmt(total)}` : ''}; gross receivables ${fmt(company.balance('1100'))}, allowance ${fmt(-company.balance('1150'))}. `;
    }
    yield 'Open Customers for invoice details. Historical payment status is not reconstructed from current rows.';
    return;
  }
  if (/deferred|recogni[sz]e|revenue/.test(q)) {
    const report = reportFor(closeYm);
    for (const company of report.companies) {
      const fmt = (amount: bigint) => formatMinor(amount, company.entity.functionalCcy, { trimZeroCents: true });
      if (report.companies.length > 1) yield `${company.entity.name}: `;
      if (asked) {
        const month = company.pnl.totalRevenueMinor;
        const undecided = [...A.db.proposal.iter()]
          .filter(p => p.periodId === period.id && ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag) && p.kind.tag === 'JournalEntry')
          .map(p => pendingRevenue(p.payloadJson, code => company.books.accountByCode.get(code)?.type === 'revenue'))
          .filter(v => v !== 0n);
        yield `Revenue for ${monthLabel(closeYm)} is ${fmt(month)} on the books. `;
        if (undecided.length) yield `${undecided.length} revenue proposal${undecided.length > 1 ? 's' : ''} worth ${fmt(undecided.reduce((a, b) => a + b, 0n))} for that month ${undecided.length > 1 ? 'are' : 'is'} still waiting for a ruling or your OK, so the month is not final yet. `;
        yield `Deferred revenue still to be earned through ${monthLabel(closeYm)} is ${fmt(company.balance('2400'))}. `;
      } else {
        yield `Revenue recognized to date is ${fmt(company.revenueToDate)}, and deferred revenue still to be earned is ${fmt(company.balance('2400'))}. `;
      }
    }
    yield `Revenue is recognized evenly over each annual contract and in the month of use for metered plans; every number drills down to its journal lines in the Ledger.`;
    return;
  }
  if (/payable|\bap\b|vendor|supplier|bills?/.test(q)) {
    const report = reportFor(closeYm);
    const blocked = report.companies.flatMap(company => company.books.vendors).filter(v => v.verification.tag === 'Blocked');
    for (const company of report.companies) yield `${company.entity.name}: accounts payable stands at ${formatMinor(company.balance('2000'), company.entity.functionalCcy, { trimZeroCents: true })}${asOf}. `;
    yield blocked.length ? `${blocked.length} vendor${blocked.length > 1 ? 's are' : ' is'} blocked from payment: ${blocked.map(v => v.name).join(', ')}.` : `No vendors are blocked.`;
    return;
  }
  if (/approve|pending|waiting|my ok|needs/.test(q)) {
    if (!pending.length) {
      yield `Nothing is waiting for you right now.`;
      return;
    }
    yield `${pending.length} item${pending.length > 1 ? 's' : ''} need your OK:\n`;
    for (const p of pending) yield `- ${p.summaryPlain} (${money(p.amountMinor)})\n`;
    yield `Open the Dashboard to approve or send back.`;
    return;
  }
  if (/status|where are we|how.*close/.test(q)) {
    const tasks = s.closeTasks;
    const done = tasks.filter(t => t.status.tag === 'Done').length;
    const report = reportFor(closeYm);
    const unmatched = report.companies.flatMap(company => company.books.bankTxRows).filter(tx => !tx.matched && tx.ym <= closeYm);
    yield `${closeYm} is ${period.status.tag === 'Closed' ? 'closed' : 'open'}: ${done} of ${tasks.length} close tasks done, ${pending.length} item${pending.length === 1 ? '' : 's'} waiting for your OK. `;
    if (unmatched.length) yield `${unmatched.length} unmatched bank line${unmatched.length === 1 ? '' : 's'} remain; the bank is not fully reconciled even if processing tasks are done. `;
    for (const company of report.companies) yield `${company.entity.name}: cash ${formatMinor(company.balance('1000'), company.entity.functionalCcy, { trimZeroCents: true })}. `;
    return;
  }
  if (/consolidat|\bgroup\b/.test(q)) {
    const ym = asked?.ym ?? periods.filter(p => p.ym < ymOf(now)).at(-1)?.ym ?? closeYm;
    const report = reportFor(ym);
    yield `Consolidated group for ${monthLabel(ym)}. `;
    try {
      const fmt = (amount: bigint) => formatMinor(amount, report.group.reportingCcy, { trimZeroCents: true });
      yield `Book cash ${fmt(report.groupBalance('1000'))}, gross receivables ${fmt(report.groupBalance('1100'))}, allowance ${fmt(-report.groupBalance('1150'))}, payables ${fmt(report.groupBalance('2000'))}. `;
      const net = report.consolidated().incomeStatement.netIncomeMonthMinor;
      yield `The month's P&L shows net ${net < 0n ? 'loss' : 'income'} ${fmt(net < 0n ? -net : net)}, including posted eliminations. `;
      yield 'Balances use closing rates and P&L uses monthly average rates. ';
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error;
      yield `I cannot complete the consolidated view: ${error.message} `;
    }
    yield 'Open the Board Pack for company columns, translation and drill-down.';
    return;
  }
  for (const company of reportFor(closeYm).companies) {
    const fmt = (amount: bigint) => formatMinor(amount, company.entity.functionalCcy, { trimZeroCents: true });
    yield `Here is where ${company.entity.name} stands for ${closeYm}: cash ${fmt(company.balance('1000'))}, receivables ${fmt(company.balance('1100'))} (allowance ${fmt(-company.balance('1150'))}), payables ${fmt(company.balance('2000'))}, deferred revenue ${fmt(company.balance('2400'))}, revenue to date ${fmt(company.revenueToDate)}. `;
  }
  yield `Ask me about cash, receivables, revenue, vendors, or what needs your OK, or say "start the close" to run month-end.`;
}
