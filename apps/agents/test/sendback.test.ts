import { describe, expect, it } from 'vitest';
import { answerSendBack, askedFor } from '../src/scripted/sendback';

const allowance = (minor: bigint) => ({
  kind: { tag: 'JournalEntry' },
  amountMinor: minor,
  payloadJson: JSON.stringify({
    subsidiaryId: '1', periodYm: '2026-09', memo: 'Allowance for doubtful accounts: Okafor Dental Group (tier D)',
    lines: [
      { accountCode: '5700', debitMinor: String(minor), creditMinor: '0', customerId: '7' },
      { accountCode: '1150', debitMinor: '0', creditMinor: String(minor), customerId: '7' },
    ],
  }),
});
const facts = { openArMinor: () => 4_800_000n, allowanceMinor: () => 0n, customerName: () => 'Okafor Dental Group' };

describe('reading the CFO note', () => {
  it('takes the rate asked for, not the one being replaced', () => {
    expect(askedFor('reserve 50% not 75% on c06')).toEqual({ bp: 5000n });
    expect(askedFor('use 50% instead of 75%')).toEqual({ bp: 5000n });
    expect(askedFor('not 75%, make it 12.5%')).toEqual({ bp: 1250n });
    expect(askedFor('reserve $10,000.50 for them')).toEqual({ minor: 1_000_050n });
    expect(askedFor('please look again')).toBeNull();
    expect(askedFor('reserve 150%')).toBeNull();
  });
});

describe('answering a send-back', () => {
  it('recomputes an allowance at the asked rate as an amendment, never resubmitting it unchanged', () => {
    const a = answerSendBack(allowance(3_600_000n), 'reserve 50% not 75%', facts);
    expect(a.action).toBe('amend');
    if (a.action !== 'amend') return;
    const lines = JSON.parse(a.payloadJson).lines;
    expect(lines.map((l: { accountCode: string; debitMinor: string; creditMinor: string }) => [l.accountCode, l.debitMinor, l.creditMinor])).toEqual([['5700', '2400000', '0'], ['1150', '0', '2400000']]);
    expect(a.rationale).toBe('The CFO sent this back: "reserve 50% not 75%". Recomputed: $48,000 of open receivables at 50% is $24,000; the current allowance is $0, so set aside $24,000 (the original proposal was $36,000). An amendment always returns to the CFO.');
    expect(a.summaryPlain).toBe('Revised as you asked: set aside $24,000 for Okafor Dental Group instead of $36,000; it needs your OK again.');
  });

  it('releases part of an existing allowance when the asked reserve is lower than what is booked', () => {
    const a = answerSendBack(allowance(1_000_000n), 'reserve $10,000', { ...facts, allowanceMinor: () => 1_500_000n });
    expect(a.action === 'amend' && JSON.parse(a.payloadJson).lines[0]).toMatchObject({ accountCode: '1150', debitMinor: '500000' });
  });

  it('rejects with the reason when the note gives nothing to apply, or the proposal is not an allowance', () => {
    expect(answerSendBack(allowance(3_600_000n), 'Show customer names, not IDs.', facts)).toMatchObject({ action: 'reject', summaryPlain: 'Not posted: I could not apply your note automatically (the note names no reserve rate (such as 50%) or amount (such as $10,000)).' });
    const match = { kind: { tag: 'BankMatch' }, amountMinor: 0n, payloadJson: '{"matches":[]}' };
    expect(answerSendBack(match, 'match it to INV-1058', facts)).toMatchObject({ action: 'reject', rationale: expect.stringContaining('Rejected rather than resubmitted unchanged') });
    expect(answerSendBack(allowance(0n), 'reserve 0%', facts)).toMatchObject({ action: 'reject' });
  });
});
