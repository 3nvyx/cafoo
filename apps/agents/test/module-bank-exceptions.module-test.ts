import { expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import * as module from '../../../spacetimedb/spacetimedb/src/index';
import { bankExceptionSnapshot } from '@cafoo/ledger-core';

const cfo = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://cafoo.test', sub: 'cfo' }), new ConnectionId(1n));
const advisor = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://cafoo.test', sub: 'advisor' }), new ConnectionId(2n));

function setup() {
  const now = new Timestamp(BigInt(Date.parse('2026-10-24T00:00:00Z')) * 1000n);
  const test = createModuleTestHarness(module.default, module, { clock: new TestClock(now) });
  test.withReducerTx(cfo, ctx => {
    ctx.db.agentIdentity.insert({ identity: ctx.sender, role: { tag: 'cfo' }, displayName: 'CFO', registeredAt: now });
    ctx.db.period.insert({ id: 1n, subsidiaryId: 1n, year: 2026, month: 9, ym: '2026-09', status: { tag: 'open' } });
    ctx.db.bankTransaction.insert({ id: 1n, subsidiaryId: 1n, bookedAt: now, ym: '2026-09', amountMinor: 9_748_500n, ccy: 'USD', description: 'Unresolved receipts', counterparty: 'Customers', matched: false });
    ctx.db.closeTask.insert({ id: 1n, periodId: 1n, title: 'Reconcile bank transactions', description: 'Resolve the bank lines', ownerRole: 'bookkeeper', status: { tag: 'done' }, sortOrder: 1, evidenceProposalIds: '[]' });
  });
  test.withReducerTx(advisor, ctx => {
    ctx.db.agentIdentity.insert({ identity: ctx.sender, role: { tag: 'advisor' }, displayName: 'Advisor', registeredAt: now });
  });
  return test;
}

function reviewedSnapshot(test: ReturnType<typeof setup>, periodYm = '2026-09') {
  return bankExceptionSnapshot({
    periodYm,
    bankRows: [...test.db.bankTransaction.iter()].map(row => ({ ...row, id: String(row.id), subsidiaryId: String(row.subsidiaryId), amountMinor: String(row.amountMinor), bookedAt: new Date(Number(row.bookedAt.microsSinceUnixEpoch / 1000n)).toISOString() })),
    auditEvents: [...test.db.auditEvent.iter()].map(event => ({ ...event, id: String(event.id), targetId: String(event.targetId), at: new Date(Number(event.at.microsSinceUnixEpoch / 1000n)).toISOString() })),
  });
}

it('refuses a period lock when a legacy done task still has unmatched bank lines', () => {
  const test = setup();
  expect(() => test.withReducerTx(cfo, ctx => module.lockPeriod(ctx, { periodYm: '2026-09', rationale: 'Close' }))).toThrow(/bank.*exception|unmatched/i);
  expect(test.db.period.id.find(1n)?.status.tag).toBe('open');
  expect(test.db.periodLock.count()).toBe(0n);
});

it('locks only after CFO acceptance of the reviewed exceptions, leaving reconciliation incomplete', () => {
  const test = setup();
  const snapshot = reviewedSnapshot(test);
  test.withReducerTx(cfo, ctx => module.acceptBankExceptions(ctx, { periodYm: '2026-09', expectedSnapshot: snapshot, reasonPlain: '  Chase remittance detail next month.  ' }));
  const event = [...test.db.auditEvent.iter()].find(row => row.action === 'accept_bank_exceptions');
  expect(event?.actorRole).toBe('cfo');
  expect(JSON.parse(event?.detail ?? '')).toEqual({ periodYm: '2026-09', snapshot, reasonPlain: 'Chase remittance detail next month.' });
  expect(test.db.bankTransaction.id.find(1n)?.matched).toBe(false);
  test.withReducerTx(cfo, ctx => module.lockPeriod(ctx, { periodYm: '2026-09', rationale: 'Close with accepted exceptions' }));
  expect(test.db.period.id.find(1n)?.status.tag).toBe('closed');
  expect(test.db.closeTask.id.find(1n)?.status.tag).toBe('in_progress');
  expect(test.db.bankTransaction.id.find(1n)?.matched).toBe(false);
});

it('refuses an Advisor lock request while unmatched bank exceptions lack CFO acceptance', () => {
  const test = setup();
  expect(() => test.withReducerTx(advisor, ctx => module.requestPeriodLock(ctx, { periodYm: '2026-09', rationale: 'Ready', summaryPlain: 'Ready to lock.' }))).toThrow(/unmatched|bank.*exception/i);
  expect(test.db.period.id.find(1n)?.status.tag).toBe('open');
});

it('refuses to mark reconciliation done before its exceptions have CFO acceptance', () => {
  const test = setup();
  expect(() => test.withReducerTx(advisor, ctx => module.updateCloseTask(ctx, { taskId: 1n, status: 'done', note: 'Rulings issued' }))).toThrow(/unmatched|bank.*exception/i);
});

it('restricts acceptance to the CFO and requires a nonempty reason', () => {
  const test = setup();
  const args = { periodYm: '2026-09', expectedSnapshot: reviewedSnapshot(test), reasonPlain: 'Reviewed.' };
  expect(() => test.withReducerTx(advisor, ctx => module.acceptBankExceptions(ctx, args))).toThrow(/Only cfo/);
  expect(() => test.withReducerTx(cfo, ctx => module.acceptBankExceptions(ctx, { ...args, reasonPlain: ' \n ' }))).toThrow(/reason/);
  expect([...test.db.auditEvent.iter()].some(event => event.action === 'accept_bank_exceptions')).toBe(false);
});

it('rejects a stale reviewed snapshot after bank details change', () => {
  const test = setup();
  const snapshot = reviewedSnapshot(test);
  test.withReducerTx(cfo, ctx => {
    const row = ctx.db.bankTransaction.id.find(1n)!;
    ctx.db.bankTransaction.id.update({ ...row, amountMinor: 1n });
  });
  expect(() => test.withReducerTx(cfo, ctx => module.acceptBankExceptions(ctx, { periodYm: '2026-09', expectedSnapshot: snapshot, reasonPlain: 'Reviewed.' }))).toThrow(/changed.*review/i);
});

it('invalidates acceptance when a lock is reopened, even with identical bank rows', () => {
  const test = setup();
  const snapshot = reviewedSnapshot(test);
  test.withReducerTx(cfo, ctx => module.acceptBankExceptions(ctx, { periodYm: '2026-09', expectedSnapshot: snapshot, reasonPlain: 'Reviewed.' }));
  test.withReducerTx(cfo, ctx => module.lockPeriod(ctx, { periodYm: '2026-09', rationale: 'Close with exceptions' }));
  test.withReducerTx(cfo, ctx => module.unlockPeriod(ctx, { periodYm: '2026-09', rationale: 'Recheck' }));
  expect(reviewedSnapshot(test)).not.toBe(snapshot);
  expect(() => test.withReducerTx(cfo, ctx => module.lockPeriod(ctx, { periodYm: '2026-09', rationale: 'Old consent' }))).toThrow(/unmatched/);
});

it('acceptance leaves an independently blocked task blocked', () => {
  const test = setup();
  test.withReducerTx(advisor, ctx => module.updateCloseTask(ctx, { taskId: 1n, status: 'blocked', note: 'Missing bank statement' }));
  const snapshot = reviewedSnapshot(test);
  test.withReducerTx(cfo, ctx => module.acceptBankExceptions(ctx, { periodYm: '2026-09', expectedSnapshot: snapshot, reasonPlain: 'Reviewed unmatched receipts.' }));
  expect(test.db.closeTask.id.find(1n)?.status.tag).toBe('blocked');
  expect(() => test.withReducerTx(cfo, ctx => module.lockPeriod(ctx, { periodYm: '2026-09', rationale: 'Close' }))).toThrow(/blocked/);
});

it('allows ordinary completion and lock when every bank line is matched', () => {
  const test = setup();
  test.withReducerTx(cfo, ctx => {
    const row = ctx.db.bankTransaction.id.find(1n)!;
    ctx.db.bankTransaction.id.update({ ...row, matched: true });
  });
  test.withReducerTx(advisor, ctx => module.updateCloseTask(ctx, { taskId: 1n, status: 'done', note: 'Reconciled' }));
  test.withReducerTx(advisor, ctx => module.requestPeriodLock(ctx, { periodYm: '2026-09', rationale: 'Ready', summaryPlain: 'Ready to lock.' }));
  test.withReducerTx(cfo, ctx => module.lockPeriod(ctx, { periodYm: '2026-09', rationale: 'Close' }));
  expect(test.db.closeTask.id.find(1n)?.status.tag).toBe('done');
});

it('does not convert accepted exceptions into a done bank task when the Advisor marks tasks done', () => {
  const test = setup();
  const snapshot = reviewedSnapshot(test);
  test.withReducerTx(cfo, ctx => module.acceptBankExceptions(ctx, { periodYm: '2026-09', expectedSnapshot: snapshot, reasonPlain: 'Reviewed.' }));
  test.withReducerTx(advisor, ctx => module.updateCloseTask(ctx, { taskId: 1n, status: 'done', note: 'Rulings issued' }));
  test.withReducerTx(advisor, ctx => module.requestPeriodLock(ctx, { periodYm: '2026-09', rationale: 'Accepted exceptions', summaryPlain: 'Ready for the CFO.' }));
  expect(test.db.closeTask.id.find(1n)?.status.tag).toBe('in_progress');
  expect(test.db.period.id.find(1n)?.status.tag).toBe('closing');
});
