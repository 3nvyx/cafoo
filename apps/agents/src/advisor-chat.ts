/**
 * "Ask the books": answers chat questions from the live ledger.
 * Demo mode answers deterministic questions from the tables; live mode hands the question to the Advisor.
 */
import { formatMinor } from '@cafoo/ledger-core';
import { agentsLive } from './env';
import { snapshot } from './snapshot';
import type { Cast } from './stdb';

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });

export async function* answerQuestion(cast: Cast, question: string, _history: { role: string; content: string }[]): AsyncGenerator<string> {
  const q = question.toLowerCase();
  const A = cast.advisor;
  const periods = [...A.db.period.iter()].sort((a, b) => a.ym.localeCompare(b.ym));
  const openPeriod = periods.find(p => p.status.tag !== 'Closed') ?? periods[periods.length - 1];
  const closeYm = /\b(20\d{2}-\d{2})\b/.exec(q)?.[1] ?? openPeriod?.ym ?? '';
  let s;
  try {
    s = snapshot(A, closeYm);
  } catch {
    yield 'The books are not seeded yet. Run the seed loader first.';
    return;
  }

  if (/close|month.?end/.test(q) && /(start|run|begin|kick)/.test(q)) {
    const res = await fetch(`http://localhost:${process.env.GATEWAY_PORT ?? 8787}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodYm: closeYm }) }).catch(() => null);
    yield res ? `Starting the ${closeYm} close. Watch the Agents page: the Bookkeeper, Revenue, and Credit & Risk will propose, the Red Team will challenge, and I will rule. Anything material will wait for your OK.` : `I could not reach the close runner.`;
    return;
  }

  if (agentsLive()) {
    const { liveAnswer } = await import('./live/orchestrator');
    yield* liveAnswer(cast, question);
    return;
  }

  const cash = s.balance('1000');
  const ar = s.balance('1100');
  const allowance = -s.balance('1150');
  const deferred = -s.balance('2400');
  const ap = -s.balance('2000');
  const revenue = -(s.balance('4000') + s.balance('4100'));
  const pending = [...A.db.proposal.iter()].filter(p => p.status.tag === 'AwaitingCfo');
  const overdue = [...A.db.invoice.iter()].filter(i => i.status.tag === 'Overdue');

  if (/cash|runway|bank balance/.test(q)) {
    yield `Cash is ${money(cash)}. `;
    const monthlyBurn = [...A.db.bill.iter()].filter(b => b.ym === closeYm).reduce((a, b) => a + b.amountMinor, 0n);
    yield `Bills recorded for ${closeYm} total ${money(monthlyBurn)}, so at that pace cash covers roughly ${monthlyBurn > 0n ? Number(cash / monthlyBurn) : 'many'} months before new collections.`;
    return;
  }
  if (/receivable|\bar\b|overdue|owe us|collect/.test(q)) {
    yield `Open receivables total ${money(ar)} with an allowance of ${money(allowance)} set aside. `;
    if (overdue.length) {
      const names = overdue.map(i => `${s.customerName.get(i.customerId)} (${money(i.amountMinor)})`).join(', ');
      yield `${overdue.length} invoice${overdue.length > 1 ? 's are' : ' is'} overdue: ${names}.`;
    } else yield `Nothing is overdue.`;
    return;
  }
  if (/deferred|recogni[sz]e|revenue/.test(q)) {
    yield `Revenue recognized to date is ${money(revenue)}, and deferred revenue still to be earned is ${money(deferred)}. `;
    yield `Revenue is recognized evenly over each annual contract and in the month of use for metered plans; every number drills down to its journal lines in the Ledger.`;
    return;
  }
  if (/payable|\bap\b|vendor|bills?/.test(q)) {
    const blocked = [...A.db.vendor.iter()].filter(v => v.verification.tag === 'Blocked');
    yield `Accounts payable stands at ${money(ap)}. `;
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
    yield `Open the Launchpad to approve or send back.`;
    return;
  }
  if (/status|where are we|how.*close/.test(q)) {
    const tasks = s.closeTasks;
    const done = tasks.filter(t => t.status.tag === 'Done').length;
    yield `${closeYm} is ${openPeriod?.status.tag === 'Closed' ? 'closed' : 'open'}: ${done} of ${tasks.length} close tasks done, ${pending.length} item${pending.length === 1 ? '' : 's'} waiting for your OK. Cash ${money(cash)}, receivables ${money(ar)}, deferred revenue ${money(deferred)}.`;
    return;
  }
  yield `Here is where ${s.subsidiary.name} stands for ${closeYm}: cash ${money(cash)}, receivables ${money(ar)} (allowance ${money(allowance)}), payables ${money(ap)}, deferred revenue ${money(deferred)}, revenue to date ${money(revenue)}. `;
  yield `Ask me about cash, receivables, revenue, vendors, or what needs your OK, or say "start the close" to run month-end.`;
}
