import { describe, expect, it, vi } from 'vitest';
import { fetchNessieBankEvents, nessieConfig, parseNessieDollars } from '../src/nessie';
import { startFeeder } from '../src/feed/feeder';
import { fakeConn, ts } from './fake-conn';
import type { Cast } from '../src/stdb';

const config = { apiKey: 'secret-test-key', baseUrl: 'https://prod-api.nessieisreal.com', accounts: new Map([['US', 'account-1']]) };
const scope = { ym: '2026-10', subsidiaries: [{ code: 'US', functionalCcy: 'USD' }], materialityMinor: 1_000_000n };

describe('Nessie bank feed', () => {
  it('parses exact dollar cents and rejects fractional cents', () => {
    expect(parseNessieDollars(12.34)).toBe(1234n);
    expect(parseNessieDollars(0.1)).toBe(10n);
    expect(() => parseNessieDollars(0.001)).toThrow(/cent/);
    expect(() => parseNessieDollars(-1)).toThrow(/positive/);
  });

  it('stays unconfigured without a key and mapping, and rejects a partial setup', () => {
    expect(nessieConfig({})).toBeNull();
    expect(nessieConfig({ DEMO_MODE: '1', NESSIE_API_KEY: 'key', NESSIE_ACCOUNT_IDS: 'US:account-1' })).toBeNull();
    expect(() => nessieConfig({ NESSIE_API_KEY: 'key' })).toThrow(/NESSIE_ACCOUNT_IDS/);
    expect(nessieConfig({ NESSIE_API_KEY: 'key', NESSIE_ACCOUNT_IDS: 'US:account-1' })?.accounts.get('US')).toBe('account-1');
  });

  it('reads deposits and withdrawals, filters posted month, and preserves provider identity', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('key')).toBe('secret-test-key');
      if (url.pathname.endsWith('/deposits')) return new Response(JSON.stringify([
        { _id: 'dep-1', amount: 12.34, transaction_date: '2026-10-05', status: 'completed', description: 'Acme payment' },
        { _id: 'old', amount: 3, transaction_date: '2026-09-30', status: 'completed' },
        { _id: 'pending', amount: 4, transaction_date: '2026-10-06', status: 'pending' },
      ]), { status: 200 });
      return new Response(JSON.stringify([{ _id: 'wd-1', amount: 10000.5, transaction_date: '2026-10-07', status: 'completed', description: 'Payroll' }]), { status: 200 });
    });
    const events = await fetchNessieBankEvents(config, scope, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(events.map(event => [event.externalId, event.tx.amountMinor])).toEqual([
      ['nessie:account-1:deposit:dep-1', 1234n],
      ['nessie:account-1:withdrawal:wd-1', -1_000_050n],
    ]);
    expect(events[1]).toMatchObject({ subsidiaryCode: 'US', material: true, expect: 'classify' });
  });

  it('refuses a GBP mapping before making any request', async () => {
    const fetcher = vi.fn();
    await expect(fetchNessieBankEvents(
      { ...config, accounts: new Map([['UK', 'account-2']]) },
      { ...scope, subsidiaries: [{ code: 'UK', functionalCcy: 'GBP' }] },
      fetcher,
    )).rejects.toThrow(/USD/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not turn failed authentication into simulated bank lines or leak the key', async () => {
    const fetcher = vi.fn(async () => new Response('unauthorized secret-test-key', { status: 401 }));
    await expect(fetchNessieBankEvents(config, scope, fetcher)).rejects.toThrow(/Nessie .*HTTP 401/);
  });
});

function feederBooks() {
  return {
    subsidiary: [{ id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', parentId: undefined, isElimination: false }],
    period: [{ id: 9n, ym: '2026-09', status: { tag: 'Closed' } }, { id: 10n, ym: '2026-10', status: { tag: 'Open' } }],
    periodLock: [{ id: 1n, periodId: 9n, lockedByRole: 'cfo' }],
    settings: [{ key: 'feed_enabled', valueI64: 1n, valueText: '' }, { key: 'materiality_threshold_minor', valueI64: 1_000_000n, valueText: '' }],
    feedEvent: [] as { externalId: string; ym: string; ingestedAt: ReturnType<typeof ts>; kind: { tag: 'BankTx' | 'Invoice' } }[],
  };
}

describe('Nessie through the ingest-only feeder', () => {
  const deposit = { _id: 'dep-1', amount: 20.5, transaction_date: '2026-10-05', status: 'completed', description: 'Customer payment' };
  const fetcher = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes('/deposits') ? [deposit] : []), { status: 200 }));

  it('ingests once across restarts and never adds simulated bank lines', async () => {
    fetcher.mockClear();
    const rows = feederBooks();
    const ingested: string[] = [];
    const cast = {
      advisor: fakeConn(rows),
      feed: { reducers: {
        ingestBankTransactions: async ({ txs }: { txs: { externalId: string }[] }) => {
          for (const tx of txs) {
            ingested.push(tx.externalId);
            rows.feedEvent.push({ externalId: tx.externalId, ym: '2026-10', ingestedAt: ts('2026-10-05'), kind: { tag: 'BankTx' } });
          }
        },
        ingestInvoices: async () => { throw new Error('No simulated invoices are expected in these books.'); },
      } },
    } as unknown as Cast;
    const first = startFeeder(cast, { intervalMs: 0, autoStart: false, nessie: config, fetcher });
    expect(first.status()).toMatchObject({ source: 'nessie', planned: 0, blockedReason: expect.stringMatching(/not been fetched/) });
    expect(await first.drain()).toBe(1);
    expect(ingested).toEqual(['nessie:account-1:deposit:dep-1']);
    expect(first.status()).toMatchObject({ source: 'nessie', planned: 1, ingested: 1 });
    first.stop();
    const second = startFeeder(cast, { intervalMs: 0, autoStart: false, nessie: config, fetcher });
    expect(await second.drain()).toBe(0);
    expect(ingested).toEqual(['nessie:account-1:deposit:dep-1']);
    second.stop();
  });

  it('keeps the live source blocked after an HTTP error instead of substituting simulated lines', async () => {
    const rows = feederBooks();
    const ingest = vi.fn();
    const cast = { advisor: fakeConn(rows), feed: { reducers: { ingestBankTransactions: ingest, ingestInvoices: ingest } } } as unknown as Cast;
    const fetcher = vi.fn(async () => new Response('', { status: 401 }));
    const failed = startFeeder(cast, { intervalMs: 0, autoStart: false, nessie: config, fetcher });
    expect(await failed.tick()).toBe(false);
    expect(await failed.tick()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(failed.status()).toMatchObject({ source: 'nessie', planned: 0, blockedReason: expect.stringMatching(/HTTP 401/) });
    failed.stop();
  });

  it('rejects a mid-month switch from simulated bank events to Nessie', async () => {
    const rows = feederBooks();
    rows.feedEvent.push({ externalId: 'feed-2026-10-fee-05', ym: '2026-10', ingestedAt: ts('2026-10-05'), kind: { tag: 'BankTx' } });
    const ingest = vi.fn();
    const cast = { advisor: fakeConn(rows), feed: { reducers: { ingestBankTransactions: ingest, ingestInvoices: ingest } } } as unknown as Cast;
    const fetcher = vi.fn();
    const feeder = startFeeder(cast, { intervalMs: 0, autoStart: false, nessie: config, fetcher });
    expect(await feeder.tick()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(feeder.status().blockedReason).toMatch(/different feed source/);
    feeder.stop();
  });
});
