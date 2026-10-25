/**
 * Consolidation harness: currency revaluations and intercompany eliminations for the group, never a posting or a
 * ruling. A revaluation's arithmetic is checked in the call (closing rate times the foreign balance, the delta, and the
 * lines that book it); whether the rate and balances are the recorded ones is a ledger join, checked by the eval.
 */
import { applyFx } from '@luyten/ledger-core';
import { PLAIN_RULE, BOOKS_TOOLS, allow, arr, baseName, deny, kindAllowed, mcp, noPosting, noRulings, obj, plainSummaryRule, rule, str } from './rules';
import type { Harness, ToolCall } from './types';

/** Intercompany differences above this many reporting-currency minor units ($1.00) are raised in the close thread. */
export const IC_DIFFERENCE_TOLERANCE_MINOR = 100n;

export const CONSOLIDATION_TOOLS = ['propose_fx_revaluation', 'propose_ic_elimination', 'revaluation_candidates', 'elimination_candidates', 'post_message', 'update_close_task'] as const;

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIFFER = /differ/;
/** A whole number of minor units written as a decimal string (or a safe integer); null otherwise. */
const minor = (v: unknown): bigint | null => (/^-?\d+$/.test(str(v)) ? BigInt(str(v)) : null);
const absBig = (v: bigint) => (v < 0n ? -v : v);

/** Balanced lines with whole, non-negative amounts, one side each; a reason when not. */
function linesProblem(lines: Record<string, unknown>[]): string | undefined {
  if (lines.length < 2) return 'an entry needs at least two lines';
  let dr = 0n;
  let cr = 0n;
  for (const l of lines) {
    const d = minor(l.debitMinor);
    const c = minor(l.creditMinor);
    if (d === null || c === null || d < 0n || c < 0n) return `line on ${str(l.accountCode) || '?'} needs whole, non-negative debitMinor and creditMinor`;
    if ((d === 0n) === (c === 0n)) return `line on ${str(l.accountCode) || '?'} is either a debit or a credit, not both or neither`;
    dr += d;
    cr += c;
  }
  return dr === cr ? undefined : `the lines do not balance: debits ${dr}, credits ${cr}`;
}

/** Net debit effect of an entry's lines on one account. */
const netOn = (lines: Record<string, unknown>[], code: string) => lines.filter(l => str(l.accountCode) === code).reduce((a, l) => a + (minor(l.debitMinor) ?? 0n) - (minor(l.creditMinor) ?? 0n), 0n);

const isElimination = (call: ToolCall) => baseName(call.tool) === 'propose_ic_elimination';
const isRevaluation = (call: ToolCall) => baseName(call.tool) === 'propose_fx_revaluation';

