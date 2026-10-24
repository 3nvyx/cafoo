import { describe, expect, it } from 'vitest';
import { LedgerError, parseProposalPayload, serializeProposalPayload, toJsonPayload } from '../src/index.js';
import type { ProposalPayload } from '../src/index.js';
import { ALLOW, BAD_DEBT, cr, dr, HOSTING, ACCRUED } from './fixtures.js';

const samples: ProposalPayload[] = [
  { kind: 'journal_entry', subsidiaryId: 1n, periodId: 9n, memo: 'Reserve', purpose: 'allowance', reasonPlain: 'bankrupt', lines: [dr(BAD_DEBT.id, 9_007_199_254_740_993n, { customerId: 5n }), cr(ALLOW.id, 9_007_199_254_740_993n, { customerId: 5n, memo: 'x' })] },
  { kind: 'bank_match', bankTxId: 1n, targetKind: 'invoice', targetId: 1042n, scoreBp: 9200, reasons: ['amount matches exactly'], bucket: 'auto' },
  { kind: 'revenue_schedule', contractItemId: 11n, lines: [{ contractItemId: 11n, ym: { year: 2026, month: 9 }, amountMinor: 8_333n, recognized: false }] },
  { kind: 'credit_decision', customerId: 5n, tier: 'B', paymentTermsDays: 30, summaryPlain: 'Owner has solid credit.' },
  { kind: 'accrual', subsidiaryId: 1n, periodId: 9n, memo: 'Accrue', reversesInYm: { year: 2026, month: 10 }, billId: 2n, lines: [dr(HOSTING.id, 1n, { vendorId: 7n }), cr(ACCRUED.id, 1n, { vendorId: 7n })] },
  { kind: 'vendor_block', vendorId: 7n, reasonPlain: 'the vendor matched a sanctions list' },
  { kind: 'vendor_verify', vendorId: 7n, creditCheckIds: ['req_tu_7', 'req_ff_7'], reasonPlain: 'the owner passed identity and fraud checks' },
  { kind: 'vendor_verify', vendorId: 8n, creditCheckIds: ['req_tu_8'] },
  {
    kind: 'fx_revaluation', subsidiaryId: 2n, periodId: 9n, memo: 'Revalue', periodYm: { year: 2026, month: 9 }, rateYm: { year: 2026, month: 9 },
    items: [{ accountId: 205n, ccy: 'USD', txnBalanceMinor: -20_000_000n, closingRateE6: 781_250n, bookedFunctionalMinor: -16_000_000n, targetFunctionalMinor: -15_625_000n, deltaMinor: 375_000n }],
    lines: [dr(205n, 375_000n, { ccy: 'GBP' }), cr(210n, 375_000n, { ccy: 'GBP' })],
  },
  {
    kind: 'ic_elimination', subsidiaryId: 3n, periodId: 9n, memo: 'Remove', periodYm: { year: 2026, month: 9 }, basis: 'balance', reversesInYm: { year: 2026, month: 10 },
    pairs: [{ label: 'Loan', sourceSubsidiaryId: 1n, sourceAccountId: 103n, counterSubsidiaryId: 2n, counterAccountId: 205n, amountMinor: 20_000_000n, counterTranslatedMinor: 20_000_000n, differenceMinor: 0n }],
    lines: [dr(304n, 20_000_000n), cr(302n, 20_000_000n)],
  },
  {
    kind: 'ic_elimination', subsidiaryId: 3n, periodId: 9n, memo: 'Remove fees', periodYm: { year: 2026, month: 9 }, basis: 'activity',
    pairs: [{ label: 'Service fees', sourceSubsidiaryId: 1n, sourceAccountId: 106n, counterSubsidiaryId: 2n, counterAccountId: 207n, amountMinor: 1_500_000n, counterTranslatedMinor: 1_500_001n, differenceMinor: -1n }],
    lines: [dr(305n, 1_500_000n), cr(306n, 1_500_000n)],
  },
];

