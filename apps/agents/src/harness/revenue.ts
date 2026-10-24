/** Revenue harness: recognition schedules and revenue entries, never ahead of the service month. */
import { PLAIN_RULE, BOOKS_TOOLS, allow, arr, baseName, deny, idKey, kindAllowed, mcp, noPosting, noRulings, obj, plainSummaryRule, rule, str } from './rules';
import type { Harness } from './types';

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthIndex = (ym: string) => {
  const m = YM.exec(ym);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : NaN;
};
const toBig = (v: unknown): bigint | null => {
  try {
    return BigInt(str(v));
  } catch {
    return null;
  }
};

export const revenue: Harness = {
  role: 'revenue',
  charterFile: 'revenue.md',
  fallbackPrompt: `You are the Revenue agent. Every subscription contract must have a recognition schedule; use close_snapshot and build_revenue_schedule and propose any missing schedule. Then propose one journal entry recognizing this month's unrecognized schedule lines (Dr 2400 Deferred Revenue / Cr 4000 Subscription Revenue per customer, with recognizeScheduleYm set) and one for usage invoices of the month (Dr 1100 / Cr 4100). Never recognize revenue before the service month. You never post; you only propose. ${PLAIN_RULE}`,
  description: 'Revenue schedules, recognition, deferred revenue. Proposes only.',
  model: { env: 'WORKER_MODEL', default: 'sonnet' },
  tools: ['SendMessage', ...mcp('revenue', ['propose_revenue_schedule', 'propose_journal_entry', 'post_message', 'update_close_task']), ...mcp('books', BOOKS_TOOLS)],
  proposalKinds: ['revenue_schedule', 'journal_entry'],
  maxTurns: 30,
  rules: [
    rule('revenue.may.1', 'May 1', call => {
      const kind = kindAllowed(call, revenue.proposalKinds);
      if (!kind.allow || baseName(call.tool) !== 'propose_journal_entry') return kind;
      // Same shape the eval requires (revenue-proposal-kinds): the second line is the revenue credit.
      const second = str(obj(arr(call.input.lines)[1]).accountCode);
      return /^4\d{3}$/.test(second) ? allow : deny(`a revenue journal entry has its revenue account (4xxx) on the second line; got "${second}"`);
    }, { format: 'Propose only revenue schedules and revenue journal entries; in every propose_journal_entry the second line (lines[1]) is on a 4xxx revenue account, e.g. 2400 debit then 4000 credit.' }),
    rule('revenue.may.2', 'May 2', call => {
      if (baseName(call.tool) !== 'propose_revenue_schedule') return allow;
      const months = arr(call.input.lines).map(l => str(obj(l).ym));
      const bad = months.find(m => !YM.test(m));
      if (bad !== undefined) return deny(`schedule month "${bad}" is not YYYY-MM`);
      const idx = months.map(monthIndex).sort((a, b) => a - b);
      if (new Set(idx).size !== idx.length) return deny('a month is scheduled twice; one line per month of the term');
      if (idx.length && idx[idx.length - 1]! - idx[0]! + 1 !== idx.length) return deny('schedule months must run without gaps across the contract term');
      return allow;
    }, { format: 'propose_revenue_schedule: one line per month as YYYY-MM, no month twice, no gaps, for the customer\'s own subscription contract item and never a month that item already has (use build_revenue_schedule).' }),
    noPosting('revenue.never.1', 'Must never 1'),
    rule('revenue.never.2', 'Must never 2', call => {
      const name = baseName(call.tool);
      if (name === 'propose_journal_entry') {
        const rec = str(call.input.recognizeScheduleYm);
        if (rec && rec > str(call.input.periodYm)) return deny(`recognizes ${rec} revenue in ${str(call.input.periodYm)}, before its service month`);
        // Subscription revenue is earned only through the schedule: a net 4000 credit needs a recognition entry.
        const net4000 = arr(call.input.lines).map(obj).filter(l => str(l.accountCode) === '4000').reduce((a, l) => a + (toBig(l.creditMinor) ?? 0n) - (toBig(l.debitMinor) ?? 0n), 0n);
        return net4000 > 0n && !rec ? deny('a net credit to 4000 Subscription Revenue appears only in a recognition entry (set recognizeScheduleYm); usage revenue goes to 4100') : allow;
      }
      if (name !== 'propose_revenue_schedule') return allow;
      const total = toBig(call.input.totalMinor);
      const amounts = arr(call.input.lines).map(l => toBig(obj(l).amountMinor));
      if (total === null || amounts.some(a => a === null)) return deny('totalMinor and every line amountMinor must be whole minor units');
      const sum = amounts.reduce<bigint>((a, b) => a + b!, 0n);
      return sum === total ? allow : deny(`schedule lines sum to ${sum} minor units, not the contract total ${total}`);
    }, {
      format: 'A net credit to 4000 Subscription Revenue appears only in a recognition entry: recognizeScheduleYm set and never after periodYm (an open month). Usage revenue goes to 4100. Schedule line amountMinor values sum exactly to totalMinor.',
      partial: { scenario: 'revenue-recognition-timing.yaml', rest: 'recognized lines land in their own month or later, and schedules sum to the contract total on file' },
    }),
    noRulings('revenue.never.4', 'Must never 4'),
    rule(
      'revenue.escalates.1',
      'Escalates 1',
      (call, ctx) => {
        if (baseName(call.tool) !== 'propose_journal_entry' || !str(call.input.recognizeScheduleYm)) return allow;
        const lines = arr(call.input.lines).map(obj);
        // Only the 4000 lines carry the customer (a combined, untagged 2400 debit is valid).
        const revenueLines = lines.filter(l => str(l.accountCode) === '4000');
        const untagged = revenueLines.filter(l => !idKey(l.customerId)).length;
        if (untagged) return deny(`a recognition entry tags every 4000 Subscription Revenue line with its customerId; ${untagged} line(s) have none`);
        // A customer whose new schedule still waits for a ruling is recognized only once the schedule is approved.
        const waitingSchedule = new Set(
          (ctx.pendingProposals ?? []).filter(p => p.kind === 'revenue_schedule').flatMap(p => arr(p.payload.lines).map(l => idKey(obj(l).customerId) ?? ''))
        );
        const waiting = [...new Set(revenueLines.map(l => idKey(l.customerId)!))].filter(c => waitingSchedule.has(c));
        return waiting.length ? deny(`customer ${waiting.join(', ')} has a revenue schedule still waiting for a ruling; leave ${waiting.length > 1 ? 'them' : 'it'} out of this recognition entry until the schedule is approved`) : allow;
      },
      {
        format:
          'A recognition entry (propose_journal_entry with recognizeScheduleYm) tags every 4000 line with customerId, credits 4000 for each customer exactly that customer\'s unrecognized subscription schedule lines through recognizeScheduleYm, and leaves out any customer whose revenue schedule proposal is still waiting for a ruling: propose the schedule, and recognize it once it is approved.',
        partial: { scenario: 'revenue-unscheduled-contracts.yaml', rest: 'every invoiced annual contract gets a schedule or a schedule proposal at all' },
      }
    ),
    plainSummaryRule('revenue.plain'),
  ],
  evalOnly: [
    { charter: 'Must never 3', scenario: 'revenue-schedule-within-term.yaml', why: "the contract's start and end months are in the ledger, not in the propose call" },
    { charter: 'Escalates 2', scenario: 'advisor-material-waits.yaml', why: 'the wait for the CFO happens in the approval reducer after the Advisor rules; the summary half is the Plain summary rule' },
  ],
};
