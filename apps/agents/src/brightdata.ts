/**
 * Bright Data client for the agents: Web Unlocker pages and Google results as JSON.
 * Follows the hackathon route notes: one Web Unlocker zone (type "unblocker") covers both; never create zones here.
 * Demo mode (no token, or DEMO_MODE=1) answers from fixtures/brightdata/.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordFallback, recordOk } from './provider-calls';
import { repoRoot } from './stdb';

const API = 'https://api.brightdata.com';

/** Accept the MCP's name (API_TOKEN) and the SDK / hackpack names. */
export function brightDataToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // First non-empty value wins (an empty BRIGHTDATA_API_TOKEN="" in .env must not hide API_TOKEN).
  for (const name of ['BRIGHTDATA_API_TOKEN', 'BRIGHTDATA_API_KEY', 'API_TOKEN']) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

export const brightDataLive = (env: NodeJS.ProcessEnv = process.env) => Boolean(brightDataToken(env)) && env.DEMO_MODE !== '1';

export class BrightDataError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string | null) {
    super(message);
    this.name = 'BrightDataError';
  }
}

let zonePromise: Promise<string> | null = null;

/** The Web Unlocker zone to use: WEB_UNLOCKER_ZONE / BRIGHTDATA_ZONE, else the account's first "unblocker" zone. */
export function unlockerZone(): Promise<string> {
  const configured = (process.env.WEB_UNLOCKER_ZONE?.trim() || process.env.BRIGHTDATA_ZONE?.trim()) || undefined;
  if (zonePromise) return zonePromise;
  zonePromise = (async () => {
    const res = await fetch(`${API}/zone/get_active_zones`, { headers: { Authorization: `Bearer ${brightDataToken()}` } });
    if (!res.ok) throw new BrightDataError(`Could not list Bright Data zones (HTTP ${res.status}).`, res.status);
    const zones = (await res.json()) as { name: string; type?: string }[];
    // A configured name must exist on the account; otherwise the first Web Unlocker (or SERP) zone.
    if (configured && zones.some(z => z.name === configured)) return configured;
    const z = zones.find(x => x.type === 'unblocker') ?? zones.find(x => x.type === 'serp');
    if (!z) {
      throw new BrightDataError(
        configured
          ? `Zone "${configured}" does not exist on this Bright Data account. Add a Web Unlocker zone in the control panel (Proxies & Scraping → Add → Web Unlocker API).`
          : 'The Bright Data account has no Web Unlocker zone. Add one in the control panel (Proxies & Scraping → Add → Web Unlocker API).'
      );
    }
    return z.name;
  })();
  zonePromise.catch(() => (zonePromise = null));
  return zonePromise;
}

async function request(body: Record<string, unknown>, attempts = 3): Promise<{ status: number; text: string; code: string | null }> {
  let last: { status: number; text: string; code: string | null } = { status: 0, text: '', code: null };
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${API}/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${brightDataToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    last = { status: res.status, text, code: res.headers.get('x-brd-error-code') };
    // A 200 with an empty or tiny body is a failure (captcha, rate limit): retry after a short wait.
    if (res.status === 200 && text.length > 200) {
      recordOk('brightdata');
      return last;
    }
    if (res.status === 401 || res.status === 403) break;
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  const failed = new BrightDataError(`Bright Data request failed (HTTP ${last.status}${last.code ? `, ${last.code}` : ''}, ${last.text.length} bytes).`, last.status, last.code);
  recordFallback('brightdata', failed);
  throw failed;
}

/** Fetch any public page through Web Unlocker. Raw HTML by default (markdown rounds numbers on some sites). */
export async function unlockerPage(url: string, opts: { markdown?: boolean } = {}): Promise<string> {
  const zone = await unlockerZone();
  const r = await request({ zone, url, format: 'raw', country: 'us', ...(opts.markdown ? { data_format: 'markdown' } : {}) });
  return r.text;
}

export type GoogleResult = { rank: number; title: string; link: string; description: string; displayLink: string };

/** Google results as JSON through the same zone (`brd_json=1`). Treats a non-JSON body as a failed call. */
export async function googleResults(query: string, limit = 5): Promise<GoogleResult[]> {
  const zone = await unlockerZone();
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&brd_json=1`;
  const r = await request({ zone, url, format: 'raw', country: 'us' });
  let data: any;
  try {
    data = JSON.parse(r.text);
  } catch {
    throw new BrightDataError('Google results did not come back as JSON.', r.status, r.code);
  }
  return ((data.organic ?? []) as any[]).slice(0, limit).map(o => ({ rank: Number(o.rank ?? 0), title: String(o.title ?? ''), link: String(o.link ?? ''), description: String(o.description ?? ''), displayLink: String(o.display_link ?? '') }));
}

/** Recorded answer for demo mode, by counterparty slug. */
export function recordedLookup(counterparty: string): string | null {
  const slug = counterparty.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const p = join(repoRoot, 'fixtures', 'brightdata', `${slug}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').slice(0, 3).join(' ') : null;
}

/**
 * Web Scraper API, synchronous form: structured records for a few inputs. A 202 means the job is still running;
 * then poll progress and download the snapshot. Records can carry `error` / `error_code` inside a 200.
 */
export async function scrapeDataset(datasetId: string, input: Record<string, unknown>[], timeoutMs = 240_000): Promise<Record<string, any>[]> {
  const headers = { Authorization: `Bearer ${brightDataToken()}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${API}/datasets/v3/scrape?dataset_id=${encodeURIComponent(datasetId)}&format=json&include_errors=true`, { method: 'POST', headers, body: JSON.stringify({ input }) });
  if (res.status === 200) return (await res.json()) as Record<string, any>[];
  if (res.status !== 202) throw new BrightDataError(`Web Scraper API answered HTTP ${res.status}.`, res.status);
  const { snapshot_id: snapshotId } = (await res.json()) as { snapshot_id: string };
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 7000));
    const p = await fetch(`${API}/datasets/v3/progress/${snapshotId}`, { headers });
    const status = ((await p.json()) as { status?: string }).status;
    if (status === 'failed') throw new BrightDataError('The scraper job failed.');
    if (status === 'ready') {
      const d = await fetch(`${API}/datasets/v3/snapshot/${snapshotId}?format=json`, { headers });
      if (d.status === 200) return (await d.json()) as Record<string, any>[];
    }
  }
  throw new BrightDataError('The scraper job did not finish in time.');
}
