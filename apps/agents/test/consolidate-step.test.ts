import { describe, expect, it } from 'vitest';
import { applyFx, ymFromString, type Account, type Entity, type FxRate, type JournalLine } from '@cafoo/ledger-core';
import { alreadyDoneRefusal, planConsolidation, runConsolidationStep } from '../src/scripted/consolidate';
import { eliminationCritique, type Refusal } from '../src/scripted/rulings';
import type { Cast } from '../src/stdb';
import { fakeConn } from './fake-conn';
import type { GroupSnapshot } from '../src/snapshot';
import { checkCall, HARNESSES } from '../src/harness';
import { plainSummaryProblems } from '../src/harness/rules';

/** The seeded group of contract §2.5: Cafoo Inc (USD), Cafoo Ltd (GBP), group eliminations; July to September. */
function group(opts: { feeCounterUsd?: bigint } = {}): GroupSnapshot {
  const entities: Entity[] = [
    { id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', isElimination: false },
    { id: 2n, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: 1n, isElimination: false },
    { id: 3n, code: 'ELIM', name: 'Group eliminations', functionalCcy: 'USD', parentId: 1n, isElimination: true },
  ];
  let nextId = 100n;
  const accounts: Account[] = [];
  const acct = (subsidiaryId: bigint, code: string, type: Account['type'], isIntercompany = false) => {
    const a = { id: nextId++, subsidiaryId, code, name: code, type, isIntercompany };
    accounts.push(a);
    return a.id;
  };
  const A = {
    cash: acct(1n, '1000', 'asset'),
    due: acct(1n, '1900', 'asset', true),
    loan: acct(1n, '1950', 'asset', true),
    capital: acct(1n, '3000', 'equity'),
    fees: acct(1n, '4900', 'revenue', true),
    fx: acct(1n, '7100', 'expense'),
    ukCash: acct(2n, '1000-UK', 'asset'),
    ukDue: acct(2n, '2900-UK', 'liability', true),
    ukLoan: acct(2n, '2950-UK', 'liability', true),
    ukCapital: acct(2n, '3000-UK', 'equity'),
    ukFees: acct(2n, '5900-UK', 'expense', true),
    ukFx: acct(2n, '7100-UK', 'expense'),
  };
  for (const [code, type] of [['1900-ELIM', 'asset'], ['1950-ELIM', 'asset'], ['2900-ELIM', 'liability'], ['2950-ELIM', 'liability'], ['4900-ELIM', 'revenue'], ['5900-ELIM', 'expense']] as const) acct(3n, code, type, true);
  const rates: FxRate[] = [];
  const rate = (ym: string, gbpUsd: [bigint, bigint], usdGbp: [bigint, bigint]) => {
    rates.push({ fromCcy: 'GBP', toCcy: 'USD', ym: ymFromString(ym), rateE6: gbpUsd[0], kind: 'average' }, { fromCcy: 'GBP', toCcy: 'USD', ym: ymFromString(ym), rateE6: gbpUsd[1], kind: 'closing' });
    rates.push({ fromCcy: 'USD', toCcy: 'GBP', ym: ymFromString(ym), rateE6: usdGbp[0], kind: 'average' }, { fromCcy: 'USD', toCcy: 'GBP', ym: ymFromString(ym), rateE6: usdGbp[1], kind: 'closing' });
  };
  rate('2026-07', [1250000n, 1250000n], [800000n, 800000n]);
  rate('2026-08', [1250000n, 1250000n], [800000n, 800000n]);
  rate('2026-09', [1270000n, 1280000n], [787402n, 781250n]);
  rate('2026-10', [1280000n, 1280000n], [781250n, 781250n]);
  const lines: JournalLine[] = [];
  let lineId = 1n;
  let jeId = 1n;
  const entry = (ym: string, ls: [bigint, bigint, bigint, string, bigint][]) => {
    const je = jeId++;
    for (const [accountId, debitMinor, creditMinor, ccy, fxRateE6] of ls) lines.push({ id: lineId++, jeId: je, ym: ymFromString(ym), postedAt: 0n, source: 'seed', accountId, debitMinor, creditMinor, ccy, fxRateE6 });
  };
  const E6 = 1_000_000n;
  entry('2026-07', [[A.ukCash, 2_000_000n, 0n, 'GBP', E6], [A.ukCapital, 0n, 2_000_000n, 'GBP', E6]]);
  entry('2026-07', [[A.ukCash, 16_000_000n, 0n, 'GBP', E6], [A.ukLoan, 0n, 20_000_000n, 'USD', 800000n]]);
  entry('2026-07', [[A.loan, 20_000_000n, 0n, 'USD', E6], [A.capital, 0n, 20_000_000n, 'USD', E6]]);
  for (const [ym, avg] of [['2026-07', 800000n], ['2026-08', 800000n], ['2026-09', 787402n]] as const) {
    entry(ym, [[A.due, 1_500_000n, 0n, 'USD', E6], [A.fees, 0n, 1_500_000n, 'USD', E6]]);
    const fee = ym === '2026-09' && opts.feeCounterUsd ? opts.feeCounterUsd : 1_500_000n;
    entry(ym, [[A.ukFees, fee, 0n, 'USD', avg], [A.ukDue, 0n, fee, 'USD', avg]]);
  }
  // A USD line in a GBP company is functional at its rate; keep the fixture honest about that.
  expect(applyFx(1_500_000n, 787402n)).toBe(1_181_103n);
  return {
    entities,
    accounts,
    accountsById: new Map(accounts.map(a => [a.id, a])),
    lines,
    rates,
    reportingCcy: 'USD',
    periodIdOf: (ym: string) => ({ '2026-07': 7n, '2026-08': 8n, '2026-09': 9n, '2026-10': 10n })[ym],
  };
}

const codes = () => group().accounts.map(a => a.code);
const asCall = (d: ReturnType<typeof planConsolidation>['revaluations'][number]) => ({
  tool: d.kind === 'fx_revaluation' ? 'mcp__consolidation__propose_fx_revaluation' : 'mcp__consolidation__propose_ic_elimination',
  input: { ...d.payload, rationale: d.rationale, summaryPlain: d.summaryPlain, periodYm: d.periodYm, amountMinor: d.amountMinor.toString() },
});

describe('planConsolidation on the seeded group', () => {
  const plan = planConsolidation(group(), '2026-09', { toleranceMinor: 100n });

  it("revalues Cafoo Ltd's dollar loan and payable at September's closing rate: a £4,404.78 gain", () => {
    expect(plan.group).toBe(true);
    expect(plan.revaluations).toHaveLength(1);
    const r = plan.revaluations[0]!;
    const p = r.payload as { subsidiaryId: string; rateYm: string; items: { accountCode: string; deltaMinor: string; closingRateE6: string }[]; lines: { accountCode: string; debitMinor: string; creditMinor: string; ccy: string }[] };
    expect(p.subsidiaryId).toBe('2');
    expect(p.rateYm).toBe('2026-09');
    expect(p.items.map(i => [i.accountCode, i.deltaMinor, i.closingRateE6])).toEqual([['2900-UK', '65478', '781250'], ['2950-UK', '375000', '781250']]);
    expect(p.lines.find(l => l.accountCode === '7100-UK')).toMatchObject({ debitMinor: '0', creditMinor: '440478', ccy: 'GBP' });
    // £4,404.78 at the September closing rate of 1.28: under the $10,000 materiality threshold.
    expect(r.amountMinor).toBe(563812n);
    expect(r.summaryPlain).toMatch(/Cafoo Ltd owes Cafoo Inc at September's closing rate, a £4,404\.78 gain\.$/);
    expect(r.rationale).toMatch(/2950-UK: -\$200,000\.00 at the 2026-09 closing rate 0\.78125 is -£156,250\.00/);
  });

  it('eliminates $245,000 of balances (reversing in October) and $15,000 of September fees', () => {
    expect(plan.eliminations.map(e => [(e.payload as { basis: string }).basis, e.amountMinor])).toEqual([['balance', 24_500_000n], ['activity', 1_500_000n]]);
    const balance = plan.eliminations[0]!.payload as { subsidiaryId: string; reversesInYm: string; pairs: { label: string; amountMinor: string; differenceMinor: string; sourceAccountCode: string }[]; lines: { accountCode: string }[] };
    expect(balance.subsidiaryId).toBe('3');
    expect(balance.reversesInYm).toBe('2026-10');
    expect(balance.pairs.map(x => [x.label, x.sourceAccountCode, x.amountMinor, x.differenceMinor])).toEqual([['Intercompany balance', '1900', '4500000', '0'], ['Loan', '1950', '20000000', '0']]);
    expect(balance.lines.every(l => l.accountCode.endsWith('-ELIM'))).toBe(true);
    const activity = plan.eliminations[1]!.payload as { reversesInYm?: string; pairs: { differenceMinor: string }[] };
    expect(activity.reversesInYm).toBeUndefined();
    // Cafoo Ltd's side translates to $15,000.01 at September's average rate: a cent, under the dollar tolerance.
    expect(activity.pairs[0]!.differenceMinor).toBe('-1');
    expect(plan.differences).toEqual([]);
    expect(plan.eliminations[0]!.summaryPlain).toBe("Remove the $245,000 Cafoo Inc and Cafoo Ltd owe each other from the group's combined balance sheet; it reverses in October.");
  });

  it('writes Proposals the Consolidation harness allows, with plain summaries', () => {
    for (const d of [...plan.revaluations, ...plan.eliminations]) {
      expect(checkCall(HARNESSES.consolidation, asCall(d), { accountCodes: codes(), history: [] }), d.summaryPlain).toEqual({ allow: true });
      expect(plainSummaryProblems(d.summaryPlain, codes()), d.summaryPlain).toEqual([]);
    }
  });

  it('lists a difference over the tolerance for the close thread', () => {
    expect(planConsolidation(group(), '2026-09', { toleranceMinor: 0n }).differences).toMatchObject([{ label: 'Service fees', basis: 'activity', source: 'Cafoo Inc', counter: 'Cafoo Ltd', differenceMinor: -1n }]);
    // Cafoo Ltd booked $14,000 of September fees against Cafoo Inc's $15,000: $1,000 apart on the fees and on the balance.
    const off = planConsolidation(group({ feeCounterUsd: 1_400_000n }), '2026-09', { toleranceMinor: 100n });
    expect(off.differences.map(d => [d.label, d.differenceMinor])).toEqual([['Intercompany balance', 100_000n], ['Service fees', 99_999n]]);
    // The elimination still removes the source company's own amounts.
    expect(off.eliminations.map(e => e.amountMinor)).toEqual([24_500_000n, 1_500_000n]);
    // The harness then wants each difference raised in the close thread first.
    const elim = off.eliminations[0]!;
    expect(checkCall(HARNESSES.consolidation, asCall(elim), { accountCodes: codes(), history: [] })).toMatchObject({ allow: false, ruleIds: ['consolidation.escalates.1'] });
  });

  it('has nothing to consolidate on a single-company database', () => {
    const g = group();
    const solo = { ...g, entities: g.entities.filter(e => e.code === 'US') };
    expect(planConsolidation(solo, '2026-09', { toleranceMinor: 100n })).toMatchObject({ group: false, revaluations: [], eliminations: [] });
  });
});

describe('already-done refusals', () => {
  it("treat the module's duplicate refusals as done, and nothing else", () => {
    expect(alreadyDoneRefusal('fx_revaluation', 'A revaluation of Cafoo Ltd for 2026-09 is still waiting; decide it before proposing another.')).toBe(true);
    expect(alreadyDoneRefusal('fx_revaluation', 'Every item already stands at the 2026-09 closing rate; there is nothing to revalue.')).toBe(true);
    expect(alreadyDoneRefusal('ic_elimination', '1950-ELIM already carries -20000000 through 2026-09: 2026-09 is already eliminated on the balance basis.')).toBe(true);
    expect(alreadyDoneRefusal('ic_elimination', 'Pair Loan eliminates 20000000 but the books hold 19000000.')).toBe(false);
    expect(alreadyDoneRefusal('journal_entry', 'A revaluation is still waiting; decide it before proposing another.')).toBe(false);
  });
});

describe('Red Team on an elimination', () => {
  it('calls a cent of translation rounding agreement, and a difference over a dollar a question for a person', () => {
    const fees = eliminationCritique({ basis: 'activity', pairs: [{ label: 'Service fees', differenceMinor: '-1' }] });
    expect(fees.summaryPlain).toMatch(/match apart from a few cents of currency rounding/);
    // Kind-accurate: an activity elimination never reverses; a balance elimination does.
    expect(fees.body).toMatch(/this month's activity only/);
    expect(fees.body).not.toMatch(/reverses next month/);
    expect(eliminationCritique({ basis: 'balance', pairs: [{ label: 'Loan', differenceMinor: '0' }] }).body).toMatch(/reverses next month/);
    expect(eliminationCritique({ pairs: [{ label: 'Loan', differenceMinor: '0' }] }).summaryPlain).toMatch(/both companies' books match/);
    const off = eliminationCritique({ pairs: [{ label: 'Loan', differenceMinor: '250' }, { label: 'Service fees', differenceMinor: '-1' }] });
    expect(off.body).toMatch(/disagree on Loan by \$2\.50, over the one-dollar tolerance/);
    expect(off.body).not.toMatch(/Service fees/);
  });
});

describe('runConsolidationStep without the month an elimination reverses in', () => {
  it('holds the balance elimination back as a refusal against the consolidation task, so no lock is requested', async () => {
    const g = group();
    const pascal = (t: string) => t[0]!.toUpperCase() + t.slice(1);
    const ymOf = (ym: { year: number; month: number }) => `${ym.year}-${String(ym.month).padStart(2, '0')}`;
    const periods = [['2026-07', 7n], ['2026-08', 8n], ['2026-09', 9n], ['2026-10', 10n]] as const;
    const periodId = new Map<string, bigint>(periods.map(([ym, id]) => [ym, id]));
    const entries = [...new Map(g.lines.map(l => [l.jeId, l])).values()];
    const rows = {
      subsidiary: g.entities.map(e => ({ ...e })),
      account: g.accounts.map(a => ({ ...a, accountType: { tag: pascal(a.type) } })),
      period: periods.map(([ym, id]) => ({ id, ym, status: { tag: ym === '2026-10' ? 'Open' : 'Closed' } })),
      journalEntry: entries.map(l => ({ id: l.jeId, periodId: periodId.get(ymOf(l.ym)), postedAt: { microsSinceUnixEpoch: 0n }, source: { tag: 'Seed' } })),
      journalLine: g.lines.map(l => ({ ...l })),
      fxRate: g.rates.map((r, i) => ({ id: BigInt(i + 1), fromCcy: r.fromCcy, toCcy: r.toCcy, ym: ymOf(r.ym), rateE6: r.rateE6, kind: { tag: pascal(r.kind) } })),
      settings: [{ key: 'reporting_ccy', valueI64: 0n, valueText: 'USD' }],
    };
    const said: string[] = [];
    const cast = { advisor: fakeConn(rows), consolidation: { reducers: { postAgentMessage: async (m: { body: string }) => void said.push(m.body) } } } as unknown as Cast;
    const filed: string[] = [];
    const refused: Refusal[] = [];
    const r = await runConsolidationStep(cast, '2026-10', { log: () => undefined, pause: async () => undefined, thread: 'close:2026-10', taskId: 6n, file: async (_w, d) => {
      filed.push(d.kind);
      return true;
    }, refuse: x => refused.push(x) });
    expect(filed).toEqual(['fx_revaluation']);
    expect(r.proposed).toBe(1);
    expect(refused).toMatchObject([{ kind: 'ic_elimination', closeTaskId: 6n, why: expect.stringMatching(/2026-11 is not in the books yet/) }]);
    expect(said.some(b => /reverses in 2026-11, which the books do not have yet/.test(b))).toBe(true);
  });
});