export const consolidation: Harness = {
  role: 'consolidation',
  charterFile: 'consolidation.md',
  fallbackPrompt: `You are the Consolidation agent. Cafoo Inc (US dollars) owns Cafoo Ltd (pounds); the group reports in dollars. Use revaluation_candidates and propose one currency revaluation per company with foreign-currency balances (propose_fx_revaluation, exactly the payload it returns). Use elimination_candidates and propose the balance elimination (reverses next month) and the activity elimination (this month's service fees) to the elimination subsidiary (propose_ic_elimination, exactly the payloads it returns). If a pair's two sides differ by more than one dollar, say so in the close thread first. You never post; you only propose. ${PLAIN_RULE}`,
  description: 'Group consolidation: currency revaluations and intercompany eliminations. Proposes only.',
  model: { env: 'WORKER_MODEL', default: 'sonnet' },
  tools: ['SendMessage', ...mcp('consolidation', CONSOLIDATION_TOOLS), ...mcp('books', BOOKS_TOOLS)],
  proposalKinds: ['fx_revaluation', 'ic_elimination'],
  maxTurns: 20,
  rules: [
    rule('consolidation.may.1', 'May 1', call => {
      const kind = kindAllowed(call, consolidation.proposalKinds);
      if (!kind.allow || (!isRevaluation(call) && !isElimination(call))) return kind;
      const periodYm = str(call.input.periodYm);
      if (!YM.test(periodYm)) return deny(`periodYm must be YYYY-MM; got "${periodYm}"`);
      if (!/^\d+$/.test(str(call.input.subsidiaryId))) return deny(`subsidiaryId must be the numeric subsidiary id; got "${str(call.input.subsidiaryId)}"`);
      const bad = linesProblem(arr(call.input.lines).map(obj));
      if (bad) return deny(bad);
      if (isRevaluation(call)) return arr(call.input.items).length ? allow : deny('a revaluation lists the balances it restates (items)');
      const pairs = arr(call.input.pairs).map(obj);
      if (!pairs.length) return deny('an elimination lists the intercompany pairs it removes (pairs)');
      const small = pairs.filter(p => !((minor(p.amountMinor) ?? 0n) > 0n)).map(p => str(p.label) || '?');
      if (small.length) return deny(`every pair eliminates a positive amountMinor; not ${small.join(', ')}`);
      const basis = str(call.input.basis);
      const reverses = str(call.input.reversesInYm);
      if (basis === 'balance') return YM.test(reverses) && reverses > periodYm ? allow : deny(`a balance elimination reverses in a later month than ${periodYm}; reversesInYm is "${reverses}"`);
      if (basis === 'activity') return reverses ? deny("an activity elimination covers only this month's activity and never reverses; drop reversesInYm") : allow;
      return deny(`basis is balance or activity; got "${basis}"`);
    }, {
      format:
        'Propose only currency revaluations (propose_fx_revaluation) and intercompany eliminations (propose_ic_elimination), each for an open month (periodYm) with the numeric subsidiaryId and balanced lines, every line a debit or a credit. A revaluation lists its items; an elimination lists its pairs, each with a positive amountMinor; basis "balance" reverses in a later month (reversesInYm), basis "activity" never reverses. Pass the payloads revaluation_candidates and elimination_candidates return unchanged.',
    }),
    rule('consolidation.may.2', 'May 2', call => {
      if (!isRevaluation(call)) return allow;
      const lines = arr(call.input.lines).map(obj);
      const functional = new Set(lines.map(l => str(l.ccy).toUpperCase()).filter(Boolean));
      const periodYm = str(call.input.periodYm);
      if (str(call.input.rateYm) && str(call.input.rateYm) !== periodYm) return deny(`revalue at the closing rate of ${periodYm}, not ${str(call.input.rateYm)}`);
      for (const it of arr(call.input.items).map(obj)) {
        const code = str(it.accountCode) || '?';
        const ccy = str(it.ccy).toUpperCase();
        if (!ccy || functional.has(ccy)) return deny(`${code}: revalue only balances held in a currency other than the company's own (its lines are in ${[...functional].join(', ') || 'no currency'}); got ${ccy || 'no currency'}`);
        const [txn, rate, booked, target, delta] = [it.txnBalanceMinor, it.closingRateE6, it.bookedFunctionalMinor, it.targetFunctionalMinor, it.deltaMinor].map(minor);
        if (txn === null || rate === null || booked === null || target === null || delta === null || rate <= 0n) return deny(`${code}: txnBalanceMinor, closingRateE6 (positive), bookedFunctionalMinor, targetFunctionalMinor and deltaMinor are whole numbers`);
        const want = applyFx(txn, rate);
        if (target !== want) return deny(`${code}: the ${ccy} balance ${txn} at the closing rate ${rate} is ${want}, not ${target}`);
        if (delta !== target - booked) return deny(`${code}: deltaMinor is target minus booked, ${target - booked}, not ${delta}`);
        const net = netOn(lines, str(it.accountCode));
        if (net !== delta) return deny(`${code}: the lines move this account by ${net}, not by its delta ${delta}`);
      }
      return allow;
    }, {
      format:
        'propose_fx_revaluation: every item is a balance in a currency other than the lines\' currency (the company\'s own); targetFunctionalMinor = txnBalanceMinor × closingRateE6 / 1,000,000 rounded half away from zero; deltaMinor = targetFunctionalMinor − bookedFunctionalMinor; the lines move each item\'s account by exactly its deltaMinor (the offset goes to the company\'s currency gain or loss account); rateYm, when given, equals periodYm.',
      partial: { scenario: 'consolidation-revalue-closing-rate.yaml', rest: "the closing rate is the one recorded for the month and each balance is the ledger's own through that month" },
    }),
    noPosting('consolidation.never.1', 'Must never 1'),
    noRulings('consolidation.never.2', 'Must never 2'),
    rule('consolidation.escalates.1', 'Escalates 1', (call, ctx) => {
      if (!isElimination(call) || !ctx.history) return allow;
      // As the eval reads it: the stated difference, or the amount less the counter side when that is larger.
      const gap = (p: Record<string, unknown>) => {
        const stated = absBig(minor(p.differenceMinor) ?? 0n);
        const derived = absBig((minor(p.amountMinor) ?? 0n) - (minor(p.counterTranslatedMinor) ?? minor(p.amountMinor) ?? 0n));
        return stated > derived ? stated : derived;
      };
      const off = arr(call.input.pairs).map(obj).filter(p => gap(p) > IC_DIFFERENCE_TOLERANCE_MINOR);
      if (!off.length) return allow;
      const thread = `close:${str(call.input.periodYm)}`;
      // The eval's trigger (consolidation-ic-difference-escalated): a close-thread message naming the pair and saying the books differ.
      const said = ctx.history.filter(c => baseName(c.tool) === 'post_message' && str(c.input.threadId) === thread).map(c => `${str(c.input.body)} ${str(c.input.summaryPlain)}`.toLowerCase());
      const unraised = off.filter(p => !said.some(t => DIFFER.test(t) && t.includes((str(p.label) || '?').toLowerCase())));
      return unraised.length ? deny(`${unraised.map(p => str(p.label) || '?').join(', ')} ${unraised.length > 1 ? 'differ' : 'differs'} by more than one dollar between the two companies; say so in ${thread} (post_message naming the pair and saying the books differ) before proposing the elimination`) : allow;
    }, {
      format: 'Before a propose_ic_elimination with any pair whose |differenceMinor| is over 100 (one dollar), post_message to threadId close:YYYY-MM naming that pair by its label and saying the two companies\' books differ, with the amount.',
      partial: { scenario: 'consolidation-ic-difference-escalated.yaml', rest: 'every intercompany difference over one dollar in the books is raised in the close thread, whether or not an elimination is proposed' },
    }),
    plainSummaryRule('consolidation.plain'),
  ],
  evalOnly: [
    { charter: 'Must never 3', scenario: 'consolidation-eliminate-books-balance.yaml', why: "the source company's intercompany balance or activity is ledger state, re-derived from its journal lines" },
    { charter: 'Escalates 2', scenario: 'advisor-material-waits.yaml', why: 'the wait for the CFO happens in the approval reducer after the Advisor rules; the summary half is the Plain summary rule' },
  ],
};
