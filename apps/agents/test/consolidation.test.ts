import { describe, expect, it } from 'vitest';
import { checkCall, harnessFor, HARNESSES, WORKERS } from '../src/harness';
import { call, ruleSuite } from './helpers';

const h = HARNESSES.consolidation;
const T = (name: string) => `mcp__consolidation__${name}`;

/** The September revaluation of Cafoo Ltd's dollar loan (contract §2.3). */
const revaluation = (over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) =>
  call(T('propose_fx_revaluation'), {
    subsidiaryId: '2',
    periodYm: '2026-09',
    rateYm: '2026-09',
    memo: 'Revalue Cafoo Ltd dollar balances at the September closing rate',
    items: [{ accountCode: '2950-UK', ccy: 'USD', txnBalanceMinor: '-20000000', closingRateE6: '781250', bookedFunctionalMinor: '-16000000', targetFunctionalMinor: '-15625000', deltaMinor: '375000', ...item }],
    lines: [
      { accountCode: '2950-UK', debitMinor: '375000', creditMinor: '0', ccy: 'GBP', fxRateE6: '1000000' },
      { accountCode: '7100-UK', debitMinor: '0', creditMinor: '375000', ccy: 'GBP', fxRateE6: '1000000' },
    ],
    amountMinor: '476250',
    rationale: 'The dollar loan is booked at the August rate; restate it at the September closing rate of 0.78125.',
    summaryPlain: "Restate the $200,000 loan Cafoo Ltd owes Cafoo Inc at September's closing rate, a £3,750 gain.",
    ...over,
  });

const pair = (over: Record<string, unknown> = {}) => ({
  label: 'Loan',
  sourceSubsidiaryId: '1',
  sourceAccountCode: '1950',
  counterSubsidiaryId: '2',
  counterAccountCode: '2950-UK',
  amountMinor: '20000000',
  counterTranslatedMinor: '20000000',
  differenceMinor: '0',
  ...over,
});
/** The September balance elimination of the loan (contract §2.3). */
const elimination = (over: Record<string, unknown> = {}) =>
  call(T('propose_ic_elimination'), {
    subsidiaryId: '3',
    periodYm: '2026-09',
    memo: 'Remove balances Cafoo Inc and Cafoo Ltd owe each other',
    basis: 'balance',
    reversesInYm: '2026-10',
    pairs: [pair()],
    lines: [
      { accountCode: '2950-ELIM', debitMinor: '20000000', creditMinor: '0', ccy: 'USD', fxRateE6: '1000000' },
      { accountCode: '1950-ELIM', debitMinor: '0', creditMinor: '20000000', ccy: 'USD', fxRateE6: '1000000' },
    ],
    amountMinor: '20000000',
    rationale: 'Cafoo Inc lends Cafoo Ltd $200,000; the group owes nothing to itself.',
    summaryPlain: "Remove the $200,000 Cafoo Inc and Cafoo Ltd owe each other from the group's combined balance sheet; it reverses in October.",
    ...over,
  });
const activity = (over: Record<string, unknown> = {}) =>
  elimination({
    basis: 'activity',
    reversesInYm: undefined,
    memo: 'Remove service fees Cafoo Inc charged Cafoo Ltd in September',
    pairs: [pair({ label: 'Service fees', sourceAccountCode: '4900', counterAccountCode: '5900-UK', amountMinor: '1500000', counterTranslatedMinor: '1500000' })],
    lines: [
      { accountCode: '4900-ELIM', debitMinor: '1500000', creditMinor: '0', ccy: 'USD', fxRateE6: '1000000' },
      { accountCode: '5900-ELIM', debitMinor: '0', creditMinor: '1500000', ccy: 'USD', fxRateE6: '1000000' },
    ],
    summaryPlain: "Remove the $15,000 of fees Cafoo Inc charged Cafoo Ltd in September from the group's combined results.",
    ...over,
  });
const differing = (diff = '250') => elimination({ pairs: [pair({ counterTranslatedMinor: String(20000000 - Number(diff)), differenceMinor: diff })] });
const raise = (body: string, threadId = 'close:2026-09') => call(T('post_message'), { threadId, body, summaryPlain: 'The Consolidation agent found a gap between the two companies.' });
const codes = { accountCodes: ['1950', '2950-UK', '7100-UK', '1950-ELIM', '2950-ELIM'] };

