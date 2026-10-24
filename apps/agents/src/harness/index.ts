/**
 * Harness registry: one harness per agent, and the one function that judges a tool call against it.
 * The live orchestrator builds the Advisor query and each subagent from these; redteam.ts runs the Red Team's
 * rules before a critique is written. The database reducers stay the real gate (ADR 0001); this is the belt.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { advisor } from './advisor';
import { bookkeeper } from './bookkeeper';
import { consolidation } from './consolidation';
import { credit } from './credit';
import { redteam } from './redteam';
import { revenue } from './revenue';
import type { Harness, Role, RuleContext, ToolCall, WorkerRole } from './types';

export type { CharterLine, EvalOnly, Harness, ProposalKind, Role, Rule, RuleContext, ToolCall, Verdict, WorkerRole } from './types';

export const HARNESSES: Record<Role, Harness> = { advisor, bookkeeper, revenue, credit, redteam, consolidation };
export const WORKERS: readonly WorkerRole[] = ['bookkeeper', 'revenue', 'credit', 'consolidation'];

export const chartersDir = fileURLToPath(new URL('../charters/', import.meta.url));

/** The harness for an Agent SDK caller: no agent type is the root query (the Advisor); unknown types get none. */
export function harnessFor(agentType: string | undefined): Harness | undefined {
  if (!agentType) return advisor;
  return Object.hasOwn(HARNESSES, agentType) ? HARNESSES[agentType as Role] : undefined;
}

/** The agent's system prompt: its charter file, or the harness fallback when the file is missing. */
export function charterPrompt(h: Harness, dir = chartersDir): string {
  const p = `${dir}${dir.endsWith('/') ? '' : '/'}${h.charterFile}`;
  return existsSync(p) ? readFileSync(p, 'utf8') : h.fallbackPrompt;
}

/** "Formats the gate checks": every rule's format line, so the agent is told what the gate will refuse. */
export function gateFormats(h: Harness): string {
  const lines = h.rules.filter(r => r.format).map(r => `- ${r.format} (${r.id})`);
  return lines.length ? `## Formats the gate checks\n\nEvery tool call is checked against these before it runs; a call that breaks one is refused with the rule id and the reason. Fix the call and try again.\n\n${lines.join('\n')}\n` : '';
}

/**
 * The full system prompt: the charter (or the fallback when the file is missing), then the gate formats.
 * `withInstructions` puts the fallback's operating instructions before a present charter (the Red Team's Grok prompt).
 */
export function agentPrompt(h: Harness, opts: { withInstructions?: boolean; dir?: string } = {}): string {
  const charter = charterPrompt(h, opts.dir);
  const head = opts.withInstructions && charter !== h.fallbackPrompt ? [h.fallbackPrompt, charter] : [charter];
  return [...head, gateFormats(h)].filter(Boolean).join('\n\n');
}

export const modelFor = (h: Harness, env: NodeJS.ProcessEnv = process.env) => env[h.model.env] || h.model.default;

export type Decision = { allow: true } | { allow: false; ruleIds: string[]; reason: string };

/** Run the tool allowlist and every rule; a denial names each broken rule id and charter line. */
export function checkCall(h: Harness, call: ToolCall, ctx: RuleContext = {}): Decision {
  if (!h.tools.includes(call.tool)) return { allow: false, ruleIds: [`${h.role}.tools`], reason: `${h.role}.tools: ${call.tool} is not on the ${h.role} harness tool list` };
  const broken = h.rules.flatMap(r => {
    const v = r.check(call, ctx);
    return v.allow ? [] : [{ id: r.id, text: `${r.id} (${r.charter}): ${v.reason}` }];
  });
  return broken.length ? { allow: false, ruleIds: broken.map(b => b.id), reason: broken.map(b => b.text).join('; ') } : { allow: true };
}
