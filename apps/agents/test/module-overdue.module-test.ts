import { expect, it } from 'vitest';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import * as module from '../../../spacetimedb/spacetimedb/src/index';

it('marks past-due open invoices overdue when the scheduler has no internal auth flag', () => {
  const now = new Timestamp(BigInt(Date.parse('2026-10-24T00:00:00Z')) * 1000n);
  const test = createModuleTestHarness(module.default, module, { clock: new TestClock(now) });
  test.withReducerTx(TestAuth.internal(), ctx => {
    ctx.db.invoice.insert({
      id: 1n, customerId: 1n, contractId: undefined, number: 'INV-1054', ym: '2026-09',
      issuedAt: new Timestamp(BigInt(Date.parse('2026-09-01T12:00:00Z')) * 1000n),
      dueAt: new Timestamp(BigInt(Date.parse('2026-10-01T12:00:00Z')) * 1000n),
      amountMinor: 9_600_000n, status: { tag: 'open' },
    });
  });
  test.withReducerTx(TestAuth.internal(), ctx => {
    // The pinned 2.13 runtime's AuthCtxImpl.fromBackend reports false for a null connection.
    // The real scheduler failure is recorded in the persisted module logs.
    const scheduledCtx = new Proxy(ctx, {
      get(target, property) {
        if (property === 'senderAuth') return { ...target.senderAuth, isInternal: false };
        return Reflect.get(target, property, target);
      },
    });
    module.overdueSweepTick(scheduledCtx, { timer: { scheduledId: 1n, scheduledAt: ScheduleAt.interval(60_000_000n) } });
  });
  expect(test.db.invoice.id.find(1n)?.status.tag).toBe('overdue');
  expect([...test.db.auditEvent.iter()].map(row => row.action)).toEqual(['overdue_sweep']);
  test.withReducerTx(TestAuth.internal(), ctx => {
    module.overdueSweepTick(ctx, { timer: { scheduledId: 1n, scheduledAt: ScheduleAt.interval(60_000_000n) } });
  });
  expect([...test.db.auditEvent.iter()].map(row => row.action)).toEqual(['overdue_sweep']);
});

it('preserves paid invoices, future due dates and invoices due exactly at the tick', () => {
  const now = new Timestamp(BigInt(Date.parse('2026-10-24T00:00:00Z')) * 1000n);
  const test = createModuleTestHarness(module.default, module, { clock: new TestClock(now) });
  test.withReducerTx(TestAuth.internal(), ctx => {
    const base = {
      customerId: 1n, contractId: undefined, ym: '2026-09',
      issuedAt: new Timestamp(now.microsSinceUnixEpoch - 86_400_000_000n), amountMinor: 100n,
    };
    ctx.db.invoice.insert({ ...base, id: 1n, number: 'PAID', dueAt: new Timestamp(1n), status: { tag: 'paid' } });
    ctx.db.invoice.insert({ ...base, id: 2n, number: 'FUTURE', dueAt: new Timestamp(now.microsSinceUnixEpoch + 1n), status: { tag: 'open' } });
    ctx.db.invoice.insert({ ...base, id: 3n, number: 'DUE-NOW', dueAt: now, status: { tag: 'open' } });
  });
  test.withReducerTx(TestAuth.internal(), ctx => {
    module.overdueSweepTick(ctx, { timer: { scheduledId: 1n, scheduledAt: ScheduleAt.interval(60_000_000n) } });
  });
  expect(test.db.invoice.id.find(1n)?.status.tag).toBe('paid');
  expect(test.db.invoice.id.find(2n)?.status.tag).toBe('open');
  expect(test.db.invoice.id.find(3n)?.status.tag).toBe('open');
  expect(test.db.auditEvent.count()).toBe(0n);
});
