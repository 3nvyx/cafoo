// The consolidation checks on a small group ledger built from the seed's figures (roadmap §2.5): Cafoo Inc (USD),
// Cafoo Ltd (GBP) with a $200,000 loan and three $15,000 monthly service fees, and the elimination company. The
// September revaluation gains £3,750.00 on the loan and £654.78 on the payable; the balance elimination is $245,000
// and the activity elimination $15,000, with no difference on any pair. Payloads follow the module wire form.
import { describe, expect, it } from 'vitest';
import type { Row } from '../src/db.js';
import { CHECKS } from '../src/checks.js';
import { FakeDb, type Tables } from '../src/fake-db.js';

const ctx = { asOf: '2026-10-24', vars: { ic_difference_tolerance_minor: 100 } };
const US = 1, UK = 2, ELIM = 3;
const periods = ['2026-07', '2026-08', '2026-09', '2026-10'];
const periodId = (ym: string) => periods.indexOf(ym) + 1;

function ledger(): Tables {
  const accounts: Row[] = [];
  const acct = (subsidiary_id: number, code: string, account_type: string, is_intercompany = false) => accounts.push({ id: accounts.length + 1, subsidiary_id, code, name: code, account_type, is_intercompany, sort_order: 0 });
  acct(US, '1000', 'asset'); acct(US, '1900', 'asset', true); acct(US, '1950', 'asset', true); acct(US, '3000', 'equity'); acct(US, '4900', 'revenue', true); acct(US, '7100', 'expense');
  acct(UK, '1000-UK', 'asset'); acct(UK, '2900-UK', 'liability', true); acct(UK, '2950-UK', 'liability', true); acct(UK, '3000-UK', 'equity'); acct(UK, '5900-UK', 'expense', true); acct(UK, '7100-UK', 'expense');
  for (const [code, type] of [['1900-ELIM', 'asset'], ['1950-ELIM', 'asset'], ['2900-ELIM', 'liability'], ['2950-ELIM', 'liability'], ['4900-ELIM', 'revenue'], ['5900-ELIM', 'expense']] as const) acct(ELIM, code, type, true);

  const journal_entry: Row[] = [];
  const journal_line: Row[] = [];
  const entry = (subsidiary_id: number, ym: string, lines: [string, number, number, string, number][], proposal_id: number | null = null) => {
    const id = journal_entry.length + 1;
    journal_entry.push({ id, subsidiary_id, period_id: periodId(ym), memo: `entry ${id}`, source: proposal_id === null ? 'seed' : 'agent', proposal_id, reversal_of: null });
    for (const [code, debit_minor, credit_minor, ccy, fx_rate_e_6] of lines) journal_line.push({ id: journal_line.length + 1, je_id: id, account_code: code, debit_minor, credit_minor, ccy, fx_rate_e_6 });
  };
  entry(UK, '2026-07', [['1000-UK', 2_000_000, 0, 'GBP', 1_000_000], ['3000-UK', 0, 2_000_000, 'GBP', 1_000_000]]);
  entry(UK, '2026-07', [['1000-UK', 16_000_000, 0, 'GBP', 1_000_000], ['2950-UK', 0, 20_000_000, 'USD', 800_000]]);
  entry(US, '2026-07', [['1950', 20_000_000, 0, 'USD', 1_000_000], ['3000', 0, 20_000_000, 'USD', 1_000_000]]);
  for (const [ym, avg] of [['2026-07', 800_000], ['2026-08', 800_000], ['2026-09', 787_402]] as const) {
    entry(US, ym, [['1900', 1_500_000, 0, 'USD', 1_000_000], ['4900', 0, 1_500_000, 'USD', 1_000_000]]);
    entry(UK, ym, [['5900-UK', 1_500_000, 0, 'USD', avg], ['2900-UK', 0, 1_500_000, 'USD', avg]]);
  }
  const rate = (from_ccy: string, to_ccy: string, ym: string, kind: string, rate_e_6: number) => ({ from_ccy, to_ccy, ym, kind, rate_e_6 });
  const fx_rate = [
    ...['2026-07', '2026-08'].flatMap(ym => [rate('GBP', 'USD', ym, 'average', 1_250_000), rate('GBP', 'USD', ym, 'closing', 1_250_000), rate('USD', 'GBP', ym, 'average', 800_000), rate('USD', 'GBP', ym, 'closing', 800_000)]),
    rate('GBP', 'USD', '2026-09', 'average', 1_270_000), rate('GBP', 'USD', '2026-09', 'closing', 1_280_000), rate('USD', 'GBP', '2026-09', 'average', 787_402), rate('USD', 'GBP', '2026-09', 'closing', 781_250),
  ].map((r, i) => ({ id: i + 1, ...r }));

  const line = (accountCode: string, debit: number, credit: number, ccy: string) => ({ accountCode, debitMinor: String(debit), creditMinor: String(credit), ccy, fxRateE6: '1000000' });
  const revaluation = {
    subsidiaryId: String(UK), periodYm: '2026-09', rateYm: '2026-09', memo: 'Revalue Cafoo Ltd dollar balances at the September closing rate',
    items: [
      { accountCode: '2950-UK', ccy: 'USD', txnBalanceMinor: '-20000000', closingRateE6: '781250', bookedFunctionalMinor: '-16000000', targetFunctionalMinor: '-15625000', deltaMinor: '375000' },
      { accountCode: '2900-UK', ccy: 'USD', txnBalanceMinor: '-4500000', closingRateE6: '781250', bookedFunctionalMinor: '-3581103', targetFunctionalMinor: '-3515625', deltaMinor: '65478' },
    ],
    lines: [line('2950-UK', 375_000, 0, 'GBP'), line('2900-UK', 65_478, 0, 'GBP'), line('7100-UK', 0, 440_478, 'GBP')],
  };
  const pair = (label: string, src: string, counter: string, amount: number) => ({ label, sourceSubsidiaryId: String(US), sourceAccountCode: src, counterSubsidiaryId: String(UK), counterAccountCode: counter, amountMinor: String(amount), counterTranslatedMinor: String(amount), differenceMinor: '0' });
  const balance = {
    subsidiaryId: String(ELIM), periodYm: '2026-09', memo: 'Remove balances Cafoo Inc and Cafoo Ltd owe each other', basis: 'balance', reversesInYm: '2026-10',
    pairs: [pair('Intercompany balance', '1900', '2900-UK', 4_500_000), pair('Loan', '1950', '2950-UK', 20_000_000)],
    lines: [line('2900-ELIM', 4_500_000, 0, 'USD'), line('2950-ELIM', 20_000_000, 0, 'USD'), line('1900-ELIM', 0, 4_500_000, 'USD'), line('1950-ELIM', 0, 20_000_000, 'USD')],
  };
  const activity = {
    subsidiaryId: String(ELIM), periodYm: '2026-09', memo: 'Remove the service fees Cafoo Inc charged Cafoo Ltd in September', basis: 'activity',
    pairs: [pair('Service fees', '4900', '5900-UK', 1_500_000)],
    lines: [line('4900-ELIM', 1_500_000, 0, 'USD'), line('5900-ELIM', 0, 1_500_000, 'USD')],
  };
  const proposal = (id: number, kind: string, payload: unknown) => ({ id, kind, status: 'open', proposer_role: 'consolidation', period_id: periodId('2026-09'), amount_minor: 0, payload_json: JSON.stringify(payload) });
  return {
    subsidiary: [
      { id: US, code: 'US', name: 'Cafoo Inc', functional_ccy: 'USD', parent_id: null, is_elimination: false },
      { id: UK, code: 'UK', name: 'Cafoo Ltd', functional_ccy: 'GBP', parent_id: US, is_elimination: false },
      { id: ELIM, code: 'ELIM', name: 'Group eliminations', functional_ccy: 'USD', parent_id: US, is_elimination: true },
    ],
    account: accounts,
    period: periods.map((ym, i) => ({ id: i + 1, ym, status: 'open' })),
    journal_entry,
    journal_line,
    fx_rate,
    settings: [{ key: 'reporting_ccy', value_i_64: 0, value_text: 'USD' }],
    proposal: [proposal(101, 'fx_revaluation', revaluation), proposal(102, 'ic_elimination', balance), proposal(103, 'ic_elimination', activity)],
    agent_message: [],
  };
}

