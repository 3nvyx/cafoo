import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runScriptedClose } from '../src/scripted/close';
import { books, fakeCast } from './fake-cast';

vi.mock('../src/stdb', async original => ({
  ...await original<typeof import('../src/stdb')>(),
  sleep: async () => undefined,
}));

beforeEach(() => {
  vi.stubEnv('DEMO_MODE', '1');
  vi.stubEnv('CRS_REPLAY', '1');
  vi.stubEnv('CLOSE_NO_WAIT', '1');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('keeps the bank task incomplete while receipts still need reconciliation or CFO exception acceptance', async () => {
  const fx = fakeCast(books());
  await runScriptedClose(fx.cast, '2026-09');
  const bankUpdates = fx.callsTo('updateCloseTask').filter(call => call.args.taskId === 5n);
  expect(bankUpdates.at(-1)?.args).toMatchObject({ status: 'in_progress' });
  expect(bankUpdates.at(-1)?.args.note).toMatch(/unmatched|exceptions/i);
  expect(fx.callsTo('requestPeriodLock').every(call => !/feed is reconciled/.test(call.args.rationale))).toBe(true);
});
