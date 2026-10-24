import { describe, expect, it } from 'vitest';
import {
  allowanceProposal, dateMicros, detectMissingAccruals, eliminations, fxRevaluationPayload, icEliminationPayload, plainSummary, revaluation,
  specificReserveReasons,
} from '../src/index.js';
import type { BankTransaction, FxRevaluationPayload, IcEliminationPayload, PlainContext, ProposalPayload } from '../src/index.js';
import { ACCOUNTS, ACCRUED, ALLOW, BAD_DEBT, CASH, cr, dr, HOSTING, SUB } from './fixtures.js';
import * as G from './group.js';

const GROUP_LINES = G.groupLines();
const REVAL = fxRevaluationPayload(
  revaluation({ entity: G.UK_ENTITY, lines: GROUP_LINES, accountsById: G.ACCOUNTS_BY_ID, rates: G.RATES, ym: G.SEP, periodId: 9n, fxGainLossAccountId: G.A.ukFx.id }),
)!;
const ELIMS = eliminations({ entities: G.ENTITIES, accounts: G.ACCOUNTS, lines: GROUP_LINES, rates: G.RATES, reportingCcy: 'USD', ym: G.SEP, periodId: 9n });
const BALANCE_ELIM = icEliminationPayload(ELIMS.balance)!;
const ACTIVITY_ELIM = icEliminationPayload(ELIMS.activity)!;
const LOSS: FxRevaluationPayload = { ...REVAL, items: REVAL.items.map((i) => ({ ...i, deltaMinor: -i.deltaMinor })) };
const OWED_TO_US: FxRevaluationPayload = { ...REVAL, items: REVAL.items.map((i) => ({ ...i, txnBalanceMinor: -i.txnBalanceMinor })) };
const MIXED: FxRevaluationPayload = { ...REVAL, items: [REVAL.items[0]!, { ...REVAL.items[1]!, ccy: 'EUR' }] };
const TWO_WAY: IcEliminationPayload = {
  ...ACTIVITY_ELIM,
  pairs: [...ACTIVITY_ELIM.pairs, { ...ACTIVITY_ELIM.pairs[0]!, label: 'Royalties', sourceSubsidiaryId: G.UK, counterSubsidiaryId: G.US }],
};

const tx: BankTransaction = { id: 55n, bookedAt: dateMicros(2026, 9, 14), amountMinor: 125_000n, ccy: 'USD', description: 'INV 1042', counterparty: 'ACME CO', matched: false };
const ctx: PlainContext = {
  customers: new Map([[5n, 'Acme Co'], [6n, 'Initech Holdings']]),
  vendors: new Map([[7n, 'Northwind Hosting']]),
  accounts: ACCOUNTS,
  bankTxs: new Map([[55n, tx]]),
  periods: new Map([[9n, { year: 2026, month: 9 }]]),
  subsidiaries: new Map([
    [G.US, { name: 'Cafoo Inc', functionalCcy: 'USD' }],
    [G.UK, { name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: G.US }],
    [G.ELIM, { name: 'Group eliminations', functionalCcy: 'USD', parentId: G.US, isElimination: true }],
  ]),
};
const allowAccounts = { subsidiaryId: SUB, periodId: 9n, badDebtExpenseAccountId: BAD_DEBT.id, allowanceAccountId: ALLOW.id };

