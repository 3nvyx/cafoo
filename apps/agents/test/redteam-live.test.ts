/**
 * The Red Team's live Grok path (src/redteam.ts startCritic) with the model call faked: generateText is a spy that
 * plays Grok by calling the request's own tools, and createXai never builds a real client. Pins what Grok is asked,
 * that the harness judges each critique (when submitted and again before it is written), and the fall back to the
 * scripted critique when Grok fails or submits nothing usable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinCharter } from '../src/charter/active';
import { startCritic } from '../src/redteam';
import { books, fakeCast, type Rows } from './fake-cast';

const ai = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock('ai', async importOriginal => ({ ...(await importOriginal<typeof import('ai')>()), generateText: ai.generateText }));
vi.mock('@ai-sdk/xai', () => ({ createXai: vi.fn((o: { apiKey?: string }) => ({ responses: (modelId: string) => ({ fake: 'xai', modelId, apiKey: o.apiKey }) })) }));

type Tools = Record<string, { execute: (input: unknown, opts: unknown) => Promise<unknown> }>;
type Req = { model: { modelId: string; apiKey?: string }; system: string; prompt: string; tools: Tools; stopWhen: unknown };
/** Grok's turn: what it does with the request's tools. */
type Grok = (req: Req, submit: (c: { body: string; summaryPlain: string }) => Promise<unknown>) => Promise<void>;

let rows: Rows;
let fx: ReturnType<typeof fakeCast>;
let stop: (() => void) | undefined;
let requests: Req[];
let replies: unknown[];
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
vi.spyOn(console, 'log').mockImplementation(() => undefined);

/** Every generateText call plays `grok`; what each submit_critique call returned is kept in `replies`. */
function grokDoes(grok: Grok) {
  ai.generateText.mockImplementation(async (req: Req) => {
    requests.push(req);
    await grok(req, async c => {
      const r = await req.tools.submit_critique!.execute(c, { toolCallId: `c${replies.length}`, messages: [] });
      replies.push(r);
      return r;
    });
    return { text: '' };
  });
}
const settle = () => new Promise(r => setTimeout(r, 20));

const weakMatch = (id = 14n, extra: Record<string, unknown> = {}) => ({
  id,
  periodId: 9n,
  kind: { tag: 'BankMatch' },
  status: { tag: 'Open' },
  proposerRole: 'bookkeeper',
  amountMinor: 0n,
  summaryPlain: 'Match the $2,500 Gamma payment to its invoice.',
  rationale: 'Amount exact; counterparty only partly matches.',
  payloadJson: JSON.stringify({ matches: [{ bankTxId: '104', targetKind: 'invoice', targetId: '3', scoreBp: 6100 }] }),
  ...extra,
});
const smallEntry = (id = 15n) => weakMatch(id, { kind: { tag: 'JournalEntry' }, amountMinor: 4500n, payloadJson: JSON.stringify({ memo: 'Bank fees', lines: [] }) });
const good = { body: 'The counterparty name only partly matches and the score is 61%; ask for remittance detail before matching.', summaryPlain: 'The Red Team doubts this match because the name only partly fits.' };
const scripted = { body: expect.stringMatching(/^Confidence 61% is below the auto threshold/), summaryPlain: 'The Red Team doubts this match: the name only partly fits.' };
const critiques = () => fx.callsTo('critique');

beforeEach(() => {
  vi.stubEnv('DEMO_MODE', '');
  vi.stubEnv('XAI_API_KEY', 'test-key-not-real');
  vi.stubEnv('REDTEAM_MODEL', undefined);
  vi.stubEnv('MOSS_PROJECT_ID', '');
  vi.stubEnv('MOSS_PROJECT_KEY', '');
  vi.stubEnv('CHARTER_OVERRIDE_JSON', '');
  rows = books();
  fx = fakeCast(rows);
  requests = [];
  replies = [];
  ai.generateText.mockReset();
  warn.mockClear();
  error.mockClear();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllEnvs();
});

