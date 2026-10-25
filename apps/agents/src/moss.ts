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

/** Words that carry no meaning for a keyword match. */
const STOP = new Set(['what', 'which', 'when', 'where', 'does', 'should', 'would', 'could', 'about', 'with', 'from', 'that', 'this', 'have', 'there', 'their', 'into', 'your', 'ours']);
/**
 * Finance words a question uses for what a document names another way ("bad debt" is the allowance for doubtful
 * accounts). Each extra stem counts as a match like the question's own words.
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  debt: ['allowanc', 'doubtful'],
  provision: ['allowanc', 'reserv'],
  writeoff: ['allowanc', 'reserv'],
  cutoff: ['accrual'],
};

/**
 * A light stem, so a plural or an inflection matches its root: "reserves" and "reserve" are "reserv", "policies" is
 * "policy", "accrued" is "accru", "reconciliation" is "reconcili". Not a full stemmer; only the folding a keyword match
 * needs.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith('ation')) w = w.slice(0, -5);
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** "write-off" and "cut-off" read as one word. */
const words = (text: string) => text.toLowerCase().replace(/\b(write|cut)-off\b/g, '$1off').split(/[^a-z0-9]+/).filter(Boolean);

/** The stems of a text's words. */
export const stems = (text: string): string[] => words(text).map(stem);

/** A question's search terms: stems of its words longer than three letters, minus stop words, plus finance synonyms. */
export function queryTerms(queryText: string): string[] {
  const out = new Set<string>();
  for (const w of words(queryText.slice(0, 1000))) {
    if (w.length <= 3 || STOP.has(w)) continue;
    const s = stem(w);
    out.add(s);
    for (const syn of SYNONYMS[s] ?? []) out.add(syn);
  }
  return [...out];
}

/** Does one of these stems match the term: the same stem, or a longer word built on it ("reconcil" in "reconcili")? */
export const matchesTerm = (stemmed: readonly string[], term: string) => stemmed.some(w => w === term || (term.length >= 4 && w.startsWith(term)));

/**
 * Local keyword search: each query term found in a document scores 1, or 2 when it is in the title (the document id or
 * its first line: a policy's heading, a page's title). Ties keep the documents' order.
 */
export function keywordSearch(docs: Doc[], queryText: string, topK: number): Hit[] {
  const terms = queryTerms(queryText);
  return docs
    .map((d, i) => {
      const nl = d.text.indexOf('\n');
      const title = [...stems(d.id), ...stems(nl < 0 ? d.text : d.text.slice(0, nl))];
      const body = nl < 0 ? [] : stems(d.text.slice(nl + 1));
      return { d, i, score: terms.reduce((n, t) => n + (matchesTerm(title, t) ? 2 : matchesTerm(body, t) ? 1 : 0), 0) };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, topK)
    .map(({ d, score }) => ({ ...d, score, via: 'local' as const }));
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
