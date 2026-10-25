/**
 * Live mode: the Chief Finance Advisor is the root Claude Agent SDK query; Bookkeeper, Revenue, and
 * Credit & Risk are named subagents with their own identity-bound tool servers. Each agent is built from its
 * harness (src/harness: charter plus the formats its gate checks, model, exact tool list, turn cap), and one PreToolUse hook denies any role
 * calling another role's tools or breaking a charter rule (belt); the database reducers check identity (braces).
 */
import { query, type AgentDefinition, type HookCallback, type PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { say, sleep, type Cast } from '../stdb';
import { closeHasWork, openingMarker } from '../close-state';
import { advisorServer, booksServer, consolidationServer, crsServer, workerServer } from './tools';
import { startCritic } from '../redteam';
import { HARNESSES, modelFor, WORKERS, type ProposalKind, type WorkerRole } from '../harness';
import { activeCharter, activeHarnessResolver } from '../charter/active';
import { harnessGate } from '../harness/hook';
import { BOOKS_TOOLS, mcp } from '../harness/rules';
import { recordFallback, recordOk } from '../provider-calls';
import { catchUpAmounts } from '../revenue-catchup';
import { groupSnapshot, rootSubsidiary, snapshot } from '../snapshot';
import { ruleOpen } from '../scripted/rulings';
import type { RoleConn } from '../stdb';
import { claudeProcessEnv } from './openai-bridge';

const ADVISOR = HARNESSES.advisor;
const safeJson = (s: string): Record<string, unknown> => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** A worker subagent exactly as its active charter declares it (a published version, else the built-in one). */
function subagent(conn: RoleConn, role: WorkerRole): AgentDefinition {
  const { harness: h, prompt } = activeCharter(conn, role);
  return { description: h.description ?? role, prompt, model: modelFor(h), tools: [...h.tools], maxTurns: h.maxTurns };
}

export async function runLiveClose(cast: Cast, periodYm: string, onStep: (m: string) => void) {
  const cfoWaitMs = Number(process.env.CLOSE_CFO_WAIT_MS?.trim() || 45 * 60_000);
  if (!Number.isSafeInteger(cfoWaitMs) || cfoWaitMs < 0) throw new Error('CLOSE_CFO_WAIT_MS must be a non-negative safe integer');
  // Resume only a close that has work of its own (src/close-state.ts): not the live feed's Proposals of an open month,
  // and not a close that failed right after opening, before it filed anything.
  if (closeHasWork(cast.advisor, periodYm)) {
    onStep(`the ${periodYm} close already started; resuming through the scripted path instead of proposing twice`);
    const { runScriptedClose } = await import('../scripted/close');
    return runScriptedClose(cast, periodYm, { onStep });
  }
  const books = booksServer(cast);
  const advisor = advisorServer(cast);
  const bookkeeper = workerServer(cast.bookkeeper, cast);
  const revenue = workerServer(cast.revenue, cast);
  const credit = workerServer(cast.credit, cast);
  const consolidation = consolidationServer(cast);
  const crs = crsServer();
  // A group (a second trading company and an elimination subsidiary) gets the Consolidation agent too.
  const group = groupSnapshot(cast.advisor).entities.filter(e => !e.isElimination).length > 1;

  const A = cast.advisor;
  const advisorCharter = activeCharter(A, 'advisor');
  const gate = harnessGate({
    // Published charters change the gate as well as the prompts.
    resolve: activeHarnessResolver(A),
    context: () => ({
      proposalStatus: id => (/^\d+$/.test(id) ? A.db.proposal.id.find(BigInt(id))?.status.tag : undefined),
      accountCodes: [...A.db.account.iter()].map(a => a.code),
      pendingProposals: [...A.db.proposal.iter()]
        .filter(p => ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag))
        .map(p => ({ kind: p.kind.tag.replace(/[A-Z]/g, (c, i) => `${i ? '_' : ''}${c.toLowerCase()}`) as ProposalKind, payload: safeJson(p.payloadJson) })),
    }),
    onDeny: (agent, tool, why) => onStep(`gate denied ${agent} ${tool}: ${why.slice(0, 200)}`),
  });
  const mirror: HookCallback = async input => {
    const post = input as PostToolUseHookInput;
    if (post.tool_name !== 'SendMessage') return {};
    const agent = ((post as any).agent_type as string | undefined) ?? 'advisor';
    const inp = post.tool_input as { to?: string; message?: string };
    const who = ((WORKERS as readonly string[]).includes(agent) ? cast.byRole(agent as WorkerRole) : cast.advisor);
    try {
      await who.reducers.postAgentMessage({ threadId: `close:${periodYm}`, kind: agent === 'advisor' ? 'ruling' : 'statement', body: `to ${inp.to}: ${inp.message ?? ''}`, summaryPlain: `${agent} messaged ${inp.to}.`, proposalId: undefined });
    } catch {
      /* mirroring is best effort */
    }
    return {};
  };

  // The root pre-approves every harness tool so subagents can use theirs under dontAsk; the gate keeps each to its own list.
  const allowedTools = [...new Set([advisorCharter.harness, ...WORKERS.map(r => activeCharter(A, r).harness)].flatMap(h => h.tools))];
  let total = 0;
  let advisorUnavailable = false;
  /** Set when the Advisor failed and the close still needs finishing; runs after the critic stops (below). */
  let finishScripted = false;
  /** The most the whole close may spend (CLOSE_BUDGET_USD, empty means the default); each run gets what is left. */
  const budget = Number(process.env.CLOSE_BUDGET_USD?.trim() || 15);
  /** One Advisor query over the same servers, subagents and gate. */
  const run = async (prompt: string) => {
    if (advisorUnavailable) return;
    const left = budget - total;
    if (!(left > 0)) {
      onStep(`the close budget of $${budget.toFixed(2)} is spent ($${total.toFixed(2)}); no further Advisor run`);
      return;
    }
    try {
      const env = await claudeProcessEnv();
      for await (const msg of query({
        prompt,
        options: {
          model: modelFor(advisorCharter.harness),
          systemPrompt: advisorCharter.prompt,
          tools: advisorCharter.harness.tools.filter(t => !t.startsWith('mcp__')),
          allowedTools,
          ...(advisorCharter.harness.maxTurns ? { maxTurns: advisorCharter.harness.maxTurns } : {}),
          permissionMode: 'dontAsk',
          mcpServers: { books, advisor, bookkeeper, revenue, credit, consolidation, crs },
          agents: Object.fromEntries(WORKERS.filter(r => group || r !== 'consolidation').map(r => [r, subagent(A, r)])),
          // The gate judges on PreToolUse and learns from results (history of successful calls) on the other two.
          hooks: {
            PreToolUse: [{ matcher: '^mcp__', hooks: [gate] }],
            PostToolUse: [{ matcher: 'SendMessage', hooks: [mirror] }, { matcher: '^mcp__', hooks: [gate] }],
            PostToolUseFailure: [{ matcher: '^mcp__', hooks: [gate] }],
          },
          env,
          maxBudgetUsd: left,
          settingSources: [],
        },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg as any).message?.content ?? []) {
            if (block.type === 'text' && block.text?.trim()) onStep(`${(msg as any).agent_id ? 'agent' : 'advisor'}: ${String(block.text).slice(0, 200)}`);
            if (block.type === 'tool_use') onStep(`tool ${block.name}`);
          }
        } else if (msg.type === 'result') {
          total += (msg as any).total_cost_usd ?? 0;
          onStep(`done (${(msg as any).subtype}), cost $${total.toFixed(2)}`);
        }
      }
      recordOk('agents');
    } catch (error) {
      advisorUnavailable = true;
      recordFallback('agents', error);
      const why = error instanceof Error ? error.message : String(error);
      onStep(`Advisor run failed: ${why}; applying standard rulings to remaining proposals`);
    }
  };
  const periodId = [...A.db.period.iter()].find(p => p.ym === periodYm)?.id;
  const runAndRule = async (prompt: string) => {
    await run(prompt);
    await ruleRemaining();
  };
  const pendingSchedules = () =>
    [...A.db.proposal.iter()].filter(p => p.periodId === periodId && p.kind.tag === 'RevenueSchedule' && ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag));
  /**
   * Subagents run in the background, so the Advisor's run can end while workers still file Proposals.
   * Wait until the proposal and message counts stop changing for `quietMs` (cap `maxMs`).
   */
  const quiesce = async (quietMs = 30_000, maxMs = 10 * 60_000) => {
    const count = () => `${[...A.db.proposal.iter()].length}:${[...A.db.agentMessage.iter()].length}`;
    const start = Date.now();
    let last = count();
    let lastChange = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(2000);
      const now = count();
      if (now !== last) {
        last = now;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= quietMs) return;
    }
    onStep('workers still active after the wait cap; ruling on what is filed');
  };
  const openProposals = () => [...A.db.proposal.iter()].filter(p => p.periodId === periodId && p.status.tag === 'Open').sort((a, b) => Number(a.id - b.id));
  /** Rule on every open Proposal: a bounded Advisor run first, then the deterministic pass for anything it left. */
  const ruleRemaining = async () => {
    await quiesce();
    let open = openProposals();
    if (!open.length) return;
    onStep(`${open.length} proposal(s) still open after delegation; the Advisor rules on them now`);
    await run(
      `Delegation is finished for ${periodYm}. ${open.length} proposals are still open. Call list_proposals for ${periodYm} with status Open, weigh each Red Team critique, and rule on every one with approve_proposal or reject_proposal (technical rationale plus a one-sentence plain summary). Do not delegate again and do not propose anything. Then mark the close tasks done and call request_period_lock.`
    );
    open = openProposals();
    if (open.length) {
      onStep(`${open.length} proposal(s) left unruled by the Advisor; applying the standard rulings`);
      // startCritic already ran Gemini on these, live or scripted; no second scripted Gemini critique.
      await ruleOpen(cast, open, { thread: `close:${periodYm}`, snapshot: snapshot(A, periodYm), log: onStep, secondCritic: false });
    }
  };
  // Started only now, so a close that fails while setting up (a charter that does not build) leaves no critic running.
  const stopCritic = startCritic(cast);
  try {
    // The opening message marks the close as started, so a second run resumes instead of proposing twice.
    await say(A, `close:${periodYm}`, `${openingMarker(periodYm)} for ${rootSubsidiary(A).name}. Delegating to the Bookkeeper, Revenue, and Credit & Risk; nothing posts until I rule, and anything material waits for the CFO.`, `The Advisor started the ${periodYm} close.`, 'ruling');
    await run(
      `Close ${periodYm} for Cafoo Inc. Delegate: 1) bookkeeper (bank reconciliation, duplicates, quick entries, accruals), 2) revenue (schedules and recognition), 3) credit (guarantor cascades, allowances, vendor verification)${group ? ', 4) consolidation (revalue Cafoo Ltd\'s foreign-currency balances at the closing rate and propose the balance and activity eliminations; it raises any intercompany difference in the close thread first)' : ''}. Wait for each report. Then list proposals, consider critiques, rule on every one, mark tasks done, and request the lock.`
    );
    await ruleRemaining();
    // Revenue catch-up, as in the scripted close: the recognition entry had to leave out any customer whose new
    // schedule waited for a ruling. Once those schedules are decided, recognize their lines through the month.
    if (pendingSchedules().length) {
      if (process.env.CLOSE_NO_WAIT === '1') {
        onStep('revenue schedules still wait for the CFO; their revenue catch-up rolls into the next close');
        return { costUsd: total };
      }
      onStep('waiting for the CFO to decide the revenue schedules before the revenue catch-up');
      const deadline = Date.now() + cfoWaitMs;
      while (pendingSchedules().length && Date.now() < deadline) await sleep(Math.min(2000, deadline - Date.now()));
      if (pendingSchedules().length) {
        onStep('CFO wait limit reached; revenue schedules still await a decision, so revenue catch-up remains pending');
        return { costUsd: total };
      }
    }
    if (advisorUnavailable) {
      finishScripted = true;
      return { costUsd: total };
    }
    const s = snapshot(A, periodYm);
    const due = catchUpAmounts(A, s);
    if (due.size) {
      const lines = [...due].map(([cid, amt]) => `${s.customerName.get(cid) ?? 'customer'} (customerId ${cid}): ${amt} minor units`).join('; ');
      onStep(`revenue catch-up for ${due.size} customer(s)`);
      await runAndRule(
        `Revenue catch-up for ${periodYm}: the revenue schedules for these customers were approved after the recognition entry had to leave them out: ${lines}. Delegate to revenue: propose one recognition journal entry for ${periodYm} with recognizeScheduleYm ${periodYm} that, for each customer, debits 2400 and credits 4000 by exactly that amount on lines tagged with the customerId. Then list proposals, consider the critique, rule on it, and request the lock (the books refuse the lock until this revenue is recognized).`
      );
    }
  } finally {
    stopCritic();
    // The failed Advisor run was the one asked to finish the close: mark tasks done, catch up revenue and request the
    // lock. Nothing else would, so the scripted close resumes this one (it rules only what is still open and never
    // proposes twice) once the live critic has stopped. A close that waits on the CFO stays waiting, as above.
    if (finishScripted && [...A.db.period.iter()].find(p => p.ym === periodYm)?.status.tag === 'Open') {
      onStep('the Advisor is unavailable, so the scripted close finishes this one: close tasks, revenue catch-up and the lock request');
      const { runScriptedClose } = await import('../scripted/close');
      await runScriptedClose(cast, periodYm, { onStep });
    }
  }
  return { costUsd: total };
}

