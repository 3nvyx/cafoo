/**
 * The Red Team: a second model vendor (xAI Grok through the Vercel AI SDK) that critiques every open
 * proposal before the Advisor rules. Runs as its own database identity; it can critique, never propose or rule.
 * Without XAI_API_KEY it falls back to rule-based critiques so demo mode still shows a debate. Gemini (src/gemini.ts)
 * then reads the same Proposal and that critique and adds what it missed: live with GEMINI_API_KEY, scripted fixtures
 * otherwise. Either way the Red Team harness (src/harness/redteam.ts) judges each critique before it is written: open
 * Proposals only, a plain summary, critiques only.
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { generateText, stepCountIs, tool as aiTool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { geminiKey, geminiLive, geminiModel, redTeamLive } from './env';
import { labeled, scriptedGeminiCritique, unlabeled } from './gemini';
import { checkCall, modelFor, type Decision, type RuleContext } from './harness';
import { activeCharter } from './charter/active';
import { eliminationCritique, weakBankMatchCritique } from './scripted/rulings';
import { statusKey } from './harness/rules';
import { Cast, repoRoot, type RoleConn } from './stdb';

type Critique = { body: string; summaryPlain: string };
/** The Red Team's active charter (a published version, else the built-in one): its harness, prompt and model. */
const red = (A: RoleConn) => activeCharter(A, 'redteam');
/** Run the Red Team harness on a critique as the submit_critique tool call it is. */
const judge = (A: RoleConn, proposalId: bigint, c: Critique, ctx: RuleContext): Decision => checkCall(red(A).harness, { tool: 'submit_critique', input: { proposalId: proposalId.toString(), ...c } }, ctx);

const policiesDir = join(repoRoot, 'fixtures', 'moss');

/** Moss in live mode; local keyword search over the same policy documents otherwise. */
const POLICY_INDEX = 'cafoo-policies';
let mossReady: Promise<any | null> | null = null;

/** One shared Moss client with the policy index created once and loaded once; null when Moss is unusable. */
function mossIndex(docs: { id: string; text: string }[]): Promise<any | null> {
  if (mossReady) return mossReady;
  mossReady = (async () => {
    try {
      const moss: any = await import('@moss-js/moss' as string);
      const client = new moss.MossClient(process.env.MOSS_PROJECT_ID, process.env.MOSS_PROJECT_KEY);
      const existing: { name: string; status?: string }[] = await client.listIndexes();
      if (!existing.some(i => i.name === POLICY_INDEX)) {
        await client.createIndex(POLICY_INDEX, docs, { modelId: 'moss-minilm' }); // polls until the job completes
      }
      await client.loadIndex(POLICY_INDEX);
      console.log(`[moss] policy index "${POLICY_INDEX}" ready (${docs.length} documents)`);
      return client;
    } catch (e) {
      console.warn('moss unavailable, using local search:', (e as Error).message);
      return null;
    }
  })();
  return mossReady;
}

