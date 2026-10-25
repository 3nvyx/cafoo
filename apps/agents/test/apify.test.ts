import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crawlLive, customerSite, demoSnapshot, resetApify, searchSite, siteSignals, sitePlain, validDomain } from '../src/apify';
import { evidence, resetProviderCalls } from '../src/provider-calls';

beforeEach(() => {
  resetApify();
  resetProviderCalls();
  vi.stubEnv('MOSS_PROJECT_ID', '');
  vi.stubEnv('MOSS_PROJECT_KEY', '');
});
afterEach(() => vi.unstubAllEnvs());

const items = [
  { url: 'https://example-co.com/', text: 'We build furniture.', metadata: { title: 'Example Co' } },
  { url: 'https://example-co.com/news', text: 'Example Co has ceased operations as of October.', metadata: { title: 'News' } },
];
const okFetch = () => vi.fn(async (_u: unknown, _i?: RequestInit) => new Response(JSON.stringify(items), { status: 200 }));

describe('crawlLive', () => {
  it('runs the actor synchronously with the token in a header, never in the URL', async () => {
    const f = okFetch();
    const site = await crawlLive('example-co.com', { APIFY_TOKEN: 'tok' }, f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe('https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?timeout=120&clean=true');
    expect(String(url)).not.toContain('tok');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init!.body))).toMatchObject({ startUrls: [{ url: 'https://example-co.com' }], maxCrawlPages: 5 });
    expect(site).toMatchObject({ domain: 'example-co.com', source: 'apify', pages: [{ title: 'Example Co' }, { title: 'News' }] });
  });

  it('refuses anything but a bare domain, and a dataset without the expected fields', async () => {
    for (const bad of ['example.com/path', 'https://example.com', 'localhost', 'a b.com', '169.254.169.254']) expect(validDomain(bad)).toBe(false);
    await expect(crawlLive('example.com/../x', { APIFY_TOKEN: 't' }, okFetch() as unknown as typeof fetch)).rejects.toThrow('Not a website domain');
    const wrong = vi.fn(async () => new Response(JSON.stringify({ error: 'x' }), { status: 200 }));
    await expect(crawlLive('example-co.com', { APIFY_TOKEN: 't' }, wrong as unknown as typeof fetch)).rejects.toThrow('expected url and text');
  });

  it('accepts the null fields the real crawler sends for what it did not save', async () => {
    const real = [{ url: 'https://example-co.com/', text: 'We build furniture.', markdown: null, html: null, screenshotUrl: null, metadata: { title: 'Example Co', author: null } }];
    const f = vi.fn(async () => new Response(JSON.stringify(real), { status: 201 }));
    const site = await crawlLive('example-co.com', { APIFY_TOKEN: 't' }, f as unknown as typeof fetch);
    expect(site.pages).toEqual([{ url: 'https://example-co.com/', title: 'Example Co', text: 'We build furniture.' }]);
  });
});

describe('customerSite', () => {
  it('uses the demo snapshot without a token, labeled as such', async () => {
    const site = await customerSite('daltonautorepair.com', {});
    expect(site?.source).toBe('demo snapshot');
    expect(await customerSite('no-snapshot-here.com', {})).toBeNull();
  });

  it('never stands a demo snapshot in for a failed live crawl, and records the fallback', async () => {
    const down = vi.fn(async () => new Response('busy', { status: 503 }));
    expect(await customerSite('daltonautorepair.com', { APIFY_TOKEN: 't' }, down as unknown as typeof fetch)).toBeNull();
    expect(evidence('apify')).toMatchObject({ okCount: 0, fallbackCount: 1, lastFallbackReason: 'Apify run failed (HTTP 503).' });
  });

  it('crawls once per domain per process and records the answer', async () => {
    const f = okFetch();
    await customerSite('example-co.com', { APIFY_TOKEN: 't' }, f as unknown as typeof fetch);
    await customerSite('EXAMPLE-CO.com', { APIFY_TOKEN: 't' }, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    expect(evidence('apify').okCount).toBe(1);
  });
});

describe('site signals', () => {
  it('quotes the sentence that says the business changed hands, with its page', () => {
    const site = demoSnapshot('daltonautorepair.com')!;
    const signals = siteSignals(site);
    expect(signals).toEqual([{ label: 'says the business changed hands', quote: 'Dalton Auto Repair is now part of Eastbay Auto Group.', url: 'https://daltonautorepair.com/news' }]);
    expect(sitePlain('Dalton Auto Repair', site, signals)).toContain('from the demo snapshot');
  });

  it('finds nothing on an ordinary site', () => {
    const site = demoSnapshot('okafordental.com')!;
    expect(siteSignals(site)).toEqual([]);
    expect(sitePlain('Okafor Dental Group', site, [])).toContain('nothing about closing, insolvency or a change of owner');
  });

  it('searches the pages and returns each hit with its URL', async () => {
    const hits = await searchSite(demoSnapshot('daltonautorepair.com')!, 'who owns the business now, eastbay group');
    expect(hits[0]).toMatchObject({ url: 'https://daltonautorepair.com/news', via: 'local' });
  });
});
