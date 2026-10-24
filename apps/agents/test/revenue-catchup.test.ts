import { describe, expect, it } from 'vitest';
import { catchUpAmounts } from '../src/revenue-catchup';
import type { Snapshot } from '../src/snapshot';
import type { RoleConn } from '../src/stdb';

const schedule = (id: bigint, customerId: string, status = 'Approved') => ({ id, periodId: 2n, kind: { tag: 'RevenueSchedule' }, status: { tag: status }, payloadJson: JSON.stringify({ lines: [{ customerId, ym: '2026-08', amountMinor: '220000' }] }) });
const recognition = (id: bigint, customerIds: string[], status = 'AwaitingCfo') => ({
  id,
  periodId: 2n,
  kind: { tag: 'JournalEntry' },
  status: { tag: status },
  payloadJson: JSON.stringify({ recognizeScheduleYm: '2026-09', lines: customerIds.map(c => ({ accountCode: '4000', customerId: c, creditMinor: '440000' })) }),
});
const conn = (proposals: unknown[]) => ({ db: { proposal: { iter: () => proposals[Symbol.iterator]() } } }) as unknown as RoleConn;
const s = {
  closeYm: '2026-09',
  period: { id: 2n },
  items: [{ id: 41n, kind: 'subscription' }, { id: 42n, kind: 'subscription' }, { id: 43n, kind: 'usage' }],
  scheduleLines: [
    { contractItemId: 41n, customerId: 7n, ym: '2026-08', amountMinor: 220000n, recognized: false },
    { contractItemId: 41n, customerId: 7n, ym: '2026-09', amountMinor: 220000n, recognized: false },
    { contractItemId: 41n, customerId: 7n, ym: '2026-10', amountMinor: 220000n, recognized: false },
    { contractItemId: 42n, customerId: 8n, ym: '2026-09', amountMinor: 100000n, recognized: false },
    { contractItemId: 43n, customerId: 8n, ym: '2026-09', amountMinor: 5000n, recognized: false },
  ],
} as unknown as Snapshot;

describe('catchUpAmounts', () => {
  it('sums unrecognized subscription lines through the month for customers whose schedule was approved this close', () => {
    expect(catchUpAmounts(conn([schedule(1n, '7'), schedule(2n, '8')]), s)).toEqual(new Map([[7n, 440000n], [8n, 100000n]]));
    expect(catchUpAmounts(conn([schedule(1n, '7', 'AwaitingCfo')]), s)).toEqual(new Map());
  });
  it('leaves out customers a recognition proposal still waiting for a ruling or the CFO already credits', () => {
    expect(catchUpAmounts(conn([schedule(1n, '7'), schedule(2n, '8'), recognition(3n, ['7'])]), s)).toEqual(new Map([[8n, 100000n]]));
    // A decided (approved or rejected) recognition entry covers nobody any more.
    expect(catchUpAmounts(conn([schedule(1n, '7'), recognition(3n, ['7'], 'Rejected')]), s)).toEqual(new Map([[7n, 440000n]]));
  });
});
