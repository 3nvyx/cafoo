import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keywordSearch, queryTerms, search, stem } from '../src/moss';

const dir = join(__dirname, '../../../fixtures/moss');
const policies = readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => ({ id: f.replace(/\.md$/, ''), text: readFileSync(join(dir, f), 'utf8') }));

afterEach(() => vi.unstubAllEnvs());

describe('stem', () => {
  it('folds plurals and inflections onto one root', () => {
    expect(stem('reserves')).toBe(stem('reserve'));
    expect(stem('policies')).toBe('policy');
    expect(stem('accruals')).toBe('accrual');
    expect(stem('accrued')).toBe('accru');
    expect(stem('reconciliation').startsWith(stem('reconcile'))).toBe(true);
    // Words that only look plural stay whole.
    expect(stem('business')).toBe('business');
    expect(stem('status')).toBe('status');
    expect(stem('basis')).toBe('basis');
  });
  it('adds the finance synonyms a question uses for a policy word', () => {
    expect(queryTerms('What is our policy on bad debt reserves?')).toEqual(['policy', 'debt', 'allowanc', 'doubtful', 'reserv']);
    expect(queryTerms('write-off rules')).toContain('allowanc');
  });
});

describe('local keyword search', () => {
  it('ranks the credit and allowance policy first for "bad debt reserves"', () => {
    const hits = keywordSearch(policies, 'What is our policy on bad debt reserves?', 2);
    expect(hits[0]).toMatchObject({ id: 'credit-and-allowance', via: 'local' });
    expect(hits[0]!.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });
  it('still finds the accruals policy for an accruals question', () => {
    expect(keywordSearch(policies, 'What is our policy on accruals for bills dated after month end?', 1)[0]!.id).toBe('accruals');
    expect(keywordSearch(policies, 'how do we reconcile the bank?', 1)[0]!.id).toBe('bank-reconciliation');
  });
  it('scores a title hit above a body hit, and keeps document order on a tie', () => {
    const docs = [
      { id: 'a', text: 'Travel\nReceipts for every reserve are kept.' },
      { id: 'b', text: 'Reserves\nHow the reserve is set.' },
      { id: 'c', text: 'Other\nA reserve again.' },
    ];
    expect(keywordSearch(docs, 'reserve', 3).map(h => [h.id, h.score])).toEqual([['b', 2], ['a', 1], ['c', 1]]);
    expect(keywordSearch(docs, 'nothing matches', 3)).toEqual([]);
  });
  it('is what search returns when Moss is not configured', async () => {
    vi.stubEnv('MOSS_PROJECT_ID', '');
    const hits = await search('cafoo-policies-test', policies, 'bad debt reserves', 1);
    expect(hits).toEqual(keywordSearch(policies, 'bad debt reserves', 1));
  });
});
