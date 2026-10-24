import { describe, expect, it, vi } from 'vitest';
import { answerQuestion, CLOSE_COMMAND_SOURCE, closeCommand, isCloseCommand, monthIn, resolveYm } from '../src/advisor-chat';
import type { Cast } from '../src/stdb';

/** A cast whose advisor cache holds just these rows; every other table is empty. */
function fakeCast(rows: Record<string, unknown[]>): Cast {
  const db = new Proxy({} as Record<string, unknown>, {
    get: (_t, table: string) => ({
      iter: () => (rows[table] ?? [])[Symbol.iterator](),
      key: { find: () => undefined },
      id: { find: (id: bigint) => (rows[table] as { id: bigint }[] | undefined)?.find(r => r.id === id) },
    }),
  });
  return { advisor: { db } } as unknown as Cast;
}

const acct = (id: bigint, code: string, tag: string) => ({ id, subsidiaryId: 1n, code, name: code, accountType: { tag }, isIntercompany: false });
const books = (extra: Record<string, unknown[]> = {}) =>
  fakeCast({
    subsidiary: [{ id: 1n, name: 'Cafoo Inc' }],
    period: [
      { id: 1n, ym: '2026-08', status: { tag: 'Closed' } },
      { id: 2n, ym: '2026-09', status: { tag: 'Open' } },
    ],
    account: [acct(10n, '4000', 'Revenue'), acct(11n, '4100', 'Revenue'), acct(12n, '1000', 'Asset'), acct(13n, '2400', 'Liability')],
    journalEntry: [
      { id: 100n, periodId: 1n },
      { id: 101n, periodId: 2n },
    ],
    journalLine: [
      { jeId: 100n, accountId: 10n, debitMinor: 0n, creditMinor: 500000n },
      { jeId: 101n, accountId: 10n, debitMinor: 0n, creditMinor: 300000n },
      { jeId: 101n, accountId: 11n, debitMinor: 0n, creditMinor: 50000n },
    ],
    proposal: [
      {
        id: 7n,
        periodId: 2n,
        kind: { tag: 'JournalEntry' },
        status: { tag: 'AwaitingCfo' },
        summaryPlain: 'Recognize revenue.',
        amountMinor: 120000n,
        payloadJson: JSON.stringify({ lines: [{ accountCode: '2400', debitMinor: '120000', creditMinor: '0' }, { accountCode: '4000', debitMinor: '0', creditMinor: '120000' }] }),
      },
    ],
    ...extra,
  });
/** The same books before the close has proposed anything. */
const fresh = () => books({ proposal: [] });
const NOW = new Date('2026-10-24T12:00:00Z');
const ask = async (cast: Cast, q: string, opts = {}) => {
  let text = '';
  for await (const c of answerQuestion(cast, q, [], { now: NOW, ...opts })) text += c;
  return text;
};

