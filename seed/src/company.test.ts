import { describe, expect, it } from 'vitest';
import { buildCompany, COMPANY } from './company';

const input = {
  closeYm: '2026-09',
  subsidiaryIds: new Map([['US', '1'], ['UK', '2']]),
  customers: Array.from({ length: 30 }, (_, i) => ({ id: String(100 + i), name: `Customer ${i}` })),
};

describe('Quillmesh company records', () => {
  const c = buildCompany(input);

  it('is deterministic', () => {
    expect(JSON.stringify(buildCompany(input))).toBe(JSON.stringify(c));
  });

  it('has 62 people, 48 in the US and 14 in the UK', () => {
    expect(c.employee).toHaveLength(62);
    expect(c.employee.filter(e => e.ccy === 'USD')).toHaveLength(48);
    expect(c.employee.filter(e => e.ccy === 'GBP')).toHaveLength(14);
  });

  it('gives every record of a kind a unique id', () => {
    for (const [kind, rows] of Object.entries(c)) {
      const ids = rows.map(r => r.id);
      expect(new Set(ids).size, kind).toBe(ids.length);
    }
  });

  it('prices the Series A at a $50M post-money on the fully diluted cap table', () => {
    const shares = c.cap_table_entry.reduce((n, r) => n + Number(r.shares), 0);
    const a = c.funding_round.find(r => r.id === 'qm-rd-a')!;
    const postMinor = (BigInt(shares) * BigInt(String(a.pricePerShareE4))) / 10_000n;
    // Whole shares round the post-money to within one share's price of $50M.
    expect(Number(COMPANY.postMoneyMinor - postMinor)).toBeGreaterThanOrEqual(0);
    expect(Number(COMPANY.postMoneyMinor - postMinor)).toBeLessThan(305);
    const raised = c.instrument.filter(i => i.roundId === 'qm-rd-a').reduce((n, i) => n + BigInt(String(i.principalMinor)), 0n);
    expect(raised).toBe(COMPANY.seriesAMinor);
  });

  it('balances every pay run to its payslips', () => {
    for (const run of c.pay_run) {
      const slips = c.payslip.filter(s => s.payRunId === run.id);
      expect(slips.length).toBe(run.employeeCount);
      const gross = slips.reduce((n, s) => n + BigInt(String(s.grossMinor)), 0n);
      const net = slips.reduce((n, s) => n + BigInt(String(s.netMinor)), 0n);
      expect(gross).toBe(BigInt(String(run.grossMinor)));
      expect(net).toBe(BigInt(String(run.netMinor)));
    }
  });

  it('joins records to the subsidiaries and customers it was given', () => {
    expect(new Set(c.employee.map(e => e.subsidiaryId))).toEqual(new Set(['1', '2']));
    const ids = new Set(input.customers.map(x => x.id));
    for (const b of c.batch) expect(ids.has(String(b.customerId))).toBe(true);
    for (const t of c.support_ticket) expect(ids.has(String(t.customerId))).toBe(true);
  });

  it('covers 18 months of cost of service', () => {
    expect(new Set(c.cloud_cost.map(r => r.ym)).size).toBe(18);
  });
});
