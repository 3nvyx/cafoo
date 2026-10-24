/**
 * The October feed plan (seed/src/feed.ts) scored with this engine's bank matcher. The seed package has no test
 * runner, and the plan's promises (auto, review, unmatched) are promises about scoreBankMatches, so they live here.
 */
import { describe, expect, it } from 'vitest';
import { feedContextFromSeed, feedPlan, type FeedBankTxEvent, type FeedContext, type FeedEvent } from '../../../seed/src/feed';
import { dateMicros, scoreBankMatches } from '../src/index.js';
import type { BankTransaction, Bill, Invoice } from '../src/index.js';

const NAMES = ['Okafor Dental Group', 'Reyes Creative Studio', 'Dalton Auto Repair', 'Szabo Catering Co', 'Brennan Media Labs', 'Whitcomb Antiques', 'Morrissey Fitness', 'Holloway Roofing'];
const due = (y: number, m: number, d: number) => dateMicros(y, m, d) + 43_200_000_000n; // noon UTC, as the seed writes

function context(over: Partial<FeedContext> = {}): FeedContext {
  return {
    ym: '2026-10',
    customers: NAMES.map((name, i) => ({ id: BigInt(i + 1), name })),
    vendors: [
      { id: 1n, name: 'Northwind Cloud', verification: 'unverified' },
      { id: 2n, name: 'Brennan Data Services LLC', verification: 'blocked' },
      { id: 3n, name: 'Lumen Analytics', verification: 'unverified' },
      { id: 4n, name: 'Granite Insurance', verification: 'verified' },
    ],
    contracts: [
      ...[4500n, 6000n, 9000n, 12000n, 4500n, 6000n].map((unitPriceMinor, i) => ({ code: `C-00${i + 1}`, customerId: BigInt(i + 1), plan: 'usage', unitPriceMinor })),
      { code: 'C-007', customerId: 7n, plan: 'annual', unitPriceMinor: 0n },
      { code: 'C-008', customerId: 8n, plan: 'annual', unitPriceMinor: 0n },
    ],
    invoices: [
      ...[564_000n, 936_000n, 427_500n, 1_812_000n, 706_500n, 1_296_000n].map((amountMinor, i) => ({
        number: `INV-${1061 + i}`, customerId: BigInt(i + 1), contractCode: `C-00${i + 1}`, ym: '2026-09', amountMinor, dueAtMicros: due(2026, 10, 30), status: 'open',
      })),
      ...[300_000n, 420_000n].map((amountMinor, i) => ({
        number: `INV-${1041 + i}`, customerId: BigInt(i + 1), contractCode: `C-00${i + 1}`, ym: '2026-08', amountMinor, dueAtMicros: due(2026, 9, 30), status: 'paid',
      })),
      { number: 'INV-1050', customerId: 7n, contractCode: 'C-007', ym: '2026-07', amountMinor: 4_800_000n, dueAtMicros: due(2026, 7, 31), status: 'overdue' },
    ],
    bills: [
      { externalRef: 'NORTHWIND-202608-7001', vendorId: 1n, ym: '2026-08', amountMinor: 1_240_000n, dueAtMicros: due(2026, 9, 2), status: 'paid' },
      { externalRef: 'NORTHWIND-202609-7016', vendorId: 1n, ym: '2026-09', amountMinor: 1_240_000n, dueAtMicros: due(2026, 10, 2), status: 'open' },
      { externalRef: 'NORTHWIND-202610-7031', vendorId: 1n, ym: '2026-10', amountMinor: 1_250_000n, dueAtMicros: due(2026, 10, 20), status: 'open' },
      { externalRef: 'BDS-0001', vendorId: 2n, ym: '2026-09', amountMinor: 2_475_000n, dueAtMicros: due(2026, 10, 3), status: 'open' },
      { externalRef: 'LUMEN-0001', vendorId: 3n, ym: '2026-09', amountMinor: 189_000n, dueAtMicros: due(2026, 10, 10), status: 'open' },
      { externalRef: 'GRANITE-0009', vendorId: 4n, ym: '2026-09', amountMinor: 310_000n, dueAtMicros: due(2026, 10, 12), status: 'open' },
    ],
    bankTransactions: [{ description: 'ACH DEBIT NORTHWIND CLOUD NORTHWIND-202609-7016', amountMinor: -1_240_000n }],
    ...over,
  };
}

const bankEvents = (plan: FeedEvent[]) => plan.filter((e): e is FeedBankTxEvent => e.kind === 'bank_tx');
const byExpect = (plan: FeedEvent[], expect: string) => plan.filter((e) => e.expect === expect);

