import { expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import * as module from '../../../spacetimedb/spacetimedb/src/index';

const cfo = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://cafoo.test', sub: 'cfo' }), new ConnectionId(1n));
const advisor = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://cafoo.test', sub: 'advisor' }), new ConnectionId(2n));
const credit = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://cafoo.test', sub: 'credit' }), new ConnectionId(3n));

const entry = (minor: bigint) => JSON.stringify({
  subsidiaryId: '1', periodYm: '2026-09', memo: 'Allowance for doubtful accounts: Okafor Dental Group (tier D)',
  lines: [
    { accountCode: '5700', debitMinor: String(minor), creditMinor: '0', ccy: 'USD', fxRateE6: '1000000', customerId: '7', memo: 'Expected credit loss' },
    { accountCode: '1150', debitMinor: '0', creditMinor: String(minor), ccy: 'USD', fxRateE6: '1000000', customerId: '7', memo: 'Allowance' },
  ],
});

it('shows an amendment at the amount it would post, and sends it back to the CFO', () => {
  const now = new Timestamp(BigInt(Date.parse('2026-10-24T00:00:00Z')) * 1000n);
  const test = createModuleTestHarness(module.default, module, { clock: new TestClock(now) });
  test.withReducerTx(cfo, ctx => {
    ctx.db.agentIdentity.insert({ identity: ctx.sender, role: { tag: 'cfo' }, displayName: 'CFO', registeredAt: now });
    ctx.db.subsidiary.insert({ id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', parentId: undefined, isElimination: false });
    ctx.db.account.insert({ id: 1n, subsidiaryId: 1n, code: '5700', name: 'Expected credit loss', accountType: { tag: 'expense' }, isIntercompany: false, sortOrder: 1 });
    ctx.db.account.insert({ id: 2n, subsidiaryId: 1n, code: '1150', name: 'Allowance for doubtful accounts', accountType: { tag: 'asset' }, isIntercompany: false, sortOrder: 2 });
    ctx.db.period.insert({ id: 1n, subsidiaryId: 1n, year: 2026, month: 9, ym: '2026-09', status: { tag: 'open' } });
    ctx.db.settings.insert({ key: 'materiality_threshold_minor', valueI64: 1_000_000n, valueText: '' });
  });
  test.withReducerTx(advisor, ctx => ctx.db.agentIdentity.insert({ identity: ctx.sender, role: { tag: 'advisor' }, displayName: 'Advisor', registeredAt: now }));
  test.withReducerTx(credit, ctx => {
    ctx.db.agentIdentity.insert({ identity: ctx.sender, role: { tag: 'credit' }, displayName: 'Credit', registeredAt: now });
    ctx.db.proposal.insert({
      id: 1n, kind: { tag: 'journal_entry' }, payloadJson: entry(3_600_000n), rationale: 'Tier D at 75%.', summaryPlain: 'Set aside $36,000.',
      amountMinor: 3_600_000n, proposedBy: ctx.sender, proposerRole: 'credit', status: { tag: 'sent_back' }, createdAt: now, updatedAt: now,
      closeTaskId: undefined, periodId: 1n, threadId: 'close:2026-09',
    });
  });
  test.withReducerTx(advisor, ctx => module.approveProposal(ctx, { proposalId: 1n, rationale: 'Recomputed at 50% as the CFO asked.', summaryPlain: 'Revised to $24,000 as you asked.', amendedPayloadJson: entry(2_400_000n) }));
  const p = test.db.proposal.id.find(1n)!;
  expect(p.status.tag).toBe('awaiting_cfo');
  // The lower, amended reserve, not the $36,000 it replaced.
  expect(p.amountMinor).toBe(2_400_000n);
  expect(JSON.parse(p.payloadJson).lines[0].debitMinor).toBe('2400000');
  expect(test.db.journalEntry.count()).toBe(0n);
});