type Payload = Record<string, any>;
const edit = (t: Tables, id: number, f: (p: Payload) => void) => {
  const row = t.proposal!.find(p => p.id === id)!;
  const p = JSON.parse(String(row.payload_json)) as Payload;
  f(p);
  row.payload_json = JSON.stringify(p);
};
const check = async (name: string, t: Tables, params: Record<string, unknown> = {}) => CHECKS[name]!(new FakeDb(t), params, ctx);
const problems = async (name: string, t: Tables) => (await check(name, t)).offenders.map(o => String(o.problem));

describe('fx_revaluation_rates', () => {
  it('passes the September revaluation of the loan and the payable at the closing rate', async () => {
    const r = await check('fx_revaluation_rates', ledger());
    expect(r.offenders).toEqual([]);
    expect(r.checked).toBe(3);
  });

  it('still passes once the revaluation has posted (its own entry is not part of the balance it restated)', async () => {
    const t = ledger();
    const id = t.journal_entry!.length + 1;
    t.journal_entry!.push({ id, subsidiary_id: UK, period_id: periodId('2026-09'), memo: 'revaluation', source: 'agent', proposal_id: 101, reversal_of: null });
    for (const [code, d, c] of [['2950-UK', 375_000, 0], ['2900-UK', 65_478, 0], ['7100-UK', 0, 440_478]] as const) t.journal_line!.push({ id: t.journal_line!.length + 1, je_id: id, account_code: code, debit_minor: d, credit_minor: c, ccy: 'GBP', fx_rate_e_6: 1_000_000 });
    expect(await problems('fx_revaluation_rates', t)).toEqual([]);
  });

  it('refuses the average rate, a delta that does not follow from the books, and a missed foreign balance', async () => {
    const avg = ledger();
    edit(avg, 101, p => (p.items[0].closingRateE6 = '787402'));
    expect(await problems('fx_revaluation_rates', avg)).toContain('rate 787402 is not the 2026-09 closing rate 781250');

    const delta = ledger();
    edit(delta, 101, p => {
      p.items[0].deltaMinor = '400000';
      p.lines[0].debitMinor = '400000';
      p.lines[2].creditMinor = '465478';
    });
    expect(await problems('fx_revaluation_rates', delta)).toContain('delta 400000 but target minus booked is 375000');

    const missed = ledger();
    edit(missed, 101, p => {
      p.items.pop();
      p.lines = [p.lines[0], { ...p.lines[2], creditMinor: '375000' }];
    });
    expect(await problems('fx_revaluation_rates', missed)).toEqual(['USD balance -4500000 is not revalued']);
  });

  it("refuses restating a balance in the subsidiary's own currency, an expense account, a foreign line and a wrong offset", async () => {
    const own = ledger();
    edit(own, 101, p => p.items.push({ accountCode: '1000-UK', ccy: 'GBP', txnBalanceMinor: '18000000', closingRateE6: '1000000', bookedFunctionalMinor: '18000000', targetFunctionalMinor: '18000000', deltaMinor: '0' }));
    expect(await problems('fx_revaluation_rates', own)).toContain("revalues a GBP balance, the subsidiary's own currency");

    const pl = ledger();
    edit(pl, 101, p => p.items.push({ accountCode: '5900-UK', ccy: 'USD', txnBalanceMinor: '4500000', closingRateE6: '781250', bookedFunctionalMinor: '3581103', targetFunctionalMinor: '3515625', deltaMinor: '-65478' }));
    expect((await problems('fx_revaluation_rates', pl)).some(x => /revalues a expense account/.test(x))).toBe(true);

    const usdLine = ledger();
    edit(usdLine, 101, p => (p.lines[0].ccy = 'USD'));
    expect(await problems('fx_revaluation_rates', usdLine)).toContain('line in USD at 1000000; revaluation lines are in GBP at 1000000');

    const offset = ledger();
    edit(offset, 101, p => (p.lines[2].accountCode = '3000-UK'));
    expect(await problems('fx_revaluation_rates', offset)).toContain("offset line on 3000-UK; the gain or loss goes to UK's 7100 account");
  });
});

