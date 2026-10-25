import { describe, expect, it } from 'vitest';
import { proofMarkdown, proofSteps, runProofs, type ProofStep } from '../src/proof';

const clock = () => new Date('2026-10-25T06:00:00.000Z');

describe('pnpm proof', () => {
  it('skips a provider without keys instead of faking it, and redacts a failure', async () => {
    const steps: ProofStep[] = [
      { id: 'grok', name: 'Grok', configured: false, run: async () => ({}) },
      { id: 'moss', name: 'Moss', configured: true, run: async () => ({ topHit: 'accruals' }) },
      { id: 'nessie', name: 'Nessie', configured: true, run: async () => { throw new Error('GET https://api.nessieisreal.com/accounts/1/deposits?key=SECRET failed\nstack'); } },
    ];
    const proofs = await runProofs(steps, clock);
    expect(proofs.map(p => [p.id, p.status])).toEqual([['grok', 'skipped'], ['moss', 'proved'], ['nessie', 'failed']]);
    expect(proofs[1]).toMatchObject({ evidence: { topHit: 'accruals' }, ms: expect.any(Number) });
    expect(proofs[2]!.reason).toBe('GET https://api.nessieisreal.com/accounts/1/deposits?… failed');
    expect(JSON.stringify(proofs)).not.toContain('SECRET');
  });

  it('with no keys tries only the local database, and asks before a CRS login or a new deck', () => {
    const steps = proofSteps({ DEMO_MODE: '' }, { crs: false, slides: false });
    expect(steps.filter(s => s.configured).map(s => s.id)).toEqual(['spacetimedb']);
    expect(steps.find(s => s.id === 'crs')?.why).toMatch(/--crs/);
    expect(steps.find(s => s.id === 'slides')?.why).toMatch(/--slides/);
    // Keys alone do not log in to CRS: the flag must be passed too.
    expect(proofSteps({ CRS_USERNAME: 'u', CRS_PASSWORD: 'p' }, { crs: false, slides: false }).find(s => s.id === 'crs')?.configured).toBe(false);
    expect(proofSteps({ NESSIE_API_KEY: 'k' }, { crs: false, slides: false }).find(s => s.id === 'nessie')?.why).toMatch(/configuration refused: NESSIE_ACCOUNT_IDS/);
  });

  it('writes one row per provider with its evidence or reason', async () => {
    const md = proofMarkdown(await runProofs([{ id: 'apify', name: 'Apify', configured: true, run: async () => ({ pages: 3 }) }], clock), 'abc1234');
    expect(md).toContain('Commit abc1234.');
    expect(md).toMatch(/\| Apify \| PROVED \| \d+ ms \| pages: 3 \|/);
    expect(md).toContain('1 proved, 0 failed, 0 skipped.');
  });
});
