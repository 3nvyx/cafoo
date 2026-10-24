import { describe, expect, it } from 'vitest';
import { overCharterCap } from '../src/scripted/close';

describe("a published charter's amount cap in the scripted close", () => {
  const cap = 1_000_000n;
  it('leaves entries, accruals, schedules, revaluations and eliminations over the cap for a human', () => {
    for (const kind of ['journal_entry', 'accrual', 'revenue_schedule', 'fx_revaluation', 'ic_elimination']) {
      expect(overCharterCap(kind, 4_860_000n, cap), kind).toBe(true);
      expect(overCharterCap(kind, cap, cap), `${kind} at the cap`).toBe(false);
    }
  });
  it('never caps bank matches, vendor kinds or credit decisions, which the module measures differently', () => {
    for (const kind of ['bank_match', 'vendor_block', 'vendor_verify', 'credit_decision']) expect(overCharterCap(kind, 4_860_000n, cap), kind).toBe(false);
  });
  it('caps nothing without a cap', () => {
    expect(overCharterCap('journal_entry', 99_999_999n, undefined)).toBe(false);
  });
});