describe('ic_elimination_amounts', () => {
  it('passes the $245,000 balance elimination and the $15,000 activity elimination', async () => {
    const r = await check('ic_elimination_amounts', ledger());
    expect(r.offenders).toEqual([]);
    expect(r.checked).toBe(5);
  });

  it('refuses an amount the books do not hold, on either basis', async () => {
    const t = ledger();
    edit(t, 102, p => {
      p.pairs[1].amountMinor = '21000000';
      p.pairs[1].counterTranslatedMinor = '21000000';
      p.lines[1].debitMinor = '21000000';
      p.lines[3].creditMinor = '21000000';
    });
    edit(t, 103, p => {
      p.pairs[0].amountMinor = '4500000';
      p.pairs[0].counterTranslatedMinor = '4500000';
    });
    const found = await problems('ic_elimination_amounts', t);
    expect(found).toContain('eliminates 21000000 but the books hold 20000000 through 2026-09');
    expect(found).toContain('eliminates 4500000 but the books hold 1500000 of 2026-09 activity');
  });

  it('refuses lines that do not take the pair amounts off both sides', async () => {
    const t = ledger();
    edit(t, 102, p => {
      p.lines[0].debitMinor = '4000000';
      p.lines[2].creditMinor = '4000000';
    });
    expect((await problems('ic_elimination_amounts', t)).sort()).toEqual(['lines move group account 1900 by -4000000; the books call for -4500000', 'lines move group account 2900 by 4000000; the books call for 4500000']);
  });

  it('refuses a posting outside the elimination company, a missing reversal month, and a reversal on activity', async () => {
    const t = ledger();
    edit(t, 102, p => {
      p.subsidiaryId = String(US);
      delete p.reversesInYm;
    });
    edit(t, 103, p => (p.reversesInYm = '2026-10'));
    const found = await problems('ic_elimination_amounts', t);
    expect(found).toContain('posts to US, which is not the elimination subsidiary');
    expect(found).toContain('a balance elimination reverses in a later month than 2026-09; reversesInYm is ""');
    expect(found).toContain('line on 2900-ELIM, not an intercompany account of US');
    expect(found).toContain("an activity elimination covers one month's results and never reverses");
  });

  it('refuses a source subsidiary outside the reporting currency', async () => {
    const t = ledger();
    edit(t, 102, p => {
      p.pairs[1] = { ...p.pairs[1], sourceSubsidiaryId: String(UK), sourceAccountCode: '2950-UK', counterSubsidiaryId: String(US), counterAccountCode: '1950' };
    });
    expect((await problems('ic_elimination_amounts', t)).some(x => /keeps its books in GBP, not the reporting currency USD/.test(x))).toBe(true);
  });
});