export async function searchPolicies(queryText: string, topK = 3): Promise<{ id: string; text: string; score: number }[]> {
  const docs = loadPolicyDocs();
  if (process.env.MOSS_PROJECT_ID && process.env.MOSS_PROJECT_KEY && process.env.DEMO_MODE !== '1') {
    const client = await mossIndex(docs.map(d => ({ id: d.id, text: d.text })));
    if (client) {
      try {
        const res = await client.query(POLICY_INDEX, queryText, { topK });
        return (res.docs ?? []).map((d: any) => ({ id: d.id, text: d.text, score: d.score }));
      } catch (e) {
        console.warn('moss query failed, using local search:', (e as Error).message);
      }
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
    return weakBankMatchCritique(payload.matches[0].scoreBp);
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
  if (kind === 'FxRevaluation') return { body: `The rate is the recorded closing rate for ${payload.periodYm ?? 'the month'} and only balances held in another currency are restated. Confirm nothing in these balances was settled after month end, or the gain or loss is overstated.`, summaryPlain: `The Red Team agrees with the rate and asks whether anything was paid after month end.` };
  if (kind === 'IcElimination') return eliminationCritique(payload);
  if (kind === 'JournalEntry' && p.amountMinor >= materiality) return { body: `Material entry. Confirm the account coding against the policy and that the bank transactions it explains are not also matched to a bill.`, summaryPlain: `The Red Team asks for a second look at a large entry.` };
  return null;
}

/** Per-critique model deadline, shared by both critics; a timed-out critic falls back like any other failure. */
function redTeamTimeoutMs(): number {
  const timeoutMs = Number(process.env.REDTEAM_TIMEOUT_MS?.trim() || 30_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('REDTEAM_TIMEOUT_MS must be a positive integer no greater than 2147483647');
  }
  return timeoutMs;
}

async function grokCritique(A: RoleConn, p: ProposalRow, materiality: bigint, ctx: () => RuleContext): Promise<Critique | null> {
  const xai = createXai({ apiKey: process.env.XAI_API_KEY });
  const c = await modelCritique(A, p, materiality, ctx, xai.responses(modelFor(red(A).harness)));
  // Only Gemini's own critiques carry its label.
  return c && unlabeled(c);
}

/** Gemini as the second critic: it sees the first critique and submits only what that critique missed. */
async function geminiCritique(A: RoleConn, p: ProposalRow, materiality: bigint, ctx: () => RuleContext, first: Critique | null): Promise<Critique | null> {
  const google = createGoogleGenerativeAI({ apiKey: geminiKey() });
  const brief = first
    ? `You are the Red Team's second critic. The first critic already wrote:\n${first.body}\nDo not repeat it. Submit a critique only for a material point it missed; if you have nothing to add, do not call submit_critique.`
    : `You are the Red Team's second critic. The first critic raised nothing on this Proposal. Submit a critique only for a material point; if you have nothing to add, do not call submit_critique.`;
  return modelCritique(A, p, materiality, ctx, google(geminiModel()), brief);
}

/** One critique from a Vercel AI SDK model through the Red Team's two tools; null when it submits nothing the harness accepts. */
async function modelCritique(A: RoleConn, p: ProposalRow, materiality: bigint, ctx: () => RuleContext, model: LanguageModel, brief?: string): Promise<Critique | null> {
  const charter = red(A);
  let submitted: Critique | null = null;
  await generateText({
    abortSignal: AbortSignal.timeout(redTeamTimeoutMs()),
    model,
    // The harness instructions say how to use the tools; the charter and the gate formats follow them.
    system: brief ? `${charter.prompt}\n\n${brief}` : charter.prompt,
    prompt: `Proposal ${p.id} (${p.kind.tag}, ${p.proposerRole}, amount minor units ${p.amountMinor}, materiality ${materiality}):\nPlain: ${p.summaryPlain}\nRationale: ${p.rationale}\nPayload: ${p.payloadJson.slice(0, 4000)}`,
    tools: {
      search_policies: aiTool({ description: 'Search the house accounting policies', inputSchema: z.object({ query: z.string() }), execute: async ({ query }) => searchPolicies(query) }),
      submit_critique: aiTool({
        description: 'Submit the critique',
        inputSchema: z.object({ body: z.string(), summaryPlain: z.string() }),
        execute: async a => {
          const c = ctx();
          const d = judge(A, p.id, a, c);
          const status = c.proposalStatus?.(p.id.toString());
          if (!d.allow && status !== undefined && statusKey(status) !== 'open') return `Stop: Proposal ${p.id} is ${status}; it was already ruled or is no longer open, so no critique can be attached. Do not call submit_critique again.`;
          if (!d.allow) return `Not submitted: ${d.reason}. Fix it and call submit_critique again.`;
          submitted = a;
          return 'submitted';
        },
      }),
    },
    stopWhen: stepCountIs(charter.harness.maxTurns ?? 6),
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
  /** Judge a critique again at write time (the Advisor may have ruled while a model was thinking), then write it. */
  const write = async (p: ProposalRow, c: Critique) => {
    const d = judge(A, p.id, c, ctx());
    if (!d.allow) return console.warn(`[redteam] proposal ${p.id}: critique withheld: ${d.reason}`);
    await RT.reducers.critique({ proposalId: p.id, body: c.body, summaryPlain: c.summaryPlain });
  };
  const vendorName = (id: bigint) => A.db.vendor.id.find(id)?.name;
  const critique = async (p: ProposalRow) => {
    if (seen.has(p.id) || p.status.tag !== 'Open') return;
    seen.add(p.id);
    const materiality = A.db.settings.key.find('materiality_threshold_minor')?.valueI64 ?? 1_000_000n;
    try {
      // Grok first when live; the scripted critique when Grok fails (outage, timeout, rate limit) or submits nothing
      // the harness accepts within its step cap.
      const grok = redTeamLive()
        ? await grokCritique(A, p, materiality, ctx).catch(e => {
            console.warn(`[redteam] proposal ${p.id}: Grok failed, using the scripted critique:`, (e as Error).message);
            return null;
          })
        : null;
      const c = grok ?? scriptedCritique(p, materiality);
      if (c) await write(p, c);
      // Gemini second. Live, a failure or "nothing to add" writes nothing: the first critique already stands, and a
      // scripted line must never appear under Gemini's live label. Without a key, the scripted stand-in.
      const g = geminiLive()
        ? await geminiCritique(A, p, materiality, ctx, c)
            .then(x => (x ? labeled(x, false) : null))
            .catch(e => {
              console.warn(`[redteam] proposal ${p.id}: Gemini failed, no second critique:`, (e as Error).message);
              return null;
            })
        : scriptedGeminiCritique(p, materiality, vendorName);
      if (g) await write(p, g);
    } catch (e) {
      console.error(`[redteam] proposal ${p.id}:`, (e as Error).message);
    }
  };
  const onInsert = (_ctx: unknown, row: ProposalRow) => {
    if (!stopped) void critique(row);
  };
  A.db.proposal.onInsert(onInsert as any);
  for (const p of A.db.proposal.iter()) if (p.status.tag === 'Open') void critique(p);
  console.log(`[redteam] watching proposals (${redTeamLive() ? modelFor(red(A).harness) : 'scripted'}, then ${geminiLive() ? geminiModel() : 'scripted Gemini'})`);
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