describe('close command', () => {
  it('is the whole message: an explicit command with nothing else', () => {
    for (const t of ['start the close', 'Please run the month-end close', 'begin the September close', 'kick off the 2026-09 close now', '  Start close', 'start the close for August, please.', 'Run the close!'])
      expect(isCloseCommand(t), t).toBe(true);
    for (const t of [
      'Give me an overview',
      'How is the close going?',
      'Can you tell me when the month-end close will start?',
      '### Task:\nPredict 3-5 useful messages... say "start the close"',
      'Ask me about cash, or say "start the close" to run month-end.',
      'start the close and send me the October numbers too',
      'Run the close report and tell me what is left',
      'run the close checklist summary',
      'Start the close? No, just show me the status',
      'start the close?',
      'Please start the close. Jan from audit asked.',
    ])
      expect(isCloseCommand(t), t).toBe(false);
  });
  it('never parses a long message, and the pattern itself stays linear on long whitespace runs', () => {
    expect(isCloseCommand(`start the close${' '.repeat(300)}`)).toBe(false);
    const re = new RegExp(CLOSE_COMMAND_SOURCE, 'i');
    for (const s of [`start the close${' '.repeat(150_000)}x`, `start the close${' ,'.repeat(75_000)}x`, `${' '.repeat(150_000)}x`, `start${' '.repeat(150_000)}x`]) {
      const t0 = performance.now();
      expect(re.test(s)).toBe(false);
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });
  it('takes its month only from its own slot or a trailing "for <month>"', () => {
    expect(closeCommand('start the close')).toEqual({});
    expect(closeCommand('start the may close')).toEqual({ month: { month: 5 } });
    expect(closeCommand('run the 2026-08 close')).toEqual({ month: { year: 2026, month: 8 } });
    expect(closeCommand('start the close for September 2026 now')).toEqual({ month: { year: 2026, month: 9 } });
  });
});

describe('month in a question', () => {
  it('reads YYYY-MM and month names with or without a year', () => {
    expect(monthIn('revenue for 2026-08')).toEqual({ year: 2026, month: 8 });
    expect(monthIn('What was revenue in September?')).toEqual({ month: 9 });
    expect(monthIn('cash at the end of Aug 2026')).toEqual({ month: 8, year: 2026 });
    expect(monthIn('revenue for may')).toEqual({ month: 5 });
    expect(monthIn('What may I approve?')).toBeUndefined();
    expect(monthIn('How do we decide on the market?')).toBeUndefined();
    // Month words that are also everyday words or names need a year or a preposition.
    expect(monthIn('Jan from audit asked about cash')).toBeUndefined();
    expect(monthIn('we march on; June will check it')).toBeUndefined();
    expect(monthIn('cash in march')).toEqual({ month: 3 });
    expect(monthIn('June 2026 revenue')).toEqual({ month: 6, year: 2026 });
    expect(monthIn('September revenue')).toEqual({ month: 9 });
  });
  it('reads "last month" and "this month" from today', () => {
    expect(monthIn('revenue last month', NOW)).toEqual({ year: 2026, month: 9 });
    expect(monthIn('cash this month', NOW)).toEqual({ year: 2026, month: 10 });
    expect(monthIn('revenue last month', new Date('2026-01-10T00:00:00Z'))).toEqual({ year: 2025, month: 12 });
  });
  it('defaults to the close year, else the latest such period, and names a missing one', () => {
    const yms = ['2025-12', '2026-08', '2026-09'];
    expect(resolveYm('September revenue', yms, '2026-09')).toEqual({ ym: '2026-09' });
    expect(resolveYm('December revenue', yms, '2026-09')).toEqual({ ym: '2025-12' });
    expect(resolveYm('revenue in March', yms, '2026-09')).toEqual({ missing: 'March 2026' });
    expect(resolveYm('revenue for 2027-01', yms, '2026-09')).toEqual({ missing: 'January 2027' });
    expect(resolveYm('how are we doing', yms, '2026-09')).toBeUndefined();
  });
});

describe('answerQuestion', () => {
  it("reports one month's revenue as that month's movement, with pending revenue proposals", async () => {
    const text = await ask(books(), 'What was revenue in September?');
    expect(text).toMatch(/Revenue for September 2026 is \$3,500 on the books/);
    expect(text).toMatch(/1 revenue proposal worth \$1,200 for that month is still waiting/);
    expect(await ask(books(), 'revenue for August 2026')).toMatch(/Revenue for August 2026 is \$5,000/);
    expect(await ask(books(), 'What is revenue to date?')).toMatch(/Revenue recognized to date is \$8,500/);
  });

  it('tells a missing period apart from unseeded books', async () => {
    expect(await ask(books(), 'What was revenue in March?')).toMatch(/There is no March 2026 period in the books; they run from August 2026 to September 2026/);
    expect(await ask(fakeCast({}), 'What was revenue in September?')).toMatch(/not seeded/);
  });

  it('starts a close only on the command, and reports a running or failed start', async () => {
    const startClose = vi.fn(async () => ({ status: 'started' as const }));
    expect(await ask(fresh(), 'Give me an overview', { startClose })).toMatch(/Here is where Cafoo Inc stands/);
    expect(await ask(fresh(), 'start the close and send me the September numbers too', { startClose })).not.toMatch(/Starting/);
    expect(startClose).not.toHaveBeenCalled();
    expect(await ask(fresh(), 'start the close', { startClose })).toMatch(/Starting the September 2026 close/);
    expect(startClose).toHaveBeenCalledWith('2026-09');
    expect(await ask(fresh(), 'start the close', { startClose: async () => ({ status: 'running' as const }) })).toMatch(/already running/);
    expect(await ask(fresh(), 'start the close', { startClose: async () => ({ status: 'failed' as const, error: 'boom' }) })).toMatch(/could not start the September 2026 close: boom/);
    expect(await ask(fresh(), 'start the August close', { startClose })).toMatch(/August 2026 is already closed/);
    expect(await ask(fresh(), 'start the may close', { startClose })).toMatch(/There is no May 2026 period in the books to close/);
    expect(startClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a month that has not ended, and tells a resume or a requested lock apart from a start', async () => {
    const startClose = vi.fn(async () => ({ status: 'started' as const }));
    expect(await ask(fresh(), 'start the close', { startClose, now: new Date('2026-09-20T00:00:00Z') })).toMatch(/September 2026 has not ended yet/);
    expect(startClose).not.toHaveBeenCalled();
    // A close is under way once the Advisor opened it in the close thread.
    const opened = [{ threadId: 'close:2026-09', senderRole: 'advisor', body: 'Opening the 2026-09 close for Cafoo Inc. Bookkeeper, Revenue, and Credit & Risk: work your tasks and propose.' }];
    const resumed = fakeCast({
      subsidiary: [{ id: 1n, name: 'Cafoo Inc' }],
      period: [{ id: 2n, ym: '2026-09', status: { tag: 'Open' } }],
      proposal: [{ id: 7n, periodId: 2n, kind: { tag: 'JournalEntry' }, status: { tag: 'AwaitingCfo' }, payloadJson: '{}', summaryPlain: 'x', amountMinor: 0n }],
      agentMessage: opened,
    });
    expect(await ask(resumed, 'start the close', { startClose })).toMatch(/already ran, so I am picking it up where it stopped instead of proposing again: 1 item still need/);
    // Proposals the live feed filed during the month (no close task, no opening message) do not make it a resume.
    const fed = fakeCast({
      subsidiary: [{ id: 1n, name: 'Cafoo Inc' }],
      period: [{ id: 2n, ym: '2026-09', status: { tag: 'Open' } }],
      proposal: [{ id: 7n, periodId: 2n, kind: { tag: 'BankMatch' }, status: { tag: 'Approved' }, payloadJson: '{}', summaryPlain: 'x', amountMinor: 0n }],
    });
    expect(await ask(fed, 'start the close', { startClose })).toMatch(/Starting the September 2026 close/);
    // Opened but failed before filing anything: it starts again rather than resuming with nothing.
    const failed = fakeCast({ subsidiary: [{ id: 1n, name: 'Cafoo Inc' }], period: [{ id: 2n, ym: '2026-09', status: { tag: 'Open' } }], agentMessage: opened });
    expect(await ask(failed, 'start the close', { startClose })).toMatch(/Starting the September 2026 close/);
    // A close from before the opening message existed filed its Proposals against close tasks.
    const legacy = fakeCast({
      subsidiary: [{ id: 1n, name: 'Cafoo Inc' }],
      period: [{ id: 2n, ym: '2026-09', status: { tag: 'Open' } }],
      proposal: [{ id: 7n, periodId: 2n, kind: { tag: 'JournalEntry' }, status: { tag: 'AwaitingCfo' }, payloadJson: '{}', summaryPlain: 'x', amountMinor: 0n, closeTaskId: 3n }],
    });
    expect(await ask(legacy, 'start the close', { startClose })).toMatch(/already ran/);
    const stuck = fakeCast({
      subsidiary: [{ id: 1n, name: 'Cafoo Inc' }],
      agentMessage: opened,
      period: [{ id: 2n, ym: '2026-09', status: { tag: 'Open' } }],
      proposal: [{ id: 7n, periodId: 2n, kind: { tag: 'JournalEntry' }, status: { tag: 'Approved' }, payloadJson: '{}', summaryPlain: 'x', amountMinor: 0n }],
      closeTask: [{ id: 3n, periodId: 2n, title: 'Review payables and accruals', status: { tag: 'Blocked' }, sortOrder: 3 }],
      contractItem: [{ id: 41n, contractId: 1n, kind: { tag: 'Subscription' } }],
      revenueScheduleLine: [{ id: 1n, contractItemId: 41n, customerId: 7n, ym: '2026-09', amountMinor: 220000n, recognized: false }],
    });
    const text = await ask(stuck, 'start the close', { startClose });
    expect(text).toMatch(/one close task is blocked \("Review payables and accruals"\) and needs a person; \$2,200 of subscription revenue through September 2026 is not recognized yet\. I will ask to lock only once those are resolved\./);
    expect(text).not.toMatch(/I will ask to lock it\./);
    const closing = fakeCast({ subsidiary: [{ id: 1n, name: 'Cafoo Inc' }], period: [{ id: 2n, ym: '2026-09', status: { tag: 'Closing' } }] });
    expect(await ask(closing, 'start the close', { startClose })).toMatch(/lock has been requested/);
    expect(startClose).toHaveBeenCalledTimes(5);
  });
});
