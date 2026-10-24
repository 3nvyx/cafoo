/**
 * The Red Team: a second model vendor (xAI Grok through the Vercel AI SDK) that critiques every open
 * proposal before the Advisor rules. Runs as its own database identity; it can critique, never propose or rule.
 * Without XAI_API_KEY it falls back to rule-based critiques so demo mode still shows a debate. Either way the
 * Red Team harness (src/harness/redteam.ts) judges the critique before it is written: open Proposals only, a plain
 * summary, critiques only.
 */
import { createXai } from '@ai-sdk/xai';
import { generateText, stepCountIs, tool as aiTool } from 'ai';
import { z } from 'zod';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redTeamLive } from './env';
import { agentPrompt, checkCall, HARNESSES, modelFor, type Decision, type RuleContext } from './harness';
import { statusKey } from './harness/rules';
import { Cast, repoRoot, type RoleConn } from './stdb';

const RED = HARNESSES.redteam;
type Critique = { body: string; summaryPlain: string };
/** Run the Red Team harness on a critique as the submit_critique tool call it is. */
const judge = (proposalId: bigint, c: Critique, ctx: RuleContext): Decision => checkCall(RED, { tool: 'submit_critique', input: { proposalId: proposalId.toString(), ...c } }, ctx);

const policiesDir = join(repoRoot, 'fixtures', 'moss');

