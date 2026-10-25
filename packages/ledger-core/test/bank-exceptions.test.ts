import { describe, expect, it } from 'vitest';
import { bankExceptionAcceptance, bankExceptionSnapshot, currentBankExceptions, isBankReconciliationTask, type BankExceptionAudit, type BankExceptionRow } from '../src/index';

const row: BankExceptionRow = {
  id: '42', subsidiaryId: '1', ym: '2026-09', bookedAt: '2026-09-18T12:00:00.000Z',
  amountMinor: '1498500', ccy: 'USD', description: 'Receipt needs remittance detail', counterparty: 'Brennan', matched: false,
};
const mutation: BankExceptionAudit = {
  id: '900', actorRole: 'advisor', action: 'approve_approve', targetTable: 'proposal', targetId: '2', detail: 'Posted bank match.', at: '2026-10-24T00:00:00.000Z',
};
const input = { periodYm: '2026-09', bankRows: [row], auditEvents: [mutation] };
const acceptance = (): BankExceptionAudit => ({
  id: '3', actorRole: 'cfo', action: 'accept_bank_exceptions', targetTable: 'period', targetId: '1',
  detail: JSON.stringify({ periodYm: input.periodYm, snapshot: bankExceptionSnapshot(input), reasonPlain: 'Awaiting remittance detail.' }),
  at: '2026-10-24T00:00:01.000Z',
});

describe('bank exceptions', () => {
  it('includes unmatched lines through the period across companies and currencies', () => {
    const previous = { ...row, id: '1', subsidiaryId: '2', ccy: 'GBP', ym: '2026-08' };
    const bankRows = [row, previous, { ...row, id: '2', matched: true }, { ...row, id: '3', ym: '2026-10' }];
    expect(currentBankExceptions({ periodYm: '2026-09', bankRows }).map(line => line.id)).toEqual(['1', '42']);
    expect(bankRows.map(line => line.id)).toEqual(['42', '1', '2', '3']);
  });

  it('recognizes only the CFO acceptance of the exact snapshot', () => {
    expect(bankExceptionAcceptance({ ...input, auditEvents: [mutation, acceptance()] })).toEqual({ accepted: true, reasonPlain: 'Awaiting remittance detail.', auditId: '3', at: '2026-10-24T00:00:01.000Z' });
    expect(bankExceptionAcceptance({ ...input, auditEvents: [mutation, { ...acceptance(), actorRole: 'advisor' }] })).toEqual({ accepted: false });
  });

  it.each([
    { field: 'id', value: '43' }, { field: 'subsidiaryId', value: '2' }, { field: 'ym', value: '2026-08' },
    { field: 'bookedAt', value: '2026-09-19T12:00:00.000Z' }, { field: 'amountMinor', value: '1' },
    { field: 'ccy', value: 'GBP' }, { field: 'description', value: 'Different receipt' }, { field: 'counterparty', value: 'Different payer' },
  ])('invalidates consent after $field changes', ({ field, value }) => {
    const bankRows = [{ ...row, [field]: value }];
    expect(bankExceptionAcceptance({ ...input, bankRows, auditEvents: [mutation, acceptance()] })).toEqual({ accepted: false });
  });

  it('does not resurrect consent after a new mutation restores the same bank rows at the same timestamp', () => {
    const reversed = { ...mutation, id: '1', action: 'cfo_reverse', targetTable: 'journal_entry' };
    expect(bankExceptionAcceptance({ ...input, auditEvents: [mutation, acceptance(), reversed] })).toEqual({ accepted: false });
  });

  it('does not invalidate consent merely because close workflow or commentary changes', () => {
    const request = { ...mutation, id: '1000', action: 'request_period_lock', targetTable: 'period' };
    const note = { ...request, id: '1001', action: 'post_agent_message', targetTable: 'agent_message' };
    expect(bankExceptionAcceptance({ ...input, auditEvents: [note, acceptance(), request, mutation] }).accepted).toBe(true);
  });

  it('fails closed for unreadable or empty acceptance evidence', () => {
    for (const detail of ['broken JSON', '{}', 'null', '[]', JSON.stringify({ periodYm: '2026-09', snapshot: bankExceptionSnapshot(input), reasonPlain: ' ' })]) {
      expect(bankExceptionAcceptance({ ...input, auditEvents: [mutation, { ...acceptance(), detail }] })).toEqual({ accepted: false });
    }
  });

  it('uses the bank task role and stable order or canonical title', () => {
    expect(isBankReconciliationTask({ ownerRole: 'bookkeeper', sortOrder: 1, title: 'Bank work' })).toBe(true);
    expect(isBankReconciliationTask({ ownerRole: 'bookkeeper', sortOrder: 9, title: 'Reconcile the bank' })).toBe(true);
    expect(isBankReconciliationTask({ ownerRole: 'bookkeeper', sortOrder: 2, title: 'Accrue expenses' })).toBe(false);
    expect(isBankReconciliationTask({ ownerRole: 'revenue', sortOrder: 1, title: 'Revenue' })).toBe(false);
  });
});
