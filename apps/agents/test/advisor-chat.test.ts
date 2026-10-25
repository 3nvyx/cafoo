import { describe, expect, it, vi } from 'vitest';
import { bankExceptionSnapshot } from '@cafoo/ledger-core';
import { answerQuestion, CLOSE_COMMAND_SOURCE, closeCommand, isCloseCommand, monthIn, policyExcerpt, resolveYm } from '../src/advisor-chat';
import type { Cast } from '../src/stdb';
import { ts } from './fake-conn';

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
    subsidiary: [{ id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', isElimination: false }],
    period: [
      { id: 1n, ym: '2026-08', status: { tag: 'Closed' } },
      { id: 2n, ym: '2026-09', status: { tag: 'Open' } },
    ],
    account: [acct(10n, '4000', 'Revenue'), acct(11n, '4100', 'Revenue'), acct(12n, '1000', 'Asset'), acct(13n, '2400', 'Liability')],
    journalEntry: [
      { id: 100n, periodId: 1n, postedAt: ts('2026-08-31'), source: { tag: 'Seed' } },
      { id: 101n, periodId: 2n, postedAt: ts('2026-09-30'), source: { tag: 'Seed' } },
    ],
    journalLine: [
      { id: 1n, jeId: 100n, accountId: 10n, debitMinor: 0n, creditMinor: 500000n, ccy: 'USD', fxRateE6: 1000000n },
      { id: 2n, jeId: 101n, accountId: 10n, debitMinor: 0n, creditMinor: 300000n, ccy: 'USD', fxRateE6: 1000000n },
      { id: 3n, jeId: 101n, accountId: 11n, debitMinor: 0n, creditMinor: 50000n, ccy: 'USD', fxRateE6: 1000000n },
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
  it('answers a policy question by quoting the house policy, not a figure', async () => {
    vi.stubEnv('MOSS_PROJECT_ID', '');
    const text = await ask(books(), 'What is our policy on accruals for bills dated after month end?');
    expect(text).toMatch(/^From the accruals policy: .*accrued/);
    expect(text).toContain('The Red Team checks every Proposal against these same policies');
  });

  it('reads pending revenue payloads the way the module posts them, and never fails on one it would refuse', async () => {
    const entry = (id: bigint, lines: unknown) => ({ id, periodId: 2n, kind: { tag: 'JournalEntry' }, status: { tag: 'AwaitingCfo' }, summaryPlain: 'x', amountMinor: 0n, payloadJson: JSON.stringify({ lines }) });
    const text = await ask(books({ proposal: [
      // "" is zero, numbers are whole minor units, and a zero rate is 1.0, as in the module's parseLines.
      entry(7n, [{ accountCode: '2400', debitMinor: 120000, creditMinor: '' }, { accountCode: '4000', debitMinor: '', creditMinor: 120000, fxRateE6: '0' }]),
      entry(8n, [{ accountCode: '4000', creditMinor: '12.5' }]),
      { ...entry(9n, []), payloadJson: 'not json' },
    ] }), 'What was revenue in September?');
    expect(text).toMatch(/1 revenue proposal worth \$1,200 for that month is still waiting/);
  });

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


/** Three sets of books: £200 UK revenue, £100 UK expense, and $127 fee eliminations. */
const groupBooks = (extra: Record<string, unknown[]> = {}) => books({
  subsidiary: [
    { id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', isElimination: false },
    { id: 2n, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: 1n, isElimination: false },
    { id: 3n, code: 'ELIM', name: 'Eliminations', functionalCcy: 'USD', parentId: 1n, isElimination: true },
  ],
  account: [
    acct(10n, '4000', 'Revenue'), acct(11n, '5000', 'Expense'), acct(12n, '1000', 'Asset'),
    { ...acct(20n, '4000-UK', 'Revenue'), subsidiaryId: 2n },
    { ...acct(21n, '5000-UK', 'Expense'), subsidiaryId: 2n },
    { ...acct(22n, '1000-UK', 'Asset'), subsidiaryId: 2n },
    { ...acct(30n, '4000-ELIM', 'Revenue'), subsidiaryId: 3n },
    { ...acct(31n, '5000-ELIM', 'Expense'), subsidiaryId: 3n },
  ],
  journalLine: [
    { id: 1n, jeId: 101n, accountId: 10n, debitMinor: 0n, creditMinor: 100000n, ccy: 'USD', fxRateE6: 1000000n },
    { id: 2n, jeId: 101n, accountId: 11n, debitMinor: 150000n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1000000n },
    { id: 3n, jeId: 101n, accountId: 20n, debitMinor: 0n, creditMinor: 20000n, ccy: 'GBP', fxRateE6: 1000000n },
    { id: 4n, jeId: 101n, accountId: 21n, debitMinor: 10000n, creditMinor: 0n, ccy: 'GBP', fxRateE6: 1000000n },
    { id: 5n, jeId: 101n, accountId: 30n, debitMinor: 12700n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1000000n },
    { id: 6n, jeId: 101n, accountId: 31n, debitMinor: 0n, creditMinor: 12700n, ccy: 'USD', fxRateE6: 1000000n },
    { id: 7n, jeId: 101n, accountId: 12n, debitMinor: 10000n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1000000n },
    { id: 8n, jeId: 101n, accountId: 22n, debitMinor: 20000n, creditMinor: 0n, ccy: 'GBP', fxRateE6: 1000000n },
  ],
  fxRate: [
    { id: 1n, ym: '2026-09', fromCcy: 'GBP', toCcy: 'USD', rateE6: 1270000n, kind: { tag: 'Average' } },
    { id: 2n, ym: '2026-09', fromCcy: 'GBP', toCcy: 'USD', rateE6: 1280000n, kind: { tag: 'Closing' } },
  ],
  proposal: [],
  ...extra,
});

describe('grounded financial answers', () => {
  it('reports each company cash in its own currency and does not infer runway from missing bills', async () => {
    const cast = books({
      subsidiary: [
        { id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', isElimination: false },
        { id: 2n, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: 1n, isElimination: false },
      ],
      account: [acct(12n, '1000', 'Asset'), { ...acct(20n, '1000-UK', 'Asset'), subsidiaryId: 2n }],
      journalLine: [
        { id: 1n, jeId: 101n, accountId: 12n, debitMinor: 35554200n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1000000n },
        { id: 2n, jeId: 101n, accountId: 20n, debitMinor: 17805000n, creditMinor: 0n, ccy: 'GBP', fxRateE6: 1000000n },
      ],
    });
    const answer = await ask(cast, 'How much cash do we have by company, and what is our runway?');
    expect(answer).toContain('Cafoo Inc: $355,542');
    expect(answer).toContain('Cafoo Ltd: £178,050');
    expect(answer).toContain('as of October 24, 2026');
    expect(answer).toMatch(/cannot estimate runway/i);
    expect(answer).not.toMatch(/end of October|many months|covers roughly/);
  });
});


it('answers consolidated P&L with expenses, currency translation and eliminations', async () => {
  const answer = await ask(groupBooks(), 'What is the consolidated September P&L?');
  expect(answer).toContain('September 2026');
  expect(answer).toContain('Cafoo Inc: revenue $1,000, expenses $1,500, net loss $500');
  expect(answer).toContain('Cafoo Ltd: revenue £200, expenses £100, net income £100');
  expect(answer).toContain('Consolidated group: revenue $1,127, expenses $1,500, net loss $373');
  expect(answer).toMatch(/including.*eliminations/i);
  expect(answer).toContain('Board Pack');
});

it('answers group ARR from active subscriptions, excluding usage and translating UK contracts', async () => {
  const answer = await ask(groupBooks({
    customer: [{ id: 1n, subsidiaryId: 1n, name: 'US customer' }, { id: 2n, subsidiaryId: 2n, name: 'UK customer' }],
    contract: [
      { id: 1n, customerId: 1n, startYm: '2026-01', endYm: '2026-12', totalMinor: 240000n, plan: { tag: 'Annual' } },
      { id: 2n, customerId: 2n, startYm: '2026-01', endYm: '2026-12', totalMinor: 120000n, plan: { tag: 'Annual' } },
      { id: 3n, customerId: 1n, startYm: '2026-01', endYm: '2026-12', totalMinor: 999999n, plan: { tag: 'Usage' } },
    ],
    contractItem: [
      { id: 1n, contractId: 1n, kind: { tag: 'Subscription' }, priceMinor: 20000n, qty: 1n, sspMinor: 240000n },
      { id: 2n, contractId: 2n, kind: { tag: 'Subscription' }, priceMinor: 10000n, qty: 1n, sspMinor: 120000n },
      { id: 3n, contractId: 3n, kind: { tag: 'Usage' }, priceMinor: 999999n, qty: 1n, sspMinor: 999999n },
    ],
  }), 'What is our group ARR for September?');
  expect(answer).toContain('Cafoo Inc: $2,400');
  expect(answer).toContain('Cafoo Ltd: £1,200');
  expect(answer).toContain('Consolidated group ARR: $3,936');
  expect(answer).toMatch(/usage.*excluded/i);
});

it('discloses missing contract coverage instead of treating absent UK contracts as complete group ARR', async () => {
  const answer = await ask(groupBooks(), 'What is our ARR for September?');
  expect(answer).toMatch(/Cafoo Ltd.*no contracts on file/i);
  expect(answer).toMatch(/group ARR.*incomplete|incomplete.*group ARR/i);
});

it('answers allowance adequacy with gross and net receivables in each currency, without claiming sufficiency', async () => {
  const answer = await ask(groupBooks({
    account: [acct(40n, '1100', 'Asset'), acct(41n, '1150', 'Asset'), { ...acct(42n, '1100-UK', 'Asset'), subsidiaryId: 2n }, { ...acct(43n, '1150-UK', 'Asset'), subsidiaryId: 2n }],
    journalLine: [
      { id: 1n, jeId: 101n, accountId: 40n, debitMinor: 100000n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1000000n },
      { id: 2n, jeId: 101n, accountId: 41n, debitMinor: 0n, creditMinor: 25000n, ccy: 'USD', fxRateE6: 1000000n },
      { id: 3n, jeId: 101n, accountId: 42n, debitMinor: 50000n, creditMinor: 0n, ccy: 'GBP', fxRateE6: 1000000n },
      { id: 4n, jeId: 101n, accountId: 43n, debitMinor: 0n, creditMinor: 10000n, ccy: 'GBP', fxRateE6: 1000000n },
    ],
  }), 'Is our allowance adequate for September?');
  expect(answer).toContain('Cafoo Inc: gross receivables $1,000, allowance $250, net receivables $750');
  expect(answer).toContain('Cafoo Ltd: gross receivables £500, allowance £100, net receivables £400');
  expect(answer).toMatch(/cannot conclude.*adequacy/i);
  expect(answer).toMatch(/unmatched receipts/);
});

it('honors an explicit company instead of answering for the parent or whole group', async () => {
  const cash = await ask(groupBooks(), 'How much cash does Cafoo Ltd have in September?');
  expect(cash).toContain('Cafoo Ltd: £200');
  expect(cash).not.toContain('Cafoo Inc');
  const pnl = await ask(groupBooks(), 'What is the UK P&L for September?');
  expect(pnl).toContain('Cafoo Ltd: revenue £200, expenses £100, net income £100');
  expect(pnl).not.toContain('Cafoo Inc');
  expect(pnl).not.toContain('Consolidated group');
});

it('answers a consolidated group overview rather than silently returning US-only balances', async () => {
  const answer = await ask(groupBooks(), 'Give me the consolidated group view for September.');
  expect(answer).toContain('Consolidated group');
  expect(answer).toContain('cash $356');
  expect(answer).toContain('net loss $373');
  expect(answer).toContain('September 2026');
});

it('reports unresolved receipts and outflows separately in their recorded currencies', async () => {
  const answer = await ask(groupBooks({ bankTransaction: [
    { id: 1n, subsidiaryId: 1n, ym: '2026-09', bookedAt: ts('2026-09-05'), amountMinor: 5000n, ccy: 'USD', matched: false },
    { id: 2n, subsidiaryId: 2n, ym: '2026-09', bookedAt: ts('2026-09-05'), amountMinor: 7000n, ccy: 'GBP', matched: false },
    { id: 3n, subsidiaryId: 1n, ym: '2026-09', bookedAt: ts('2026-09-06'), amountMinor: -2000n, ccy: 'USD', matched: false },
    { id: 4n, subsidiaryId: 1n, ym: '2026-10', bookedAt: ts('2026-10-05'), amountMinor: 999999n, ccy: 'USD', matched: false },
    { id: 5n, subsidiaryId: 1n, ym: '2026-09', bookedAt: ts('2026-09-05'), amountMinor: 111111n, ccy: 'USD', matched: true },
  ] }), 'What bank receipts remain unmatched for September?');
  expect(answer).toContain('Cafoo Inc: 1 unmatched receipt totaling $50; 1 unmatched outflow totaling $20');
  expect(answer).toContain('Cafoo Ltd: 1 unmatched receipt totaling £70');
  expect(answer).toMatch(/not fully reconciled/);
  expect(answer).not.toContain('9,999.99');
});

it('derives overdue exposure from due dates and separates company currencies despite stale status flags', async () => {
  const cast = groupBooks({
    customer: [{ id: 1n, subsidiaryId: 1n, name: 'US customer' }, { id: 2n, subsidiaryId: 2n, name: 'UK customer' }],
    invoice: [
      { id: 1n, customerId: 1n, ym: '2026-09', amountMinor: 10000n, dueAt: ts('2026-10-01'), status: { tag: 'Open' } },
      { id: 2n, customerId: 2n, ym: '2026-09', amountMinor: 20000n, dueAt: ts('2026-10-01'), status: { tag: 'Open' } },
      { id: 3n, customerId: 1n, ym: '2026-09', amountMinor: 999999n, dueAt: ts('2026-09-01'), status: { tag: 'Paid' } },
    ],
  });
  const current = await ask(cast, 'What is overdue today?');
  expect(current).toContain('Cafoo Inc: 1 overdue invoice totaling $100');
  expect(current).toContain('Cafoo Ltd: 1 overdue invoice totaling £200');
  expect(current).toContain('October 24, 2026');
  expect(current).not.toContain('9,999.99');
  const historical = await ask(cast, 'What was overdue for September?');
  expect(historical).toContain('Cafoo Inc: 0 overdue invoices');
  expect(historical).toContain('September 30, 2026');
  expect(historical).toMatch(/current unpaid.*status/i);
});

it('includes the translated total when the CFO explicitly asks for consolidated cash', async () => {
  const answer = await ask(groupBooks(), 'What is consolidated cash for September?');
  expect(answer).toContain('Consolidated group cash: $356');
  expect(answer).toMatch(/closing rate/i);
});

it('keeps legacy revenue and payables answers in the requested company scope and functional currency', async () => {
  const revenue = await ask(groupBooks(), 'What revenue did the UK recognize in September?');
  expect(revenue).toContain('Revenue for September 2026 is £200 on the books');
  expect(revenue).not.toContain('$1,000');
  const payables = await ask(groupBooks({
    account: [{ ...acct(23n, '2000-UK', 'Liability'), subsidiaryId: 2n }],
    journalLine: [{ id: 1n, jeId: 101n, accountId: 23n, debitMinor: 0n, creditMinor: 8000n, ccy: 'GBP', fxRateE6: 1000000n }],
  }), 'What are UK payables for September?');
  expect(payables).toContain('£80');
  expect(payables).not.toContain('$0');
});

it('keeps unresolved bank lines visible when every recorded close task says done', async () => {
  const answer = await ask(groupBooks({
    closeTask: [{ id: 1n, periodId: 2n, title: 'Bank reconciliation', status: { tag: 'Done' }, sortOrder: 1 }],
    bankTransaction: [{ id: 1n, subsidiaryId: 1n, ym: '2026-09', bookedAt: ts('2026-09-05'), amountMinor: 5000n, ccy: 'USD', matched: false }],
  }), 'What is the September close status?');
  expect(answer).toMatch(/1 of 1 close tasks done/);
  expect(answer).toMatch(/1 unmatched bank line.*not fully reconciled/);
});

it('answers each requested financial section and does not confuse ARR reconciliation with bank matching', async () => {
  const answer = await ask(groupBooks(), 'Give me September group cash, ARR, P&L and bank reconciliation.');
  expect(answer).toContain('Consolidated group cash: $356');
  expect(answer).toContain('Consolidated group ARR');
  expect(answer).toContain('net loss $373');
  expect(answer).toContain('unmatched bank lines');
  const arr = await ask(groupBooks(), 'What is September ARR and how does it reconcile to recognized subscription revenue?');
  expect(arr).toContain('ARR from active subscription contracts');
  expect(arr).not.toContain('Current unmatched bank lines');
});

describe('risk tier answers', () => {
  const customer = (id: bigint, name: string, creditTier?: string) => ({ id, subsidiaryId: 1n, name, creditTier, allowanceMinor: 0n, paymentTermsDays: 30 });
  const check = (id: bigint, subjectId: bigint, tier: string, at: string, requestId = `R-${id}`) => ({ id, subjectKind: { tag: 'Customer' }, subjectId, tier, requestId, createdAt: ts(at) });
  const unpaid = (id: bigint, customerId: bigint, amountMinor: bigint, tag = 'Open') => ({ id, customerId, ym: '2026-09', amountMinor, dueAt: ts('2026-10-15'), status: { tag } });
  const rated = () => books({
    account: [acct(10n, '4000', 'Revenue'), acct(40n, '1150', 'Asset')],
    customer: [customer(1n, 'Brightwater Pools'), customer(2n, 'Copperline Electric'), customer(3n, 'Lantern Bakery'), customer(4n, 'Juniper Analytics', 'B'), customer(5n, 'New Customer')],
    creditCheck: [
      check(1n, 1n, 'C', '2026-08-31'),
      check(2n, 1n, 'BLOCK', '2026-09-30', 'fx-P15-tu_identity_verification'),
      check(3n, 2n, 'D', '2026-09-30'),
      check(4n, 3n, 'A', '2026-09-30'),
      { ...check(5n, 3n, 'BLOCK', '2026-09-30'), subjectKind: { tag: 'Vendor' } },
    ],
    invoice: [unpaid(1n, 1n, 100000n), unpaid(2n, 1n, 50000n), unpaid(3n, 2n, 920000n), unpaid(4n, 2n, 777700n, 'Paid'), unpaid(5n, 3n, 20000n)],
    journalLine: [
      { id: 1n, jeId: 101n, accountId: 40n, debitMinor: 0n, creditMinor: 150000n, ccy: 'USD', fxRateE6: 1000000n, customerId: 1n },
      { id: 2n, jeId: 101n, accountId: 40n, debitMinor: 0n, creditMinor: 460000n, ccy: 'USD', fxRateE6: 1000000n, customerId: 2n },
    ],
  });

  it('answers "Which customers are high risk?" from the recorded credit checks, not the generic snapshot', async () => {
    const text = await ask(rated(), 'Which customers are high risk?');
    expect(text).not.toMatch(/Here is where/);
    // The latest check per customer sets its tier; a vendor's check never counts; an unchecked customer keeps its record's tier.
    expect(text).toMatch(/^Risk Tiers: A 1, B 1, C 0, D 1, BLOCK 1 \(1 customer not rated\)\. Source: the latest recorded credit check per customer, or the tier on the customer record where none is recorded\./);
    expect(text).toContain('Highest risk (2 in D or BLOCK)');
    expect(text).toContain('- Brightwater Pools: BLOCK (credit check fx-P15-tu_identity_verification on September 30, 2026); open balance $1,500 (2 unpaid invoices); reserve $1,500 posted to account 1150 (policy target $1,500 at 100%).');
    expect(text).toContain('- Copperline Electric: D (credit check R-3 on September 30, 2026); open balance $9,200 (1 unpaid invoice); reserve $4,600 posted to account 1150 (policy target $4,600 at 50%).');
    expect(text.indexOf('Brightwater')).toBeLessThan(text.indexOf('Copperline'));
    expect(text).not.toContain('Lantern Bakery');
    expect(text).toContain('credit and allowance policy');
  });

  it('routes other risk wordings and says so when no customer is rated D or BLOCK', async () => {
    for (const q of ['Show me the risk tiers', 'Who are our riskiest customers?', 'credit risk by customer']) expect(await ask(rated(), q), q).toMatch(/^Risk Tiers:/);
    const safe = books({ customer: [customer(3n, 'Lantern Bakery')], creditCheck: [check(4n, 3n, 'A', '2026-09-30')] });
    expect(await ask(safe, 'Which customers are high risk?')).toMatch(/A 1, B 0, C 0, D 0, BLOCK 0\. .*No customer is in Risk Tier D or BLOCK/s);
    expect(await ask(books({ customer: [customer(5n, 'New Customer')] }), 'Which customers are high risk?')).toMatch(/No customer has a Risk Tier yet/);
  });
});

describe('lock questions', () => {
  const opened = [{ threadId: 'close:2026-09', senderRole: 'advisor', body: 'Opening the 2026-09 close for Cafoo Inc.', createdAt: ts('2026-10-01') }];
  const unmatched = [{ id: 9n, subsidiaryId: 1n, ym: '2026-09', bookedAt: ts('2026-09-12'), amountMinor: 5000n, ccy: 'USD', description: 'Wire', counterparty: 'Unknown', matched: false }];
  const iso = (t: { microsSinceUnixEpoch: bigint }) => new Date(Number(t.microsSinceUnixEpoch / 1000n)).toISOString();
  /** The CFO's acceptance of exactly these unmatched lines, as the module records it. */
  const acceptance = (rows: typeof unmatched, reasonPlain = 'Timing difference, cleared on October 2') => {
    const snap = bankExceptionSnapshot({
      periodYm: '2026-09',
      bankRows: rows.map(r => ({ id: String(r.id), subsidiaryId: String(r.subsidiaryId), ym: r.ym, bookedAt: iso(r.bookedAt), amountMinor: String(r.amountMinor), ccy: r.ccy, description: r.description, counterparty: r.counterparty, matched: r.matched })),
      auditEvents: [],
    });
    return { id: 50n, actorRole: 'cfo', action: 'accept_bank_exceptions', targetTable: 'period', targetId: 2n, detail: JSON.stringify({ periodYm: '2026-09', snapshot: snap, reasonPlain }), at: ts('2026-10-24T09:00:00Z') };
  };
  const decided = (extra: Record<string, unknown[]> = {}) => books({
    agentMessage: opened,
    proposal: [{ id: 7n, periodId: 2n, kind: { tag: 'JournalEntry' }, status: { tag: 'Approved' }, summaryPlain: 'x', amountMinor: 0n, payloadJson: '{}', createdAt: ts('2026-10-02') }],
    ...extra,
  });

  it('answers "Can we lock September?" from the lock gate instead of the generic snapshot', async () => {
    const startClose = vi.fn(async () => ({ status: 'started' as const }));
    const blocked = await ask(books({ agentMessage: opened }), 'Can we lock September?', { startClose });
    expect(blocked).toMatch(/^Not yet\. 1 item still needs a decision\. These are the checks the lock runs\./);
    expect(blocked).not.toMatch(/Here is where/);
    expect(startClose).not.toHaveBeenCalled();
    const ready = await ask(decided(), 'Is September ready to lock?');
    expect(ready).toMatch(/^Yes\. Every item for September 2026 is decided.*Every bank line through the month is matched\. The lock is yours to confirm/);
    expect(await ask(decided({ bankTransaction: unmatched }), 'What blocks the lock?')).toMatch(/^Not yet\. 1 unmatched bank line through September 2026 needs reconciling or your explicit acceptance\./);
  });

  it('counts bank exceptions as the gate does: accepted ones do not block, and the answer says the CFO accepted them', async () => {
    const text = await ask(decided({ bankTransaction: unmatched, auditEvent: [acceptance(unmatched)] }), 'Can we lock September?');
    expect(text).toMatch(/^Yes\./);
    expect(text).toContain('1 unmatched bank line through September 2026 was accepted by the CFO as exceptions on October 24, 2026 ("Timing difference, cleared on October 2"), so it does not block the lock; it is still unreconciled.');
    expect(text).not.toMatch(/needs reconciling/);
    // An acceptance of a different set of lines is stale and does not count.
    const changed = [...unmatched, { ...unmatched[0]!, id: 10n, amountMinor: 7000n }];
    const stale = await ask(decided({ bankTransaction: changed, auditEvent: [acceptance(unmatched)] }), 'Can we lock September?');
    expect(stale).toMatch(/^Not yet\. 2 unmatched bank lines through September 2026 need reconciling or your explicit acceptance\./);
  });

  it('tells a locked, requested, unended or not-yet-run month apart', async () => {
    expect(await ask(books(), 'Can we lock August?')).toBe('August 2026 is already locked.');
    expect(await ask(books({ period: [{ id: 2n, ym: '2026-09', status: { tag: 'Closing' } }] }), 'can we lock september?')).toMatch(/lock has been requested/);
    expect(await ask(fresh(), 'Can we lock September?', { now: new Date('2026-09-20T00:00:00Z') })).toMatch(/has not ended/);
    expect(await ask(fresh(), 'Can we lock September?')).toMatch(/^Not yet: the September 2026 close has not run\. Say "start the close"/);
    // Months lock in order, as the gate refuses.
    const unlockedAugust = decided({ period: [{ id: 1n, ym: '2026-08', status: { tag: 'Open' } }, { id: 2n, ym: '2026-09', status: { tag: 'Open' } }] });
    expect(await ask(unlockedAugust, 'Can we lock September?')).toBe('Not yet: September 2026 cannot be locked while August 2026 is not locked: months close in order. Lock August 2026 first.');
  });

  it('notes the consolidation check on a group month that is otherwise ready', async () => {
    const group = decided({ subsidiary: [
      { id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', isElimination: false },
      { id: 2n, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: 1n, isElimination: false },
      { id: 3n, code: 'ELIM', name: 'Eliminations', functionalCcy: 'USD', parentId: 1n, isElimination: true },
    ] });
    expect(await ask(group, 'Can we lock September?')).toMatch(/^Yes\..*As a group month, the lock also checks that the consolidation .* still matches the books\. The lock is yours to confirm/);
    expect(await ask(decided(), 'Can we lock September?')).not.toMatch(/group month/);
  });
});

describe('policy questions', () => {
  it('finds the credit and allowance policy for "bad debt reserves", not the accruals policy', async () => {
    vi.stubEnv('MOSS_PROJECT_ID', '');
    const text = await ask(books(), 'What is our policy on bad debt reserves?');
    expect(text).toMatch(/^From the credit and allowance policy: /);
    expect(text).toContain('1% reserve');
    expect(text).toContain('The allowance entry books only the change from the current reserve.');
    expect(text).not.toMatch(/No passage/);
    expect(text).not.toMatch(/accruals policy/);
  });

  it('quotes the sentences that share a stem with the question', () => {
    const policy = '# Policy: x\nEvery reserve is reviewed at each close by the controller. Accruals are reversed in the following month.';
    expect(policyExcerpt(policy, 'how are reserves reviewed?')).toBe('Every reserve is reviewed at each close by the controller.');
    expect(policyExcerpt(policy, 'what about accrued costs?')).toBe('Accruals are reversed in the following month.');
    expect(policyExcerpt(policy, 'what is our policy on travel?')).toBe('');
  });
});
