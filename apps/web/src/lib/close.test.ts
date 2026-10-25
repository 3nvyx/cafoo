import { describe, expect, it } from 'vitest';
import type { AuditEvent, BankTransaction } from './data/types';
import { bankExceptionState, lockGate } from './close';

function books() {
	const bankRows: BankTransaction[] = [{ id: '1', subsidiaryId: 'us', ym: '2026-09', bookedAt: '2026-09-15T12:00:00.000Z', amountMinor: '5000', ccy: 'USD', description: 'Unmatched receipt', counterparty: 'Customer', matched: false }];
	const events: AuditEvent[] = [];
	return {
		periods: () => [{ id: '2026-09', subsidiaryId: 'us', year: 2026, month: 9, status: 'closing' as const }],
		connection: () => ({ ledger: 'live' as const, agents: 'online' as const, closes: [{ periodYm: '2026-09', status: 'done' as const }] }),
		closeTasks: () => [{ id: 'bank', periodId: '2026-09', title: 'Reconcile the bank feed', ownerRole: 'bookkeeper' as const, status: 'done' as const, order: 1, proposalIds: [] }],
		proposals: () => [],
		agentMessages: () => [],
		bankTransactions: () => bankRows,
		auditEvents: () => events,
		bankRows,
		events
	};
}

describe('CFO close readiness', () => {
	it('refuses a legacy lock request while bank exceptions lack explicit CFO acceptance', () => {
		const gate = lockGate(books(), '2026-09');
		expect(gate.canLock).toBe(false);
		expect(gate.blocker).toMatch(/unmatched.*accept/i);
	});

	it('allows the exact accepted bank exceptions, then blocks a changed bank line', () => {
		const db = books();
		const snapshot = bankExceptionState(db, '2026-09').snapshot;
		db.events.push({
			id: 'ae1', actorRole: 'cfo', action: 'accept_bank_exceptions', targetTable: 'period', targetId: '1',
			detailJson: JSON.stringify({ periodYm: '2026-09', snapshot, reasonPlain: 'Research the remittance next month.' }), at: '2026-10-24T00:00:00.000Z'
		});
		expect(lockGate(db, '2026-09').canLock).toBe(true);
		expect(db.bankRows[0].matched).toBe(false);
		db.bankRows[0].amountMinor = '6000';
		expect(lockGate(db, '2026-09').canLock).toBe(false);
	});

	it('lets the CFO lock an open month once the exceptions are accepted, though the bank task stays in progress', () => {
		const db = books();
		const open = { ...db, periods: () => [{ ...db.periods()[0], status: 'open' as const }], closeTasks: () => [{ ...db.closeTasks()[0], status: 'in_progress' as const }] };
		expect(lockGate(open, '2026-09').canLock).toBe(false);
		const snapshot = bankExceptionState(open, '2026-09').snapshot;
		db.events.push({
			id: 'ae1', actorRole: 'cfo', action: 'accept_bank_exceptions', targetTable: 'period', targetId: '1',
			detailJson: JSON.stringify({ periodYm: '2026-09', snapshot, reasonPlain: 'Research the remittance next month.' }), at: '2026-10-24T00:00:00.000Z'
		});
		const gate = lockGate(open, '2026-09');
		expect(gate).toMatchObject({ canLock: true, pendingTasks: 0, blocker: '' });
	});
});
