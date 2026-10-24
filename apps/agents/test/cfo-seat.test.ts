import { describe, expect, it } from 'vitest';
import { claimLink, parseBootstrapSecret } from '../src/cfo-seat';

describe('CFO bootstrap secret', () => {
  it('reads the secret from the claim link or a bare line', () => {
    expect(parseBootstrapSecret('Claim the CFO seat: http://localhost:5173/claim#secret=AbC_12-x9\n')).toBe('AbC_12-x9');
    expect(parseBootstrapSecret('# armed 2026-10-24\n  s3cr3t-value  \n')).toBe('s3cr3t-value');
    expect(parseBootstrapSecret('\n\n')).toBeUndefined();
  });
  it('builds the claim link on the web origin, falling back when it is empty', () => {
    expect(claimLink('a b', 'http://cfo.local:5173/')).toBe('http://cfo.local:5173/claim#secret=a%20b');
    const before = process.env.PUBLIC_WEB_ORIGIN;
    process.env.PUBLIC_WEB_ORIGIN = '';
    try {
      expect(claimLink('x')).toBe('http://localhost:5173/claim#secret=x');
    } finally {
      if (before === undefined) delete process.env.PUBLIC_WEB_ORIGIN;
      else process.env.PUBLIC_WEB_ORIGIN = before;
    }
  });
});
