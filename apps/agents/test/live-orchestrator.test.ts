/**
 * The live close (src/live/orchestrator.ts) with the Claude Agent SDK's query() replaced by a scripted fake: what it
 * asks the Advisor, with which servers, subagents, hooks and budget, and what it does when the Advisor leaves work,
 * fails, or runs out of budget. The database is the in-memory fake cast; the Red Team, the scripted close and the
 * deterministic rulings are spies; nothing reaches a model or the network.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from '../src/gateway';
import { HARNESSES, WORKERS } from '../src/harness';
import { BOOKS_TOOLS, mcp } from '../src/harness/rules';
import { builtinCharter } from '../src/charter/active';
import { STDB_DB } from '../src/env';
import { startCritic } from '../src/redteam';
import { ruleOpen } from '../src/scripted/rulings';
import { runScriptedClose } from '../src/scripted/close';
import { sleep as stdbSleep } from '../src/stdb';
import { liveAnswer, runLiveClose } from '../src/live/orchestrator';
import { books, fakeCast, type Rows } from './fake-cast';
import { ts } from './fake-conn';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: sdk.query,
  createSdkMcpServer: (o: { name: string; tools?: unknown[] }) => ({ type: 'sdk', name: o.name, tools: o.tools ?? [] }),
}));
vi.mock('../src/redteam', () => ({ startCritic: vi.fn() }));
vi.mock('../src/scripted/close', () => ({ runScriptedClose: vi.fn(async () => ({ scripted: true })) }));
vi.mock('../src/scripted/rulings', async importOriginal => ({ ...(await importOriginal<typeof import('../src/scripted/rulings')>()), ruleOpen: vi.fn(async () => 0) }));
vi.mock('../src/live/openai-bridge', () => ({ claudeProcessEnv: vi.fn(async () => ({ CAFOO_TEST_ENV: '1' })) }));
// The orchestrator's waits (quiescing, the CFO) advance the fake clock instead of sleeping.
vi.mock('../src/stdb', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/stdb')>()),
  sleep: vi.fn(async (ms: number) => void vi.setSystemTime(Date.now() + ms)),
}));

type Msg = Record<string, unknown>;
type Run = { prompt: string; options: Record<string, any> };
/** One scripted Advisor query: gets the call, yields SDK messages. */
type Script = (run: Run) => AsyncGenerator<Msg>;

const result = (cost: number, subtype = 'success'): Msg => ({ type: 'result', subtype, total_cost_usd: cost, is_error: subtype !== 'success' });
const plain = (cost = 0): Script =>
  async function* () {
    yield result(cost);
  };

let rows: Rows;
let fx: ReturnType<typeof fakeCast>;
let runs: Run[];
let scripts: Script[];
let steps: string[];
const stopCritic = vi.fn();
const onStep = (m: string) => void steps.push(m);
const signal = new AbortController().signal;