describe('live Red Team (Grok)', () => {
  it('asks Grok about each open Proposal with the charter, the two tools and the step cap, and writes the critique it submits', async () => {
    grokDoes(async (_req, submit) => void (await submit(good)));
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(critiques()).toHaveLength(1));
    expect(critiques()[0]).toEqual({ role: 'redteam', reducer: 'critique', args: { proposalId: 14n, ...good } });
    expect(replies).toEqual(['submitted']);
    const req = requests[0]!;
    expect(req.model).toEqual({ fake: 'xai', modelId: 'grok-4.7', apiKey: 'test-key-not-real' });
    expect(req.system).toBe(builtinCharter('redteam').prompt);
    expect(req.prompt).toBe(`Proposal 14 (BankMatch, bookkeeper, amount minor units 0, materiality 1000000):\nPlain: ${weakMatch().summaryPlain}\nRationale: ${weakMatch().rationale}\nPayload: ${weakMatch().payloadJson}`);
    expect(Object.keys(req.tools).sort()).toEqual(['search_policies', 'submit_critique']);
    expect(req.stopWhen).toBeDefined();
  });

  it('critiques Proposals as they are filed, each once, and only open ones', async () => {
    grokDoes(async (_req, submit) => void (await submit(good)));
    stop = startCritic(fx.cast);
    const p = fx.insert('proposal', weakMatch());
    fx.insert('proposal', p);
    fx.insert('proposal', weakMatch(16n, { status: { tag: 'Approved' } }));
    await vi.waitFor(() => expect(critiques()).toHaveLength(1));
    await settle();
    expect(requests).toHaveLength(1);
    expect(critiques()).toHaveLength(1);
  });

  it('follows REDTEAM_MODEL', async () => {
    vi.stubEnv('REDTEAM_MODEL', 'grok-test');
    grokDoes(async (_req, submit) => void (await submit(good)));
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(critiques()).toHaveLength(1));
    expect(requests[0]!.model.modelId).toBe('grok-test');
  });

  it('tells Grok why a critique was refused, and writes the corrected one', async () => {
    grokDoes(async (_req, submit) => {
      await submit({ ...good, summaryPlain: 'Weak match at 6100 bp; score below 762000 threshold.' });
      await submit(good);
    });
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(critiques()).toHaveLength(1));
    expect(replies[0]).toMatch(/^Not submitted: redteam\.plain .*raw number "762000".*Fix it and call submit_critique again\.$/);
    expect(replies[1]).toBe('submitted');
    expect(critiques()[0]!.args).toEqual({ proposalId: 14n, ...good });
  });

  it('falls back to the scripted critique when Grok submits nothing the harness accepts', async () => {
    grokDoes(async (_req, submit) => void (await submit({ ...good, summaryPlain: 'Score 6100 is under 7500.' })));
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(critiques()).toHaveLength(1));
    expect(critiques()[0]!.args).toEqual({ proposalId: 14n, ...scripted });
  });

  it('falls back to the scripted critique when Grok fails (outage, timeout, rate limit)', async () => {
    ai.generateText.mockRejectedValue(new Error('429 rate limited'));
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(critiques()).toHaveLength(1));
    expect(critiques()[0]!.args).toEqual({ proposalId: 14n, ...scripted });
    expect(warn).toHaveBeenCalledWith('[redteam] proposal 14: Grok failed, using the scripted critique:', '429 rate limited');
  });

  it('writes nothing when Grok fails on a Proposal the scripted Red Team has nothing to say about', async () => {
    ai.generateText.mockRejectedValue(new Error('timeout'));
    rows.proposal = [smallEntry()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(ai.generateText).toHaveBeenCalled());
    await settle();
    expect(critiques()).toEqual([]);
  });

  it('stops Grok once the Advisor has ruled, and writes no late critique', async () => {
    grokDoes(async (_req, submit) => {
      rows.proposal![0].status = { tag: 'Approved' };
      await submit(good);
    });
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await settle();
    expect(replies[0]).toBe('Stop: Proposal 14 is Approved; it was already ruled or is no longer open, so no critique can be attached. Do not call submit_critique again.');
    expect(critiques()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[redteam\] proposal 14: critique withheld: .*redteam\.never\.3/));
  });

  it('judges the critique again before writing it: a ruling made while Grok was thinking withholds it', async () => {
    grokDoes(async (_req, submit) => {
      await submit(good);
      rows.proposal![0].status = { tag: 'AwaitingCfo' };
    });
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(replies).toEqual(['submitted']));
    await settle();
    expect(critiques()).toEqual([]);
  });

  it('logs a refused critique write instead of failing', async () => {
    grokDoes(async (_req, submit) => void (await submit(good)));
    fx.fail('redteam.critique', 'Only the Red Team may critique.');
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[redteam] proposal 14:', 'Only the Red Team may critique.'));
  });

  it('searches the house policies locally when Moss is not configured', async () => {
    let found: unknown;
    grokDoes(async req => {
      found = await req.tools.search_policies!.execute({ query: 'bank reconciliation match confidence' }, { toolCallId: 's', messages: [] });
    });
    rows.proposal = [smallEntry()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(found).toBeDefined());
    const docs = found as { id: string; score: number }[];
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.length).toBeLessThanOrEqual(3);
    expect(docs.map(d => d.id)).toContain('bank-reconciliation');
    for (const d of docs) expect(d.score).toBeGreaterThan(0);
  });

  it('stops watching when stopped', async () => {
    grokDoes(async (_req, submit) => void (await submit(good)));
    stop = startCritic(fx.cast);
    stop();
    fx.insert('proposal', weakMatch());
    await settle();
    expect(ai.generateText).not.toHaveBeenCalled();
    expect(critiques()).toEqual([]);
  });
});

describe('Red Team without Grok', () => {
  it.each([
    ['DEMO_MODE=1 even with a key', { DEMO_MODE: '1' }],
    ['no XAI_API_KEY', { XAI_API_KEY: '' }],
  ])('with %s never calls Grok and writes the scripted critique', async (_label, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    rows.proposal = [weakMatch()];
    stop = startCritic(fx.cast);
    await vi.waitFor(() => expect(critiques()).toHaveLength(1));
    expect(ai.generateText).not.toHaveBeenCalled();
    expect(critiques()[0]!.args).toEqual({ proposalId: 14n, ...scripted });
  });
});
