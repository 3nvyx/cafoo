/**
 * The close order in the agents (docs/adr/0014): a close starts only once every earlier month is locked. The database
 * is the in-memory fake cast with rulings applied; waits are skipped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeStartRefusal } from '../src/close-state';
import { runScriptedClose } from '../src/scripted/close';
import { books, fakeCast, type Rows } from './fake-cast';

vi.mock('../src/stdb', async importOriginal => ({ ...(await importOriginal<typeof import('../src/stdb')>()), sleep: vi.fn(async () => undefined) }));

beforeEach(() => {
  vi.stubEnv('DEMO_MODE', '1');
  vi.stubEnv('CRS_REPLAY', '1');
  vi.stubEnv('CRS_USERNAME', '');
  vi.stubEnv('CLOSE_NO_WAIT', '1');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const withAugust = (status: string, r: Rows = books()) => {
  r.period!.find(p => p.ym === '2026-08')!.status = { tag: status };
  return r;
};

describe('closeStartRefusal', () => {
  it('lets the first open month after the locked ones start, whatever the later months are', () => {
    expect(closeStartRefusal(fakeCast(books()).cast.advisor, '2026-09')).toBeUndefined();
  });

  it('refuses a month the books do not have, a locked month, and a month after one that is not locked', () => {
    const c = fakeCast(withAugust('Closing')).cast.advisor;
    expect(closeStartRefusal(c, '2026-12')).toBe('The books have no December 2026 yet, so there is nothing to close.');
    expect(closeStartRefusal(fakeCast(books()).cast.advisor, '2026-08')).toBe('August 2026 is already locked. Unlock it before running its close again.');
    expect(closeStartRefusal(c, '2026-09')).toBe('The September 2026 close cannot start while August 2026 is not locked: months close in order. Lock August 2026 first.');
    expect(closeStartRefusal(c, '2026-10')).toBe('The October 2026 close cannot start while August 2026 and September 2026 are not locked: months close in order. Lock August 2026 first.');
  });
});

describe('the scripted close', () => {
  it('refuses to start while an earlier month is not locked, before it says or files anything', async () => {
    const fx = fakeCast(withAugust('Open'), { rulings: true });
    await expect(runScriptedClose(fx.cast, '2026-09')).rejects.toThrow('The September 2026 close cannot start while August 2026 is not locked');
    expect(fx.calls).toEqual([]);
  });
});
