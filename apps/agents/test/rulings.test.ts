import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ruleOpen } from '../src/scripted/rulings';
import { books, fakeCast } from './fake-cast';

let fx: ReturnType<typeof fakeCast>;

beforeEach(() => {
  fx = fakeCast(books());
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

async function rule(kind: string, payload: object, summaryPlain: string, amountMinor = 0n) {
  await fx.cast.bookkeeper.reducers.propose({
    kind, payloadJson: JSON.stringify(payload), summaryPlain, amountMinor,
    rationale: 'The amount and name match in full; the reference needs confirmation.',
    periodYm: '2026-09', closeTaskId: undefined,
  });
  await ruleOpen(fx.cast, [...fx.cast.advisor.db.proposal.iter()], {
    thread: 'close:2026-09', snapshot: { materiality: 1_000_000n, vendorName: new Map() },
  });
  return fx.callsTo('critique')[0]!.args;
}

describe('rulings grounded in proposal evidence', () => {
  it('does not invent a 50% reserve or a history of monthly payments', async () => {
    const critique = await rule('journal_entry', {
      memo: 'Allowance for doubtful accounts: Kayla Brennan',
      lines: [{ accountCode: '5700', debitMinor: '1498500', creditMinor: '0' }, { accountCode: '1150', debitMinor: '0', creditMinor: '1498500' }],
    }, 'Set aside the full $14,985 owed by Kayla Brennan.', 1_498_500n);
    expect(critique.body).not.toMatch(/50%|still paying monthly/);
    expect(critique.body).toMatch(/not yet matched/);
  });

  it('does not infer a partial name match from a low aggregate score', async () => {
    const critique = await rule('bank_match', {
      matches: [{ bankTxId: '60', targetKind: 'invoice', targetId: '40', scoreBp: 7000 }],
    }, 'Match the payment to its invoice.');
    expect(critique.body).toContain('70%');
    expect(critique.body + critique.summaryPlain).not.toMatch(/partly|partial|overlap/);
    expect(fx.callsTo('rejectProposal')).toHaveLength(1);
  });

  it('does not claim bankruptcy identity or collateral checks were performed from a summary alone', async () => {
    const critique = await rule('journal_entry', {
      memo: 'Allowance for doubtful accounts', lines: [],
    }, 'Reserve the receivable because the guarantor has a bankruptcy record.', 4_800_000n);
    const ruling = fx.callsTo('approveProposal')[0]!.args;
    expect(critique.body + ruling.rationale).not.toMatch(/evidence shows|matches the guarantor's SSN|no collateral or prepayment/);
  });
});
