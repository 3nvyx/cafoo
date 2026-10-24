/**
 * The group around Cafoo Inc: Cafoo Ltd (UK, pounds) and the group eliminations company (ELIM, dollars), their FX
 * rates, Cafoo Ltd's own trading, and the intercompany entries on both sides. Written to seed.json under `group`.
 *
 * It draws from its own PRNG (mulberry32(2027)) and never from the generator's US stream, so every US array in
 * seed.json stays byte-identical. Pure: no clock, no Node APIs; the close month comes in as an argument.
 *
 * The September story (close month), to the cent:
 * - Cafoo Ltd owes Cafoo Inc $200,000 (loan, booked at 0.80 = £160,000) and $45,000 of service fees (3 x $15,000 at
 *   0.80, 0.80 and 0.787402 = £35,811.03). At the 0.78125 closing rate they are £156,250.00 and £35,156.25: a revaluation
 *   gain of £3,750.00 + £654.78 = £4,404.78 (about $5,638 at 1.28, under the $10,000 materiality threshold).
 * - Balance elimination $245,000 (1900 + 1950 against 2900-UK + 2950-UK, which translate back to exactly $45,000 and
 *   $200,000 at 1.28): difference $0.00. Reverses next month.
 * - Activity elimination $15,000 (4900 against 5900-UK). Cafoo Ltd's side is £11,811.03, which translates at the
 *   1.27 average rate to $15,000.01, so this pair shows a one-cent rounding difference (under the $1 tolerance).
 * The two closed months were consolidated when they closed: their service-fee activity eliminations ($15,000 each,
 * exact at 1.25) are seeded in ELIM, so the year-to-date group results carry only September's cent. Their balance
 * eliminations would have reversed by now, so none are seeded; September's checks (activity in the month, ELIM balances
 * through the month) still see nothing eliminated. Rates are seeded through the month after next (the seeded periods).
 */
import { ELIM_ACCOUNTS, UK_ACCOUNTS, type SeedAccount } from './accounts';
import { DAY_MICROS, microsAt, mulberry32, ymAdd, ymStr, type Ym } from './calendar';

export type GroupLine = {
  accountCode: string;
  debitMinor: string;
  creditMinor: string;
  ccy: string;
  fxRateE6: string;
  /** Index into group.customers (group-local, not the US customers). */
  customerId?: number;
  memo: string;
};

export type GroupSeed = {
  reportingCcy: string;
  subsidiaries: { code: string; name: string; functionalCcy: string; parentCode: string; isElimination: boolean }[];
  accounts: (SeedAccount & { subsidiaryCode: string })[];
  fxRates: { fromCcy: string; toCcy: string; ym: string; rateE6: string; kind: 'average' | 'closing' }[];
  customers: { subsidiaryCode: string; idx: number; name: string; domain: string; guarantorPersonaId: string; guarantorName: string; paymentTermsDays: number }[];
  invoices: { customerIdx: number; number: string; ym: string; issuedAtMicros: string; dueAtMicros: string; amountMinor: string; status: string }[];
  bankTransactions: { subsidiaryCode: string; bookedAtMicros: string; ym: string; amountMinor: string; ccy: string; description: string; counterparty: string; matched: boolean }[];
  journalEntries: { subsidiaryCode: string; periodYm: string; memo: string; lines: GroupLine[] }[];
  /** Added to the close checklist by the loader; the existing Board pack task moves from 6 to 7. */
  closeTasks: { title: string; description: string; ownerRole: string; sortOrder: number }[];
  story: { title: string; expect: string }[];
};

