import { describe, expect, it } from 'vitest';
import { dateMicros, findDuplicatePayments, matchBucket, nameTokens, refInText, scoreBankMatch, scoreBankMatches } from '../src/index.js';
import type { BankTransaction, Bill, Invoice } from '../src/index.js';

const DAY = 86_400_000_000n;
const DUE = dateMicros(2026, 9, 15);

const inv = (id: bigint, amountMinor: bigint, customerId = 1n, dueAt = DUE): Invoice => ({ id, customerId, ym: { year: 2026, month: 9 }, amountMinor, dueAt, status: 'open' });
const bill = (id: bigint, amountMinor: bigint, externalRef: string, vendorId = 7n, dueAt = DUE): Bill => ({ id, vendorId, ym: { year: 2026, month: 9 }, amountMinor, dueAt, status: 'open', externalRef });
const tx = (id: bigint, amountMinor: bigint, counterparty: string, description = '', bookedAt = DUE): BankTransaction => ({ id, bookedAt, amountMinor, ccy: 'USD', description, counterparty, matched: false });

const names = { customers: new Map([[1n, 'Acme Co'], [2n, 'Globex Corporation']]), vendors: new Map([[7n, 'Northwind Hosting LLC']]) };

describe('scoreBankMatch', () => {
  it('perfect invoice match scores 10000 and auto-matches', () => {
    const s = scoreBankMatch(tx(1n, 125_000n, 'ACME CO', 'Payment for invoice 1042'), inv(1042n, 125_000n), names);
    expect(s).toEqual({
      bankTxId: 1n, targetKind: 'invoice', targetId: 1042n, scoreBp: 10000, bucket: 'auto',
      reasons: ['amount matches exactly', 'paid 0 days from the due date', 'counterparty name matches 1 of 1 words', 'reference 1042 found in the description'],
    });
  });

  it('amount within 1% earns 3000, beyond earns 0', () => {
    expect(scoreBankMatch(tx(1n, 99_000n, ''), inv(5n, 100_000n), {}).scoreBp).toBe(3000 + 2000);
    expect(scoreBankMatch(tx(1n, 98_999n, ''), inv(5n, 100_000n), {}).scoreBp).toBe(2000);
  });

  it('date score decays linearly from 3 to 10 days', () => {
    const at = (d: bigint) => scoreBankMatch(tx(1n, 1n, '', '', DUE + d), inv(5n, 999n), {}).scoreBp;
    expect(at(3n * DAY)).toBe(2000);
    expect(at(-3n * DAY)).toBe(2000);
    expect(at(3n * DAY + 1n)).toBe(1999);
    expect(at(6n * DAY + DAY / 2n)).toBe(1000);
    expect(at(10n * DAY)).toBe(0);
    expect(at(30n * DAY)).toBe(0);
  });

  it('counterparty tokens ignore case and stopwords', () => {
    expect(nameTokens('The Globex Corporation, Inc.')).toEqual(['globex']);
    const s = scoreBankMatch(tx(1n, 1n, 'NORTHWIND LTD', '', DUE + 30n * DAY), bill(9n, 999n, 'X'), names);
    // only the counterparty matters here: 1 of 2 words (northwind, hosting)
    expect(s.scoreBp).toBe(1000);
  });

  it('wrong direction gets no amount credit', () => {
    const s = scoreBankMatch(tx(1n, 125_000n, 'Acme'), bill(9n, 125_000n, 'X'), names);
    expect(s.scoreBp).toBe(2000);
    expect(s.reasons[0]).toContain('money came in');
  });

  it('bill external reference is matched as a whole token', () => {
    expect(refInText('INV-77', 'ach inv77 northwind')).toBe(true);
    expect(refInText('INV-77', 'INV 77')).toBe(true);
    expect(refInText('INV-77', 'INV-770')).toBe(false);
    expect(refInText('77', 'anything 77')).toBe(false);
    const s = scoreBankMatch(tx(1n, -50_000n, 'Northwind Hosting', 'NW INV-77', DUE), bill(3n, 50_000n, 'INV-77'), names);
    expect(s.scoreBp).toBe(10000);
    expect(s.targetKind).toBe('bill');
  });

  it('bucket thresholds', () => {
    expect(matchBucket(7500)).toBe('auto');
    expect(matchBucket(7499)).toBe('review');
    expect(matchBucket(5000)).toBe('review');
    expect(matchBucket(4999)).toBe('unmatched');
  });
});