describe('plainSummary', () => {
  it('matches the reference allowance sentence', () => {
    const p = allowanceProposal({ customerId: 5n, openArMinor: 4_800_000n, tier: 'BLOCK', existingAllowanceMinor: 0n, accounts: allowAccounts }, specificReserveReasons.active_bankruptcy)!;
    expect(plainSummary(p, ctx)).toBe("Set aside $48,000 against Acme Co's unpaid invoices because their owner is in an active bankruptcy plan.");
  });

  const cases: [string, ProposalPayload][] = [
    ['allowance release', allowanceProposal({ customerId: 6n, openArMinor: 100_000n, tier: 'A', existingAllowanceMinor: 5_000n, accounts: allowAccounts }, 'their credit improved')!],
    ['general entry', { kind: 'journal_entry', subsidiaryId: SUB, periodId: 9n, memo: 'September hosting invoice.', lines: [dr(HOSTING.id, 123_456n), cr(CASH.id, 123_456n)] }],
    ['reversal', { kind: 'journal_entry', purpose: 'reversal', subsidiaryId: SUB, periodId: 9n, memo: 'Reversal of: x', lines: [dr(CASH.id, 5_000n), cr(HOSTING.id, 5_000n)] }],
    ['duplicate payment', { kind: 'journal_entry', purpose: 'duplicate_payment', subsidiaryId: SUB, periodId: 9n, memo: 'dup', lines: [dr(2n, 50_000n, { vendorId: 7n }), cr(CASH.id, 50_000n, { vendorId: 7n })] }],
    ['revenue recognition', { kind: 'journal_entry', purpose: 'revenue_recognition', subsidiaryId: SUB, periodId: 9n, memo: 'Recognize', lines: [dr(6n, 833_300n), cr(8n, 833_300n)] }],
    ['mixed currency entry', { kind: 'journal_entry', subsidiaryId: SUB, periodId: 9n, memo: 'EU hosting', lines: [dr(HOSTING.id, 10_000n, { ccy: 'EUR', fxRateE6: 1_100_000n }), cr(CASH.id, 11_000n)] }],
    ['accrual', detectMissingAccruals([{ id: 2n, vendorId: 7n, ym: { year: 2026, month: 9 }, amountMinor: 450_000n, dueAt: dateMicros(2026, 10, 30), status: 'open', externalRef: 'NW-2' }], { year: 2026, month: 9 }, { subsidiaryId: SUB, periodId: 9n, expenseAccountId: HOSTING.id, accruedLiabilitiesAccountId: ACCRUED.id })[0]!],
    ['bank match with transaction', { kind: 'bank_match', bankTxId: 55n, targetKind: 'invoice', targetId: 1042n, scoreBp: 9250, reasons: [], bucket: 'auto' }],
    ['bank match without transaction', { kind: 'bank_match', bankTxId: 56n, targetKind: 'bill', targetId: 3n, scoreBp: 6000, reasons: [], bucket: 'review' }],
    ['revenue schedule even', { kind: 'revenue_schedule', contractItemId: 11n, lines: Array.from({ length: 12 }, (_, i) => ({ contractItemId: 11n, ym: { year: 2026 + Math.floor((8 + i) / 12), month: ((8 + i) % 12) + 1 }, amountMinor: i === 11 ? 8_337n : 8_333n, recognized: false })) }],
    ['revenue schedule single month', { kind: 'revenue_schedule', contractItemId: 12n, lines: [{ contractItemId: 12n, ym: { year: 2026, month: 10 }, amountMinor: 3_003n, recognized: false }] }],
    ['credit decision terms', { kind: 'credit_decision', customerId: 5n, tier: 'B', paymentTermsDays: 30, summaryPlain: 'The owner pays on time and has no court records.' }],
    ['credit decision block', { kind: 'credit_decision', customerId: 99n, tier: 'BLOCK', paymentTermsDays: 0, summaryPlain: 'The owner is in an active bankruptcy plan.' }],
    ['vendor block', { kind: 'vendor_block', vendorId: 7n, reasonPlain: 'their bank details changed twice this week.' }],
    ['vendor verify', { kind: 'vendor_verify', vendorId: 7n, creditCheckIds: ['req_tu_7', 'req_ff_7'], reasonPlain: 'the owner passed identity and fraud checks.' }],
    ['fx revaluation gain', REVAL],
    ['fx revaluation loss', LOSS],
    ['fx revaluation owed to the subsidiary', OWED_TO_US],
    ['fx revaluation in two currencies', MIXED],
    ['balance elimination', BALANCE_ELIM],
    ['activity elimination', ACTIVITY_ELIM],
    ['activity elimination both ways', TWO_WAY],
  ];

  for (const [name, p] of cases) {
    it(name, () => {
      const s = plainSummary(p, ctx);
      expect(s).toMatchSnapshot();
      expect(s.endsWith('.')).toBe(true);
      expect(s).not.toMatch(/\.\.|\bdebit|\b(Dr|Cr)\b|journal|ledger/i);
      expect(s).not.toMatch(/\b(1000|1200|1250|2000|2100|2400|4000|6100|6900)\b/);
    });
  }

  it('speaks the plan sentences for the September consolidation', () => {
    expect(plainSummary(REVAL, ctx)).toBe("Restate the $245,000 Cafoo Ltd owes Cafoo Inc at September's closing rate, a £4,404.78 gain.");
    expect(plainSummary(BALANCE_ELIM, ctx)).toBe("Remove the $245,000 Cafoo Inc and Cafoo Ltd owe each other from the group's combined balance sheet; it reverses in October.");
    expect(plainSummary(ACTIVITY_ELIM, ctx)).toBe("Remove the $15,000 of service fees Cafoo Inc charged Cafoo Ltd in September from the group's combined results.");
  });

  it('names no counterparty when it cannot tell which company is meant', () => {
    const noFlags: PlainContext = { subsidiaries: new Map([[G.US, { name: 'Cafoo Inc', functionalCcy: 'USD' }], [G.UK, { name: 'Cafoo Ltd', functionalCcy: 'GBP' }], [G.ELIM, { name: 'Group eliminations', functionalCcy: 'USD' }]]) };
    expect(plainSummary(REVAL, noFlags)).toBe("Restate Cafoo Ltd's $245,000 of dollar balances at September's closing rate, a £4,404.78 gain.");
    expect(plainSummary(REVAL)).toBe("Restate subsidiary 2's $245,000 of dollar balances at September's closing rate, a £4,404.78 gain.");
    expect(plainSummary(BALANCE_ELIM)).toBe("Remove the $245,000 subsidiary 1 and subsidiary 2 owe each other from the group's combined balance sheet; it reverses in October.");
  });

  it('falls back to ids without context', () => {
    expect(plainSummary({ kind: 'vendor_block', vendorId: 7n, reasonPlain: '' })).toBe('Stop all payments to supplier 7.');
  });
});
