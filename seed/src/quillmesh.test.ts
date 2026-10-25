import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Seed } from './generate';

const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const generate = (profile: string): Seed => {
  execFileSync('pnpm', ['exec', 'tsx', 'src/generate.ts'], { cwd: seedDir, env: { ...process.env, SEED_PROFILE: profile, CLOSE_PERIOD: '2026-09' }, stdio: 'ignore' });
  return JSON.parse(readFileSync(join(seedDir, 'out', 'seed.json'), 'utf8')) as Seed;
};
const sum = (seed: Seed, code: string) =>
  seed.journalEntries.flatMap(j => j.lines).filter(l => l.accountCode === code).reduce((n, l) => n + BigInt(l.debitMinor) - BigInt(l.creditMinor), 0n);

describe('the Quillmesh profile', () => {
  let base: Seed;
  let q: Seed;
  beforeAll(() => {
    base = generate('default');
    q = generate('quillmesh');
  }, 60_000);

  it('balances every journal entry', () => {
    for (const je of q.journalEntries) {
      const d = je.lines.reduce((n, l) => n + BigInt(l.debitMinor), 0n);
      const c = je.lines.reduce((n, l) => n + BigInt(l.creditMinor), 0n);
      expect(d, je.memo).toBe(c);
    }
  });

  it('keeps the fixture: same close month, its customers, bank lines and bills untouched', () => {
    expect(q.closeYm).toBe(base.closeYm);
    expect(q.customers.slice(0, base.customers.length)).toEqual(base.customers);
    expect(q.bankTransactions).toEqual(base.bankTransactions);
    expect(q.bills).toEqual(base.bills);
  });

  it('runs 18 months of history, every month before the close closed', () => {
    const yms = q.periods.yms;
    expect(yms[0]).toBe('2025-04');
    expect(yms.indexOf(q.closeYm)).toBe(17);
    expect(q.periods.closedYms).toEqual(yms.slice(0, 17));
  });

  it('has about $4.8M of annual contract ARR at the close and about $11M of cash before it', () => {
    const arr = q.contracts.filter(k => k.plan === 'annual' && k.startYm <= q.closeYm && q.closeYm <= k.endYm).reduce((n, k) => n + BigInt(k.totalMinor), 0n);
    expect(arr).toBeGreaterThan(4_500_000_00n);
    expect(arr).toBeLessThan(5_100_000_00n);
    const cash = sum(q, '1000');
    expect(cash).toBeGreaterThan(10_000_000_00n);
    expect(cash).toBeLessThan(12_000_000_00n);
  });

  it('leaves no new receivable open, so the close checks only the fixture customers', () => {
    const newIdx = new Set(q.customers.slice(base.customers.length).map(c => c.idx));
    const open = q.journalEntries.flatMap(j => j.lines).filter(l => l.accountCode === '1100' && l.customerId !== undefined && newIdx.has(l.customerId));
    expect(open.reduce((n, l) => n + BigInt(l.debitMinor) - BigInt(l.creditMinor), 0n)).toBe(0n);
    expect(q.invoices.filter(i => newIdx.has(i.customerIdx)).every(i => i.status === 'paid')).toBe(true);
  });
});