describe('scoreBankMatches', () => {
  it('is one-to-one: a target is consumed once and the highest score wins', () => {
    const txs = [
      tx(1n, 100_000n, 'Acme', '', DUE + 8n * DAY), // weaker on date
      tx(2n, 100_000n, 'Acme', 'inv 10', DUE), // strongest
    ];
    const out = scoreBankMatches(txs, [inv(10n, 100_000n)], [], names);
    expect(out.map((m) => [m.bankTxId, m.targetId, m.bucket])).toEqual([[2n, 10n, 'auto']]);
  });

  it('second-best target is used when the best is taken', () => {
    const txs = [tx(1n, 100_000n, 'Acme', 'inv 10'), tx(2n, 100_000n, 'Acme')];
    const out = scoreBankMatches(txs, [inv(10n, 100_000n), inv(11n, 100_000n)], [], names);
    expect(out.map((m) => [m.bankTxId, m.targetId])).toEqual([[1n, 10n], [2n, 11n]]);
  });

  it('weak matches are reported unmatched without consuming targets; matched and paid are skipped', () => {
    const txs = [tx(1n, 5n, 'Nobody', '', DUE + 5n * DAY), { ...tx(2n, 100_000n, 'Acme'), matched: true }, tx(3n, 100_000n, 'Acme')];
    const invoices = [inv(10n, 100_000n), { ...inv(11n, 100_000n), status: 'paid' as const }];
    // tx 1's only candidate (10) is consumed by tx 3, so tx 1 is omitted rather than pointing at a taken target
    expect(scoreBankMatches(txs, invoices, [], names).map((m) => [m.bankTxId, m.targetId, m.bucket])).toEqual([[3n, 10n, 'auto']]);
    // with a free target, tx 1 reports its best weak candidate
    const out = scoreBankMatches(txs, [...invoices, inv(12n, 7n)], [], names);
    expect(out.map((m) => [m.bankTxId, m.targetId, m.bucket])).toEqual([[1n, 12n, 'unmatched'], [3n, 10n, 'auto']]);
  });

  it('routes outflows to bills only and is order independent', () => {
    const txs = [tx(1n, -50_000n, 'Northwind', 'INV-77'), tx(2n, 100_000n, 'Acme')];
    const a = scoreBankMatches(txs, [inv(10n, 100_000n)], [bill(3n, 50_000n, 'INV-77')], names);
    const b = scoreBankMatches(txs, [inv(10n, 100_000n)].reverse(), [bill(3n, 50_000n, 'INV-77')], names);
    expect(a).toEqual(b);
    expect(a.map((m) => [m.bankTxId, m.targetKind])).toEqual([[1n, 'bill'], [2n, 'invoice']]);
  });
});

describe('findDuplicatePayments', () => {
  it('flags a second outflow for the same bill reference within 45 days', () => {
    const t0 = dateMicros(2026, 9, 1);
    const txs = [
      tx(1n, -50_000n, 'Northwind', 'INV-77', t0),
      tx(2n, -50_000n, 'Northwind', 'inv77 resend', t0 + 20n * DAY),
      tx(3n, 50_000n, 'Northwind', 'INV-77 refund', t0 + 21n * DAY), // inflow ignored
      tx(4n, -50_000n, 'Northwind', 'INV-770', t0 + 22n * DAY), // different ref
      tx(5n, -50_000n, 'Northwind', 'INV-77', t0 + 90n * DAY), // outside window: new anchor
    ];
    expect(findDuplicatePayments(txs, [bill(3n, 50_000n, 'INV-77')])).toEqual([
      { billId: 3n, externalRef: 'INV-77', firstTxId: 1n, duplicateTxId: 2n, amountMinor: 50_000n, daysApart: 20 },
    ]);
  });

  it('edge: exactly 45 days is a duplicate, 46 is not', () => {
    const t0 = dateMicros(2026, 9, 1);
    const b = [bill(3n, 1n, 'REF-1')];
    expect(findDuplicatePayments([tx(1n, -1n, '', 'REF-1', t0), tx(2n, -1n, '', 'REF-1', t0 + 45n * DAY)], b)).toHaveLength(1);
    expect(findDuplicatePayments([tx(1n, -1n, '', 'REF-1', t0), tx(2n, -1n, '', 'REF-1', t0 + 46n * DAY)], b)).toHaveLength(0);
  });
});
