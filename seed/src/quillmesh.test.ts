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
    // A renewed contract runs over several 12-month terms; its ARR is its total over its months, times 12.
    const arr = q.contracts.filter(k => k.plan === 'annual' && k.startYm <= q.closeYm && q.closeYm <= k.endYm).reduce((n, k) => n + (BigInt(k.totalMinor) * 12n) / BigInt(k.scheduleLines.length || 12), 0n);
    expect(arr).toBeGreaterThan(4_500_000_00n);
    expect(arr).toBeLessThan(5_100_000_00n);
    const cash = sum(q, '1000');
    expect(cash).toBeGreaterThan(10_000_000_00n);
    expect(cash).toBeLessThan(12_000_000_00n);
  });

  it('grows ARR every month into the close: no contract ends inside the books, about 3x a year', () => {
    // As the web app counts it (map.ts, derive.ts): a contract is active from its first day to its last month's end.
    const arrAt = (ym: string) => q.contracts.filter(k => k.totalMinor !== '0' && k.startYm <= ym && k.endYm > ym).reduce((n, k) => n + BigInt(k.totalMinor) * 12n / BigInt(k.scheduleLines.length || 12), 0n);
    const yms = q.periods.yms.filter(ym => ym <= q.closeYm);
    for (let i = 1; i < yms.length; i++) expect(arrAt(yms[i]), yms[i]).toBeGreaterThanOrEqual(arrAt(yms[i - 1]));
    expect(arrAt(q.closeYm)).toBeGreaterThan(arrAt(yms[yms.length - 2]));
    expect(arrAt(q.closeYm)).toBeGreaterThan(4_600_000_00n);
    expect(arrAt(q.closeYm)).toBeLessThan(5_000_000_00n);
    const yearAgo = arrAt(yms[yms.length - 13]);
    expect(Number(arrAt(q.closeYm)) / Number(yearAgo)).toBeGreaterThan(2.7);
    expect(Number(arrAt(q.closeYm)) / Number(yearAgo)).toBeLessThan(3.8);
  });

  it('ties paid-in capital to the funding records: $4.25M pre-seed and seed plus the $12M Series A', () => {
    const us = [...q.journalEntries, ...q.group.journalEntries.filter(j => j.subsidiaryCode === 'US')].flatMap(j => j.lines).filter(l => l.accountCode === '3000');
    expect(us.reduce((n, l) => n + BigInt(l.creditMinor) - BigInt(l.debitMinor), 0n)).toBe(16_250_000_00n);
  });

  it('names the group after Quillmesh, and the default profile after the fixture', () => {
    expect(JSON.stringify(q.group)).not.toMatch(/Cafoo (Inc|Ltd)|CAFOO (INC|LTD)/);
    expect(JSON.stringify(q.group)).toMatch(/Quillmesh Ltd/);
    expect(JSON.stringify(base.group)).toMatch(/Cafoo Ltd/);
  });

  it('leaves no new receivable open, so the close checks only the fixture customers', () => {
    const newIdx = new Set(q.customers.slice(base.customers.length).map(c => c.idx));
    const open = q.journalEntries.flatMap(j => j.lines).filter(l => l.accountCode === '1100' && l.customerId !== undefined && newIdx.has(l.customerId));
    expect(open.reduce((n, l) => n + BigInt(l.debitMinor) - BigInt(l.creditMinor), 0n)).toBe(0n);
    expect(q.invoices.filter(i => newIdx.has(i.customerIdx)).every(i => i.status === 'paid')).toBe(true);
  });
});