function setup(r: Rows = books()) {
  rows = r;
  fx = fakeCast(rows);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  for (const k of ['CLOSE_BUDGET_USD', 'CLOSE_NO_WAIT', 'ADVISOR_MODEL', 'WORKER_MODEL', 'CHARTER_OVERRIDE_JSON', 'CHARTER_OVERRIDE_DB']) vi.stubEnv(k, undefined);
  vi.stubEnv('DEMO_MODE', '1');
  vi.stubEnv('CRS_REPLAY', '1');
  vi.stubEnv('CRS_USERNAME', '');
  setup();
  runs = [];
  scripts = [];
  steps = [];
  stopCritic.mockReset();
  vi.mocked(startCritic).mockReset().mockReturnValue(stopCritic);
  vi.mocked(ruleOpen).mockReset().mockResolvedValue(0);
  vi.mocked(runScriptedClose).mockReset().mockResolvedValue({ scripted: true } as never);
  sdk.query.mockReset().mockImplementation((run: Run) => {
    runs.push(run);
    return (scripts.shift() ?? plain())(run);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const proposal = (id: bigint, extra: Record<string, unknown> = {}) => ({
  id,
  periodId: 9n,
  kind: { tag: 'BankMatch' },
  status: { tag: 'Open' },
  payloadJson: JSON.stringify({ matches: [{ bankTxId: '60', targetKind: 'invoice', targetId: '40', scoreBp: 9800 }] }),
  summaryPlain: `Proposal ${id}`,
  rationale: 'r',
  proposerRole: 'bookkeeper',
  amountMinor: 0n,
  createdAt: ts('2026-10-02T12:00:00Z'),
  ...extra,
});
/** A script whose Advisor run leaves these Proposals open (a worker filed them, nobody ruled). */
const files = (cost: number, ps: ReturnType<typeof proposal>[], subtype = 'success'): Script =>
  async function* () {
    for (const p of ps) fx.insert('proposal', p);
    yield result(cost, subtype);
  };

describe('the live close never runs in Demo mode', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

  /** POST /close through a gateway wired as main.ts wires it, and wait until a close runner was called. */
  async function close() {
    server = createGateway(fx.cast, { liveClose: (ym, step) => runLiveClose(fx.cast, ym, step), env: {} });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodYm: '2026-09' }) });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(vi.mocked(runScriptedClose).mock.calls.length + sdk.query.mock.calls.length).toBeGreaterThan(0));
  }

  it.each([
    ['no key', {}],
    ['an Anthropic key with DEMO_MODE=1', { ANTHROPIC_API_KEY: 'test-key-not-real', AGENT_PROVIDER: 'anthropic', DEMO_MODE: '1' }],
    ['an OpenAI key with DEMO_MODE=1', { OPENAI_API_KEY: 'test-key-not-real', AGENT_PROVIDER: 'openai', DEMO_MODE: '1' }],
  ])('with %s the gateway runs the scripted close and never queries a model', async (_label, env) => {
    vi.stubEnv('DEMO_MODE', '');
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AGENT_PROVIDER']) vi.stubEnv(k, '');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    await close();
    expect(runScriptedClose).toHaveBeenCalledWith(fx.cast, '2026-09', expect.objectContaining({ onStep: expect.any(Function) }));
    expect(sdk.query).not.toHaveBeenCalled();
    expect(startCritic).not.toHaveBeenCalled();
  });

  it('with a key and no DEMO_MODE the gateway runs the live close', async () => {
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('AGENT_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    await close();
    await vi.waitFor(() => expect(stopCritic).toHaveBeenCalled());
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(runScriptedClose).not.toHaveBeenCalled();
  });
});

