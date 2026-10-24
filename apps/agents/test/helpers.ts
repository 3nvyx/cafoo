import { describe, expect, it } from 'vitest';
import type { Harness, RuleContext, ToolCall } from '../src/harness';

export interface Case {
  call: ToolCall;
  ctx?: RuleContext;
  /** For deny cases: a pattern the reason must match. */
  why?: RegExp;
}

export const call = (tool: string, input: Record<string, unknown> = {}): ToolCall => ({ tool, input });

/**
 * One allow and one deny case at least for every rule of a harness; fails if a rule has no cases or a case names a
 * rule the harness does not have.
 */
export function ruleSuite(h: Harness, table: Record<string, { allow: Case[]; deny: Case[] }>) {
  describe(`${h.role} harness rules`, () => {
    it('has allow and deny cases for every rule', () => {
      expect(Object.keys(table).sort()).toEqual(h.rules.map(r => r.id).sort());
      for (const [id, t] of Object.entries(table)) {
        expect(t.allow.length, `${id} allow cases`).toBeGreaterThan(0);
        expect(t.deny.length, `${id} deny cases`).toBeGreaterThan(0);
      }
    });
    for (const r of h.rules) {
      const t = table[r.id];
      if (!t) continue;
      t.allow.forEach((c, i) => {
        it(`${r.id} allows #${i + 1} (${c.call.tool})`, () => {
          expect(r.check(c.call, c.ctx ?? {})).toEqual({ allow: true });
        });
      });
      t.deny.forEach((c, i) => {
        it(`${r.id} denies #${i + 1} (${c.call.tool})`, () => {
          const v = r.check(c.call, c.ctx ?? {});
          expect(v.allow).toBe(false);
          if (!v.allow && c.why) expect(v.reason).toMatch(c.why);
        });
      });
    }
  });
}
