/**
 * `pnpm proof`: evidence that each external provider really answers with this machine's keys. One minimal, cheap call
 * per configured provider (nothing touches the books), timed, with the provider's own ids where it returns them, written
 * to proofs/live-<time>.md and .json. A provider without keys is skipped, never faked. No key, token or query string is
 * ever written: evidence holds ids, counts and model names only, and failure reasons go through safeReason.
 *
 * Two calls need asking: `--crs` (one CRS sandbox login; a failed login is never retried, as repeated failures disable
 * the account) and `--slides` (creates and shares a small deck). PROOF_SITE_DOMAIN picks the site Apify crawls.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createXai } from '@ai-sdk/xai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { CrsClient, runCascade } from '@cafoo/crs-mcp';
import { agentProvider, geminiKey, geminiModel, providers } from './env';
import { HARNESSES, modelFor } from './harness';
import { apifyLive, crawlLive } from './apify';
import { brightDataLive, googleResults } from './brightdata';
import { mossConfigured, search } from './moss';
import { fetchNessieBankEvents, nessieConfig } from './nessie';
import { exportToSlides, slidesSetup } from './slides';
import { safeReason, type ProviderId } from './provider-calls';
import { claudeProcessEnv } from './live/openai-bridge';
import { repoRoot } from './stdb';

export type ProofStep = { id: ProviderId; name: string; configured: boolean; why?: string; run: () => Promise<Record<string, string | number>> };
export type Proof = { id: ProviderId; name: string; status: 'proved' | 'failed' | 'skipped'; at: string; ms?: number; evidence?: Record<string, string | number>; reason?: string };

const READY = 'Answer with the single word: ready';

export async function runProofs(steps: ProofStep[], now = () => new Date()): Promise<Proof[]> {
  const out: Proof[] = [];
  for (const s of steps) {
    const at = now().toISOString();
    if (!s.configured) {
      out.push({ id: s.id, name: s.name, status: 'skipped', at, reason: s.why ?? 'not configured on this machine' });
      continue;
    }
    const t0 = Date.now();
    try {
      const evidence = await s.run();
      out.push({ id: s.id, name: s.name, status: 'proved', at, ms: Date.now() - t0, evidence });
    } catch (e) {
      out.push({ id: s.id, name: s.name, status: 'failed', at, ms: Date.now() - t0, reason: safeReason(e) });
    }
  }
  return out;
}

export function proofSteps(env: NodeJS.ProcessEnv, flags: { crs: boolean; slides: boolean }): ProofStep[] {
  const demo = env.DEMO_MODE === '1';
  const live = (id: ProviderId) => providers(env).find(p => p.id === id)?.mode === 'live';
  const slides = slidesSetup(env);
  const httpUri = (env.SPACETIMEDB_URI ?? 'ws://localhost:3000').replace(/^ws/, 'http');
  const site = env.PROOF_SITE_DOMAIN?.trim() || 'example.com';
  const nessie = (() => {
    try {
      return nessieConfig(env);
    } catch (e) {
      return e as Error;
    }
  })();
  const month = new Date().toISOString().slice(0, 7);
  return [
    {
      id: 'spacetimedb', name: 'SpacetimeDB', configured: true,
      run: async () => {
        const r = await fetch(`${httpUri}/v1/ping`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`ping answered HTTP ${r.status}`);
        return { endpoint: `${httpUri}/v1/ping`, http: r.status };
      },
    },
    {
      id: 'agents', name: `Claude Agent SDK (${agentProvider(env)})`, configured: live('agents'),
      run: async () => {
        let text = '';
        let result: any;
        for await (const msg of query({ prompt: READY, options: { model: modelFor(HARNESSES.advisor), tools: [], allowedTools: [], permissionMode: 'dontAsk', maxTurns: 1, maxBudgetUsd: 0.05, settingSources: [], env: await claudeProcessEnv() } })) {
          if (msg.type === 'assistant') for (const b of (msg as any).message?.content ?? []) if (b.type === 'text') text += b.text;
          if (msg.type === 'result') result = msg;
        }
        if (!result || result.subtype !== 'success' || result.is_error) throw new Error(`the SDK run ended ${result?.subtype ?? 'without a result'}`);
        return { model: modelFor(HARNESSES.advisor), session: String(result.session_id ?? ''), costUsd: Number(result.total_cost_usd ?? 0), reply: text.trim().slice(0, 40) };
      },
    },
    {
      id: 'grok', name: 'xAI Grok (Red Team)', configured: live('grok'),
      run: async () => {
        const model = modelFor(HARNESSES.redteam);
        const r = await generateText({ model: createXai({ apiKey: env.XAI_API_KEY }).responses(model), prompt: READY, maxOutputTokens: 16, abortSignal: AbortSignal.timeout(30_000) });
        return { model, responseId: r.response.id, reply: r.text.trim().slice(0, 40), tokens: r.usage.totalTokens ?? 0 };
      },
    },
    {
      id: 'gemini', name: 'Google Gemini (second critic)', configured: live('gemini'),
      run: async () => {
        const model = geminiModel(env);
        const r = await generateText({ model: createGoogleGenerativeAI({ apiKey: geminiKey(env) })(model), prompt: READY, maxOutputTokens: 16, abortSignal: AbortSignal.timeout(30_000) });
        return { model, responseId: r.response.id, reply: r.text.trim().slice(0, 40), tokens: r.usage.totalTokens ?? 0 };
      },
    },
    {
      id: 'moss', name: 'Moss (policy search)', configured: mossConfigured(env),
      run: async () => {
        const hits = await search('cafoo-proof', [
          { id: 'accruals', text: 'Work performed in the close month but billed after month end is accrued.' },
          { id: 'fx', text: 'Foreign-currency balances are revalued at the closing rate.' },
        ], 'a contractor bill dated after month end', 1);
        if (hits[0]?.via !== 'moss') throw new Error('Moss did not answer; the search fell back to local keyword search');
        return { index: 'cafoo-proof', topHit: hits[0].id, score: Number(hits[0].score.toFixed(3)) };
      },
    },
    {
      id: 'brightdata', name: 'Bright Data (Web Unlocker)', configured: !demo && brightDataLive(),
      run: async () => {
        const results = await googleResults('month-end close software', 3);
        if (!results.length) throw new Error('no results came back');
        return { results: results.length, first: results[0]!.displayLink };
      },
    },
    {
      id: 'apify', name: 'Apify (Website Content Crawler)', configured: apifyLive(env),
      run: async () => {
        const s = await crawlLive(site, env);
        if (!s.pages.length) throw new Error(`the crawl of ${site} returned no pages`);
        return { domain: site, pages: s.pages.length, firstUrl: s.pages[0]!.url };
      },
    },
    {
      id: 'nessie', name: 'Capital One Nessie', configured: !(nessie instanceof Error) && nessie !== null,
      why: nessie instanceof Error ? `configuration refused: ${nessie.message}` : undefined,
      run: async () => {
        const c = nessie as Exclude<typeof nessie, Error | null>;
        const events = await fetchNessieBankEvents(c, { ym: month, subsidiaries: [...c.accounts.keys()].map(code => ({ code, functionalCcy: 'USD' })), materialityMinor: 1_000_000n });
        return { accounts: c.accounts.size, month, completedTransactions: events.length };
      },
    },
    {
      id: 'crs', name: 'CRS Credit API (sandbox)', configured: flags.crs && new CrsClient({ env }).mode === 'live',
      why: flags.crs ? 'CRS_USERNAME and CRS_PASSWORD are not set, or CRS_REPLAY=1' : 'pass --crs to log in once (a failed login is never retried)',
      run: async () => {
        const r = await runCascade(new CrsClient({ env }), 'P01', { subjectKind: 'customer_guarantor' });
        return { persona: 'P01', tier: r.tier, decision: r.decision, requestIds: r.evidence.filter(e => e.requestId).length };
      },
    },
    {
      id: 'slides', name: 'Google Slides (export)', configured: flags.slides && 'config' in slides,
      why: !flags.slides ? 'pass --slides to create and share one small deck' : 'missing' in slides ? `not set up: ${slides.missing.join('; ')}` : undefined,
      run: async () => {
        if (!('config' in slides)) throw new Error('not set up');
        const deck = await exportToSlides(slides.config, 'Cafoo proof deck', 'Created by pnpm proof', [{ title: 'Proof', header: ['Check', 'Result'], rows: [['Slides export', 'ok']] }]);
        return { presentationId: deck.presentationId, url: deck.url };
      },
    },
  ];
}

export function proofMarkdown(proofs: Proof[], commit: string): string {
  const icon = { proved: 'PROVED', failed: 'FAILED', skipped: 'skipped' } as const;
  const rows = proofs.map(p => `| ${p.name} | ${icon[p.status]} | ${p.ms === undefined ? '' : `${p.ms} ms`} | ${p.evidence ? Object.entries(p.evidence).map(([k, v]) => `${k}: ${v}`).join('; ') : p.reason ?? ''} |`);
  return [
    `# Cafoo live provider proof, ${proofs[0]?.at ?? new Date().toISOString()}`,
    '',
    `Commit ${commit}. One minimal real call per configured provider; nothing was written to the books. Skipped means no keys on this machine, never a stand-in.`,
    '',
    '| Provider | Result | Time | Evidence |',
    '|---|---|---|---|',
    ...rows,
    '',
    `${proofs.filter(p => p.status === 'proved').length} proved, ${proofs.filter(p => p.status === 'failed').length} failed, ${proofs.filter(p => p.status === 'skipped').length} skipped.`,
    '',
  ].join('\n');
}

const isMain = process.argv[1]?.endsWith('proof.ts') || process.argv[1]?.endsWith('proof.js');
if (isMain) {
  const flags = { crs: process.argv.includes('--crs'), slides: process.argv.includes('--slides') };
  const proofs = await runProofs(proofSteps(process.env, flags));
  const { execSync } = await import('node:child_process');
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  const dir = join(repoRoot, 'proofs');
  mkdirSync(dir, { recursive: true });
  const stamp = proofs[0]!.at.replace(/[:.]/g, '-');
  writeFileSync(join(dir, `live-${stamp}.json`), JSON.stringify({ commit, proofs }, null, 2) + '\n');
  writeFileSync(join(dir, `live-${stamp}.md`), proofMarkdown(proofs, commit));
  console.log(proofMarkdown(proofs, commit));
  console.log(`Saved proofs/live-${stamp}.md and .json`);
  process.exit(proofs.some(p => p.status === 'failed') ? 1 : 0);
}