describe('runLiveClose', () => {
  it('resumes a close that already has work through the scripted path instead of proposing twice', async () => {
    rows.agentMessage = [{ threadId: 'close:2026-09', senderRole: 'advisor', body: 'Opening the 2026-09 close for Cafoo Inc.', createdAt: ts('2026-10-01T00:00:00Z') }];
    rows.proposal = [proposal(14n, { createdAt: ts('2026-10-01T00:05:00Z') })];
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).resolves.toEqual({ scripted: true });
    expect(runScriptedClose).toHaveBeenCalledWith(fx.cast, '2026-09', { onStep });
    expect(steps).toEqual(['the 2026-09 close already started; resuming through the scripted path instead of proposing twice']);
    expect(sdk.query).not.toHaveBeenCalled();
    expect(startCritic).not.toHaveBeenCalled();
  });

  it('opens the close, then asks the Advisor to delegate to each worker in order and rule on everything', async () => {
    scripts.push(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Delegating to the Bookkeeper.' }, { type: 'tool_use', name: 'Agent' }] } };
      yield { type: 'assistant', agent_id: 'a1', message: { content: [{ type: 'text', text: '  ' }, { type: 'tool_use', name: 'mcp__bookkeeper__propose_bank_match' }] } };
      yield { type: 'assistant', agent_id: 'a1', message: { content: [{ type: 'text', text: 'Filed one match.' }] } };
      yield result(1.25);
    });
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).resolves.toEqual({ costUsd: 1.25 });

    const opening = fx.calls[0]!;
    expect(opening).toMatchObject({ role: 'advisor', reducer: 'postAgentMessage', args: { threadId: 'close:2026-09', kind: 'ruling', summaryPlain: 'The Advisor started the 2026-09 close.' } });
    expect(opening.args.body).toMatch(/^Opening the 2026-09 close for Cafoo Inc\. /);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toMatch(/^Close 2026-09 for Cafoo Inc\. Delegate: 1\) bookkeeper \([^)]*\), 2\) revenue \([^)]*\), 3\) credit \([^)]*\)\. Wait for each report\..*request the lock\.$/);
    expect(runs[0]!.prompt).not.toMatch(/consolidation/);
    expect(steps).toEqual(['advisor: Delegating to the Bookkeeper.', 'tool Agent', 'tool mcp__bookkeeper__propose_bank_match', 'agent: Filed one match.', 'done (success), cost $1.25']);
    expect(startCritic).toHaveBeenCalledWith(fx.cast);
    expect(stopCritic).toHaveBeenCalledTimes(1);
    expect(ruleOpen).not.toHaveBeenCalled();
  });

  it('runs the Advisor with its charter, its own tools, every harness tool pre-approved, the gate, and the default budget', async () => {
    await runLiveClose(fx.cast, '2026-09', onStep);
    const o = runs[0]!.options;
    expect(o.model).toBe('opus');
    expect(o.systemPrompt).toBe(builtinCharter('advisor').prompt);
    expect(o.tools).toEqual(['Agent', 'SendMessage']);
    expect(o).not.toHaveProperty('maxTurns');
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.settingSources).toEqual([]);
    expect(o.env).toEqual({ CAFOO_TEST_ENV: '1' });
    expect(o.maxBudgetUsd).toBe(15);
    expect(new Set(o.allowedTools).size).toBe(o.allowedTools.length);
    for (const role of ['advisor', ...WORKERS] as const) for (const t of HARNESSES[role].tools) expect(o.allowedTools, `${role}: ${t}`).toContain(t);
    expect(Object.keys(o.mcpServers).sort()).toEqual(['advisor', 'bookkeeper', 'books', 'consolidation', 'credit', 'crs', 'revenue']);
    expect(Object.keys(o.agents)).toEqual(['bookkeeper', 'revenue', 'credit']);
    for (const r of ['bookkeeper', 'revenue', 'credit'] as const) {
      const c = builtinCharter(r);
      expect(o.agents[r]).toEqual({ description: c.harness.description, prompt: c.prompt, model: 'sonnet', tools: [...c.harness.tools], maxTurns: c.harness.maxTurns });
    }
    const gate = o.hooks.PreToolUse[0].hooks[0];
    expect(o.hooks.PreToolUse).toEqual([{ matcher: '^mcp__', hooks: [gate] }]);
    expect(o.hooks.PostToolUse).toEqual([{ matcher: 'SendMessage', hooks: [expect.any(Function)] }, { matcher: '^mcp__', hooks: [gate] }]);
    expect(o.hooks.PostToolUseFailure).toEqual([{ matcher: '^mcp__', hooks: [gate] }]);
  });

  it('adds the Consolidation agent for a group', async () => {
    setup(books({ group: true }));
    await runLiveClose(fx.cast, '2026-09', onStep);
    expect(Object.keys(runs[0]!.options.agents)).toEqual(['bookkeeper', 'revenue', 'credit', 'consolidation']);
    expect(runs[0]!.prompt).toMatch(/3\) credit \([^)]*\), 4\) consolidation \(revalue Cafoo Ltd's foreign-currency balances/);
  });

  it('follows ADVISOR_MODEL and WORKER_MODEL', async () => {
    vi.stubEnv('ADVISOR_MODEL', 'claude-test-advisor');
    vi.stubEnv('WORKER_MODEL', 'claude-test-worker');
    await runLiveClose(fx.cast, '2026-09', onStep);
    expect(runs[0]!.options.model).toBe('claude-test-advisor');
    expect(runs[0]!.options.agents.credit.model).toBe('claude-test-worker');
  });
});

