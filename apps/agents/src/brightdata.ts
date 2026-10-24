/**
 * Bright Data client for the agents: Web Unlocker pages and Google results as JSON.
 * Follows the hackathon route notes: one Web Unlocker zone (type "unblocker") covers both; never create zones here.
 * Demo mode (no token, or DEMO_MODE=1) answers from fixtures/brightdata/.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './stdb';

const API = 'https://api.brightdata.com';

/** Accept the MCP's name (API_TOKEN) and the SDK / hackpack names. */
export function brightDataToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.BRIGHTDATA_API_TOKEN ?? env.BRIGHTDATA_API_KEY ?? env.API_TOKEN;
  return v?.trim() || undefined;
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
  const configured = (process.env.WEB_UNLOCKER_ZONE ?? process.env.BRIGHTDATA_ZONE)?.trim();
  if (configured) return Promise.resolve(configured);
  if (zonePromise) return zonePromise;
  zonePromise = (async () => {
    const res = await fetch(`${API}/zone/get_active_zones`, { headers: { Authorization: `Bearer ${brightDataToken()}` } });
    if (!res.ok) throw new BrightDataError(`Could not list Bright Data zones (HTTP ${res.status}).`, res.status);
    const zones = (await res.json()) as { name: string; type?: string }[];
    const z = zones.find(x => x.type === 'unblocker') ?? zones.find(x => x.type === 'serp');
    if (!z) throw new BrightDataError('The Bright Data account has no Web Unlocker zone. Add one in the control panel (Proxies & Scraping → Add → Web Unlocker API).');
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
    if (res.status === 200 && text.length > 200) return last;
    if (res.status === 401 || res.status === 403) break;
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  throw new BrightDataError(`Bright Data request failed (HTTP ${last.status}${last.code ? `, ${last.code}` : ''}, ${last.text.length} bytes).`, last.status, last.code);
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
