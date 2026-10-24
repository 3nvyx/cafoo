import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { CrsClient } from '../src/client.js';
import { fixtureName, loadDataset, parseCsv, personas, requestsFor, testCases } from '../src/csv.js';

describe('csv', () => {
  it('parses quoted fields with commas, quotes and newlines', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",2\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', '2'],
    ]);
  });

  it('loads 207 rows: 180 persona rows and 27 test cases', () => {
    const rows = loadDataset();
    expect(rows).toHaveLength(207);
    expect(rows.filter((r) => r.source === 'persona')).toHaveLength(180);
    expect(testCases()).toHaveLength(27);
  });

  it('lists 20 personas with 9 requests each', () => {
    const ps = personas();
    expect(ps).toHaveLength(20);
    for (const p of ps) expect(requestsFor(p.personaId)).toHaveLength(9);
    expect(requestsFor('p01', 'credit_report')).toHaveLength(3);
  });

  it('keeps request bodies as parsed JSON', () => {
    const [r] = requestsFor('P01', 'pitchpoint_blj');
    expect(r!.body).toEqual({ terms: { term: [{ person: { firstName: 'MARGARET', lastName: 'OKAFOR', ssn: '666701001' } }] } });
  });

  it('has a fixture for every persona row', () => {
    const c = new CrsClient({ mode: 'replay' });
    for (const r of loadDataset().filter((x) => x.source === 'persona')) {
      expect(existsSync(c.fixturePath(r)), fixtureName(r)).toBe(true);
    }
  });
});