describe('the PreToolUse role gate in the live close', () => {
  /** Run a close whose Advisor run calls the gate with these tool calls; returns each decision. */
  async function judge(callsIn: { agent?: string; tool: string; input?: Record<string, unknown> }[]) {
    const out: unknown[] = [];
    scripts.push(async function* (run) {
      const gate = run.options.hooks.PreToolUse[0].hooks[0];
      for (const [i, c] of callsIn.entries()) {
        out.push(await gate({ hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd: '', ...(c.agent ? { agent_type: c.agent } : {}), tool_name: c.tool, tool_input: c.input ?? {}, tool_use_id: `t${i}` }, `t${i}`, { signal }));
      }
      yield result(0);
    });
    await runLiveClose(fx.cast, '2026-09', onStep);
    return out as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } }[];
  }
  const reason = (d: { hookSpecificOutput?: { permissionDecisionReason: string } }) => d.hookSpecificOutput?.permissionDecisionReason;
  const ruling = { proposalId: '14', rationale: 'Exact amount, name and invoice number match.', summaryPlain: 'Approved: the payment matches the invoice.' };

  it("denies any role another role's tool server, and says so in the close log", async () => {
    const [a, b, c] = await judge([
      { agent: 'bookkeeper', tool: 'mcp__advisor__approve_proposal', input: ruling },
      { agent: 'credit', tool: 'mcp__bookkeeper__propose_bank_match', input: {} },
      { tool: 'mcp__revenue__propose_revenue_schedule', input: {} },
    ]);
    expect(reason(a!)).toBe('Only the Advisor may use advisor tools; you are bookkeeper.');
    expect(reason(b!)).toBe('Only the bookkeeper agent may use bookkeeper tools; you are credit.');
    expect(reason(c!)).toBe('Only the revenue agent may use revenue tools.');
    expect(steps).toContain('gate denied bookkeeper mcp__advisor__approve_proposal: Only the Advisor may use advisor tools; you are bookkeeper.');
    expect(steps).toContain('gate denied advisor mcp__revenue__propose_revenue_schedule: Only the revenue agent may use revenue tools.');
  });

  it('lets each role use its own tools and the books, and denies an agent type with no harness', async () => {
    rows.proposal = [proposal(14n)];
    const [own, books, unknown] = await judge([
      { tool: 'mcp__advisor__approve_proposal', input: ruling },
      { agent: 'revenue', tool: 'mcp__books__close_snapshot', input: { periodYm: '2026-09' } },
      { agent: 'intruder', tool: 'mcp__books__close_snapshot', input: { periodYm: '2026-09' } },
    ]);
    expect(own).toEqual({});
    expect(books).toEqual({});
    expect(reason(unknown!)).toMatch(/^No harness for agent type intruder/);
  });

  it('judges with the live books: a Proposal the Advisor already ruled cannot be ruled again', async () => {
    rows.proposal = [proposal(14n, { status: { tag: 'Approved' } })];
    const [again] = await judge([{ tool: 'mcp__advisor__approve_proposal', input: ruling }]);
    expect(reason(again!)).toMatch(/advisor\.never\.4 .*Proposal 14 is already ruled \(Approved\)/);
  });

  it('mirrors SendMessage between agents into the close thread as the sender', async () => {
    scripts.push(async function* (run) {
      const mirror = run.options.hooks.PostToolUse[0].hooks[0];
      const post = (agent: string | undefined, tool = 'SendMessage') => mirror({ hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '', cwd: '', ...(agent ? { agent_type: agent } : {}), tool_name: tool, tool_input: { to: 'advisor', message: 'Credit is done.' }, tool_response: {}, tool_use_id: 'm' }, 'm', { signal });
      expect(await post('credit')).toEqual({});
      expect(await post(undefined)).toEqual({});
      expect(await post('credit', 'Agent')).toEqual({});
      fx.fail('credit.postAgentMessage', 'thread closed');
      expect(await post('credit')).toEqual({});
      yield result(0);
    });
    await runLiveClose(fx.cast, '2026-09', onStep);
    const mirrored = fx.callsTo('postAgentMessage').slice(1, 3);
    expect(mirrored).toEqual([
      { role: 'credit', reducer: 'postAgentMessage', args: { threadId: 'close:2026-09', kind: 'statement', body: 'to advisor: Credit is done.', summaryPlain: 'credit messaged advisor.', proposalId: undefined } },
      { role: 'advisor', reducer: 'postAgentMessage', args: { threadId: 'close:2026-09', kind: 'ruling', body: 'to advisor: Credit is done.', summaryPlain: 'advisor messaged advisor.', proposalId: undefined } },
    ]);
    expect(fx.callsTo('postAgentMessage')).toHaveLength(4);
  });
});

