import { describe, expect, it } from 'vitest';
import { allowanceEntry, allowanceProposal, allowanceRateBp, assertBalanced, specificReserveReasons, targetAllowanceMinor } from '../src/index.js';
import type { RiskTier } from '../src/index.js';
import { ALLOW, BAD_DEBT, SUB } from './fixtures.js';

const accounts = { subsidiaryId: SUB, periodId: 9n, badDebtExpenseAccountId: BAD_DEBT.id, allowanceAccountId: ALLOW.id };

describe('allowance', () => {
  it('rates by tier', () => {
    const tiers: RiskTier[] = ['A', 'B', 'C', 'D', 'BLOCK'];
    expect(tiers.map(allowanceRateBp)).toEqual([100, 500, 1000, 5000, 10000]);
    expect(specificReserveReasons.active_bankruptcy).toBe('their owner is in an active bankruptcy plan');
  });

  it('books only the increase', () => {
    const e = allowanceEntry({ customerId: 5n, openArMinor: 1_000_000n, tier: 'C', existingAllowanceMinor: 40_000n, accounts })!;
    expect(e.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor, l.customerId])).toEqual([
      [BAD_DEBT.id, 60_000n, 0n, 5n],
      [ALLOW.id, 0n, 60_000n, 5n],
    ]);
    assertBalanced(e.lines);
  });

  it('releases when the reserve is too high', () => {
    const e = allowanceEntry({ customerId: 5n, openArMinor: 1_000_000n, tier: 'A', existingAllowanceMinor: 50_000n, accounts })!;
    expect(e.memo).toMatch(/^Release/);
    expect(e.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      [ALLOW.id, 40_000n, 0n],
      [BAD_DEBT.id, 0n, 40_000n],
    ]);
  });

  it('returns null when the delta is zero', () => {
    expect(allowanceEntry({ customerId: 5n, openArMinor: 4_800_000n, tier: 'BLOCK', existingAllowanceMinor: 4_800_000n, accounts })).toBeNull();
    expect(allowanceProposal({ customerId: 5n, openArMinor: 0n, tier: 'D', existingAllowanceMinor: 0n, accounts })).toBeNull();
  });

  it('edge: rounding half away from zero and negative AR floors at zero', () => {
    expect(targetAllowanceMinor(12_345n, 'B')).toBe(617n);
    expect(targetAllowanceMinor(-10_000n, 'D')).toBe(0n);
    const e = allowanceEntry({ customerId: 5n, openArMinor: -10_000n, tier: 'D', existingAllowanceMinor: 300n, accounts })!;
    expect(e.lines[0]!.accountId).toBe(ALLOW.id);
    expect(e.lines[0]!.debitMinor).toBe(300n);
  });

  it('wraps as a journal_entry proposal with purpose allowance', () => {
    const p = allowanceProposal({ customerId: 5n, openArMinor: 4_800_000n, tier: 'BLOCK', existingAllowanceMinor: 0n, accounts }, specificReserveReasons.active_bankruptcy)!;
    expect(p.kind).toBe('journal_entry');
    expect(p.purpose).toBe('allowance');
    expect(p.lines[0]!.debitMinor).toBe(4_800_000n);
  });
});
