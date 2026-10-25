/**
 * Shared harness rules and tool names. Each factory returns a pure Rule; the agent modules give it an id and the
 * charter line it enforces. Plain summary wording follows packages/eval-harness/src/checks.ts (plain_summary_clean)
 * so a summary the gate lets through is one the charter eval also passes.
 */
import type { CharterLine, ProposalKind, Rule, RuleContext, ToolCall, Verdict } from './types';

// Tool names, exactly as apps/agents/src/live/tools.ts and packages/crs-mcp register them.
export const BOOKS_TOOLS = ['close_snapshot', 'list_proposals', 'score_bank_matches', 'detect_missing_accruals', 'build_revenue_schedule', 'allowance_target'] as const;
export const ADVISOR_TOOLS = ['approve_proposal', 'reject_proposal', 'post_ruling', 'update_close_task', 'request_period_lock'] as const;
export const CRS_TOOLS = ['crs_personas', 'crs_credit_report', 'crs_identity_verify', 'crs_fraud_score', 'crs_public_records', 'crs_cascade'] as const;
/** Red Team tools in redteam.ts (Vercel AI SDK, no MCP prefix). */
export const REDTEAM_TOOLS = ['search_policies', 'search_customer_site', 'submit_critique'] as const;

/** Appended to fallback prompts (used only when a charter file is missing). */
export const PLAIN_RULE = `Every proposal, critique, and ruling carries a one-sentence plain summary for a CFO who has never seen a journal entry: no account codes, no jargon, dollar amounts spelled out (e.g. "$48,000"). The technical rationale goes in the rationale field.`;

/** Worker propose tools and the Proposal kind each creates. */
export const PROPOSE_TOOLS: Record<string, ProposalKind> = {
  propose_journal_entry: 'journal_entry',
  propose_accrual: 'accrual',
  propose_bank_match: 'bank_match',
  propose_revenue_schedule: 'revenue_schedule',
  propose_credit_decision: 'credit_decision',
  propose_vendor_block: 'vendor_block',
  propose_vendor_verify: 'vendor_verify',
  propose_fx_revaluation: 'fx_revaluation',
  propose_ic_elimination: 'ic_elimination',
};

/** approve_proposal is the only tool call that can post a Journal Entry (below the Materiality threshold). */
const POSTING_TOOLS = new Set(['approve_proposal']);
const RULING_TOOLS = new Set(['approve_proposal', 'reject_proposal', 'post_ruling', 'request_period_lock']);
const CRITIQUE_TOOLS = new Set(['submit_critique', 'critique']);
/** Statuses that mean the Advisor has ruled (normalized: lower case, letters only). */
const RULED = new Set(['approved', 'rejected', 'amended', 'awaitingcfo']);

export const mcp = (server: string, names: readonly string[]) => names.map(n => `mcp__${server}__${n}`);
/** Tool name without the `mcp__<server>__` prefix. */
export const baseName = (tool: string) => tool.replace(/^mcp__[a-z_]+?__/, '');
export const serverOf = (tool: string) => /^mcp__([a-z]+)__/.exec(tool)?.[1];
export const statusKey = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
export const isRuled = (status: string | undefined) => status !== undefined && RULED.has(statusKey(status));

export const allow: Verdict = { allow: true };
export const deny = (reason: string): Verdict => ({ allow: false, reason });
export const rule = (id: string, charter: CharterLine, check: Rule['check'], extra: Pick<Rule, 'format' | 'partial'> = {}): Rule => ({ id, charter, check, ...extra });

export const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A row id as the module stores it (u64): digits only, compared without leading zeros. Undefined when not an id. */
export const idKey = (v: unknown) => (/^\d+$/.test(str(v)) ? BigInt(str(v)).toString() : undefined);

/** The Proposal kind a call would create, or undefined for any other tool. */
export const proposalKindOf = (call: ToolCall): ProposalKind | undefined => PROPOSE_TOOLS[baseName(call.tool)];

export const kindWords: Record<ProposalKind, string> = {
  journal_entry: 'journal entries',
  accrual: 'accruals',
  bank_match: 'bank matches',
  revenue_schedule: 'revenue schedules',
  credit_decision: 'credit decisions',
  vendor_block: 'vendor blocks',
  vendor_verify: 'vendor checks',
  fx_revaluation: 'currency revaluations',
  ic_elimination: 'intercompany eliminations',
};

/** Shared check behind every "You may propose X, and nothing else" line. */
export function kindAllowed(call: ToolCall, kinds: readonly ProposalKind[]): Verdict {
  const kind = proposalKindOf(call);
  if (!kind || kinds.includes(kind)) return allow;
  return deny(`may propose ${kinds.map(k => kindWords[k]).join(', ')} and nothing else, not ${kindWords[kind]}`);
}

/** "Never post a journal entry": no tool that posts to the ledger. */
export const noPosting = (id: string, charter: CharterLine): Rule =>
  rule(id, charter, call => (POSTING_TOOLS.has(baseName(call.tool)) ? deny(`${baseName(call.tool)} posts to the ledger; propose instead, and only the Advisor or the CFO posts`) : allow), {
    format: 'Never call approve_proposal: it posts to the ledger.',
  });

/** "Never approve, reject or amend a Proposal, and never mark a close task done." */
export const noRulings = (id: string, charter: CharterLine): Rule =>
  rule(id, charter, call => {
    const name = baseName(call.tool);
    if (RULING_TOOLS.has(name)) return deny(`${name} is a ruling or lock tool; only the Advisor rules`);
    if (name === 'update_close_task' && (serverOf(call.tool) === 'advisor' || str(call.input.status) === 'done')) return deny('only the Advisor or the CFO marks a close task done');
    return allow;
  }, { format: 'Never call approve_proposal, reject_proposal, post_ruling or request_period_lock; update_close_task only to todo, in_progress or blocked, never done.' });

