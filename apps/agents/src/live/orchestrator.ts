/**
 * Live mode: the Chief Finance Advisor is the root Claude Agent SDK query; Bookkeeper, Revenue, and
 * Credit & Risk are named subagents with their own identity-bound tool servers. A PreToolUse hook denies any
 * role calling another role's tools (belt); the database reducers check identity (braces).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, type HookCallback, type PreToolUseHookInput, type PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { repoRoot, type Cast } from '../stdb';
import { advisorServer, booksServer, crsServer, workerServer } from './tools';
import { startCritic } from '../redteam';

const chartersDir = join(repoRoot, 'apps', 'agents', 'src', 'charters');
function charter(role: string, fallback: string) {
  const p = join(chartersDir, `${role}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : fallback;
}

const PLAIN_RULE = `Every proposal, critique, and ruling carries a one-sentence plain summary for a CFO who has never seen a journal entry: no account codes, no jargon, dollar amounts spelled out (e.g. "$48,000"). The technical rationale goes in the rationale field.`;

const FALLBACK = {
  advisor: `You are the Chief Finance Advisor of Cafoo Inc. You run the month-end close by delegating to the bookkeeper, revenue, and credit subagents (use the Agent tool, one at a time or in parallel, and wait for each report). You are the only agent that approves or rejects proposals. Read every proposal with list_proposals, weigh the Red Team critiques, and rule on each one with a technical rationale and a plain summary. Amounts at or above the materiality threshold wait for the CFO automatically. When every proposal is decided, mark the close tasks done and call request_period_lock; never lock yourself. ${PLAIN_RULE}`,
  bookkeeper: `You are the Bookkeeper. You reconcile the bank feed and keep payables right. Start with close_snapshot and score_bank_matches. Propose one bank_match proposal for all auto-confidence matches and one per review-confidence match. Book duplicate payments as money due back from the vendor (account 1200). For unexplained outflows propose quick journal entries (payroll 5300, bank fees 6000, travel 5800, office 5500, software 5100) with the bankTxIds they explain. Use detect_missing_accruals and propose accruals. You never post; you only propose. ${PLAIN_RULE}`,
  revenue: `You are the Revenue agent. Every subscription contract must have a recognition schedule; use close_snapshot and build_revenue_schedule and propose any missing schedule. Then propose one journal entry recognizing this month's unrecognized schedule lines (Dr 2400 Deferred Revenue / Cr 4000 Subscription Revenue per customer, with recognizeScheduleYm set) and one for usage invoices of the month (Dr 1100 / Cr 4100). Never recognize revenue before the service month. You never post; you only propose. ${PLAIN_RULE}`,
  credit: `You are Credit & Risk. For every customer with open receivables, run run_credit_cascade on the guarantor persona, record each evidence row with record_credit_check, propose a credit_decision (tier and terms), and use allowance_target to propose an allowance journal entry (Dr 5700 Bad Debt Expense / Cr 1150 Allowance) for the delta when it is not zero. For every unverified vendor with an owner persona, run the cascade as vendor_owner and propose a vendor_block when the tier is BLOCK. Only persona ids are ever sent to the credit API. You never post; you only propose. ${PLAIN_RULE}`,
};

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

  const roleGate: HookCallback = async input => {
    const pre = input as PreToolUseHookInput;
    const agent = (pre as any).agent_type as string | undefined;
    const server = /^mcp__([a-z]+)__/.exec(pre.tool_name)?.[1];
    const deny = (why: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } });
    if (server === 'advisor' && agent) return deny(`Only the Advisor may use advisor tools; you are ${agent}.`);
    if (['bookkeeper', 'revenue', 'credit'].includes(server ?? '') && agent !== server) return deny(`Only the ${server} agent may use ${server} tools${agent ? `; you are ${agent}` : ''}.`);
    return {};
  };
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

  const workerTools = (name: string, extra: string[] = []) => ['SendMessage', `mcp__${name}__*`, 'mcp__books__*', ...extra];
  let total = 0;
  try {
    for await (const msg of query({
      prompt: `Close ${periodYm} for Cafoo Inc. Delegate: 1) bookkeeper (bank reconciliation, duplicates, quick entries, accruals), 2) revenue (schedules and recognition), 3) credit (guarantor cascades, allowances, vendor verification). Wait for each report. Then list proposals, consider critiques, rule on every one, mark tasks done, and request the lock.`,
      options: {
        model: process.env.ADVISOR_MODEL ?? 'opus',
        systemPrompt: charter('advisor', FALLBACK.advisor),
        tools: ['Agent', 'SendMessage'],
        allowedTools: ['Agent', 'SendMessage', 'mcp__advisor__*', 'mcp__books__*', 'mcp__bookkeeper__*', 'mcp__revenue__*', 'mcp__credit__*', 'mcp__crs__*'],
        permissionMode: 'dontAsk',
        mcpServers: { books, advisor, bookkeeper, revenue, credit, crs },
        agents: {
          bookkeeper: { description: 'Bank reconciliation, duplicate payments, quick entries, accruals. Proposes only.', prompt: charter('bookkeeper', FALLBACK.bookkeeper), model: process.env.WORKER_MODEL ?? 'sonnet', tools: workerTools('bookkeeper'), maxTurns: 40 },
          revenue: { description: 'Revenue schedules, recognition, deferred revenue. Proposes only.', prompt: charter('revenue', FALLBACK.revenue), model: process.env.WORKER_MODEL ?? 'sonnet', tools: workerTools('revenue'), maxTurns: 30 },
          credit: { description: 'Guarantor and vendor credit cascades, risk tiers, allowances, vendor blocks. Proposes only.', prompt: charter('credit', FALLBACK.credit), model: process.env.WORKER_MODEL ?? 'sonnet', tools: workerTools('credit', ['mcp__crs__*']), maxTurns: 60 },
        },
        hooks: { PreToolUse: [{ matcher: '^mcp__', hooks: [roleGate] }], PostToolUse: [{ matcher: 'SendMessage', hooks: [mirror] }] },
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
      model: process.env.ADVISOR_MODEL ?? 'opus',
      systemPrompt: `You are the Chief Finance Advisor of Cafoo Inc. Answer the CFO's question from the books using the books tools. Plain language, amounts spelled out, under 120 words, and say which page in the app shows the detail (Ledger, Board Pack, Proposals, Customers, Vendors).`,
      tools: [],
      allowedTools: ['mcp__books__*'],
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