/** Ask-the-books in live mode: the Advisor answers with read-only tools. */
export async function* liveAnswer(cast: Cast, question: string): AsyncGenerator<string> {
  const budget = Number(process.env.CHAT_BUDGET_USD?.trim() || 0.5);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('CHAT_BUDGET_USD must be a positive finite number');
  const books = booksServer(cast);
  const env = await claudeProcessEnv();
  try {
    yield* streamAnswer(question, books, env, budget);
    recordOk('agents');
  } catch (error) {
    recordFallback('agents', error);
    throw error;
  }
}

async function* streamAnswer(question: string, books: ReturnType<typeof booksServer>, env: NodeJS.ProcessEnv, budget: number): AsyncGenerator<string> {
  for await (const msg of query({
    prompt: question,
    options: {
      model: modelFor(ADVISOR),
      systemPrompt: `You are the Chief Finance Advisor of Cafoo Inc. Answer the CFO's question from the books using the books tools. Plain language, amounts spelled out, under 120 words, and say which page in the app shows the detail (Ledger, Board Pack, Proposals, Customers, Vendors).`,
      tools: [],
      allowedTools: mcp('books', BOOKS_TOOLS),
      permissionMode: 'dontAsk',
      mcpServers: { books },
      maxTurns: 6,
      maxBudgetUsd: budget,
      includePartialMessages: true,
      settingSources: [],
      env,
    },
  })) {
    if (msg.type === 'stream_event') {
      const ev = (msg as any).event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') yield ev.delta.text as string;
    }
  }
}
