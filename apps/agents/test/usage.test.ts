import { describe, expect, it } from 'vitest';
import { usageInvoices } from '../src/usage';

describe("the month's usage invoices", () => {
  const contracts = [
    { id: 1n, plan: { tag: 'Usage' } },
    { id: 2n, plan: { tag: 'Annual' } },
  ];
  it('include the invoices the live feed ingested, so the usage entry books their receivable', () => {
    const invoices = [
      { number: 'INV-1050', contractId: 1n, ym: '2026-10' }, // loaded by the seed
      { number: 'INV-1073', contractId: 1n, ym: '2026-10' }, // ingested by the feed (feed_event), same shape
      { number: 'INV-1040', contractId: 1n, ym: '2026-09' }, // another month
      { number: 'INV-1060', contractId: 2n, ym: '2026-10' }, // an annual contract's invoice
      { number: 'INV-1061', contractId: undefined, ym: '2026-10' }, // no contract
    ];
    expect(usageInvoices(invoices, contracts, '2026-10').map(i => i.number)).toEqual(['INV-1050', 'INV-1073']);
  });
});