describe('what the live close does with work the Advisor leaves', () => {
  it('asks the Advisor once more to rule on open Proposals, then applies the standard rulings to what is left', async () => {
    scripts.push(files(1, [proposal(15n), proposal(14n), proposal(16n, { periodId: 10n })]));
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).resolves.toEqual({ costUsd: 1 });
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toMatch(/^Delegation is finished for 2026-09\. 2 proposals are still open\. Call list_proposals for 2026-09 with status Open/);
    expect(steps).toContain('2 proposal(s) still open after delegation; the Advisor rules on them now');
    expect(steps).toContain('2 proposal(s) left unruled by the Advisor; applying the standard rulings');
    expect(ruleOpen).toHaveBeenCalledTimes(1);
    const [cast, open, opts] = vi.mocked(ruleOpen).mock.calls[0]!;
    expect(cast).toBe(fx.cast);
    expect(open.map(p => p.id)).toEqual([14n, 15n]);
    expect(opts).toMatchObject({ thread: 'close:2026-09', log: onStep });
    expect(opts.snapshot.materiality).toBe(1_000_000n);
    expect(stopCritic).toHaveBeenCalledTimes(1);
  });

  it('skips the standard rulings when the Advisor ruled on everything', async () => {
    scripts.push(files(0, [proposal(14n)]));
    scripts.push(async function* () {
      rows.proposal!.find(p => p.id === 14n)!.status = { tag: 'Approved' };
      yield result(0);
    });
    await runLiveClose(fx.cast, '2026-09', onStep);
    expect(runs).toHaveLength(2);
    expect(ruleOpen).not.toHaveBeenCalled();
  });

  it('waits until workers stop filing before it rules', async () => {
    let filedLate = false;
    scripts.push(plain(0));
    const sleep = vi.mocked(stdbSleep);
    const real = sleep.getMockImplementation()!;
    sleep.mockImplementation(async (ms: number) => {
      await real(ms);
      // A background subagent files a Proposal 10 seconds after the Advisor's run ended.
      if (!filedLate && Date.now() >= Date.parse('2026-10-02T12:00:10Z')) {
        filedLate = true;
        fx.insert('proposal', proposal(14n));
      }
    });
    try {
      await runLiveClose(fx.cast, '2026-09', onStep);
    } finally {
      sleep.mockImplementation(real);
    }
    expect(filedLate).toBe(true);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toMatch(/1 proposals are still open/);
  });

  it('when the Advisor errors, rejects with the error, stops the Red Team and rules nothing', async () => {
    scripts.push(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Starting.' }] } };
      throw new Error('Claude Code process exited with code 1');
    });
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).rejects.toThrow('Claude Code process exited with code 1');
    expect(stopCritic).toHaveBeenCalledTimes(1);
    expect(ruleOpen).not.toHaveBeenCalled();
    expect(steps).toEqual(['advisor: Starting.']);
  });

  it('when a run ends in an error result, still rules on what is open', async () => {
    scripts.push(files(0.5, [proposal(14n)], 'error_during_execution'), plain(0.25));
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).resolves.toEqual({ costUsd: 0.75 });
    expect(steps).toContain('done (error_during_execution), cost $0.50');
    expect(runs).toHaveLength(2);
    expect(ruleOpen).toHaveBeenCalledTimes(1);
  });

  it('stops the Red Team even when the close fails before its first Advisor run', async () => {
    // A broken dry-run charter override for this database: activeCharter throws while the close sets up.
    vi.stubEnv('CHARTER_OVERRIDE_DB', STDB_DB);
    vi.stubEnv('CHARTER_OVERRIDE_JSON', 'not json');
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).rejects.toThrow('CHARTER_OVERRIDE_JSON is not JSON');
    expect(sdk.query).not.toHaveBeenCalled();
    expect(stopCritic).toHaveBeenCalledTimes(vi.mocked(startCritic).mock.calls.length);
  });
});

describe('the close budget (CLOSE_BUDGET_USD)', () => {
  it('passes CLOSE_BUDGET_USD to the Advisor run', async () => {
    vi.stubEnv('CLOSE_BUDGET_USD', '4');
    await runLiveClose(fx.cast, '2026-09', onStep);
    expect(runs[0]!.options.maxBudgetUsd).toBe(4);
  });

  it('treats an empty CLOSE_BUDGET_USD as the default, as .env.example ships every value empty', async () => {
    vi.stubEnv('CLOSE_BUDGET_USD', '');
    await runLiveClose(fx.cast, '2026-09', onStep);
    expect(runs[0]!.options.maxBudgetUsd).toBe(15);
  });

  it('is the most one close may spend: a later Advisor run gets only what is left', async () => {
    vi.stubEnv('CLOSE_BUDGET_USD', '4');
    scripts.push(files(1.5, [proposal(14n)]));
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).resolves.toEqual({ costUsd: 1.5 });
    expect(runs.map(r => r.options.maxBudgetUsd)).toEqual([4, 2.5]);
  });

  it('once spent, runs no more Advisor queries and applies the standard rulings', async () => {
    vi.stubEnv('CLOSE_BUDGET_USD', '4');
    scripts.push(files(4.02, [proposal(14n)], 'error_max_budget_usd'));
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).resolves.toEqual({ costUsd: 4.02 });
    expect(steps).toContain('done (error_max_budget_usd), cost $4.02');
    expect(steps).toContain('the close budget of $4.00 is spent ($4.02); no further Advisor run');
    expect(runs).toHaveLength(1);
    expect(ruleOpen).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ruleOpen).mock.calls[0]![1].map(p => p.id)).toEqual([14n]);
    expect(stopCritic).toHaveBeenCalledTimes(1);
  });
});