describe('proposal payload JSON', () => {
  it('round-trips every kind losslessly, including values beyond 2^53', () => {
    for (const p of samples) {
      const text = serializeProposalPayload(p);
      expect(text).not.toMatch(/\d n/);
      expect(parseProposalPayload(text)).toEqual(p);
      expect(parseProposalPayload(JSON.parse(text))).toEqual(p);
    }
  });

  it('money and ids travel as strings', () => {
    const j = toJsonPayload(samples[0]!) as { lines: { debitMinor: unknown; accountId: unknown }[] };
    expect(j.lines[0]!.debitMinor).toBe('9007199254740993');
    expect(j.lines[0]!.accountId).toBe('10');
  });

  it('serialization is stable', () => {
    expect(serializeProposalPayload(samples[3]!)).toBe('{"kind":"credit_decision","customerId":"5","tier":"B","paymentTermsDays":30,"summaryPlain":"Owner has solid credit."}');
  });

  it('consolidation kinds enforce basis, reversal month and non-empty lists', () => {
    const elim = JSON.parse(serializeProposalPayload(samples[9]!)) as Record<string, unknown>;
    const fees = JSON.parse(serializeProposalPayload(samples[10]!)) as Record<string, unknown>;
    const reval = JSON.parse(serializeProposalPayload(samples[8]!)) as Record<string, unknown>;
    expect(() => parseProposalPayload({ ...elim, reversesInYm: undefined })).toThrow('"reversesInYm" is required when basis is balance');
    expect(() => parseProposalPayload({ ...fees, reversesInYm: { year: 2026, month: 10 } })).toThrow('"reversesInYm" must be left out when basis is activity');
    expect(() => parseProposalPayload({ ...elim, basis: 'cumulative' })).toThrow('"basis" must be one of balance, activity');
    expect(() => parseProposalPayload({ ...elim, pairs: [] })).toThrow('"pairs" must list at least one intercompany pair');
    expect(() => parseProposalPayload({ ...reval, items: [] })).toThrow('"items" must list at least one restated balance');
    expect(() => parseProposalPayload({ ...reval, items: [{ accountId: '1', ccy: 'USD', txnBalanceMinor: 5 }] })).toThrow(LedgerError);
    expect(() => parseProposalPayload({ ...reval, rateYm: '2026-09' })).toThrow('"rateYm" must be an object');
  });

  it('rejects malformed payloads with plain messages', () => {
    const bad: unknown[] = [
      'not json',
      '[]',
      { kind: 'wire_transfer' },
      { kind: 'vendor_block', vendorId: 7, reasonPlain: 'x' },
      { kind: 'vendor_block', vendorId: '7.5', reasonPlain: 'x' },
      { kind: 'vendor_verify', vendorId: '7', creditCheckIds: [] },
      { kind: 'vendor_verify', vendorId: '7', creditCheckIds: [''] },
      { kind: 'vendor_verify', vendorId: '7', creditCheckIds: [42] },
      { kind: 'vendor_verify', vendorId: '7' },
      { kind: 'credit_decision', customerId: '1', tier: 'Z', paymentTermsDays: 30, summaryPlain: '' },
      { kind: 'credit_decision', customerId: '1', tier: 'A', paymentTermsDays: -1, summaryPlain: '' },
      { kind: 'bank_match', bankTxId: '1', targetKind: 'invoice', targetId: '1', scoreBp: 10001, reasons: [], bucket: 'auto' },
      { kind: 'accrual', subsidiaryId: '1', periodId: '1', memo: '', lines: [], reversesInYm: { year: 2026, month: 13 } },
      { kind: 'journal_entry', subsidiaryId: '1', periodId: '1', memo: '', lines: [{ accountId: '1' }] },
    ];
    for (const b of bad) expect(() => parseProposalPayload(b), JSON.stringify(b)).toThrow(LedgerError);
    expect(() => parseProposalPayload({ kind: 'vendor_block', vendorId: 7, reasonPlain: 'x' })).toThrow('"vendorId" must be a whole number written as a string');
  });
});
