import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCall, HARNESSES } from '../src/harness';
import { DEFAULT_GEMINI_MODEL, providers } from '../src/env';
import { GEMINI_LABEL, GEMINI_SCRIPTED_LABEL, geminiFixtures, geminiScenario, labeled, scriptedGeminiCritique, unlabeled, type GeminiScenario } from '../src/gemini';
import { call, ruleSuite } from './helpers';

const h = HARNESSES.redteam;
const critique = (input: Record<string, unknown> = {}) =>
  call('submit_critique', { proposalId: '14', body: 'Confidence 61% is below the auto threshold and the counterparty only partly matches.', summaryPlain: 'The Red Team doubts this match: the name only partly fits.', ...input });
const status = (s: string | undefined) => ({ proposalStatus: () => s });

ruleSuite(h, {
  'redteam.may.1': {
    allow: [{ call: critique(), ctx: status('Open') }, { call: critique() }, { call: call('search_policies', { query: 'bank match threshold' }) }],
    deny: [
      { call: critique({ proposalId: undefined }), why: /one Proposal/ },
      { call: critique(), ctx: status('SentBack'), why: /SentBack, not open/ },
    ],
  },
  'redteam.never.1': {
    allow: [{ call: critique() }],
    deny: [
      { call: call('mcp__bookkeeper__propose_journal_entry', {}), why: /critiques only/ },
      { call: call('mcp__advisor__reject_proposal', {}), why: /critiques only/ },
    ],
  },
  'redteam.never.2': {
    allow: [{ call: critique() }],
    deny: [{ call: call('mcp__advisor__approve_proposal', {}), why: /posts to the ledger/ }],
  },
  'redteam.never.3': {
    allow: [{ call: critique(), ctx: status('Open') }, { call: critique() }],
    deny: [
      { call: critique(), ctx: status('Approved'), why: /already ruled/ },
      { call: critique(), ctx: status('awaiting_cfo'), why: /late critique/ },
    ],
  },
  'redteam.plain': {
    allow: [{ call: critique() }],
    deny: [{ call: critique({ summaryPlain: 'Weak match at 6100 bp; score below 762000 threshold.' }), why: /raw number "762000"/ }],
  },
});

describe('red team harness as a whole', () => {
  it('lets a clean critique on an open Proposal through', () => {
    expect(checkCall(h, critique(), status('Open'))).toEqual({ allow: true });
  });
  it('names both broken rules on a late critique', () => {
    const d = checkCall(h, critique(), status('Rejected'));
    expect(d).toMatchObject({ allow: false, ruleIds: ['redteam.may.1', 'redteam.never.3'] });
  });
  it('has only its three Vercel AI SDK tools (two read-only searches and submit) and the step cap it ran with before', () => {
    expect([...h.tools]).toEqual(['search_policies', 'search_customer_site', 'submit_critique']);
    expect(h.maxTurns).toBe(6);
  });
});

