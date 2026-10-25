import { describe, expect, it } from 'vitest';
import {
  closeMonthLabel, closeOrderRefusal, closeTag, consolidationDueRefusal, earlierUnlockedMonths, isConsolidationKind, isGroup,
  type EliminationDue, type RevaluationDue,
} from '../src/index.js';

const periods = (s: Record<string, string>) => Object.entries(s).map(([ym, status]) => ({ ym, status }));

describe('close order', () => {
  it('reads statuses and kinds as the module and the client bindings write them', () => {
    expect(closeTag('AwaitingCfo')).toBe('awaiting_cfo');
    expect(closeTag({ tag: 'SentBack' })).toBe('sent_back');
    expect(closeTag({ tag: 'awaiting_cfo' })).toBe('awaiting_cfo');
    expect(isConsolidationKind({ tag: 'FxRevaluation' })).toBe(true);
    expect(isConsolidationKind('ic_elimination')).toBe(true);
    expect(isConsolidationKind('journal_entry')).toBe(false);
    expect(closeMonthLabel('2026-09')).toBe('September 2026');
    expect(closeMonthLabel('not a month')).toBe('not a month');
  });

  it('lets a month start and lock once every earlier month is locked, whatever the later months are', () => {
    const p = periods({ '2026-07': 'closed', '2026-08': 'closed', '2026-09': 'open', '2026-10': 'open' });
    expect(earlierUnlockedMonths(p, '2026-09')).toEqual([]);
    for (const action of ['start', 'request_lock', 'lock'] as const) expect(closeOrderRefusal(p, '2026-09', action)).toBeUndefined();
    expect(closeOrderRefusal(periods({ '2026-09': 'Open' }), '2026-09', 'start')).toBeUndefined();
  });

  it('refuses a later month while an earlier one is open or only waiting for its lock, naming the first to lock', () => {
    const p = periods({ '2026-07': 'closed', '2026-08': 'open', '2026-09': 'Closing', '2026-10': 'open' });
    expect(closeOrderRefusal(p, '2026-09', 'start')).toBe('The September 2026 close cannot start while August 2026 is not locked: months close in order. Lock August 2026 first.');
    expect(closeOrderRefusal(p, '2026-09', 'lock')).toBe('September 2026 cannot be locked while August 2026 is not locked: months close in order. Lock August 2026 first.');
    expect(closeOrderRefusal(p, '2026-10', 'request_lock')).toBe('The Advisor cannot ask to lock October 2026 while August 2026 and September 2026 are not locked: months close in order. Lock August 2026 first.');
    expect(closeOrderRefusal(periods({ '2026-06': 'open', '2026-07': 'open', '2026-08': 'open', '2026-09': 'open' }), '2026-09', 'lock')).toMatch(/while June 2026, July 2026 and August 2026 are not locked.*Lock June 2026 first\.$/);
  });

  describe('a group month locks only once consolidated', () => {
    const group = [{ isElimination: false }, { isElimination: false }, { isElimination: true }];
    const loan = (sourceMinor: bigint, eliminatedMinor: bigint): EliminationDue => ({ label: 'Loan', basis: 'balance', sourceMinor, eliminatedMinor, reportingCcy: 'USD' });
    const fees = (sourceMinor: bigint, eliminatedMinor: bigint): EliminationDue => ({ label: 'Service fees', basis: 'activity', sourceMinor, eliminatedMinor, reportingCcy: 'USD' });
    const ukLoan = (r: Partial<RevaluationDue>): RevaluationDue => ({ company: 'Cafoo Ltd', accountCode: '2950-UK', ccy: 'USD', functionalCcy: 'GBP', ...r });

    it('knows a group month: two or more trading companies and an elimination company', () => {
      expect(isGroup(group)).toBe(true);
      expect(isGroup([{ isElimination: false }, { isElimination: true }])).toBe(false);
      expect(isGroup([{ isElimination: false }, { isElimination: false }])).toBe(false);
    });

    it('lets a month with nothing to consolidate lock, and any month that is not a group month', () => {
      expect(consolidationDueRefusal(group, { revaluations: [], eliminations: [] }, '2026-09', 'lock')).toBeUndefined();
      // Eliminated pairs cancel what the trading companies show.
      expect(consolidationDueRefusal(group, { revaluations: [ukLoan({ deltaMinor: 0n })], eliminations: [loan(20_000_000n, -20_000_000n), fees(-1_500_000n, 1_500_000n)] }, '2026-09', 'lock')).toBeUndefined();
      const standing = { revaluations: [ukLoan({ deltaMinor: 375_000n })], eliminations: [loan(20_000_000n, 0n)] };
      expect(consolidationDueRefusal([{ isElimination: false }], standing, '2026-09', 'lock')).toBeUndefined();
      expect(consolidationDueRefusal([{ isElimination: false }, { isElimination: false }], standing, '2026-09', 'lock')).toBeUndefined();
    });

    it('refuses before the revaluation and eliminations, saying what is still standing', () => {
      const due = { revaluations: [ukLoan({ deltaMinor: 375_000n })], eliminations: [loan(20_000_000n, 0n), fees(-1_500_000n, 0n)] };
      expect(consolidationDueRefusal(group, due, '2026-09', 'request_lock')).toBe(
        "The Advisor cannot ask to lock September 2026 until its consolidation matches the books: Cafoo Ltd's USD balance on 2950-UK is £3,750.00 off the closing rate, so revalue it; the loan pair through September 2026 ($200,000.00) is not eliminated, so eliminate it; the service fees pair in September 2026 ($15,000.00) is not eliminated, so eliminate it. The Consolidation agent proposes these from the posted ledger."
      );
      expect(consolidationDueRefusal(group, { revaluations: [ukLoan({ deltaMinor: -1n })], eliminations: [] }, '2026-09', 'lock')).toMatch(/^September 2026 cannot be locked until its consolidation matches the books: .* is £0\.01 off the closing rate, so revalue it\./);
    });

    it('refuses a revaluation it cannot compute: no closing rate, or one account in two currencies', () => {
      expect(consolidationDueRefusal(group, { revaluations: [ukLoan({ problem: 'no_closing_rate' })], eliminations: [] }, '2026-09', 'lock')).toMatch(/2950-UK cannot be revalued because no USD\/GBP closing rate is recorded for September 2026, so record it and revalue/);
      expect(consolidationDueRefusal(group, { revaluations: [ukLoan({ ccy: 'EUR and USD', problem: 'several_currencies' })], eliminations: [] }, '2026-09', 'lock')).toMatch(/2950-UK holds EUR and USD balances, so split it into one account per currency/);
    });

    it('catches a correction posted after the consolidation, which makes it stale', () => {
      expect(consolidationDueRefusal(group, { revaluations: [ukLoan({ deltaMinor: 12_345n, revalued: true })], eliminations: [] }, '2026-09', 'lock')).toMatch(
        /Cafoo Ltd was revalued for September 2026, but its USD balance on 2950-UK is £123\.45 off the closing rate, so something posted after it: revalue it again\./
      );
      // A CFO reversal of part of the loan after the balance elimination posted.
      expect(consolidationDueRefusal(group, { revaluations: [], eliminations: [loan(19_000_000n, -20_000_000n)] }, '2026-09', 'lock')).toBe(
        'September 2026 cannot be locked until its consolidation matches the books: the loan pair through September 2026 now shows $190,000.00 but the elimination posted removed $200,000.00, so something posted after it: reverse that elimination and eliminate again. The Consolidation agent proposes these from the posted ledger.'
      );
      // A balance elimination needs the month it reverses in, open.
      expect(consolidationDueRefusal(group, { revaluations: [], eliminations: [{ ...loan(20_000_000n, 0n), reversal: { ym: '2026-10', problem: 'missing' } }] }, '2026-09', 'lock')).toMatch(
        /the loan pair through September 2026 \(\$200,000\.00\) is not eliminated, so first add October 2026, where the elimination reverses \(the books do not have it yet\), then eliminate it\./
      );
      expect(consolidationDueRefusal(group, { revaluations: [], eliminations: [{ ...loan(19_000_000n, -20_000_000n), reversal: { ym: '2026-10', problem: 'locked' } }] }, '2026-09', 'lock')).toMatch(
        /so something posted after it: first reopen October 2026, where the elimination reverses \(it is locked\), then reverse that elimination and eliminate again\./
      );
      // A currency with no sign is written after the amount.
      expect(consolidationDueRefusal(group, { revaluations: [ukLoan({ ccy: 'JPY', functionalCcy: 'CHF', deltaMinor: 100n })], eliminations: [] }, '2026-09', 'lock')).toMatch(/is 1\.00 CHF off the closing rate/);
    });
  });
});
