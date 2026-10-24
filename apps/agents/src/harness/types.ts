/**
 * Agent harness types. A harness is one agent's charter turned into data the runtime enforces: which tools it
 * may call, which Proposal kinds it may create, and a list of named rules, each tied to the numbered charter
 * line it enforces. Charter lines that no single tool call can show (ordering across the close, joins against
 * the ledger) are listed as evalOnly with the scenario in packages/eval-harness/scenarios/ that checks them.
 */

export type Role = 'advisor' | 'bookkeeper' | 'revenue' | 'credit' | 'redteam';
export type WorkerRole = 'bookkeeper' | 'revenue' | 'credit';

/** Proposal kinds as the module stores them. */
export type ProposalKind = 'journal_entry' | 'accrual' | 'bank_match' | 'revenue_schedule' | 'credit_decision' | 'vendor_block';

/** A numbered charter line ("May 2", "Must never 3", "Escalates 1") or the Plain summary rule. */
export type CharterLine = `May ${number}` | `Must never ${number}` | `Escalates ${number}` | 'Plain summary';

/**
 * One tool call as the runtime sees it. `tool` is the full name: `mcp__<server>__<tool>` for the Claude Agent SDK
 * roles, or the bare Vercel AI SDK tool name (`submit_critique`) for the Red Team.
 */
export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/** Read-only facts a rule may consult besides the call itself. Every field is optional; rules degrade to the input. */
export interface RuleContext {
  /** Current status tag of a Proposal by id (`Open`, `SentBack`, `Approved`, ...), or undefined when unknown. */
  proposalStatus?: (proposalId: string) => string | undefined;
  /** Chart-of-accounts codes, for the Plain summary rule. Falls back to a code-shaped pattern when absent. */
  accountCodes?: readonly string[];
  /** Earlier calls this agent made in the same run that the gate let through, oldest first. */
  history?: readonly ToolCall[];
}

export type Verdict = { allow: true } | { allow: false; reason: string };

export interface Rule {
  /** `<role>.<may|never|escalates>.<n>` or `<role>.plain`. */
  id: string;
  charter: CharterLine;
  /** Pure: same call and context, same verdict. */
  check(call: ToolCall, ctx: RuleContext): Verdict;
  /** What the agent must write for this rule to pass, appended to its prompt under "Formats the gate checks". */
  format?: string;
  /** Set when the rule covers only part of its charter line: the scenario that checks the rest, and what that is. */
  partial?: { scenario: string; rest: string };
}

export interface EvalOnly {
  charter: CharterLine;
  /** File name under packages/eval-harness/scenarios/. */
  scenario: string;
  /** Why a single tool call cannot show this line. */
  why: string;
}

export interface Harness {
  role: Role;
  /** File name under apps/agents/src/charters/. */
  charterFile: string;
  /** Used only when the charter file is missing. */
  fallbackPrompt: string;
  /** Subagent description for the Advisor's Agent tool (workers only). */
  description?: string;
  model: { env: string; default: string };
  /** Exact tool names, no wildcards. */
  tools: readonly string[];
  proposalKinds: readonly ProposalKind[];
  /** Agentic turn cap; undefined means the run is bounded by budget instead (the Advisor root). */
  maxTurns?: number;
  rules: readonly Rule[];
  evalOnly: readonly EvalOnly[];
}
