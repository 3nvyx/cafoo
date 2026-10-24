/**
 * Live mode: the Chief Finance Advisor is the root Claude Agent SDK query; Bookkeeper, Revenue, and
 * Credit & Risk are named subagents with their own identity-bound tool servers. Each agent is built from its
 * harness (src/harness: charter plus the formats its gate checks, model, exact tool list, turn cap), and one PreToolUse hook denies any role
 * calling another role's tools or breaking a charter rule (belt); the database reducers check identity (braces).
 */
import { query, type AgentDefinition, type HookCallback, type PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { type Cast } from '../stdb';
import { advisorServer, booksServer, crsServer, workerServer } from './tools';
import { startCritic } from '../redteam';
import { agentPrompt, HARNESSES, modelFor, WORKERS, type WorkerRole } from '../harness';
import { harnessGate } from '../harness/hook';
import { BOOKS_TOOLS, mcp } from '../harness/rules';

const ADVISOR = HARNESSES.advisor;

/** A worker subagent exactly as its harness declares it. */
function subagent(role: WorkerRole): AgentDefinition {
  const h = HARNESSES[role];
  return { description: h.description ?? role, prompt: agentPrompt(h), model: modelFor(h), tools: [...h.tools], maxTurns: h.maxTurns };
}

export async function runLiveClose(cast: Cast, periodYm: string, onStep: (m: string) => void) {
  const period = [...cast.advisor.db.period.iter()].find(p => p.ym === periodYm);
  if (period && [...cast.advisor.db.proposal.iter()].some(p => p.periodId === period.id)) {
    onStep(`${periodYm} already has proposals; resuming through the scripted path instead of proposing twice`);
    const { runScriptedClose } = await import('../scripted/close');
    return runScriptedClose(cast, periodYm, { onStep });
  }
  const books = booksServer(cast);
  const advisor = advisorServer(cast);
  const bookkeeper = workerServer(cast.bookkeeper, cast);
  const revenue = workerServer(cast.revenue, cast);
  const credit = workerServer(cast.credit, cast);
  const crs = crsServer();
  const stopCritic = startCritic(cast);

  const A = cast.advisor;
  const gate = harnessGate({
    context: () => ({
      proposalStatus: id => (/^\d+$/.test(id) ? A.db.proposal.id.find(BigInt(id))?.status.tag : undefined),
      accountCodes: [...A.db.account.iter()].map(a => a.code),
    }),
    onDeny: (agent, tool, why) => onStep(`gate denied ${agent} ${tool}: ${why.slice(0, 200)}`),
  });
  const mirror: HookCallback = async input => {
    const post = input as PostToolUseHookInput;
    if (post.tool_name !== 'SendMessage') return {};
    const agent = ((post as any).agent_type as string | undefined) ?? 'advisor';
    const inp = post.tool_input as { to?: string; message?: string };
    const who = (['bookkeeper', 'revenue', 'credit'].includes(agent) ? cast.byRole(agent as any) : cast.advisor);
    try {
      await who.reducers.postAgentMessage({ threadId: `close:${periodYm}`, kind: agent === 'advisor' ? 'ruling' : 'statement', body: `to ${inp.to}: ${inp.message ?? ''}`, summaryPlain: `${agent} messaged ${inp.to}.`, proposalId: undefined });
    } catch {
      /* mirroring is best effort */
    }
    return {};
  };

  // The root pre-approves every harness tool so subagents can use theirs under dontAsk; the gate keeps each to its own list.
  const allowedTools = [...new Set([ADVISOR, ...WORKERS.map(r => HARNESSES[r])].flatMap(h => h.tools))];
  let total = 0;
  try {
    for await (const msg of query({
      prompt: `Close ${periodYm} for Cafoo Inc. Delegate: 1) bookkeeper (bank reconciliation, duplicates, quick entries, accruals), 2) revenue (schedules and recognition), 3) credit (guarantor cascades, allowances, vendor verification). Wait for each report. Then list proposals, consider critiques, rule on every one, mark tasks done, and request the lock.`,
      options: {
        model: modelFor(ADVISOR),
        systemPrompt: agentPrompt(ADVISOR),
        tools: ADVISOR.tools.filter(t => !t.startsWith('mcp__')),
        allowedTools,
        ...(ADVISOR.maxTurns ? { maxTurns: ADVISOR.maxTurns } : {}),
        permissionMode: 'dontAsk',
        mcpServers: { books, advisor, bookkeeper, revenue, credit, crs },
        agents: Object.fromEntries(WORKERS.map(r => [r, subagent(r)])),
        // The gate judges on PreToolUse and learns from results (history of successful calls) on the other two.
        hooks: {
          PreToolUse: [{ matcher: '^mcp__', hooks: [gate] }],
          PostToolUse: [{ matcher: 'SendMessage', hooks: [mirror] }, { matcher: '^mcp__', hooks: [gate] }],
          PostToolUseFailure: [{ matcher: '^mcp__', hooks: [gate] }],
        },
        env: { ...process.env, CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4' },
        maxBudgetUsd: Number(process.env.CLOSE_BUDGET_USD ?? 15),
        settingSources: [],
      },
    })) {
      if (msg.type === 'assistant') {
        for (const block of (msg as any).message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) onStep(`${(msg as any).agent_id ? 'agent' : 'advisor'}: ${String(block.text).slice(0, 200)}`);
          if (block.type === 'tool_use') onStep(`tool ${block.name}`);
        }
      } else if (msg.type === 'result') {
        total = (msg as any).total_cost_usd ?? 0;
        onStep(`done (${(msg as any).subtype}), cost $${total.toFixed(2)}`);
      }
    }
  } finally {
    stopCritic();
  }
  return { costUsd: total };
}

/** Ask-the-books in live mode: the Advisor answers with read-only tools. */
export async function* liveAnswer(cast: Cast, question: string): AsyncGenerator<string> {
  const books = booksServer(cast);
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
      includePartialMessages: true,
      settingSources: [],
    },
  })) {
    if (msg.type === 'stream_event') {
      const ev = (msg as any).event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') yield ev.delta.text as string;
    }
  }
}