/** "Never post a critique or a ruling message": statements and questions only. */
export const noCritiqueOrRulingMessage = (id: string, charter: CharterLine): Rule =>
  rule(id, charter, call => {
    const name = baseName(call.tool);
    if (name === 'post_ruling' || CRITIQUE_TOOLS.has(name)) return deny(`${name} posts a ${name === 'post_ruling' ? 'ruling' : 'critique'}; post statements or questions only`);
    if (name === 'post_message') {
      const kind = str(call.input.kind) || 'statement';
      if (kind !== 'statement' && kind !== 'question') return deny(`a ${kind} message is not allowed; post statements or questions only`);
    }
    return allow;
  }, { format: 'post_message kind is statement or question, never critique or ruling.' });

// ---- Plain summary ----

/** Jargon words, one list for the check and for the format text the agent reads. */
const BOOKKEEPING_WORDS = ['debit', 'debits', 'debited', 'accrual', 'accruals', 'accrue', 'accrued'];
const BOOKKEEPING_ABBREVIATIONS = ['Dr', 'Cr', 'GL', 'JE', 'ECL', 'AR', 'AP'];
const BUREAU_WORDS = ['tradeline', 'tradelines', 'FICO', 'KBA', 'BLJ', 'PitchPoint', 'risk.score'];
const words = (list: readonly string[]) => list.map(w => w.replace(/\./g, '\\.')).join('|');
const JARGON: [string, RegExp][] = [
  ['bookkeeping jargon', new RegExp(`\\b(${words(BOOKKEEPING_WORDS)})\\b|\\b(${words(BOOKKEEPING_ABBREVIATIONS)})\\b|\\bASC ?606\\b`, 'i')],
  ['bureau jargon', new RegExp(`\\b(${words(BUREAU_WORDS)})\\b`, 'i')],
  ['machine reason code', /\b[a-z]+_[a-z0-9_]+\b/],
  ['more than one sentence', /[.!?]\s+[A-Z]/],
];
/** Account-code shaped numbers when the chart is not at hand: 1000..6990 in steps of ten, as the seed chart uses. */
const CODE_SHAPE = '[1-6]\\d{2}0';
// Account codes and 5+ digit raw numbers use the eval's own lookbehind, so the gate never passes what the eval
// blocks ("#6000", "Software-5100", "-450000"). Only the extra 4-digit check also skips ids such as INV-1042 or #1042.
const codeRe = (codes: string) => new RegExp(`(?<![\\d,.$])\\b(${codes})\\b(?![,.]\\d)`, 'g');
const RAW = /(?<![\d,.$])\b(\d{5,})\b/g;
const RAW4 = /(?<![\d,.$#-])\b(\d{4})\b(?![,.]\d)/g;
const isYear = (n: string) => /^(19|20)\d\d$/.test(n);

/**
 * Problems with a plain summary: shorter than 10 characters, more than one sentence, an account code, bookkeeping
 * or bureau jargon, a machine reason code, or a raw number where money belongs. Empty when the summary is clean.
 */
export function plainSummaryProblems(text: string, accountCodes?: readonly string[]): string[] {
  const problems: string[] = [];
  if (text.trim().length < 10) problems.push('shorter than 10 characters');
  const codes = accountCodes?.length ? accountCodes.map(c => c.replace(/\D/g, '')).filter(Boolean).join('|') : CODE_SHAPE;
  const codeHits = new Set([...text.matchAll(codeRe(codes))].map(m => m[1]!).filter(n => !isYear(n) || accountCodes?.includes(n)));
  if (codeHits.size) problems.push(`account code ${[...codeHits].join(', ')}`);
  for (const [name, re] of JARGON) {
    const m = re.exec(text);
    if (m) problems.push(`${name} "${m[0].trim()}"`);
  }
  const raw = [...text.matchAll(RAW)].map(m => m[1]!)[0] ?? [...text.matchAll(RAW4)].map(m => m[1]!).find(n => !isYear(n) && !codeHits.has(n));
  if (raw) problems.push(`raw number "${raw}"; write amounts as money, e.g. "$48,000"`);
  return problems;
}

/** Fields that carry plain English for the CFO: every summary, and the reason on a vendor block or vendor check. */
const PLAIN_FIELDS = ['summaryPlain', 'reasonPlain'] as const;

/** The Plain summary rule over every call that carries a plain field. */
export const plainSummaryRule = (id: string): Rule =>
  rule(
    id,
    'Plain summary',
    (call, ctx) => {
      const broken = PLAIN_FIELDS.flatMap(f => {
        const v = call.input[f];
        const problems = typeof v === 'string' ? plainSummaryProblems(v, ctx.accountCodes) : [];
        return problems.length ? [`${f}: ${problems.join('; ')}`] : [];
      });
      return broken.length ? deny(`write one plain sentence with amounts as money; ${broken.join('; ')}`) : allow;
    },
    {
      format:
        `summaryPlain (and reasonPlain): one sentence of at least 10 characters; no account codes; no jargon (${[...BOOKKEEPING_WORDS, ...BOOKKEEPING_ABBREVIATIONS, 'ASC 606', ...BUREAU_WORDS].join(', ')}, any case); no snake_case codes; amounts as money such as "$48,000", never raw minor units such as "4800000"; no bare numbers of 4 or more digits except years and ids like INV-1042.`,
    }
  );