/** Score the plan's bank lines against the context's documents plus the plan's new invoices, as the Bookkeeper would. */
function score(ctx: FeedContext, plan: FeedEvent[]) {
  const invoices: (Invoice & { number: string })[] = ctx.invoices.map((i, n) => ({
    id: BigInt(n + 1), number: i.number, customerId: i.customerId, ym: { year: +i.ym.slice(0, 4), month: +i.ym.slice(5) }, amountMinor: i.amountMinor, dueAt: i.dueAtMicros, status: i.status as Invoice['status'],
  }));
  for (const e of plan) {
    if (e.kind !== 'invoice') continue;
    invoices.push({ id: BigInt(invoices.length + 1), number: e.invoice.number, customerId: e.invoice.customerId, ym: { year: 2026, month: 10 }, amountMinor: e.invoice.amountMinor, dueAt: e.invoice.dueAtMicros, status: 'open' });
  }
  const bills: (Bill & { ref: string })[] = ctx.bills.map((b, n) => ({
    id: BigInt(n + 1), ref: b.externalRef, vendorId: b.vendorId, ym: { year: +b.ym.slice(0, 4), month: +b.ym.slice(5) }, amountMinor: b.amountMinor, dueAt: b.dueAtMicros, status: b.status as Bill['status'], externalRef: b.externalRef,
  }));
  const txs: BankTransaction[] = bankEvents(plan).map((e, n) => ({ id: BigInt(n + 1), bookedAt: e.tx.bookedAtMicros, amountMinor: e.tx.amountMinor, ccy: e.tx.ccy, description: e.tx.description, counterparty: e.tx.counterparty, matched: false }));
  const cands = scoreBankMatches(txs, invoices, bills, { customers: new Map(ctx.customers.map((c) => [c.id, c.name])), vendors: new Map(ctx.vendors.map((v) => [v.id, v.name])) });
  return bankEvents(plan).map((e, n) => {
    const c = cands.find((x) => x.bankTxId === BigInt(n + 1));
    const ref = c ? (c.targetKind === 'invoice' ? invoices.find((i) => i.id === c.targetId)?.number : bills.find((b) => b.id === c.targetId)?.ref) : undefined;
    return { e, bucket: c?.bucket ?? 'none', ref };
  });
}