export const UK = { code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP' } as const;
export const ELIM = { code: 'ELIM', name: 'Group eliminations', functionalCcy: 'USD' } as const;

/** Rates x 1e6 by month offset from the close month: [GBP->USD average, GBP->USD closing, USD->GBP average, USD->GBP closing]. */
const RATES: Record<number, [number, number, number, number]> = {
  [-2]: [1_250_000, 1_250_000, 800_000, 800_000],
  [-1]: [1_250_000, 1_250_000, 800_000, 800_000],
  [0]: [1_270_000, 1_280_000, 787_402, 781_250],
  [1]: [1_280_000, 1_280_000, 781_250, 781_250],
  [2]: [1_280_000, 1_280_000, 781_250, 781_250],
};

const LOAN_USD = 200_000_00;
const SERVICE_FEE_USD = 15_000_00;
const UK_CAPITAL_GBP = 20_000_00;
const RENT_GBP = 3_250_00;

const UK_CUSTOMERS: [name: string, domain: string][] = [
  ['Harrowgate Joinery', 'harrowgatejoinery.co.uk'],
  ['Pembroke Dental Care', 'pembrokedental.co.uk'],
  ['Larkspur Bakery', 'larkspurbakery.co.uk'],
];

const s = (n: number | bigint) => String(n);

/** USD amount in pence at a USD->GBP rate, rounded half away from zero (exact for every amount used here). */
const toGbp = (usdMinor: number, rateE6: number) => {
  const n = BigInt(usdMinor) * BigInt(rateE6);
  return (n * 2n + 1_000_000n) / 2_000_000n;
};

export function buildGroup(close: Ym): GroupSeed {
  const rand = mulberry32(2027);
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const months = [-2, -1, 0].map(k => ({ k, ym: ymAdd(close, k) }));
  const m2 = ymAdd(close, -2);
  const rates = (k: number) => RATES[k]!;

  const line = (accountCode: string, debit: number | bigint, credit: number | bigint, ccy: string, rateE6: number, memo: string, customerId?: number): GroupLine => ({
    accountCode,
    debitMinor: s(debit),
    creditMinor: s(credit),
    ccy,
    fxRateE6: s(rateE6),
    customerId,
    memo,
  });
  const gbp = (accountCode: string, debit: number, credit: number, memo: string, customerId?: number) => line(accountCode, debit, credit, 'GBP', 1_000_000, memo, customerId);
  const usd = (accountCode: string, debit: number, credit: number, memo: string) => line(accountCode, debit, credit, 'USD', 1_000_000, memo);

  const g: GroupSeed = {
    reportingCcy: 'USD',
    subsidiaries: [
      { ...UK, parentCode: 'US', isElimination: false },
      { ...ELIM, parentCode: 'US', isElimination: true },
    ],
    accounts: [...UK_ACCOUNTS.map(a => ({ subsidiaryCode: UK.code, ...a })), ...ELIM_ACCOUNTS.map(a => ({ subsidiaryCode: ELIM.code, ...a }))],
    fxRates: [],
    customers: [],
    invoices: [],
    bankTransactions: [],
    journalEntries: [],
    closeTasks: [
      {
        title: 'Consolidate subsidiaries',
        description: "Revalue Cafoo Ltd's dollar balances at the month's closing rate, then remove what the group companies owe and charge each other from the combined reports.",
        ownerRole: 'consolidation',
        sortOrder: 6,
      },
    ],
    story: [],
  };

  for (const k of [-2, -1, 0, 1, 2]) {
    const ym = ymStr(ymAdd(close, k));
    const [ga, gc, ua, uc] = rates(k);
    g.fxRates.push(
      { fromCcy: 'GBP', toCcy: 'USD', ym, rateE6: s(ga), kind: 'average' },
      { fromCcy: 'GBP', toCcy: 'USD', ym, rateE6: s(gc), kind: 'closing' },
      { fromCcy: 'USD', toCcy: 'GBP', ym, rateE6: s(ua), kind: 'average' },
      { fromCcy: 'USD', toCcy: 'GBP', ym, rateE6: s(uc), kind: 'closing' }
    );
  }

  const fees = UK_CUSTOMERS.map(() => between(30, 90) * 100_00);
  const payroll = between(150, 190) * 100_00;
  UK_CUSTOMERS.forEach(([name, domain], i) => {
    g.customers.push({ subsidiaryCode: UK.code, idx: i + 1, name, domain, guarantorPersonaId: '', guarantorName: '', paymentTermsDays: 14 });
  });

  const tx = (ym: Ym, day: number, amountMinor: number, description: string, counterparty: string) =>
    g.bankTransactions.push({ subsidiaryCode: UK.code, bookedAtMicros: s(microsAt(ym, day)), ym: ymStr(ym), amountMinor: s(amountMinor), ccy: 'GBP', description, counterparty, matched: true });

  // ---------- opening balances and the loan (first seeded month) ----------
  g.journalEntries.push({
    subsidiaryCode: UK.code,
    periodYm: ymStr(m2),
    memo: 'Opening balances Cafoo Ltd',
    lines: [gbp('1000-UK', UK_CAPITAL_GBP, 0, 'Opening cash'), gbp('3000-UK', 0, UK_CAPITAL_GBP, 'Share capital')],
  });
  const loanRate = rates(-2)[2];
  g.journalEntries.push(
    {
      subsidiaryCode: 'US',
      periodYm: ymStr(m2),
      memo: 'Loan to Cafoo Ltd, funded from the capital raise',
      lines: [usd('1950', LOAN_USD, 0, 'Loan to Cafoo Ltd'), usd('3000', 0, LOAN_USD, 'Capital raised for the Cafoo Ltd loan')],
    },
    {
      subsidiaryCode: UK.code,
      periodYm: ymStr(m2),
      memo: 'Loan from Cafoo Inc, received in pounds',
      lines: [gbp('1000-UK', Number(toGbp(LOAN_USD, loanRate)), 0, 'Loan proceeds'), line('2950-UK', 0, LOAN_USD, 'USD', loanRate, 'Loan from Cafoo Inc')],
    }
  );
  tx(m2, 2, Number(toGbp(LOAN_USD, loanRate)), 'CHAPS IN CAFOO INC INTERCOMPANY LOAN', 'Cafoo Inc');

  // ---------- every seeded month up to and including the close month ----------
  let invoiceNo = 2000;
  for (const { k, ym } of months) {
    const period = ymStr(ym);
    const feeRate = rates(k)[2];
    g.journalEntries.push(
      {
        subsidiaryCode: 'US',
        periodYm: period,
        memo: `Service fee charged to Cafoo Ltd ${period}`,
        lines: [usd('1900', SERVICE_FEE_USD, 0, 'Due from Cafoo Ltd'), usd('4900', 0, SERVICE_FEE_USD, 'Group services to Cafoo Ltd')],
      },
      {
        subsidiaryCode: UK.code,
        periodYm: period,
        memo: `Service fee from Cafoo Inc ${period}`,
        lines: [line('5900-UK', SERVICE_FEE_USD, 0, 'USD', feeRate, 'Group services from Cafoo Inc'), line('2900-UK', 0, SERVICE_FEE_USD, 'USD', feeRate, 'Due to Cafoo Inc')],
      }
    );
    if (k < 0) {
      // A closed month was consolidated when it closed: its service fees are already removed from the group's results.
      g.journalEntries.push({
        subsidiaryCode: ELIM.code,
        periodYm: period,
        memo: `Remove ${period} service fees between Cafoo Inc and Cafoo Ltd`,
        lines: [usd('4900-ELIM', SERVICE_FEE_USD, 0, 'Service fees charged to Cafoo Ltd'), usd('5900-ELIM', 0, SERVICE_FEE_USD, 'Service fees paid to Cafoo Inc')],
      });
    }

    tx(ym, 1, -RENT_GBP, 'STANDING ORDER SHOREDITCH WORKSPACE', 'Shoreditch Workspace');
    g.journalEntries.push({ subsidiaryCode: UK.code, periodYm: period, memo: `Rent ${period}`, lines: [gbp('5500-UK', RENT_GBP, 0, 'Office rent'), gbp('1000-UK', 0, RENT_GBP, 'Bank payment')] });

    g.customers.forEach((c, i) => {
      const amount = fees[i]!;
      const number = `UK-${++invoiceNo}`;
      const issued = microsAt(ym, 1);
      const due = issued + BigInt(c.paymentTermsDays) * DAY_MICROS;
      g.invoices.push({ customerIdx: c.idx, number, ym: period, issuedAtMicros: s(issued), dueAtMicros: s(due), amountMinor: s(amount), status: 'paid' });
      g.journalEntries.push({
        subsidiaryCode: UK.code,
        periodYm: period,
        memo: `Invoice ${c.name} ${number}`,
        lines: [gbp('1100-UK', amount, 0, `Invoice ${number}`, c.idx), gbp('4000-UK', 0, amount, 'Monthly subscription', c.idx)],
      });
      tx(ym, between(8, 15), amount, `FASTER PAYMENT ${c.name.toUpperCase()} ${number}`, c.name);
      g.journalEntries.push({
        subsidiaryCode: UK.code,
        periodYm: period,
        memo: `Payment received ${c.name} ${number}`,
        lines: [gbp('1000-UK', amount, 0, 'Bank receipt', c.idx), gbp('1100-UK', 0, amount, `Settle ${number}`, c.idx)],
      });
    });

    tx(ym, 25, -payroll, 'BACS PAYROLL CAFOO LTD', 'Cafoo Ltd payroll');
    g.journalEntries.push({ subsidiaryCode: UK.code, periodYm: period, memo: `Payroll ${period}`, lines: [gbp('5300-UK', payroll, 0, 'Monthly payroll'), gbp('1000-UK', 0, payroll, 'Bank payment')] });
  }

  const closeYm = ymStr(close);
  g.story = [
    {
      title: 'Cafoo Ltd owes Cafoo Inc $245,000 in dollars',
      expect: `Consolidation proposes a revaluation at the ${closeYm} closing rate: a £4,404.78 gain (£3,750.00 on the loan, £654.78 on the service fees owed), under the materiality threshold, so the Advisor posts it.`,
    },
    {
      title: 'Balances the group companies owe each other',
      expect: 'Consolidation proposes a $245,000 balance elimination that reverses next month, with no difference on either pair; it is material, so it waits for the CFO.',
    },
    {
      title: 'Service fees between the group companies',
      expect: `Consolidation proposes a $15,000 activity elimination for ${closeYm}; it is material, so it waits for the CFO. Cafoo Ltd's side translates to $15,000.01 at the average rate, a one-cent difference under the $1 tolerance.`,
    },
  ];
  return g;
}