describe('scripted Red Team critiques (Demo mode fallback)', () => {
  it('all pass the Red Team harness on an open Proposal', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/redteam.ts', import.meta.url)), 'utf8');
    const fn = src.slice(src.indexOf('function scriptedCritique'), src.indexOf('async function grokCritique'));
    const summaries = [...fn.matchAll(/summaryPlain: `([^`$]*)`/g)].map(m => m[1]!);
    expect(summaries.length).toBeGreaterThanOrEqual(7);
    for (const s of summaries) expect(checkCall(h, critique({ summaryPlain: s }), status('Open')), s).toEqual({ allow: true });
  });
});

describe('Gemini, the second critic (Demo mode fixtures)', () => {
  const row = (kind: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    ({ id: 14n, kind: { tag: kind }, payloadJson: JSON.stringify(payload), amountMinor: 0n, summaryPlain: '', ...extra }) as unknown as Parameters<typeof scriptedGeminiCritique>[0];

  it('has a scripted critique for every scenario, and each passes the Red Team harness on an open Proposal', () => {
    const scenarios: GeminiScenario[] = ['bank_match_weak', 'allowance_bankruptcy', 'allowance_tier', 'revenue_schedule', 'vendor_verify', 'vendor_block', 'accrual', 'fx_revaluation', 'ic_elimination', 'material_entry'];
    const f = geminiFixtures();
    expect(Object.keys(f).sort()).toEqual([...scenarios].sort());
    for (const s of scenarios) {
      const c = { ...f[s], summaryPlain: f[s].summaryPlain.replaceAll('{vendor}', 'Quillstack') };
      expect(checkCall(h, critique(c), status('Open')), s).toEqual({ allow: true });
    }
  });

  it('labels scripted critiques so the app never shows them as live Gemini output', () => {
    const c = scriptedGeminiCritique(row('VendorVerify', { vendorId: '7' }), 1_000_000n, id => (id === 7n ? 'Quillstack' : undefined));
    expect(c?.body.startsWith(GEMINI_SCRIPTED_LABEL)).toBe(true);
    expect(c?.summaryPlain).toContain('Quillstack');
    expect(c?.body).not.toContain('{vendor}');
    expect(labeled({ body: 'x', summaryPlain: 'y' }, false).body).toBe(`${GEMINI_LABEL}x`);
  });

  it('strips a label a model wrote itself, so the first critic cannot pass as Gemini and the label is never doubled', () => {
    expect(unlabeled({ body: 'Gemini (scripted): agree', summaryPlain: 's' }).body).toBe('agree');
    expect(unlabeled({ body: ' gemini: agree', summaryPlain: 's' }).body).toBe('agree');
    expect(labeled({ body: 'Gemini: agree', summaryPlain: 's' }, false).body).toBe(`${GEMINI_LABEL}agree`);
    expect(unlabeled({ body: 'Unlike Gemini: this stays', summaryPlain: 's' }).body).toBe('Unlike Gemini: this stays');
  });

  it('fills a vendor name literally, even one with replacement patterns', () => {
    const c = scriptedGeminiCritique(row('VendorVerify', { vendorId: '7' }), 1_000_000n, () => 'A $& B');
    expect(c?.summaryPlain).toContain('A $& B');
  });

  it('picks the same cases as the first critic and stays quiet on the rest', () => {
    expect(geminiScenario(row('BankMatch', { matches: [{ scoreBp: 6100 }] }), 1_000_000n)).toBe('bank_match_weak');
    expect(geminiScenario(row('BankMatch', { matches: [{ scoreBp: 9400 }] }), 1_000_000n)).toBeNull();
    expect(geminiScenario(row('JournalEntry', { memo: 'Allowance for doubtful accounts' }, { amountMinor: 4_800_000n, summaryPlain: 'Guarantor in an active bankruptcy plan' }), 1_000_000n)).toBe('allowance_bankruptcy');
    expect(geminiScenario(row('JournalEntry', { memo: 'Payroll' }, { amountMinor: 100n }), 1_000_000n)).toBeNull();
    expect(scriptedGeminiCritique(row('FxRevaluation', { periodYm: '2026-09' }), 1_000_000n)?.body).toContain('2026-09 closing rate');
  });
});

describe('Gemini provider status', () => {
  it('is live only with a key and without DEMO_MODE, and defaults the model', () => {
    const gem = (env: NodeJS.ProcessEnv) => providers(env).find(p => p.name.startsWith('Google Gemini'))!;
    expect(gem({}).mode).toBe('demo');
    expect(gem({ GEMINI_API_KEY: 'k' })).toMatchObject({ mode: 'live', detail: `configured for ${DEFAULT_GEMINI_MODEL} critiques; status does not verify a call` });
    expect(gem({ GOOGLE_GENERATIVE_AI_API_KEY: 'k', GEMINI_MODEL: 'gemini-pro-latest' })).toMatchObject({ mode: 'live', detail: 'configured for gemini-pro-latest critiques; status does not verify a call' });
    expect(gem({ GEMINI_API_KEY: 'k', DEMO_MODE: '1' }).mode).toBe('demo');
    // geminiLive() reads the list by position.
    expect(providers({})[2]!.name).toMatch(/^Google Gemini/);
  });
});
