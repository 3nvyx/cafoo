/**
 * "Ask the books": answers chat questions from the live ledger.
 * Demo mode answers deterministic questions from the tables; live mode hands the question to the Advisor.
 * A close starts only on an explicit command ("start the close") at the start of the CFO's latest message, never
 * because a question or a chat client's background prompt happens to mention the close.
 */
import { formatMinor } from '@cafoo/ledger-core';
import { agentsLive, GATEWAY_PORT } from './env';
import { snapshot } from './snapshot';
import { closeHasWork } from './close-state';
import type { Cast } from './stdb';

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** Month words that are also everyday words or names ("may", "march", "Jan from audit"): a month only next to a year or after a preposition. */
const AMBIGUOUS = new Set(['jan', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'aug', 'august']);
const MONTH_RE = new RegExp(`(\\b(?:in|for|of|during|since|through|until|from|to|by)\\s+)?\\b(${MONTH_WORD})\\b\\.?(?:\\s+(?:of\\s+)?(\\d{4}))?`, 'gi');
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
    if (AMBIGUOUS.has(word) && !m[1] && !m[3]) continue;
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
  const undecided = [...A.db.proposal.iter()].filter(p => p.periodId === periodId && ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag)).length;
  const blocked = [...A.db.closeTask.iter()].filter(t => t.periodId === periodId && t.status.tag === 'Blocked');
  const subscription = new Set([...A.db.contractItem.iter()].filter(i => i.kind.tag === 'Subscription').map(i => i.id));
  const unrecognized = [...A.db.revenueScheduleLine.iter()].filter(l => l.ym <= ym && !l.recognized && subscription.has(l.contractItemId)).reduce((a, l) => a + l.amountMinor, 0n);
  const left = [
    undecided ? `${undecided} item${undecided === 1 ? '' : 's'} still need${undecided === 1 ? 's' : ''} a decision` : '',
    blocked.length ? `${blocked.length === 1 ? 'one close task is' : `${blocked.length} close tasks are`} blocked (${blocked.map(t => `"${t.title}"`).join(', ')}) and need${blocked.length === 1 ? 's' : ''} a person` : '',
    unrecognized > 0n ? `${money(unrecognized)} of subscription revenue through ${monthLabel(ym)} is not recognized yet` : '',
  ].filter(Boolean);
  if (!left.length) return 'everything is decided, so I will ask to lock it.';
  return `${left.join('; ')}. I will ask to lock only once ${left.length === 1 ? 'that is' : 'those are'} resolved.`;
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

  // Balances as of the asked month's end, or as of now when no month is named.
  const at = asked ? closeYm : undefined;
  const cash = s.balance('1000', at);
  const ar = s.balance('1100', at);
  const allowance = -s.balance('1150', at);
  const deferred = -s.balance('2400', at);
  const ap = -s.balance('2000', at);
  const revenue = -(s.balance('4000', at) + s.balance('4100', at));
  const pending = [...A.db.proposal.iter()].filter(p => p.status.tag === 'AwaitingCfo');
  const overdue = [...A.db.invoice.iter()].filter(i => i.status.tag === 'Overdue');
  const asOf = asked ? ` at the end of ${monthLabel(closeYm)}` : '';

  if (/cash|runway|bank balance/.test(q)) {
    yield `Cash is ${money(cash)}${asOf}. `;
    const monthlyBurn = [...A.db.bill.iter()].filter(b => b.ym === closeYm).reduce((a, b) => a + b.amountMinor, 0n);
    yield `Bills recorded for ${closeYm} total ${money(monthlyBurn)}, so at that pace cash covers roughly ${monthlyBurn > 0n ? Number(cash / monthlyBurn) : 'many'} months before new collections.`;
    return;
  }
  if (/receivable|\bar\b|overdue|owe us|collect/.test(q)) {
    yield `Open receivables total ${money(ar)}${asOf} with an allowance of ${money(allowance)} set aside. `;
    if (overdue.length) {
      const names = overdue.map(i => `${s.customerName.get(i.customerId)} (${money(i.amountMinor)})`).join(', ');
      yield `${overdue.length} invoice${overdue.length > 1 ? 's are' : ' is'} overdue: ${names}.`;
    } else yield `Nothing is overdue.`;
    return;
  }
  if (/deferred|recogni[sz]e|revenue/.test(q)) {
    if (asked) {
      // The month's movement on the revenue accounts: balance at its end minus balance at the previous month's end.
      const prev = prevYm(closeYm);
      const month = -(s.balance('4000', closeYm) - s.balance('4000', prev) + (s.balance('4100', closeYm) - s.balance('4100', prev)));
      const undecided = [...A.db.proposal.iter()]
        .filter(p => p.periodId === period.id && ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag) && p.kind.tag === 'JournalEntry')
        .map(p => {
          const lines = (JSON.parse(p.payloadJson).lines ?? []) as { accountCode?: string; debitMinor?: string; creditMinor?: string }[];
          return lines.filter(l => /^4\d{3}$/.test(String(l.accountCode))).reduce((a, l) => a + BigInt(l.creditMinor ?? '0') - BigInt(l.debitMinor ?? '0'), 0n);
        })
        .filter(v => v !== 0n);
      yield `Revenue for ${monthLabel(closeYm)} is ${money(month)} on the books. `;
      if (undecided.length) yield `${undecided.length} revenue proposal${undecided.length > 1 ? 's' : ''} worth ${money(undecided.reduce((a, b) => a + b, 0n))} for that month ${undecided.length > 1 ? 'are' : 'is'} still waiting for a ruling or your OK, so the month is not final yet. `;
      yield `Deferred revenue still to be earned at the end of ${monthLabel(closeYm)} is ${money(deferred)}.`;
      return;
    }
    yield `Revenue recognized to date is ${money(revenue)}, and deferred revenue still to be earned is ${money(deferred)}. `;
    yield `Revenue is recognized evenly over each annual contract and in the month of use for metered plans; every number drills down to its journal lines in the Ledger.`;
    return;
  }
  if (/payable|\bap\b|vendor|bills?/.test(q)) {
    const blocked = [...A.db.vendor.iter()].filter(v => v.verification.tag === 'Blocked');
    yield `Accounts payable stands at ${money(ap)}${asOf}. `;
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
    yield `${closeYm} is ${period.status.tag === 'Closed' ? 'closed' : 'open'}: ${done} of ${tasks.length} close tasks done, ${pending.length} item${pending.length === 1 ? '' : 's'} waiting for your OK. Cash ${money(cash)}, receivables ${money(ar)}, deferred revenue ${money(deferred)}.`;
    return;
  }
  yield `Here is where ${s.subsidiary.name} stands for ${closeYm}: cash ${money(cash)}, receivables ${money(ar)} (allowance ${money(allowance)}), payables ${money(ap)}, deferred revenue ${money(deferred)}, revenue to date ${money(revenue)}. `;
  yield `Ask me about cash, receivables, revenue, vendors, or what needs your OK, or say "start the close" to run month-end.`;
}