describe('the revenue catch-up', () => {
  const approvedSchedule = (status = 'Approved') =>
    proposal(20n, { kind: { tag: 'RevenueSchedule' }, status: { tag: status }, payloadJson: JSON.stringify({ lines: [{ contractItemId: '80', customerId: '20', ym: '2026-09', amountMinor: '100000' }] }) });

  it('asks for one recognition entry for revenue whose schedule was approved after the recognition entry', async () => {
    rows.proposal = [approvedSchedule()];
    rows.revenueScheduleLine!.push({ id: 91n, contractItemId: 80n, customerId: 20n, ym: '2026-09', amountMinor: 100000n, recognized: false });
    await runLiveClose(fx.cast, '2026-09', onStep);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toMatch(/^Revenue catch-up for 2026-09: .*Acme Analytics \(customerId 20\): 100000 minor units\. Delegate to revenue: propose one recognition journal entry for 2026-09 with recognizeScheduleYm 2026-09/);
    expect(steps).toContain('revenue catch-up for 1 customer(s)');
  });

  it('with CLOSE_NO_WAIT, leaves a schedule still waiting for the CFO to the next close', async () => {
    vi.stubEnv('CLOSE_NO_WAIT', '1');
    rows.proposal = [approvedSchedule('AwaitingCfo')];
    await expect(runLiveClose(fx.cast, '2026-09', onStep)).resolves.toEqual({ costUsd: 0 });
    expect(steps).toContain('revenue schedules still wait for the CFO; their revenue catch-up rolls into the next close');
    expect(runs).toHaveLength(1);
    expect(stopCritic).toHaveBeenCalledTimes(1);
  });

  it('otherwise waits for the CFO to decide the schedule, then catches up', async () => {
    rows.proposal = [approvedSchedule('AwaitingCfo')];
    rows.revenueScheduleLine!.push({ id: 91n, contractItemId: 80n, customerId: 20n, ym: '2026-09', amountMinor: 100000n, recognized: false });
    const sleep = vi.mocked(stdbSleep);
    const real = sleep.getMockImplementation()!;
    let waited = 0;
    sleep.mockImplementation(async (ms: number) => {
      await real(ms);
      if (steps.includes('waiting for the CFO to decide the revenue schedules before the revenue catch-up') && ++waited === 3) rows.proposal![0].status = { tag: 'Approved' };
    });
    try {
      await runLiveClose(fx.cast, '2026-09', onStep);
    } finally {
      sleep.mockImplementation(real);
    }
    expect(waited).toBeGreaterThanOrEqual(3);
    expect(runs.map(r => r.prompt.slice(0, 22))).toEqual(['Close 2026-09 for Cafo', 'Revenue catch-up for 2']);
  });
});

describe('liveAnswer', () => {
  it('answers from the books tools only, streaming the text deltas', async () => {
    scripts.push(async function* () {
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Cash is ' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Cash is $4,200.' }] } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '$4,200.' } } };
      yield result(0.01);
    });
    const out: string[] = [];
    for await (const t of liveAnswer(fx.cast, 'How much cash?')) out.push(t);
    expect(out).toEqual(['Cash is ', '$4,200.']);
    const o = runs[0]!.options;
    expect(runs[0]!.prompt).toBe('How much cash?');
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual(mcp('books', BOOKS_TOOLS));
    expect(Object.keys(o.mcpServers)).toEqual(['books']);
    expect(o).toMatchObject({ permissionMode: 'dontAsk', maxTurns: 6, includePartialMessages: true, settingSources: [], env: { CAFOO_TEST_ENV: '1' } });
  });
});