/** Moss in live mode; local keyword search over the same policy documents otherwise. */
export async function searchPolicies(queryText: string, topK = 3): Promise<{ id: string; text: string; score: number }[]> {
  const docs = loadPolicyDocs();
  if (process.env.MOSS_PROJECT_ID && process.env.MOSS_PROJECT_KEY && process.env.DEMO_MODE !== '1') {
    try {
      const moss: any = await import('@moss-js/moss' as string);
      const client = new moss.MossClient(process.env.MOSS_PROJECT_ID, process.env.MOSS_PROJECT_KEY);
      const name = 'cafoo-policies';
      try {
        await client.loadIndex(name);
      } catch {
        await client.createIndex(name, docs.map(d => ({ id: d.id, text: d.text })), { modelId: 'moss-minilm' });
        await client.loadIndex(name);
      }
      const res = await client.query(name, queryText, { topK });
      return (res.docs ?? []).map((d: any) => ({ id: d.id, text: d.text, score: d.score }));
    } catch (e) {
      console.warn('moss unavailable, using local search:', (e as Error).message);
    }
  }
  const terms = queryText.toLowerCase().split(/\W+/).filter(t => t.length > 3);
  return docs
    .map(d => ({ ...d, score: terms.reduce((n, t) => n + (d.text.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function loadPolicyDocs() {
  if (!existsSync(policiesDir)) return [] as { id: string; text: string }[];
  return readdirSync(policiesDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ id: f.replace(/\.md$/, ''), text: readFileSync(join(policiesDir, f), 'utf8') }));
}

type ProposalRow = NonNullable<ReturnType<RoleConn['db']['proposal']['id']['find']>>;

function scriptedCritique(p: ProposalRow, materiality: bigint): Critique | null {
  const payload = JSON.parse(p.payloadJson);
  const kind = p.kind.tag;
  if (kind === 'BankMatch' && payload.matches?.length === 1 && payload.matches[0].scoreBp < 7500) {
    return { body: `Confidence ${(payload.matches[0].scoreBp / 100).toFixed(0)}% is below the auto threshold and the counterparty only partly matches. A wrong match shows an invoice as paid when it is not. Ask the customer for remittance detail instead of matching now.`, summaryPlain: `The Red Team doubts this match: the name only partly fits.` };
  }
  if (kind === 'RevenueSchedule') return { body: `Straight-line is right for a flat annual subscription. Confirm the schedule starts in the invoice month and runs 12 months inclusive.`, summaryPlain: `The Red Team agrees with straight-line and asks to confirm the start month.` };
  if (kind === 'VendorVerify') return { body: `The owner's identity and fraud checks are clean, so verification is reasonable. Before the first payment, confirm the bank account on the bill belongs to the vendor and not to a look-alike.`, summaryPlain: `The Red Team agrees and asks to confirm the bank details before the first payment.` };
  if (kind === 'VendorBlock') return { body: `Agree with the block. Notify procurement before the bill's due date so the engagement is cancelled, not just unpaid.`, summaryPlain: `The Red Team agrees and asks that procurement be told.` };
  if (kind === 'Accrual') return { body: `Accrual is appropriate. Confirm the amount matches the bill rather than an estimate, and that the reversal is scheduled for next month so the expense is not doubled when the bill posts.`, summaryPlain: `The Red Team agrees and checks the reversal is scheduled.` };
  if (kind === 'JournalEntry' && /allowance/i.test(payload.memo ?? '') && p.amountMinor >= materiality) {
    return /bankruptcy/i.test(p.summaryPlain)
      ? { body: `A 100% reserve is the right default for an active bankruptcy plan. Confirm none of the receivable is secured or prepaid, and that the public record is tied to the guarantor's SSN rather than a same-name match.`, summaryPlain: `The Red Team asks whether any of this debt is secured before reserving all of it.` }
      : { body: `The reserve rate follows the tier table. Confirm the open balance excludes payments received this month but not yet matched, and revisit the rate if the customer keeps paying monthly.`, summaryPlain: `The Red Team asks to confirm the unpaid balance before reserving against it.` };
  }
  if (kind === 'JournalEntry' && p.amountMinor >= materiality) return { body: `Material entry. Confirm the account coding against the policy and that the bank transactions it explains are not also matched to a bill.`, summaryPlain: `The Red Team asks for a second look at a large entry.` };
  return null;
}

async function grokCritique(p: ProposalRow, materiality: bigint, ctx: () => RuleContext): Promise<Critique | null> {
  const xai = createXai({ apiKey: process.env.XAI_API_KEY });
  let submitted: Critique | null = null;
  await generateText({
    model: xai.responses(modelFor(RED)),
    // The harness instructions say how to use the tools; the charter and the gate formats follow them.
    system: agentPrompt(RED, { withInstructions: true }),
    prompt: `Proposal ${p.id} (${p.kind.tag}, ${p.proposerRole}, amount minor units ${p.amountMinor}, materiality ${materiality}):\nPlain: ${p.summaryPlain}\nRationale: ${p.rationale}\nPayload: ${p.payloadJson.slice(0, 4000)}`,
    tools: {
      search_policies: aiTool({ description: 'Search the house accounting policies', inputSchema: z.object({ query: z.string() }), execute: async ({ query }) => searchPolicies(query) }),
      submit_critique: aiTool({
        description: 'Submit the critique',
        inputSchema: z.object({ body: z.string(), summaryPlain: z.string() }),
        execute: async a => {
          const c = ctx();
          const d = judge(p.id, a, c);
          const status = c.proposalStatus?.(p.id.toString());
          if (!d.allow && status !== undefined && statusKey(status) !== 'open') return `Stop: Proposal ${p.id} is ${status}; it was already ruled or is no longer open, so no critique can be attached. Do not call submit_critique again.`;
          if (!d.allow) return `Not submitted: ${d.reason}. Fix it and call submit_critique again.`;
          submitted = a;
          return 'submitted';
        },
      }),
    },
    stopWhen: stepCountIs(RED.maxTurns ?? 6),
  });
  return submitted;
}

/** Watch for open proposals and critique each one once. Returns a stop function. */
export function startCritic(cast: Cast): () => void {
  const RT = cast.redteam;
  const A = cast.advisor;
  const seen = new Set<bigint>();
  let stopped = false;
  const ctx = (): RuleContext => ({ proposalStatus: id => (/^\d+$/.test(id) ? A.db.proposal.id.find(BigInt(id))?.status.tag : undefined), accountCodes: [...A.db.account.iter()].map(a => a.code) });
  const critique = async (p: ProposalRow) => {
    if (seen.has(p.id) || p.status.tag !== 'Open') return;
    seen.add(p.id);
    const materiality = A.db.settings.key.find('materiality_threshold_minor')?.valueI64 ?? 1_000_000n;
    try {
      // Grok first when live; the scripted critique when Grok fails (outage, timeout, rate limit) or submits nothing
      // the harness accepts within its step cap.
      const grok = redTeamLive()
        ? await grokCritique(p, materiality, ctx).catch(e => {
            console.warn(`[redteam] proposal ${p.id}: Grok failed, using the scripted critique:`, (e as Error).message);
            return null;
          })
        : null;
      const c = grok ?? scriptedCritique(p, materiality);
      if (!c) return;
      // Judged again at write time: the Advisor may have ruled while Grok was thinking.
      const d = judge(p.id, c, ctx());
      if (!d.allow) return console.warn(`[redteam] proposal ${p.id}: critique withheld: ${d.reason}`);
      await RT.reducers.critique({ proposalId: p.id, body: c.body, summaryPlain: c.summaryPlain });
    } catch (e) {
      console.error(`[redteam] proposal ${p.id}:`, (e as Error).message);
    }
  };
  const onInsert = (_ctx: unknown, row: ProposalRow) => {
    if (!stopped) void critique(row);
  };
  A.db.proposal.onInsert(onInsert as any);
  for (const p of A.db.proposal.iter()) if (p.status.tag === 'Open') void critique(p);
  console.log(`[redteam] watching proposals (${redTeamLive() ? modelFor(RED) : 'scripted'})`);
  return () => {
    stopped = true;
    try {
      A.db.proposal.removeOnInsert(onInsert as any);
    } catch {
      /* ignore */
    }
  };
}

const isMain = process.argv[1]?.endsWith('redteam.ts') || process.argv[1]?.endsWith('redteam.js');
if (isMain) {
  const cast = await Cast.connectAll();
  startCritic(cast);
  console.log('red team standing by; Ctrl-C to stop');
}
