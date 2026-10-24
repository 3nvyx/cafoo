import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { feedContext, feedRoutes, feedTargetYm, startFeeder } from '../src/feed/feeder';
import { createGateway } from '../src/gateway';
import type { Cast } from '../src/stdb';
import { fakeConn, ts } from './fake-conn';

/** Root company with three usage customers whose September invoices are open; September locked, October open. */
function books(over: Record<string, unknown[]> = {}) {
  const rows: Record<string, unknown[]> = {
    subsidiary: [
      { id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', parentId: undefined, isElimination: false },
      { id: 2n, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: 1n, isElimination: false },
    ],
    period: [
      { id: 7n, ym: '2026-07', status: { tag: 'Closed' } },
      { id: 8n, ym: '2026-08', status: { tag: 'Closed' } },
      { id: 9n, ym: '2026-09', status: { tag: 'Closed' } },
      { id: 10n, ym: '2026-10', status: { tag: 'Open' } },
      { id: 11n, ym: '2026-11', status: { tag: 'Open' } },
    ],
    // The seed locks the history months; the CFO locked September.
    periodLock: [
      { id: 1n, periodId: 7n, lockedByRole: 'seed' },
      { id: 2n, periodId: 8n, lockedByRole: 'seed' },
      { id: 3n, periodId: 9n, lockedByRole: 'cfo' },
    ],
    settings: [
      { key: 'feed_enabled', valueI64: 1n, valueText: '' },
      { key: 'materiality_threshold_minor', valueI64: 1_000_000n, valueText: '' },
    ],
    customer: [
      { id: 11n, subsidiaryId: 1n, name: 'Acme Analytics' },
      { id: 12n, subsidiaryId: 1n, name: 'Beta Corp' },
      { id: 13n, subsidiaryId: 1n, name: 'Gamma Labs' },
      { id: 14n, subsidiaryId: 1n, name: 'Delta Works' },
      { id: 21n, subsidiaryId: 2n, name: 'Brit Co' },
    ],
    vendor: [{ id: 31n, subsidiaryId: 1n, name: 'Northwind', verification: { tag: 'Verified' } }],
    contract: [11n, 12n, 13n, 14n, 21n].map(c => ({ id: c + 100n, customerId: c, code: `K-${c}`, plan: { tag: 'Usage' } })),
    contractItem: [11n, 12n, 13n, 14n, 21n].map(c => ({ id: c + 200n, contractId: c + 100n, kind: { tag: 'Usage' }, priceMinor: 2500n })),
    invoice: [11n, 12n, 13n].map((c, i) => ({ id: c + 300n, customerId: c, contractId: c + 100n, number: `INV-10${40 + i}`, ym: '2026-09', amountMinor: 420000n + BigInt(i) * 10000n, dueAt: ts('2026-10-10'), status: { tag: 'Open' } })),
    bill: [],
    bankTransaction: [],
    feedEvent: [],
    ...over,
  };
  return rows;
}

/** A cast whose feed identity ingests into the same rows, as the module would (feed_event per accepted row). */
function cast(rows: Record<string, unknown[]>, refuse?: string) {
  const advisor = fakeConn(rows);
  const calls: string[] = [];
  const feed = {
    reducers: {
      ingestBankTransactions: async ({ txs }: { txs: { externalId: string }[] }) => {
        if (refuse) throw new Error(refuse);
        for (const t of txs) {
          calls.push(t.externalId);
          rows.feedEvent!.push({ externalId: t.externalId, kind: { tag: 'BankTx' }, rowId: 1n, subsidiaryId: 1n, ym: '2026-10', ingestedAt: ts('2026-10-24T10:00:00Z') });
        }
      },
      ingestInvoices: async ({ invoices }: { invoices: { externalId: string }[] }) => {
        if (refuse) throw new Error(refuse);
        for (const i of invoices) {
          calls.push(i.externalId);
          rows.feedEvent!.push({ externalId: i.externalId, kind: { tag: 'Invoice' }, rowId: 2n, subsidiaryId: 1n, ym: '2026-10', ingestedAt: ts('2026-10-24T10:01:00Z') });
        }
      },
    },
  };
  return { cast: { advisor, feed } as unknown as Cast, calls };
}

describe('feed target month', () => {
  it('is the first open month after a month the CFO locked', () => {
    expect(feedTargetYm(fakeConn(books()))).toBe('2026-10');
    expect(feedTargetYm(fakeConn(books({ period: [{ id: 9n, ym: '2026-09', status: { tag: 'Closed' } }, { id: 10n, ym: '2026-10', status: { tag: 'Closing' } }] })))).toBeUndefined();
  });

  it('is no month on a freshly seeded database, where only the seed locked July and August', () => {
    const fresh = books({
      period: [
        { id: 7n, ym: '2026-07', status: { tag: 'Closed' } },
        { id: 8n, ym: '2026-08', status: { tag: 'Closed' } },
        { id: 9n, ym: '2026-09', status: { tag: 'Open' } },
        { id: 10n, ym: '2026-10', status: { tag: 'Open' } },
      ],
      periodLock: [
        { id: 1n, periodId: 7n, lockedByRole: 'seed' },
        { id: 2n, periodId: 8n, lockedByRole: 'seed' },
      ],
    });
    expect(feedTargetYm(fakeConn(fresh))).toBeUndefined();
    // GET /feed/status names no month then, with the feed off or on.
    const off = { ...fresh, settings: [{ key: 'feed_enabled', valueI64: 0n, valueText: '' }] };
    const status = startFeeder(cast(off).cast, { intervalMs: 0, autoStart: false }).status();
    expect(status.ym).toBeUndefined();
    expect(status).toMatchObject({ enabled: false, planned: 0, ingested: 0, blockedReason: expect.stringMatching(/switched off/) });
    expect(startFeeder(cast(fresh).cast, { intervalMs: 0, autoStart: false }).status().ym).toBeUndefined();
  });

  it('sends nothing into the close month even when the CFO switches the feed on before locking it', async () => {
    const rows = books({ period: [{ id: 8n, ym: '2026-08', status: { tag: 'Closed' } }, { id: 9n, ym: '2026-09', status: { tag: 'Open' } }, { id: 10n, ym: '2026-10', status: { tag: 'Open' } }], periodLock: [{ id: 2n, periodId: 8n, lockedByRole: 'seed' }] });
    const { cast: c, calls } = cast(rows);
    const f = startFeeder(c, { intervalMs: 0, autoStart: false });
    expect(await f.drain()).toBe(0);
    expect(calls).toEqual([]);
    expect(f.status()).toMatchObject({ enabled: true, planned: 0, blockedReason: expect.stringMatching(/CFO locks the close month/) });
  });

  it("reads only the root company's books for the plan", () => {
    const ctx = feedContext(fakeConn(books()), '2026-10');
    expect(ctx.subsidiaryCode).toBe('US');
    expect(ctx.customers.map(c => c.name)).toEqual(['Acme Analytics', 'Beta Corp', 'Gamma Labs', 'Delta Works']);
    expect(ctx.contracts.map(k => [k.code, k.plan, k.unitPriceMinor])).toContainEqual(['K-11', 'usage', 2500n]);
    expect(ctx.invoices[0]).toMatchObject({ number: 'INV-1040', contractCode: 'K-11', status: 'open', ym: '2026-09' });
    expect(ctx.vendors).toEqual([{ id: 31n, name: 'Northwind', verification: 'verified' }]);
  });
});

describe('feeder', () => {
  it('sends the month one event at a time, invoices before their receipts, and reports progress', async () => {
    const rows = books();
    const { cast: c, calls } = cast(rows);
    const f = startFeeder(c, { intervalMs: 0, autoStart: false });
    const plan = f.plan();
    expect(plan.length).toBeGreaterThan(5);
    expect(f.status()).toMatchObject({ enabled: true, ym: '2026-10', planned: plan.length, ingested: 0 });
    expect(await f.tick()).toBe(true);
    expect(calls).toEqual([plan[0]!.externalId]);
    expect(await f.drain()).toBe(plan.length - 1);
    expect(calls).toEqual(plan.map(e => e.externalId));
    const inv = calls.findIndex(id => /-inv-/.test(id));
    const rcpt = calls.findIndex(id => id === calls[inv]!.replace('-inv-', '-rcpt-'));
    expect(inv).toBeGreaterThanOrEqual(0);
    expect(rcpt).toBeGreaterThan(inv);
    expect(f.status()).toMatchObject({ planned: plan.length, ingested: plan.length, lastEventAt: '2026-10-24T10:01:00.000Z' });
    expect(f.status().blockedReason).toBeUndefined();
    expect(await f.tick()).toBe(false);
    f.stop();
  });

  it('waits while the feed is off, before a month is locked, or once the month close has started', async () => {
    const off = books({ settings: [{ key: 'feed_enabled', valueI64: 0n, valueText: '' }] });
    const a = startFeeder(cast(off).cast, { intervalMs: 0, autoStart: false });
    expect(await a.tick()).toBe(false);
    expect(a.status()).toMatchObject({ enabled: false, ym: '2026-10', blockedReason: expect.stringMatching(/switched off/) });
    const early = books({ period: [{ id: 9n, ym: '2026-09', status: { tag: 'Open' } }] });
    expect(startFeeder(cast(early).cast, { intervalMs: 0, autoStart: false }).status().blockedReason).toMatch(/CFO locks the close month/);
    const closing = books({ agentMessage: [{ threadId: 'close:2026-10', senderRole: 'advisor', body: 'Opening the 2026-10 close for Cafoo Inc.' }] });
    const b = startFeeder(cast(closing).cast, { intervalMs: 0, autoStart: false });
    expect(await b.tick()).toBe(false);
    expect(b.status().blockedReason).toMatch(/October close has started/);
  });

  it('stops on a refusal and says why', async () => {
    const f = startFeeder(cast(books(), 'The live feed is switched off.').cast, { intervalMs: 0, autoStart: false });
    expect(await f.drain()).toBe(0);
    expect(f.status().blockedReason).toMatch(/The books refused feed-2026-10-.*: The live feed is switched off\./);
  });
});

describe('GET /feed/status', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));
  it('answers through the gateway with the feeder status', async () => {
    const status = { enabled: true, ym: '2026-10', planned: 12, ingested: 3, lastEventAt: '2026-10-24T10:00:00.000Z' };
    server = createGateway({} as Cast, { env: {}, routes: feedRoutes({ status: () => status }) });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/feed/status`)).json()).toEqual(status);
    // Read-only: from another machine too.
    expect((await fetch(`${base}/feed/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });
});
