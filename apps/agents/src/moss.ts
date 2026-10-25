/**
 * Moss semantic search over small document sets (house policies, crawled customer sites), with local keyword search
 * as the fallback. One client per process; each index is created once and loaded once. Every live query records its
 * outcome in provider-calls.ts, so /status never calls Moss verified on the strength of a key alone.
 */
import { recordFallback, recordOk } from './provider-calls';

export type Doc = { id: string; text: string };
export type Hit = Doc & { score: number; via: 'moss' | 'local' };

export const mossConfigured = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.MOSS_PROJECT_ID?.trim() && env.MOSS_PROJECT_KEY?.trim()) && env.DEMO_MODE !== '1';

let client: Promise<any> | null = null;
const ready = new Map<string, Promise<any | null>>();
/** Why an index could not be set up, reported on every search that falls back because of it. */
const down = new Map<string, string>();
const downAt = new Map<string, number>();
/** A failed setup is tried again after this long, so one transient error does not mean local search until restart. */
const RETRY_MS = 5 * 60_000;

function mossClient(): Promise<any> {
  client ??= (async () => {
    const moss: any = await import('@moss-js/moss' as string);
    return new moss.MossClient(process.env.MOSS_PROJECT_ID, process.env.MOSS_PROJECT_KEY);
  })();
  return client;
}

function mossIndex(name: string, docs: Doc[]): Promise<any | null> {
  if (down.has(name) && Date.now() - (downAt.get(name) ?? 0) >= RETRY_MS) {
    ready.delete(name);
    down.delete(name);
  }
  let p = ready.get(name);
  if (p) return p;
  p = (async () => {
    try {
      const c = await mossClient();
      const existing: { name: string }[] = await c.listIndexes();
      if (!existing.some(i => i.name === name)) await c.createIndex(name, docs, { modelId: 'moss-minilm' }); // polls until the job completes
      await c.loadIndex(name);
      console.log(`[moss] index "${name}" ready (${docs.length} documents)`);
      return c;
    } catch (e) {
      console.warn(`moss index "${name}" unavailable, using local search:`, (e as Error).message);
      down.set(name, (e as Error).message);
      downAt.set(name, Date.now());
      // A client that failed to construct is rebuilt on the retry too.
      client = null;
      return null;
    }
  })();
  ready.set(name, p);
  return p;
}

export function keywordSearch(docs: Doc[], queryText: string, topK: number): Hit[] {
  const terms = queryText.toLowerCase().split(/\W+/).filter(t => t.length > 3);
  return docs
    .map(d => ({ ...d, score: terms.reduce((n, t) => n + (d.text.toLowerCase().includes(t) ? 1 : 0), 0), via: 'local' as const }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Search `docs` under index `name`: Moss when configured and reachable, local keyword search otherwise. */
export async function search(name: string, docs: Doc[], queryText: string, topK = 3): Promise<Hit[]> {
  if (mossConfigured() && docs.length) {
    const c = await mossIndex(name, docs);
    if (c) {
      try {
        const res = await c.query(name, queryText, { topK });
        recordOk('moss');
        return (res.docs ?? []).map((d: any) => ({ id: String(d.id), text: String(d.text), score: Number(d.score), via: 'moss' as const }));
      } catch (e) {
        console.warn(`moss query on "${name}" failed, using local search:`, (e as Error).message);
        recordFallback('moss', e);
      }
    } else {
      recordFallback('moss', `Moss unavailable: ${down.get(name) ?? 'unknown error'}`);
    }
  }
  return keywordSearch(docs, queryText, topK);
}

/** Tests only. */
export function resetMoss(): void {
  client = null;
  ready.clear();
  down.clear();
  downAt.clear();
}
