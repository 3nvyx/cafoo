import { applyBp, FX_SCALE } from './money.js';
import type { JournalEntryInput, JournalEntryPayload, RiskTier } from './types.js';

const RATE_BP: Readonly<Record<RiskTier, number>> = { A: 100, B: 500, C: 1000, D: 5000, BLOCK: 10000 };

/** Expected-loss reserve rate: A 1%, B 5%, C 10%, D 50%, BLOCK 100% (specific reserve). */
export function allowanceRateBp(tier: RiskTier): number {
  return RATE_BP[tier];
}

/** BLOCK is a specific (100%) reserve rather than a pooled rate. */
export function isSpecificReserve(tier: RiskTier): boolean {
  return tier === 'BLOCK';
}

export type SpecificReserveReason =
  | 'active_bankruptcy'
  | 'fraud_alert'
  | 'identity_mismatch'
  | 'judgment_or_lien'
  | 'sanctions_match'
  | 'deceased_guarantor';

/**
 * Plain-English clauses that justify a 100% specific reserve. Written to follow "because".
 * Example: "because their owner is in an active bankruptcy plan".
 */
export const specificReserveReasons: Readonly<Record<SpecificReserveReason, string>> = {
  active_bankruptcy: 'their owner is in an active bankruptcy plan',
  fraud_alert: 'their owner’s credit file carries a fraud alert',
  identity_mismatch: 'we could not confirm their owner’s identity',
  judgment_or_lien: 'there is an unpaid court judgment or lien against them',
  sanctions_match: 'they matched a government sanctions list',
  deceased_guarantor: 'their owner is reported as deceased',
};

/** Target reserve = open AR (floored at 0) * rate, rounded half away from zero. */
export function targetAllowanceMinor(openArMinor: bigint, tier: RiskTier): bigint {
  return applyBp(openArMinor > 0n ? openArMinor : 0n, allowanceRateBp(tier));
}

export interface AllowanceAccounts {
  subsidiaryId: bigint;
  periodId: bigint;
  badDebtExpenseAccountId: bigint;
  allowanceAccountId: bigint;
  ccy?: string;
  fxRateE6?: bigint;
}

export interface AllowanceInput {
  customerId: bigint;
  openArMinor: bigint;
  tier: RiskTier;
  existingAllowanceMinor: bigint;
  accounts: AllowanceAccounts;
}

/**
 * Entry for the change in reserve only. Increase: Dr Bad Debt Expense / Cr Allowance.
 * Decrease: Dr Allowance / Cr Bad Debt Expense. Null when the reserve is already right.
 */
export function allowanceEntry(input: AllowanceInput): JournalEntryInput | null {
  const target = targetAllowanceMinor(input.openArMinor, input.tier);
  const delta = target - input.existingAllowanceMinor;
  if (delta === 0n) return null;
  const a = input.accounts;
  const ccy = a.ccy ?? 'USD';
  const fxRateE6 = a.fxRateE6 ?? FX_SCALE;
  const amt = delta > 0n ? delta : -delta;
  const [dr, cr] = delta > 0n ? [a.badDebtExpenseAccountId, a.allowanceAccountId] : [a.allowanceAccountId, a.badDebtExpenseAccountId];
  return {
    subsidiaryId: a.subsidiaryId,
    periodId: a.periodId,
    memo: `${delta > 0n ? 'Increase' : 'Release'} allowance for customer ${input.customerId} (tier ${input.tier}, ${allowanceRateBp(input.tier) / 100}%)`,
    lines: [
      { accountId: dr, debitMinor: amt, creditMinor: 0n, ccy, fxRateE6, customerId: input.customerId },
      { accountId: cr, debitMinor: 0n, creditMinor: amt, ccy, fxRateE6, customerId: input.customerId },
    ],
  };
}

/** allowanceEntry wrapped as a journal_entry proposal payload with purpose 'allowance'. */
export function allowanceProposal(input: AllowanceInput, reasonPlain?: string): JournalEntryPayload | null {
  const e = allowanceEntry(input);
  if (!e) return null;
  const p: JournalEntryPayload = { kind: 'journal_entry', purpose: 'allowance', ...e };
  if (reasonPlain !== undefined) p.reasonPlain = reasonPlain;
  return p;
}