describe('feedPlan', () => {
  it('is deterministic and pure: same context, same events', () => {
    const json = (p: FeedEvent[]) => JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json(feedPlan(context()))).toBe(json(feedPlan(context())));
    expect(json(feedPlan(context(), { seed: 2027 }))).toBe(json(feedPlan(context())));
    expect(json(feedPlan(context(), { seed: 7 }))).not.toBe(json(feedPlan(context())));
  });

  it('builds every external id from content, never from position or seed', () => {
    const plan = feedPlan(context());
    for (const e of plan) {
      expect(e.externalId).toMatch(/^feed-2026-10-(rcpt-INV-\d+|inv-INV-\d+|fee-\d\d|card-\d\d|payroll-\d\d|pay-[A-Z0-9-]+)$/);
      expect(e.kind === 'invoice' ? e.invoice.externalId : e.tx.externalId).toBe(e.externalId);
    }
    const ids = (seed: number) => feedPlan(context(), { seed }).map((e) => e.externalId).filter((id) => !/-card-/.test(id)).sort();
    expect(ids(1)).toEqual(ids(2027));
    expect(plan.map((e) => e.externalId)).toContain('feed-2026-10-fee-04');
    expect(plan.map((e) => e.externalId)).toContain('feed-2026-10-payroll-15');
  });

  it('keeps ids and contents stable when rebuilt after some events were ingested and matched', () => {
    const ctx = context();
    const first = feedPlan(ctx);
    const paidNumbers = new Set(byExpect(first, 'auto_match').flatMap((e) => (e.kind === 'bank_tx' && e.target ? [e.target.ref] : [])));
    const newInvoices = first.flatMap((e) => (e.kind === 'invoice' ? [e.invoice] : []));
    const later = context({
      invoices: [
        ...ctx.invoices.map((i) => (paidNumbers.has(i.number) ? { ...i, status: 'paid' } : i)),
        ...newInvoices.map((i) => ({ number: i.number, customerId: i.customerId, contractCode: i.contractCode, ym: '2026-10', amountMinor: i.amountMinor, dueAtMicros: i.dueAtMicros, status: 'paid' })),
      ],
      bills: ctx.bills.map((b) => (paidNumbers.has(b.externalRef) ? { ...b, status: 'paid' } : b)),
    });
    const rebuilt = feedPlan(later);
    expect(rebuilt.length).toBeLessThan(first.length);
    const original = new Map(first.map((e) => [e.externalId, e]));
    for (const e of rebuilt) expect(e, e.externalId).toEqual(original.get(e.externalId));
  });

  it("plays October's mix: receipts for September usage, one partial, one review, fee, card, payroll, three new invoices", () => {
    const plan = feedPlan(context());
    const receipts = bankEvents(plan).filter((e) => e.target?.kind === 'invoice' && /^INV-106[1-6]$/.test(e.target.ref));
    expect(receipts).toHaveLength(6);
    expect(receipts.filter((e) => e.expect === 'auto_match')).toHaveLength(4);
    expect(receipts.filter((e) => e.expect === 'partial')).toHaveLength(1);
    expect(receipts.filter((e) => e.expect === 'review')).toHaveLength(1);
    const invoices = plan.flatMap((e) => (e.kind === 'invoice' ? [e.invoice] : []));
    expect(invoices.map((i) => i.number)).toEqual(['INV-1067', 'INV-1068', 'INV-1069']);
    for (const inv of invoices) {
      expect(inv.amountMinor).toBeLessThan(1_000_000n);
      expect(inv.dueAtMicros - inv.issuedAtMicros).toBe(30n * 86_400_000_000n);
      const rcpt = bankEvents(plan).find((e) => e.target?.ref === inv.number)!;
      expect(rcpt.tx.amountMinor).toBe(inv.amountMinor);
      expect(plan.indexOf(rcpt)).toBeGreaterThan(plan.findIndex((e) => e.kind === 'invoice' && e.invoice.number === inv.number));
    }
    const payroll = plan.find((e) => e.externalId === 'feed-2026-10-payroll-15')!;
    expect(payroll.kind === 'bank_tx' && payroll.tx.amountMinor).toBe(-4_860_000n);
    expect(payroll.material).toBe(true);
    expect(byExpect(plan, 'classify').map((e) => e.externalId.replace(/\d\d$/, ''))).toEqual(['feed-2026-10-fee-', 'feed-2026-10-card-', 'feed-2026-10-payroll-']);
    expect([...plan].sort((a, b) => (a.atMicros < b.atMicros ? -1 : a.atMicros > b.atMicros ? 1 : 0)).map((e) => e.externalId)).toEqual(plan.map((e) => e.externalId));
    expect(plan.every((e) => e.ym === '2026-10' && e.atMicros >= dateMicros(2026, 10, 1) && e.atMicros < dateMicros(2026, 11, 1))).toBe(true);
  });

  it('never pays a blocked vendor, a first-time unverified vendor, or a bill already paid from the bank', () => {
    const pays = bankEvents(feedPlan(context())).filter((e) => e.target?.kind === 'bill');
    expect(pays.map((e) => [e.target!.ref, e.tx.amountMinor, e.tx.counterparty])).toEqual([
      ['GRANITE-0009', -310_000n, 'Granite Insurance'],
      ['NORTHWIND-202610-7031', -1_250_000n, 'Northwind Cloud'],
    ]);
    const unblocked = context({ vendors: context().vendors.map((v) => (v.id === 2n ? { ...v, verification: 'verified' } : v)) });
    expect(bankEvents(feedPlan(unblocked)).some((e) => e.target?.ref === 'BDS-0001')).toBe(true);
  });

  it('lands where it says when the Bookkeeper scores it: exact receipts auto, the review one in review, the partial one unmatched', () => {
    const ctx = context();
    const scored = score(ctx, feedPlan(ctx));
    for (const { e, bucket, ref } of scored) {
      if (e.expect === 'auto_match') expect([e.externalId, bucket, ref]).toEqual([e.externalId, 'auto', e.target!.ref]);
      if (e.expect === 'review') expect([bucket, ref]).toEqual(['review', e.target!.ref]);
      if (e.expect === 'partial') expect(['unmatched', 'none']).toContain(bucket);
      if (e.expect === 'classify') expect(bucket).not.toBe('auto');
    }
  });

  it('reads seed.json through feedContextFromSeed', () => {
    const ctx = feedContextFromSeed({
      closeYm: '2026-09',
      customers: [{ idx: 1, name: 'Okafor Dental Group' }],
      vendors: [{ idx: 1, name: 'Northwind Cloud' }],
      contracts: [{ customerIdx: 1, code: 'C-001', plan: 'usage', items: [{ kind: 'usage', priceMinor: '4500' }] }],
      invoices: [{ customerIdx: 1, contractCode: 'C-001', number: 'INV-1041', ym: '2026-09', dueAtMicros: String(due(2026, 10, 30)), amountMinor: '450000', status: 'open' }],
      bills: [],
      bankTransactions: [],
    });
    expect(ctx.ym).toBe('2026-10');
    expect(ctx.contracts[0]).toEqual({ code: 'C-001', customerId: 1n, plan: 'usage', unitPriceMinor: 4500n });
    expect(ctx.vendors[0]!.verification).toBe('unverified');
    expect(feedPlan(ctx).map((e) => e.externalId)).toContain('feed-2026-10-rcpt-INV-1041');
  });
});
