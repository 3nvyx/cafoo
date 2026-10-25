import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/gateway';
import { providers } from '../src/env';
import { evidence, recordFallback, recordOk, resetProviderCalls, stateOf, tracked, withEvidence } from '../src/provider-calls';
import type { Cast } from '../src/stdb';

beforeEach(() => resetProviderCalls());
afterEach(() => vi.unstubAllEnvs());

describe('provider call evidence', () => {
  it('moves from configured to verified or fell_back by the most recent outcome', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 5, 0, s));
    expect(stateOf('demo', evidence('grok'))).toBe('demo');
    expect(stateOf('live', evidence('grok'))).toBe('configured');
    recordOk('grok', at(1));
    expect(stateOf('live', evidence('grok'))).toBe('verified');
    recordFallback('grok', new Error('timeout'), at(2));
    expect(stateOf('live', evidence('grok'))).toBe('fell_back');
    recordOk('grok', at(3));
    expect(stateOf('live', evidence('grok'))).toBe('verified');
    expect(evidence('grok')).toMatchObject({ okCount: 2, fallbackCount: 1, lastFallbackReason: 'timeout' });
    // A demo provider stays demo whatever was recorded: no live claim without live configuration.
    expect(stateOf('demo', evidence('grok'))).toBe('demo');
  });

  it('keeps one line of the reason and drops query strings, where Nessie carries its key', () => {
    recordFallback('nessie', new Error('GET https://api.nessieisreal.com/accounts/1/deposits?key=SECRET failed\nstack'));
    expect(evidence('nessie').lastFallbackReason).toBe('GET https://api.nessieisreal.com/accounts/1/deposits?… failed');
  });

  it('tracked() records and still rethrows, so the caller falls back as before', async () => {
    await expect(tracked('moss', async () => 7)).resolves.toBe(7);
    await expect(tracked('moss', async () => { throw new Error('down'); })).rejects.toThrow('down');
    expect(evidence('moss')).toMatchObject({ okCount: 1, fallbackCount: 1, lastFallbackReason: 'down' });
  });

  it('says what happened in the detail line', () => {
    recordFallback('grok', 'rate limited');
    const grok = withEvidence(providers({ XAI_API_KEY: 'k' })).find(p => p.id === 'grok')!;
    expect(grok).toMatchObject({ mode: 'live', state: 'fell_back' });
    expect(grok.detail).toMatch(/; fell back at .*: rate limited$/);
    const apify = withEvidence(providers({})).find(p => p.id === 'apify')!;
    expect(apify.state).toBe('demo');
  });

  it('gives every provider row a distinct id', () => {
    const ids = providers({}).map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('GET /status', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

  it('reports a provider as verified only after a recorded answer', async () => {
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('XAI_API_KEY', 'k');
    server = createGateway({} as Cast, { runClose: vi.fn(), env: {} });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const grok = async () => ((await (await fetch(`${base}/status`)).json()) as { providers: { id: string; state: string }[] }).providers.find(p => p.id === 'grok');
    expect((await grok())?.state).toBe('configured');
    recordOk('grok');
    expect((await grok())?.state).toBe('verified');
  });
});
