import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, BankTransaction } from './data/types';
import { bankExceptionState, lockGate } from './close';
import { MockDataSource } from './data/mock/mock-source.svelte';

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
	it('holds a month back while an earlier month is not locked, after its own bank-exception blocker', () => {
		const db = books();
		const later = { ...db, periods: () => [{ id: '2026-08', subsidiaryId: 'us', year: 2026, month: 8, status: 'open' as const }, ...db.periods()] };
		// The unaccepted bank exception still shows its own blocker first.
		expect(lockGate(later, '2026-09')).toMatchObject({ canLock: false, blocker: expect.stringMatching(/unmatched.*accept/i) });
		const snapshot = bankExceptionState(later, '2026-09').snapshot;
		db.events.push({
			id: 'ae1', actorRole: 'cfo', action: 'accept_bank_exceptions', targetTable: 'period', targetId: '1',
			detailJson: JSON.stringify({ periodYm: '2026-09', snapshot, reasonPlain: 'Research the remittance next month.' }), at: '2026-10-24T00:00:00.000Z'
		});
		expect(lockGate(later, '2026-09')).toMatchObject({
			canLock: false,
			blocker: 'September 2026 cannot be locked while August 2026 is not locked: months close in order. Lock August 2026 first.'
		});
		expect(lockGate(db, '2026-09').canLock).toBe(true);
	});
});

describe('the Demo close', () => {
	let ds: MockDataSource;
	beforeEach(() => {
		vi.useFakeTimers();
		ds = new MockDataSource();
	});
	afterEach(() => vi.useRealTimers());

	const of = (ym: string) => ds.proposals().filter((p) => p.periodId === ym);
	const consolidation = () => of('2026-09').filter((p) => p.proposerRole === 'consolidation');
	const run = async (ms: number) => void (await vi.advanceTimersByTimeAsync(ms));

	it('replays its recorded close for September 2026 only', async () => {
		await ds.unlockPeriod('2026-08', 'Reopen for a late invoice');
		await expect(ds.startClose('2026-08')).rejects.toThrow('Demo mode has a recorded close for September 2026 only, so it cannot close August 2026. Connect the live ledger and agents to close other months.');
		await run(30_000);
		expect(of('2026-08').filter((p) => p.status !== 'amended')).toEqual([]);
		expect(ds.connection().closes).toEqual([]);
	});

	it('starts and locks a month only once every earlier month is locked, and says so on the checklist', async () => {
		await ds.unlockPeriod('2026-08', 'Reopen for a late invoice');
		const why = 'while August 2026 is not locked: months close in order. Lock August 2026 first.';
		await expect(ds.startClose('2026-09')).rejects.toThrow(`The September 2026 close cannot start ${why}`);
		await expect(ds.lockPeriod('2026-09')).rejects.toThrow(`September 2026 cannot be locked ${why}`);
		expect(lockGate(ds, '2026-09')).toMatchObject({ canLock: false, blocker: `September 2026 cannot be locked ${why}` });
		await run(30_000);
		expect(ds.connection().closes).toEqual([]);
	});

	it('consolidates during the close and asks for the lock once the CFO has decided everything', async () => {
		await ds.startClose('2026-09');
		await run(24_000);
		expect(ds.connection().closes[0]?.status).toBe('done');
		expect(consolidation().map((p) => `${p.id} ${p.status}`)).toEqual(['pr-c1 approved', 'pr-c2 awaiting_cfo', 'pr-c3 awaiting_cfo']);
		const waiting = of('2026-09').filter((p) => p.status === 'awaiting_cfo').map((p) => p.id);
		expect(waiting).toEqual(expect.arrayContaining(['pr-10', 'pr-11', 'pr-13', 'pr-c2', 'pr-c3']));
		for (const id of waiting) await ds.cfoConfirm(id);
		expect(ds.periods().find((p) => p.id === '2026-09')?.status).toBe('open');
		const bank = bankExceptionState(ds, '2026-09');
		await ds.acceptBankExceptions('2026-09', bank.snapshot, 'Research the remittances next month.');
		expect(ds.periods().find((p) => p.id === '2026-09')?.status).toBe('closing');
		await ds.lockPeriod('2026-09');
		expect(ds.periods().find((p) => p.id === '2026-09')?.status).toBe('closed');
	});

	it('asks for the lock once an earlier month unlocked mid-close is locked again', async () => {
		await ds.startClose('2026-09');
		await run(24_000);
		await ds.unlockPeriod('2026-08', 'A late invoice');
		for (const id of ['pr-10', 'pr-11', 'pr-13', 'pr-c2', 'pr-c3']) await ds.cfoConfirm(id);
		await ds.acceptBankExceptions('2026-09', bankExceptionState(ds, '2026-09').snapshot, 'Research the remittances next month.');
		expect(ds.periods().find((p) => p.id === '2026-09')?.status).toBe('open');
		expect(lockGate(ds, '2026-09').blocker).toBe('September 2026 cannot be locked while August 2026 is not locked: months close in order. Lock August 2026 first.');
		await ds.lockPeriod('2026-08');
		expect(ds.periods().find((p) => p.id === '2026-09')?.status).toBe('closing');
	});

	it('refuses an elimination the books no longer support, and recomputes it when sent back', async () => {
		await ds.startClose('2026-09');
		await run(24_000);
		for (const id of ['pr-10', 'pr-11', 'pr-13']) await ds.cfoConfirm(id);
		await run(5_000);
		const old = consolidation().find((p) => p.id === 'pr-c2')!;
		// A CFO correction to the intercompany receivable after the elimination was computed.
		const ic = ds.accounts().find((a) => a.code.startsWith('1900'))!;
		const line = ds.journalLines().find((l) => l.accountId === ic.id)!;
		await ds.cfoReverse(line.jeId, 'Booked to the wrong company');
		await expect(ds.cfoConfirm('pr-c2')).rejects.toThrow('The books changed after the Consolidation agent computed this, so it no longer matches the ledger. Send it back and the Consolidation agent will recompute it from the posted books.');
		expect(old.status).toBe('awaiting_cfo');

		await ds.cfoSendBack('pr-c2', 'Recompute after the correction');
		await run(8_000);
		const fresh = consolidation().find((p) => p.id === 'pr-c2-v2')!;
		expect(fresh.payloadJson).not.toBe(old.payloadJson);
		expect(old.status).toBe('superseded');
		await ds.cfoConfirm('pr-c2-v2');
		expect(fresh.status).toBe('approved');
	});
});