ruleSuite(h, {
  'consolidation.may.1': {
    allow: [{ call: revaluation() }, { call: elimination() }, { call: activity() }, { call: call(T('revaluation_candidates'), { periodYm: '2026-09' }) }],
    deny: [
      { call: call(T('propose_journal_entry'), { periodYm: '2026-09', lines: [] }), why: /currency revaluations, intercompany eliminations and nothing else, not journal entries/ },
      { call: call(T('propose_bank_match'), { matches: [] }), why: /not bank matches/ },
      { call: elimination({ reversesInYm: '2026-09' }), why: /reverses in a later month than 2026-09/ },
      { call: activity({ reversesInYm: '2026-10' }), why: /never reverses/ },
      { call: elimination({ basis: 'cumulative' }), why: /basis is balance or activity/ },
      { call: elimination({ pairs: [pair({ amountMinor: '0' })] }), why: /positive amountMinor; not Loan/ },
      { call: elimination({ pairs: [] }), why: /lists the intercompany pairs/ },
      { call: revaluation({ items: [] }), why: /lists the balances it restates/ },
      { call: revaluation({ lines: [{ accountCode: '2950-UK', debitMinor: '375000', creditMinor: '0' }, { accountCode: '7100-UK', debitMinor: '0', creditMinor: '370000' }] }), why: /do not balance/ },
      { call: revaluation({ lines: [{ accountCode: '2950-UK', debitMinor: '375000', creditMinor: '375000' }, { accountCode: '7100-UK', debitMinor: '0', creditMinor: '0' }] }), why: /either a debit or a credit/ },
      { call: revaluation({ subsidiaryId: 'UK' }), why: /numeric subsidiary id/ },
      { call: revaluation({ periodYm: 'September' }), why: /periodYm must be YYYY-MM/ },
    ],
  },
  'consolidation.may.2': {
    allow: [{ call: revaluation() }, { call: revaluation({ rateYm: undefined }) }, { call: elimination() }],
    deny: [
      { call: revaluation({}, { ccy: 'GBP' }), why: /other than the company's own/ },
      { call: revaluation({}, { targetFunctionalMinor: '-15748031', deltaMinor: '251969' }), why: /at the closing rate 781250 is -15625000, not -15748031/ },
      { call: revaluation({}, { deltaMinor: '400000' }), why: /deltaMinor is target minus booked, 375000, not 400000/ },
      { call: revaluation({ rateYm: '2026-08' }), why: /closing rate of 2026-09, not 2026-08/ },
      { call: revaluation({}, { closingRateE6: '0' }), why: /whole numbers/ },
      {
        call: revaluation({ lines: [{ accountCode: '2950-UK', debitMinor: '300000', creditMinor: '0', ccy: 'GBP' }, { accountCode: '7100-UK', debitMinor: '0', creditMinor: '300000', ccy: 'GBP' }] }),
        why: /move this account by 300000, not by its delta 375000/,
      },
    ],
  },
  'consolidation.never.1': {
    allow: [{ call: elimination() }],
    deny: [{ call: call('mcp__advisor__approve_proposal', { proposalId: '3', rationale: 'x', summaryPlain: 'x' }), why: /posts to the ledger/ }],
  },
  'consolidation.never.2': {
    allow: [{ call: call(T('update_close_task'), { taskId: '6', status: 'in_progress', note: 'revaluing' }) }],
    deny: [
      { call: call('mcp__advisor__reject_proposal', { proposalId: '3' }), why: /only the Advisor rules/ },
      { call: call(T('update_close_task'), { taskId: '6', status: 'done', note: 'x' }), why: /marks a close task done/ },
    ],
  },
  'consolidation.escalates.1': {
    allow: [
      { call: elimination(), ctx: { history: [] } },
      // Within the one-dollar tolerance.
      { call: differing('100'), ctx: { history: [] } },
      { call: differing(), ctx: { history: [raise('The two books differ on the Loan by $2.50: Cafoo Ltd shows less than Cafoo Inc.')] } },
      // No history known: the eval checks it instead.
      { call: differing() },
    ],
    deny: [
      { call: differing(), ctx: { history: [] }, why: /Loan differs by more than one dollar.*close:2026-09/ },
      { call: differing(), ctx: { history: [raise('The two books differ on the Loan by $2.50.', 'close:2026-08')] }, why: /Loan differs/ },
      { call: differing(), ctx: { history: [raise('Something about the service fees differs.')] }, why: /Loan differs/ },
      // The stated difference is zero but the two sides are $5 apart: the eval reads the larger.
      { call: elimination({ pairs: [pair({ counterTranslatedMinor: '19999500', differenceMinor: '0' })] }), ctx: { history: [] }, why: /Loan differs/ },
    ],
  },
  'consolidation.plain': {
    allow: [{ call: revaluation(), ctx: codes }, { call: elimination(), ctx: codes }, { call: activity(), ctx: codes }],
    deny: [
      { call: revaluation({ summaryPlain: 'Revalue 2950-UK at the closing rate.' }), ctx: codes, why: /account code 2950/ },
      { call: elimination({ summaryPlain: 'Eliminate 20000000 of intercompany balances.' }), ctx: codes, why: /raw number "20000000"/ },
      { call: elimination({ summaryPlain: 'Remove the loan. It reverses in October.' }), ctx: codes, why: /more than one sentence/ },
    ],
  },
});

describe('consolidation harness', () => {
  it('is a worker with its own tool server, refused everything else', () => {
    expect(WORKERS).toContain('consolidation');
    expect(harnessFor('consolidation')).toBe(h);
    expect(checkCall(h, revaluation(), codes)).toEqual({ allow: true });
    expect(checkCall(h, call('mcp__bookkeeper__propose_bank_match', { matches: [] }))).toMatchObject({ allow: false, ruleIds: ['consolidation.tools'] });
    expect(checkCall(HARNESSES.bookkeeper, revaluation())).toMatchObject({ allow: false, ruleIds: ['bookkeeper.tools'] });
  });

  it('names every broken rule at once', () => {
    const d = checkCall(h, revaluation({ summaryPlain: 'Revalue 2950-UK.' }, { deltaMinor: '1' }), codes);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.ruleIds.sort()).toEqual(['consolidation.may.2', 'consolidation.plain']);
  });
});
