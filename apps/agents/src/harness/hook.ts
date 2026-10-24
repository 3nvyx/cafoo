/**
 * Tool hook built from the harnesses. On PreToolUse: first the cross-role server gate (no role calls another
 * role's tool server), then the calling agent's allowlist and charter rules, from the harness `resolve` returns
 * (the built-in harnesses unless a published charter is passed in). A denial carries the rule id and the
 * reason so the agent can correct the call. On PostToolUse a call the gate let through joins its role's history
 * only if the tool succeeded, so rules that need history never rely on a call that failed in the tool.
 * Any error while judging (a stale cache, a broken context) denies the call: the gate fails closed.
 * Register the same callback for PreToolUse, PostToolUse and PostToolUseFailure.
 */
import type { HookCallback, HookInput, PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { checkCall, harnessFor, WORKERS } from './index';
import { obj, serverOf } from './rules';
import type { Harness, RuleContext, ToolCall } from './types';

export interface HarnessGateOptions {
  /** Fresh facts for each call (Proposal status, account codes). History is added by the gate. */
  context?: () => Omit<RuleContext, 'history'>;
  onDeny?: (agent: string, tool: string, reason: string) => void;
  /**
   * The harness that judges an agent type (undefined: the root query, the Advisor). Defaults to harnessFor, the
   * built-in harnesses; the live close passes activeHarnessResolver(cast.advisor) so a published charter applies.
   */
  resolve?: (agentType: string | undefined) => Harness | undefined;
}

/** Defensive only: with SDK 0.3.309 an MCP result with isError is raised as PostToolUseFailure and never reaches PostToolUse. */
const failed = (response: unknown) => obj(response).isError === true;

const deny = (why: string): SyncHookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });

/** The cross-role server gate, unchanged from the inline roleGate it replaces. */
export function serverGate(tool: string, agent: string | undefined): string | undefined {
  const server = serverOf(tool);
  if (server === 'advisor' && agent) return `Only the Advisor may use advisor tools; you are ${agent}.`;
  if ((WORKERS as readonly string[]).includes(server ?? '') && agent !== server) return `Only the ${server} agent may use ${server} tools${agent ? `; you are ${agent}` : ''}.`;
  return undefined;
}

export function harnessGate(opts: HarnessGateOptions = {}): HookCallback {
  const resolve = opts.resolve ?? harnessFor;
  // Keyed by role, not agent id: the Advisor may start the same worker more than once in one close.
  const history = new Map<string, ToolCall[]>();
  /** Allowed calls waiting for their result, by tool use id. */
  const pending = new Map<string, { role: string; call: ToolCall }>();
  /** Calls that never got a result (an interrupted turn) are dropped oldest first past this many. */
  const MAX_PENDING = 256;
  const settle = (input: HookInput) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return;
    const p = pending.get(input.tool_use_id);
    pending.delete(input.tool_use_id);
    if (p && input.hook_event_name === 'PostToolUse' && !failed(input.tool_response)) history.set(p.role, [...(history.get(p.role) ?? []), p.call]);
  };
  return async input => {
    if (input.hook_event_name !== 'PreToolUse') {
      settle(input);
      return {};
    }
    const pre = input as PreToolUseHookInput;
    const agent = pre.agent_type;
    const refuse = (why: string) => {
      try {
        opts.onDeny?.(agent ?? 'advisor', pre.tool_name, why);
      } catch {
        /* reporting is best effort */
      }
      return deny(why);
    };
    try {
      const crossRole = serverGate(pre.tool_name, agent);
      if (crossRole) return refuse(crossRole);
      const h = resolve(agent);
      if (!h) return refuse(`No harness for agent type ${agent}; only the Advisor and the ${WORKERS.join(', ')} agents may use these tools.`);
      const call: ToolCall = { tool: pre.tool_name, input: obj(pre.tool_input) };
      const seen = history.get(h.role) ?? [];
      const d = checkCall(h, call, { ...opts.context?.(), history: seen });
      if (!d.allow) return refuse(`Denied by the ${h.role} harness: ${d.reason}`);
      pending.set(pre.tool_use_id, { role: h.role, call });
      for (const id of pending.keys()) {
        if (pending.size <= MAX_PENDING) break;
        pending.delete(id);
      }
      return {};
    } catch (e) {
      return refuse(`Denied: the harness gate could not judge this call (${(e as Error)?.message ?? String(e)}); try again.`);
    }
  };
}