describe('ic_difference_escalated', () => {
  const withDifference = () => {
    const t = ledger();
    edit(t, 102, p => {
      p.pairs[1].counterTranslatedMinor = '19950000';
      p.pairs[1].differenceMinor = '50000';
    });
    return t;
  };

  it('passes when every pair agrees within a dollar', async () => {
    const t = ledger();
    edit(t, 102, p => {
      p.pairs[0].counterTranslatedMinor = '4499900';
      p.pairs[0].differenceMinor = '100';
    });
    expect(await check('ic_difference_escalated', t)).toEqual({ checked: 0, unit: 'intercompany differences over the tolerance', offenders: [] });
  });

  it('fails a $500 difference nobody raised, and passes once the consolidation agent raises it in the close thread', async () => {
    const t = withDifference();
    expect(await problems('ic_difference_escalated', t)).toEqual(['a 50000 difference is not raised by consolidation in close:2026-09']);
    t.agent_message!.push({ id: 1, thread_id: 'close:2026-09', sender_role: 'consolidation', kind: 'statement', body: 'Loan: Cafoo Inc holds $200,000 but Cafoo Ltd translates to $199,500; the $500 difference needs a person.', summary_plain: 'The two companies disagree on the loan by $500.', proposal_id: null, created_at: 1 });
    expect(await problems('ic_difference_escalated', t)).toEqual([]);
  });

  it('does not count a message in another thread, from another role, or about another pair', async () => {
    for (const m of [
      { thread_id: 'close:2026-08', sender_role: 'consolidation', body: 'Loan difference of $500.' },
      { thread_id: 'close:2026-09', sender_role: 'advisor', body: 'Loan difference of $500.' },
      { thread_id: 'close:2026-09', sender_role: 'consolidation', body: 'Service fees difference of $500.' },
    ]) {
      const t = withDifference();
      t.agent_message!.push({ id: 1, kind: 'statement', summary_plain: '', proposal_id: null, created_at: 1, ...m });
      expect((await check('ic_difference_escalated', t)).offenders, JSON.stringify(m)).toHaveLength(1);
    }
  });

  it('takes the tolerance from params over the variable', async () => {
    expect((await check('ic_difference_escalated', withDifference(), { tolerance_minor: 50_000 })).offenders).toEqual([]);
  });
});
