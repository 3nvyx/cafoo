/**
 * The live agents' MCP tools (src/live/tools.ts), called the way the SDK's in-process MCP server calls them: the input
 * parsed with the tool's schema, a thrown error reported as an isError result. Every reducer is a recording fake over
 * an in-memory database (test/fake-cast.ts); the credit cascade replays the recorded CRS fixtures, so nothing here
 * touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { creditCheckSummaryJson } from '@cafoo/crs-mcp';
import { HARNESSES, WORKERS } from '../src/harness';
import { BOOKS_TOOLS } from '../src/harness/rules';
import { DEFAULT_PARAMS } from '../src/charter/types';
import { collectFootprint } from '../src/footprint';
import { planConsolidation } from '../src/scripted/consolidate';
import { advisorServer, booksServer, consolidationServer, workerServer } from '../src/live/tools';
import { books, fakeCast, type Rows } from './fake-cast';
import { ts } from './fake-conn';

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  // The server's tool definitions, so a test can call each handler directly.
  createSdkMcpServer: (o: { name: string; tools?: unknown[] }) => ({ type: 'sdk', name: o.name, tools: o.tools ?? [] }),
}));
vi.mock('../src/footprint', () => ({ collectFootprint: vi.fn() }));
vi.mock('../src/scripted/consolidate', async importOriginal => {
  const real = await importOriginal<typeof import('../src/scripted/consolidate')>();
  return { ...real, planConsolidation: vi.fn(real.planConsolidation) };
});

type ToolDef = { name: string; inputSchema: z.ZodRawShape; handler: (args: unknown, extra: unknown) => Promise<Result>; annotations?: { readOnlyHint?: boolean } };
type Result = { content: { type: string; text: string }[]; isError?: boolean };
const toolsOf = (server: unknown) => (server as { tools: ToolDef[] }).tools;
const nameOf = (server: unknown) => (server as { name: string }).name;

/** Call a tool as the SDK's MCP server does: validate and default the input, and turn a throw into an isError result. */
async function call(server: unknown, name: string, input: Record<string, unknown>): Promise<Result> {
  const t = toolsOf(server).find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name} on ${nameOf(server)}`);
  const args = z.object(t.inputSchema).parse(input);
  try {
    return await t.handler(args, {});
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
}
const text = (r: Result) => r.content[0]!.text;
const data = (r: Result) => JSON.parse(text(r));
const ok = (r: Result) => {
  expect(r.isError, text(r)).toBeFalsy();
  return r;
};

let rows: Rows;
let fx: ReturnType<typeof fakeCast>;
beforeEach(() => {
  // Replay the recorded CRS fixtures; never log in to the sandbox.
  vi.stubEnv('DEMO_MODE', '1');
  vi.stubEnv('CRS_REPLAY', '1');
  vi.stubEnv('CRS_USERNAME', '');
  vi.stubEnv('CHARTER_OVERRIDE_JSON', '');
  rows = books();
  fx = fakeCast(rows);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(collectFootprint).mockReset();
});

const common = { rationale: 'Bank line 62 is the monthly service fee.', summaryPlain: 'Record the $45 monthly bank fee.', periodYm: '2026-09' };
const proposed = () => fx.callsTo('propose');
const payloadOf = (i = 0) => JSON.parse(proposed()[i]!.args.payloadJson);

describe('tool servers match the harnesses', () => {
  it('every MCP tool a harness allows exists on the server that role calls, under the same name', () => {
    const servers: Record<string, unknown> = {
      books: booksServer(fx.cast),
      advisor: advisorServer(fx.cast),
      bookkeeper: workerServer(fx.cast.bookkeeper, fx.cast),
      revenue: workerServer(fx.cast.revenue, fx.cast),
      credit: workerServer(fx.cast.credit, fx.cast),
      consolidation: consolidationServer(fx.cast),
    };
    for (const role of ['advisor', ...WORKERS] as const) {
      for (const t of HARNESSES[role].tools) {
        const m = /^mcp__([a-z]+)__(.+)$/.exec(t);
        if (!m || m[1] === 'crs') continue;
        expect(toolsOf(servers[m[1]!]).map(x => x.name), `${role} may call ${t}`).toContain(m[2]);
      }
    }
  });

  it('names each worker server after its role, so the cross-role gate sees whose tools they are', () => {
    for (const r of ['bookkeeper', 'revenue', 'credit'] as const) expect(nameOf(workerServer(fx.cast[r], fx.cast))).toBe(r);
    expect(nameOf(consolidationServer(fx.cast))).toBe('consolidation');
    expect(nameOf(advisorServer(fx.cast))).toBe('advisor');
    expect(nameOf(booksServer(fx.cast))).toBe('books');
  });

  it('marks the books tools and run_credit_cascade read-only, and every tool that writes not', () => {
    const books = toolsOf(booksServer(fx.cast));
    expect(books.map(t => t.name)).toEqual([...BOOKS_TOOLS]);
    for (const t of books) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    const readOnly = toolsOf(workerServer(fx.cast.credit, fx.cast)).filter(t => t.annotations?.readOnlyHint).map(t => t.name);
    // record_credit_check is not read-only on purpose: the CLI runs it serially, so the gate's history has it in time.
    expect(readOnly).toEqual(['run_credit_cascade']);
    expect(toolsOf(advisorServer(fx.cast)).filter(t => t.annotations?.readOnlyHint)).toEqual([]);
  });
});

describe('books tools (read-only, on the Advisor cache)', () => {
  const books = () => booksServer(fx.cast);

  it('close_snapshot gives the root company the month as it stands', async () => {
    const s = data(ok(await call(books(), 'close_snapshot', { periodYm: '2026-09' })));
    expect(s.period).toEqual({ id: '9', ym: '2026-09', status: 'Open' });
    expect(s.subsidiaryId).toBe('1');
    expect(s.materialityThreshold).toBe('$10,000');
    expect(s.closeTasks).toEqual([
      { id: '5', title: 'Bank reconciliation', ownerRole: 'bookkeeper', status: 'Todo' },
      { id: '6', title: 'Revenue recognition', ownerRole: 'revenue', status: 'InProgress' },
    ]);
    expect(s.accounts).toContain('2100 Account 2100 (liability)');
    // Unmatched lines of this month only: 63 is August and matched.
    expect(s.unmatchedBankTransactions.map((t: { id: string }) => t.id)).toEqual(['60', '61', '62']);
    expect(s.unmatchedBankTransactions[0]).toEqual({ id: '60', bookedAt: '2026-09-20', amount: '$4,200', amountMinor: '420000', description: 'ACME ANALYTICS PAYMENT INV-40', counterparty: 'Acme Analytics' });
    expect(s.openInvoices.map((i: { id: string }) => i.id)).toEqual(['40', '41']);
    expect(s.openBills.map((b: { id: string; billedAt: string }) => [b.id, b.billedAt])).toEqual([['50', '2026-10-03'], ['51', '2026-09-10']]);
    expect(s.contractsMissingSchedules).toEqual([{ contractId: '70', code: 'K-ACME', customerId: '20', customer: 'Acme Analytics', startYm: '2026-09', endYm: '2027-08', total: '$12,000' }]);
    expect(s.unrecognizedScheduleLinesThisMonth).toEqual({ '21:Beta Corp': '$100' });
    expect(s.customersWithOpenReceivables).toEqual([
      { customerId: '20', name: 'Acme Analytics', guarantorPersonaId: 'P01', guarantorName: 'Guarantor One', openReceivables: '$4,200', openReceivablesMinor: '420000', currentTier: null, currentAllowance: '$0', paymentTermsDays: 30 },
      { customerId: '21', name: 'Beta Corp', guarantorPersonaId: 'P07', guarantorName: 'Guarantor Seven', openReceivables: '$1,000', openReceivablesMinor: '100000', currentTier: 'B', currentAllowance: '$50', paymentTermsDays: 30 },
    ]);
    expect(s.vendors).toEqual([
      { vendorId: '30', name: 'Northwind Traders', category: 'hosting', verification: 'Verified', ownerPersonaId: null },
      { vendorId: '31', name: 'Shady Supplies', category: 'supplies', verification: 'Unverified', ownerPersonaId: 'P07' },
    ]);
  });

  it("close_snapshot leaves out a second company's rows", async () => {
    rows.subsidiary!.push({ id: 2n, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: 1n, isElimination: false });
    rows.customer!.push({ id: 22n, subsidiaryId: 2n, name: 'Brit Co', guarantorPersonaId: 'P02', allowanceMinor: 0n, paymentTermsDays: 30 });
    rows.invoice!.push({ id: 43n, number: 'UK-1', customerId: 22n, ym: '2026-09', amountMinor: 1n, dueAt: ts('2026-10-01'), status: { tag: 'Open' } });
    rows.bankTransaction!.push({ id: 64n, subsidiaryId: 2n, ym: '2026-09', bookedAt: ts('2026-09-09'), amountMinor: 1n, ccy: 'GBP', description: 'UK', counterparty: 'Brit Co', matched: false });
    const s = data(ok(await call(books(), 'close_snapshot', { periodYm: '2026-09' })));
    expect(s.openInvoices.map((i: { id: string }) => i.id)).toEqual(['40', '41']);
    expect(s.unmatchedBankTransactions.map((t: { id: string }) => t.id)).toEqual(['60', '61', '62']);
    expect(s.customersWithOpenReceivables.map((c: { customerId: string }) => c.customerId)).toEqual(['20', '21']);
  });

  it('close_snapshot and the other month tools report an unknown month as an error', async () => {
    for (const t of ['close_snapshot', 'list_proposals', 'score_bank_matches', 'detect_missing_accruals']) {
      const r = await call(books(), t, { periodYm: '2026-12' });
      expect(r.isError, t).toBe(true);
      expect(text(r), t).toMatch(/No period 2026-12/);
    }
  });

  it('list_proposals gives the month, oldest first, with critiques, CFO notes and the payload, filtered by status', async () => {
    const p = (id: bigint, periodId: bigint, tag: string, status: string) => ({ id, periodId, kind: { tag }, status: { tag: status }, proposerRole: 'bookkeeper', amountMinor: 450000n, summaryPlain: `s${id}`, rationale: `r${id}`, payloadJson: JSON.stringify({ n: Number(id) }) });
    rows.proposal = [p(12n, 9n, 'JournalEntry', 'AwaitingCfo'), p(11n, 9n, 'BankMatch', 'Open'), p(13n, 10n, 'BankMatch', 'Open')];
    rows.agentMessage = [
      { proposalId: 11n, kind: { tag: 'Critique' }, senderRole: 'redteam', body: 'weak match' },
      { proposalId: 11n, kind: { tag: 'Statement' }, senderRole: 'bookkeeper', body: 'not a critique' },
      { proposalId: 12n, kind: { tag: 'Statement' }, senderRole: 'cfo', body: 'check the vendor' },
    ];
    const all = data(ok(await call(books(), 'list_proposals', { periodYm: '2026-09' })));
    expect(all).toEqual([
      { id: '11', kind: 'BankMatch', status: 'Open', proposer: 'bookkeeper', amount: '$4,500', summaryPlain: 's11', rationale: 'r11', payload: { n: 11 }, critiques: ['weak match'], cfoNotes: [] },
      { id: '12', kind: 'JournalEntry', status: 'AwaitingCfo', proposer: 'bookkeeper', amount: '$4,500', summaryPlain: 's12', rationale: 'r12', payload: { n: 12 }, critiques: [], cfoNotes: ['check the vendor'] },
    ]);
    expect(data(ok(await call(books(), 'list_proposals', { periodYm: '2026-09', status: 'Open' }))).map((x: { id: string }) => x.id)).toEqual(['11']);
    expect(data(ok(await call(books(), 'list_proposals', { periodYm: '2026-09', status: 'all' }))).map((x: { id: string }) => x.id)).toEqual(['11', '12']);
  });

  it('score_bank_matches offers only exact-amount matches as candidates', async () => {
    const r = data(ok(await call(books(), 'score_bank_matches', { periodYm: '2026-09' })));
    expect(r.candidates).toContainEqual(expect.objectContaining({ bankTxId: '60', targetKind: 'invoice', targetId: '40' }));
    // 61 pays 990 of a 1,000 invoice: never a bank match candidate.
    expect(r.candidates.filter((c: { bankTxId: string; bucket: string }) => c.bankTxId === '61' && c.bucket !== 'unmatched')).toEqual([]);
    for (const c of r.nearAmount) expect(c.bankTxId, 'near-amount lines are not exact').not.toBe('60');
    expect(r.unexplained.map((t: { id: string }) => t.id)).toContain('62');
    expect(r.unexplained.map((t: { id: string }) => t.id)).not.toContain('60');
  });

  it("detect_missing_accruals proposes September work billed in October on the vendor's own expense account", async () => {
    const r = data(ok(await call(books(), 'detect_missing_accruals', { periodYm: '2026-09' })));
    expect(r).toEqual([
      {
        billId: '50',
        externalRef: 'NW-311',
        reversesInYm: '2026-10',
        lines: [
          { accountCode: '6100', debitMinor: '120000', creditMinor: '0' },
          { accountCode: '2100', debitMinor: '0', creditMinor: '120000' },
        ],
      },
    ]);
  });

  it('build_revenue_schedule gives one straight line per month of the term for the contract code', async () => {
    const r = data(ok(await call(books(), 'build_revenue_schedule', { contractCode: 'K-ACME' })));
    expect(r.contractItemId).toBe('80');
    expect(r.customerId).toBe('20');
    expect(r.lines).toHaveLength(12);
    expect(r.lines[0].ym).toBe('2026-09');
    expect(r.lines[11].ym).toBe('2027-08');
    expect(r.lines.reduce((a: bigint, l: { amountMinor: string }) => a + BigInt(l.amountMinor), 0n)).toBe(1_200_000n);
    const none = await call(books(), 'build_revenue_schedule', { contractCode: 'K-NOPE' });
    expect(none).toMatchObject({ isError: true });
    expect(text(none)).toBe('No contract K-NOPE');
  });

  it('build_revenue_schedule refuses a contract with no subscription item', async () => {
    rows.contractItem = rows.contractItem!.filter(i => i.contractId !== 70n);
    const r = await call(books(), 'build_revenue_schedule', { contractCode: 'K-ACME' });
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toBe('Contract has no subscription item');
  });

  it("allowance_target sizes the reserve on the customer's unpaid invoices against the reserve already booked", async () => {
    expect(data(ok(await call(books(), 'allowance_target', { customerId: '21', tier: 'B' })))).toEqual({ customer: 'Beta Corp', openReceivablesMinor: '100000', targetMinor: '5000', currentMinor: '5000', deltaMinor: '0', becauseClause: null });
    const d = data(ok(await call(books(), 'allowance_target', { customerId: '21', tier: 'BLOCK', reasonCode: 'active_bankruptcy' })));
    expect(d).toMatchObject({ targetMinor: '100000', deltaMinor: '95000', becauseClause: 'their owner is in an active bankruptcy plan' });
    expect(data(ok(await call(books(), 'allowance_target', { customerId: '21', tier: 'D', reasonCode: 'made_up' }))).becauseClause).toBeNull();
  });

  it('allowance_target reports an unknown or malformed customer id as an error', async () => {
    const unknown = await call(books(), 'allowance_target', { customerId: '99', tier: 'A' });
    expect(unknown).toMatchObject({ isError: true });
    expect(text(unknown)).toBe('Unknown customer');
    expect(await call(books(), 'allowance_target', { customerId: 'Beta Corp', tier: 'A' })).toMatchObject({ isError: true });
  });
});

describe('worker proposal tools', () => {
  const bk = () => workerServer(fx.cast.bookkeeper, fx.cast);
  const line = (accountCode: string, debitMinor: string, creditMinor: string, extra: Record<string, string> = {}) => ({ accountCode, debitMinor, creditMinor, ...extra });

  it('propose_journal_entry files a journal entry as the calling worker, in USD at par with canonical ids', async () => {
    const r = data(
      ok(
        await call(bk(), 'propose_journal_entry', {
          ...common,
          closeTaskId: '05',
          memo: 'Bank fees: MONTHLY SERVICE FEE',
          lines: [line('6000', '4500', '0', { memo: 'fee' }), line('1000', '0', '4500', { customerId: '020', vendorId: '0031' })],
          amountMinor: '4500',
          bankTxIds: ['062'],
        })
      )
    );
    expect(r).toEqual({ proposalId: '1000', status: 'Open' });
    expect(proposed()).toHaveLength(1);
    expect(proposed()[0]).toMatchObject({ role: 'bookkeeper', args: { kind: 'journal_entry', amountMinor: 4500n, periodYm: '2026-09', closeTaskId: 5n, rationale: common.rationale, summaryPlain: common.summaryPlain } });
    expect(payloadOf()).toEqual({
      subsidiaryId: '1',
      periodYm: '2026-09',
      memo: 'Bank fees: MONTHLY SERVICE FEE',
      lines: [
        { accountCode: '6000', debitMinor: '4500', creditMinor: '0', memo: 'fee', ccy: 'USD', fxRateE6: '1000000' },
        { accountCode: '1000', debitMinor: '0', creditMinor: '4500', customerId: '20', vendorId: '31', ccy: 'USD', fxRateE6: '1000000' },
      ],
      bankTxIds: ['62'],
    });
  });

  it('propose_journal_entry passes a recognition month through, and propose_accrual files an accrual with its reversal month', async () => {
    ok(await call(bk(), 'propose_journal_entry', { ...common, memo: 'Recognize September', lines: [line('2400', '10000', '0'), line('4000', '0', '10000', { customerId: '21' })], amountMinor: '10000', recognizeScheduleYm: '2026-09' }));
    expect(payloadOf(0).recognizeScheduleYm).toBe('2026-09');
    ok(await call(bk(), 'propose_accrual', { ...common, summaryPlain: 'Count $1,200 of hosting in September.', memo: 'Accrue NW-311', lines: [line('6100', '120000', '0', { vendorId: '30' }), line('2100', '0', '120000', { vendorId: '30' })], amountMinor: '120000', reversesInYm: '2026-10' }));
    expect(proposed()[1]!.args).toMatchObject({ kind: 'accrual', amountMinor: 120000n });
    expect(payloadOf(1)).toMatchObject({ reversesInYm: '2026-10', lines: [{ vendorId: '30' }, { vendorId: '30' }] });
    expect(proposed()[1]!.args.closeTaskId).toBeUndefined();
  });

  it('propose_journal_entry refuses a non-integer amount, an unknown month, and a refusal from the module', async () => {
    const lines = [line('6000', '4500', '0'), line('1000', '0', '4500')];
    expect(await call(bk(), 'propose_journal_entry', { ...common, memo: 'm', lines, amountMinor: '45.00' })).toMatchObject({ isError: true });
    const noMonth = await call(bk(), 'propose_journal_entry', { ...common, periodYm: '2027-01', memo: 'm', lines, amountMinor: '4500' });
    expect(noMonth).toMatchObject({ isError: true });
    expect(text(noMonth)).toBe('No period 2027-01');
    expect(proposed()).toHaveLength(0);
    fx.fail('bookkeeper.propose', 'Journal entry does not balance.');
    const refused = await call(bk(), 'propose_journal_entry', { ...common, memo: 'm', lines, amountMinor: '4500' });
    expect(refused).toEqual({ content: [{ type: 'text', text: 'Journal entry does not balance.' }], isError: true });
  });

  it('propose_bank_match files the matches with canonical ids and no amount', async () => {
    const r = data(ok(await call(bk(), 'propose_bank_match', { ...common, closeTaskId: '5', matches: [{ bankTxId: '060', targetKind: 'invoice', targetId: '040', scoreBp: 9800 }] })));
    expect(r).toEqual({ proposalId: '1000' });
    expect(proposed()[0]).toMatchObject({ role: 'bookkeeper', args: { kind: 'bank_match', amountMinor: 0n, closeTaskId: 5n } });
    expect(payloadOf()).toEqual({ matches: [{ bankTxId: '60', targetKind: 'invoice', targetId: '40', scoreBp: 9800 }] });
  });

  it('refuses an id that is not a row id instead of sending a different row', async () => {
    for (const bad of ['abc', '', '0x3C', '-60', '6.0e1']) {
      const r = await call(bk(), 'propose_bank_match', { ...common, matches: [{ bankTxId: bad, targetKind: 'invoice', targetId: '40', scoreBp: 9800 }] });
      expect(r.isError, `bankTxId ${JSON.stringify(bad)}`).toBe(true);
    }
    const target = await call(bk(), 'propose_bank_match', { ...common, matches: [{ bankTxId: '60', targetKind: 'invoice', targetId: '', scoreBp: 9800 }] });
    expect(target.isError, 'empty targetId').toBe(true);
    expect(proposed()).toEqual([]);
  });

  it("propose_revenue_schedule files one line per month on the contract item and customer, for the schedule's total", async () => {
    const revenue = workerServer(fx.cast.revenue, fx.cast);
    ok(await call(revenue, 'propose_revenue_schedule', { ...common, contractItemId: '080', customerId: '020', lines: [{ ym: '2026-09', amountMinor: '100000' }, { ym: '2026-10', amountMinor: '100000' }], totalMinor: '1200000' }));
    expect(proposed()[0]).toMatchObject({ role: 'revenue', args: { kind: 'revenue_schedule', amountMinor: 1_200_000n } });
    expect(payloadOf()).toEqual({
      lines: [
        { contractItemId: '80', customerId: '20', ym: '2026-09', amountMinor: '100000' },
        { contractItemId: '80', customerId: '20', ym: '2026-10', amountMinor: '100000' },
      ],
    });
  });

  it('the credit tools file credit decisions, vendor blocks and vendor checks with their cited request ids', async () => {
    const credit = workerServer(fx.cast.credit, fx.cast);
    ok(await call(credit, 'propose_credit_decision', { ...common, customerId: '020', tier: 'A', paymentTermsDays: 45, creditCheckRequestIds: ['fx-P01-tu_identity_verification', 'fx-P01-fraud_finder'] }));
    expect(proposed()[0]).toMatchObject({ role: 'credit', args: { kind: 'credit_decision', amountMinor: 0n } });
    expect(payloadOf(0)).toEqual({ customerId: '20', tier: 'A', paymentTermsDays: 45, creditCheckIds: ['fx-P01-tu_identity_verification', 'fx-P01-fraud_finder'] });
    ok(await call(credit, 'propose_credit_decision', { ...common, summaryPlain: 'Second decision.', customerId: '21', tier: 'C', paymentTermsDays: 15 }));
    expect(payloadOf(1).creditCheckIds).toEqual([]);

    ok(await call(credit, 'propose_vendor_block', { ...common, summaryPlain: 'Stop paying Shady Supplies.', vendorId: '031', reasonPlain: 'The owner failed identity checks.', exposureMinor: '50000' }));
    expect(proposed()[2]!.args).toMatchObject({ kind: 'vendor_block', amountMinor: 50000n });
    expect(payloadOf(2)).toEqual({ vendorId: '31', reasonPlain: 'The owner failed identity checks.' });

    ok(await call(credit, 'propose_vendor_verify', { ...common, summaryPlain: 'Northwind can be paid.', vendorId: '30', creditCheckRequestIds: ['a', 'b'] }));
    expect(proposed()[3]!.args).toMatchObject({ kind: 'vendor_verify', amountMinor: 0n });
    expect(payloadOf(3)).toEqual({ vendorId: '30', creditCheckIds: ['a', 'b'] });
    ok(await call(credit, 'propose_vendor_verify', { ...common, summaryPlain: 'Northwind can be paid now.', vendorId: '30', creditCheckRequestIds: ['a'], reasonPlain: 'Clean checks.', exposureMinor: '120000' }));
    expect(proposed()[4]!.args.amountMinor).toBe(120000n);
    expect(payloadOf(4)).toEqual({ vendorId: '30', creditCheckIds: ['a'], reasonPlain: 'Clean checks.' });
  });

  it('a vendor check must cite at least one request id', () => {
    const t = toolsOf(workerServer(fx.cast.credit, fx.cast)).find(x => x.name === 'propose_vendor_verify')!;
    expect(z.object(t.inputSchema).safeParse({ ...common, vendorId: '30', creditCheckRequestIds: [] }).success).toBe(false);
  });

  it('a module refusal of any proposal comes back as an error with its reason', async () => {
    fx.fail('*.propose', 'Only worker agents may propose.');
    const credit = workerServer(fx.cast.credit, fx.cast);
    for (const [t, input] of [
      ['propose_bank_match', { matches: [{ bankTxId: '60', targetKind: 'invoice', targetId: '40', scoreBp: 9800 }] }],
      ['propose_revenue_schedule', { contractItemId: '80', customerId: '20', lines: [{ ym: '2026-09', amountMinor: '1' }], totalMinor: '1' }],
      ['propose_credit_decision', { customerId: '20', tier: 'A', paymentTermsDays: 45 }],
      ['propose_vendor_block', { vendorId: '31', reasonPlain: 'x', exposureMinor: '1' }],
      ['propose_vendor_verify', { vendorId: '30', creditCheckRequestIds: ['a'] }],
    ] as const) {
      const r = await call(credit, t, { ...common, ...input });
      expect(r, t).toEqual({ content: [{ type: 'text', text: 'Only worker agents may propose.' }], isError: true });
    }
  });
});

describe('worker close-thread tools', () => {
  it('post_message posts as the worker, a statement unless asked, on the proposal it names', async () => {
    const bk = workerServer(fx.cast.bookkeeper, fx.cast);
    expect(text(ok(await call(bk, 'post_message', { threadId: 'close:2026-09', body: 'b', summaryPlain: 's' })))).toBe('posted');
    ok(await call(bk, 'post_message', { threadId: 'proposal:14', body: 'q?', summaryPlain: 'A question.', kind: 'question', proposalId: '14' }));
    expect(fx.callsTo('postAgentMessage')).toEqual([
      { role: 'bookkeeper', reducer: 'postAgentMessage', args: { threadId: 'close:2026-09', kind: 'statement', body: 'b', summaryPlain: 's', proposalId: undefined } },
      { role: 'bookkeeper', reducer: 'postAgentMessage', args: { threadId: 'proposal:14', kind: 'question', body: 'q?', summaryPlain: 'A question.', proposalId: 14n } },
    ]);
  });

  it('a worker may post only statements and questions, and move a task to todo, in progress or blocked, never done', () => {
    const tools = toolsOf(workerServer(fx.cast.revenue, fx.cast));
    const schema = (n: string) => z.object(tools.find(t => t.name === n)!.inputSchema);
    expect(schema('post_message').safeParse({ threadId: 't', body: 'b', summaryPlain: 's', kind: 'ruling' }).success).toBe(false);
    expect(schema('update_close_task').safeParse({ taskId: '5', status: 'done', note: 'n' }).success).toBe(false);
    for (const status of ['todo', 'in_progress', 'blocked']) expect(schema('update_close_task').safeParse({ taskId: '5', status, note: 'n' }).success).toBe(true);
  });

  it('update_close_task updates as the worker, and module refusals come back as errors', async () => {
    const rev = workerServer(fx.cast.revenue, fx.cast);
    expect(text(ok(await call(rev, 'update_close_task', { taskId: '6', status: 'blocked', note: 'waiting on the CFO' })))).toBe('updated');
    expect(fx.callsTo('updateCloseTask')).toEqual([{ role: 'revenue', reducer: 'updateCloseTask', args: { taskId: 6n, status: 'blocked', note: 'waiting on the CFO' } }]);
    fx.fail('revenue.updateCloseTask', 'Task 6 belongs to another role.');
    expect(await call(rev, 'update_close_task', { taskId: '6', status: 'todo', note: 'n' })).toEqual({ content: [{ type: 'text', text: 'Task 6 belongs to another role.' }], isError: true });
    fx.fail('revenue.postAgentMessage', 'Thread is closed.');
    expect(await call(rev, 'post_message', { threadId: 'close:2026-09', body: 'b', summaryPlain: 's' })).toMatchObject({ isError: true });
    expect(await call(rev, 'update_close_task', { taskId: 'six', status: 'todo', note: 'n' })).toMatchObject({ isError: true });
  });
});

describe('credit cascade tools', () => {
  const credit = () => workerServer(fx.cast.credit, fx.cast);
  const cascade = async (server: unknown, personaId: string, subjectKind = 'customer_guarantor') => data(ok(await call(server, 'run_credit_cascade', { personaId, subjectKind })));
  type Ev = { product: string; requestId: string };

  it('run_credit_cascade replays the cascade for a persona and records nothing', async () => {
    const r = await cascade(credit(), 'p01');
    expect(r).toMatchObject({ personaId: 'P01', subjectKind: 'customer_guarantor', tier: 'A', decision: 'APPROVE' });
    expect(r.evidence.map((e: Ev) => e.product)).toEqual(expect.arrayContaining(['tu_identity_verification', 'fraud_finder']));
    expect(fx.calls).toEqual([]);
    const bad = await call(credit(), 'run_credit_cascade', { personaId: 'P99', subjectKind: 'customer_guarantor' });
    expect(bad).toMatchObject({ isError: true });
    expect(text(bad)).toMatch(/unknown persona P99/);
  });

  it('record_credit_check refuses before a cascade ran for that persona', async () => {
    const r = await call(credit(), 'record_credit_check', { subjectKind: 'customer', subjectId: '20', personaId: 'P01', product: 'fraud_finder', requestId: 'fx-P01-fraud_finder', summaryJson: '{}', tier: 'A', decision: 'APPROVE' });
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toMatch(/run run_credit_cascade for P01 first/);
    expect(fx.calls).toEqual([]);
  });

  it("record_credit_check records the cascade's own row and facts under its persona id, whatever the model typed", async () => {
    const server = credit();
    const run = await cascade(server, 'p01');
    const ev = run.evidence.find((e: Ev) => e.product === 'fraud_finder');
    const r = await call(server, 'record_credit_check', { subjectKind: 'customer', subjectId: '020', personaId: ' p01 ', product: 'fraud_finder', requestId: ev.requestId, summaryJson: '{"requestId":"made up","tier":"A"}', tier: 'A', decision: 'APPROVE' });
    expect(text(ok(r))).toBe('recorded');
    const recorded = fx.callsTo('recordCreditCheck');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ role: 'credit', args: { subjectKind: 'customer', subjectId: 20n, personaId: 'P01', product: 'fraud_finder', requestId: ev.requestId } });
    expect(recorded[0]!.args.summaryJson).toBe(creditCheckSummaryJson(run, ev));
    expect(JSON.parse(recorded[0]!.args.summaryJson)).toMatchObject({ requestId: ev.requestId, facts: run.facts });
  });

  it("record_credit_check refuses a row that is not in that persona's last cascade, or a tier or decision it did not return", async () => {
    const server = credit();
    await cascade(server, 'P01');
    const p07 = await cascade(server, 'P07', 'vendor_owner');
    const p07Row = p07.evidence.find((e: Ev) => e.product === 'fraud_finder');
    const base = { subjectKind: 'customer', subjectId: '20', personaId: 'P01', summaryJson: '{}', tier: 'A', decision: 'APPROVE' };
    const foreign = await call(server, 'record_credit_check', { ...base, product: 'fraud_finder', requestId: p07Row.requestId });
    expect(foreign).toMatchObject({ isError: true });
    expect(text(foreign)).toMatch(/your last cascade for P01 has no fraud_finder row with request id fx-P07-fraud_finder; its rows are tu_identity_verification fx-P01-tu_identity_verification, fraud_finder fx-P01-fraud_finder/);
    const wrongProduct = await call(server, 'record_credit_check', { ...base, product: 'criminal', requestId: 'fx-P01-fraud_finder' });
    expect(wrongProduct).toMatchObject({ isError: true });
    const wrongTier = await call(server, 'record_credit_check', { ...base, product: 'fraud_finder', requestId: 'fx-P01-fraud_finder', tier: 'B' });
    expect(text(wrongTier)).toBe('that cascade returned tier A and decision APPROVE, not B and APPROVE');
    const p07AsApprove = await call(server, 'record_credit_check', { ...base, subjectKind: 'vendor', subjectId: '31', personaId: 'P07', product: 'fraud_finder', requestId: p07Row.requestId });
    expect(text(p07AsApprove)).toBe(`that cascade returned tier ${p07.tier} and decision ${p07.decision}, not A and APPROVE`);
    expect(fx.callsTo('recordCreditCheck')).toEqual([]);
    ok(await call(server, 'record_credit_check', { ...base, subjectKind: 'vendor', subjectId: '31', personaId: 'P07', product: 'fraud_finder', requestId: p07Row.requestId, tier: p07.tier, decision: p07.decision }));
    expect(fx.callsTo('recordCreditCheck')[0]!.args).toMatchObject({ subjectKind: 'vendor', subjectId: 31n, personaId: 'P07' });
  });

  it("record_credit_check sees only the cascades run on its own server, and reports a module refusal", async () => {
    const one = credit();
    await cascade(one, 'P01');
    const other = credit();
    const input = { subjectKind: 'customer', subjectId: '20', personaId: 'P01', product: 'fraud_finder', requestId: 'fx-P01-fraud_finder', summaryJson: '{}', tier: 'A', decision: 'APPROVE' };
    expect(text(await call(other, 'record_credit_check', input))).toMatch(/first/);
    fx.fail('credit.recordCreditCheck', 'P01 is not the guarantor of customer 20.');
    expect(await call(one, 'record_credit_check', input)).toEqual({ content: [{ type: 'text', text: 'P01 is not the guarantor of customer 20.' }], isError: true });
    expect(await call(one, 'record_credit_check', { ...input, subjectId: 'Acme' })).toMatchObject({ isError: true });
  });

  it('collect_public_footprint collects for the subject and lists what it stored', async () => {
    vi.mocked(collectFootprint).mockResolvedValueOnce([{ source: 'yelp', status: 'ok', summaryPlain: 'Open, 4.5 stars.', live: false, sourceUrl: 'u' } as never]);
    const r = data(ok(await call(credit(), 'collect_public_footprint', { subjectKind: 'customer', subjectId: '020' })));
    expect(r).toEqual([{ source: 'yelp', status: 'ok', summaryPlain: 'Open, 4.5 stars.', live: false }]);
    expect(vi.mocked(collectFootprint)).toHaveBeenCalledWith(fx.cast, 'customer', 20n);
    vi.mocked(collectFootprint).mockResolvedValueOnce([]);
    expect(text(ok(await call(credit(), 'collect_public_footprint', { subjectKind: 'vendor', subjectId: '30' })))).toBe('No public listing on file for this subject.');
    vi.mocked(collectFootprint).mockRejectedValueOnce(new Error('Unknown vendor 99'));
    expect(await call(credit(), 'collect_public_footprint', { subjectKind: 'vendor', subjectId: '99' })).toEqual({ content: [{ type: 'text', text: 'Unknown vendor 99' }], isError: true });
  });
});

describe('consolidation tools', () => {
  const plan = vi.mocked(planConsolidation);
  const lines = [
    { accountCode: '2950-UK', debitMinor: '1000', creditMinor: '0', ccy: 'GBP' },
    { accountCode: '7100-UK', debitMinor: '0', creditMinor: '1000', ccy: 'GBP', fxRateE6: '1270000' },
  ];

  it('with one company there is nothing to consolidate', async () => {
    const c = consolidationServer(fx.cast);
    expect(data(ok(await call(c, 'revaluation_candidates', { periodYm: '2026-09' })))).toEqual({ note: 'One company only: nothing to consolidate.', revaluations: [] });
    expect(data(ok(await call(c, 'elimination_candidates', { periodYm: '2026-09' })))).toEqual({ note: 'One company only: nothing to consolidate.', eliminations: [] });
  });

  it("plans with the active charter's intercompany tolerance and returns the planned payloads", async () => {
    plan.mockReturnValue({ group: true, revaluations: [{ subsidiaryId: 2n }], eliminations: [{ basis: 'balance' }], differences: [{ label: 'pair' }] } as never);
    try {
      const c = consolidationServer(fx.cast);
      expect(data(ok(await call(c, 'revaluation_candidates', { periodYm: '2026-09' })))).toEqual([{ subsidiaryId: '2' }]);
      expect(data(ok(await call(c, 'elimination_candidates', { periodYm: '2026-09' })))).toEqual({ eliminations: [{ basis: 'balance' }], differencesOverTolerance: [{ label: 'pair' }], toleranceMinor: DEFAULT_PARAMS.icDifferenceToleranceMinor.toString() });
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({ reportingCcy: 'USD' }), '2026-09', { toleranceMinor: DEFAULT_PARAMS.icDifferenceToleranceMinor });
      plan.mockImplementation(() => {
        throw new Error('No closing rate for GBP in 2026-09');
      });
      expect(await call(c, 'revaluation_candidates', { periodYm: '2026-09' })).toEqual({ content: [{ type: 'text', text: 'No closing rate for GBP in 2026-09' }], isError: true });
      expect(await call(c, 'elimination_candidates', { periodYm: '2026-09' })).toMatchObject({ isError: true });
    } finally {
      plan.mockReset();
    }
  });

  it('propose_fx_revaluation files as the Consolidation agent, at the month rate unless told otherwise', async () => {
    const c = consolidationServer(fx.cast);
    const items = [{ accountCode: '2950-UK', ccy: 'USD', txnBalanceMinor: '100000', closingRateE6: '790000', bookedFunctionalMinor: '78000', targetFunctionalMinor: '79000', deltaMinor: '1000' }];
    const r = data(ok(await call(c, 'propose_fx_revaluation', { ...common, amountMinor: '1270', subsidiaryId: '02', memo: 'Revalue', items, lines })));
    expect(r).toEqual({ proposalId: '1000', status: 'Open', amountMinor: '1270' });
    expect(proposed()[0]).toMatchObject({ role: 'consolidation', args: { kind: 'fx_revaluation', amountMinor: 1270n, periodYm: '2026-09' } });
    expect(payloadOf()).toEqual({ subsidiaryId: '2', periodYm: '2026-09', rateYm: '2026-09', memo: 'Revalue', items, lines: [{ ...lines[0], fxRateE6: '1000000' }, lines[1]] });
  });

  it('propose_ic_elimination files the pairs with canonical subsidiary ids, and a reversal month only when given', async () => {
    const c = consolidationServer(fx.cast);
    const pair = { label: 'US owes UK', sourceSubsidiaryId: '01', sourceAccountCode: '2950', counterSubsidiaryId: '002', counterAccountCode: '1950-UK', amountMinor: '5000', counterTranslatedMinor: '5000', differenceMinor: '0' };
    const elim = [
      { accountCode: '2950-ELIM', debitMinor: '5000', creditMinor: '0', ccy: 'USD' },
      { accountCode: '1950-ELIM', debitMinor: '0', creditMinor: '5000', ccy: 'USD' },
    ];
    ok(await call(c, 'propose_ic_elimination', { ...common, amountMinor: '5000', subsidiaryId: '3', memo: 'Eliminate balances', basis: 'balance', reversesInYm: '2026-10', pairs: [pair], lines: elim }));
    expect(payloadOf(0)).toEqual({ subsidiaryId: '3', periodYm: '2026-09', memo: 'Eliminate balances', basis: 'balance', reversesInYm: '2026-10', pairs: [{ ...pair, sourceSubsidiaryId: '1', counterSubsidiaryId: '2' }], lines: elim.map(l => ({ ...l, fxRateE6: '1000000' })) });
    ok(await call(c, 'propose_ic_elimination', { ...common, summaryPlain: 'Remove the fees.', amountMinor: '5000', subsidiaryId: '3', memo: 'Eliminate fees', basis: 'activity', pairs: [pair], lines: elim }));
    expect(payloadOf(1)).not.toHaveProperty('reversesInYm');
    expect(proposed()[1]!.args).toMatchObject({ kind: 'ic_elimination', amountMinor: 5000n });
  });

  it('reports a refusal or a malformed amount as an error, and posts in the thread as itself', async () => {
    const c = consolidationServer(fx.cast);
    const items = [{ accountCode: '2950-UK', ccy: 'USD', txnBalanceMinor: '1', closingRateE6: '1', bookedFunctionalMinor: '1', targetFunctionalMinor: '1', deltaMinor: '0' }];
    expect(await call(c, 'propose_fx_revaluation', { ...common, amountMinor: '12.7', subsidiaryId: '2', memo: 'm', items, lines })).toMatchObject({ isError: true });
    fx.fail('consolidation.propose', 'The revaluation is off by a cent.');
    expect(await call(c, 'propose_fx_revaluation', { ...common, amountMinor: '1', subsidiaryId: '2', memo: 'm', items, lines })).toEqual({ content: [{ type: 'text', text: 'The revaluation is off by a cent.' }], isError: true });
    ok(await call(c, 'post_message', { threadId: 'close:2026-09', body: 'The pair differs by $12.', summaryPlain: 'Two companies disagree by $12.' }));
    expect(fx.callsTo('postAgentMessage')[0]!.role).toBe('consolidation');
  });
});

describe('advisor tools', () => {
  const adv = () => advisorServer(fx.cast);
  beforeEach(() => {
    rows.proposal = [{ id: 14n, periodId: 9n, kind: { tag: 'BankMatch' }, status: { tag: 'Open' }, payloadJson: '{}', summaryPlain: 's', proposerRole: 'bookkeeper', amountMinor: 0n }];
  });

  it("approve_proposal rules as the Advisor and reports the Proposal's status after the ruling", async () => {
    const r = await call(adv(), 'approve_proposal', { proposalId: '014', rationale: 'Exact amount and name.', summaryPlain: 'Approved the match.' });
    expect(data(ok(r))).toEqual({ status: 'Open' });
    expect(fx.callsTo('approveProposal')).toEqual([{ role: 'advisor', reducer: 'approveProposal', args: { proposalId: 14n, rationale: 'Exact amount and name.', summaryPlain: 'Approved the match.', amendedPayloadJson: undefined } }]);
    ok(await call(adv(), 'approve_proposal', { proposalId: '14', rationale: 'r', summaryPlain: 's', amendedPayloadJson: '{"matches":[]}' }));
    expect(fx.callsTo('approveProposal')[1]!.args.amendedPayloadJson).toBe('{"matches":[]}');
  });

  it('reject_proposal, post_ruling, update_close_task and request_period_lock call their reducers as the Advisor', async () => {
    expect(text(ok(await call(adv(), 'reject_proposal', { proposalId: '14', rationale: 'r', summaryPlain: 's' })))).toBe('rejected');
    expect(text(ok(await call(adv(), 'post_ruling', { threadId: 'proposal:14', body: 'b', summaryPlain: 's', proposalId: '14' })))).toBe('posted');
    ok(await call(adv(), 'post_ruling', { threadId: 'close:2026-09', body: 'b', summaryPlain: 's' }));
    expect(text(ok(await call(adv(), 'update_close_task', { taskId: '5', status: 'done', note: 'All matches ruled.' })))).toBe('updated');
    expect(text(ok(await call(adv(), 'request_period_lock', { periodYm: '2026-09', rationale: 'r', summaryPlain: 's' })))).toBe('lock requested; the CFO confirms in the app');
    expect(fx.calls.map(c => [c.role, c.reducer, c.args])).toEqual([
      ['advisor', 'rejectProposal', { proposalId: 14n, rationale: 'r', summaryPlain: 's' }],
      ['advisor', 'postAgentMessage', { threadId: 'proposal:14', kind: 'ruling', body: 'b', summaryPlain: 's', proposalId: 14n }],
      ['advisor', 'postAgentMessage', { threadId: 'close:2026-09', kind: 'ruling', body: 'b', summaryPlain: 's', proposalId: undefined }],
      ['advisor', 'updateCloseTask', { taskId: 5n, status: 'done', note: 'All matches ruled.' }],
      ['advisor', 'requestPeriodLock', { periodYm: '2026-09', rationale: 'r', summaryPlain: 's' }],
    ]);
  });

  it('module refusals and malformed ids come back as errors', async () => {
    for (const [reducer, tool, input] of [
      ['approveProposal', 'approve_proposal', { proposalId: '14', rationale: 'r', summaryPlain: 's' }],
      ['rejectProposal', 'reject_proposal', { proposalId: '14', rationale: 'r', summaryPlain: 's' }],
      ['postAgentMessage', 'post_ruling', { threadId: 't', body: 'b', summaryPlain: 's' }],
      ['updateCloseTask', 'update_close_task', { taskId: '5', status: 'done', note: 'n' }],
      ['requestPeriodLock', 'request_period_lock', { periodYm: '2026-09', rationale: 'r', summaryPlain: 's' }],
    ] as const) {
      fx.fail(`advisor.${reducer}`, `${reducer} refused`);
      expect(await call(adv(), tool, input), tool).toEqual({ content: [{ type: 'text', text: `${reducer} refused` }], isError: true });
    }
    expect(await call(adv(), 'approve_proposal', { proposalId: 'fourteen', rationale: 'r', summaryPlain: 's' })).toMatchObject({ isError: true });
  });
});
