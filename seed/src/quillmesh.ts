/**
 * The Quillmesh profile (SEED_PROFILE=quillmesh): scales the test fixture's books up to the demo company in plan.md.
 *
 * The fixture's close stays intact (its customers, planted problems and September bank lines are untouched). On top:
 * - 18 months of periods, April 2025 to the close month, all closed before it;
 * - 80 insurance and logistics customers on annual contracts (15 enterprise, 65 mid-market), signed at a pace that
 *   triples ARR a year and renewed every 12 months, each term invoiced on its first day and paid within the month, with
 *   a revenue schedule recognized through the month before the close. No contract ends inside the books, so ARR grows
 *   every month, to about $4.8M with the fixture's contracts. The Revenue agent recognizes their close-month line like
 *   any other contract's;
 * - self-serve subscriptions and per-page usage as one billing-sync entry a month, paid by card (revenue, not ARR:
 *   ARR counts contracts only);
 * - payroll for the US employees on the People page, GPU and model costs, software, marketing and rent, plus the
 *   hiring and growth spend after the Series A, synced from the payroll and cloud providers each month (the close
 *   month's fixture bills and bank lines come on top);
 * - the seed and Series A rounds in cash and paid-in capital, tying to the funding records ($16.25M), so the close
 *   month ends near $11M of cash and about 24 months of runway at its three-month burn;
 * - the group's companies named Quillmesh Inc and Quillmesh Ltd.
 * Every new customer's receivables are paid before the close, so Credit & Risk's checks and the Bookkeeper's September
 * work are exactly the fixture's.
 */
import { usStaffAt } from './company';
import type { Seed } from './generate';

/** What the pre-seed years (2024 to March 2025) spent of the money raised before the books start, in dollars. */
const PRE_BOOKS_SPEND = 250_000;

type Ym = { year: number; month: number };
type Line = Seed['journalEntries'][number]['lines'][number];

const ymStr = (ym: Ym) => `${ym.year}-${String(ym.month).padStart(2, '0')}`;
const ymAdd = (ym: Ym, n: number): Ym => {
  const idx = ym.year * 12 + (ym.month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
};
const micros = (ym: Ym, day: number) => String(BigInt(Date.UTC(ym.year, ym.month - 1, day, 12)) * 1000n);
const plusDays = (m: string, days: number) => String(BigInt(m) + BigInt(days) * 86_400_000_000n);
const cents = (dollars: number) => Math.round(dollars * 100);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function line(accountCode: string, debit: number, credit: number, memo: string, customerIdx?: number): Line {
  return { accountCode, debitMinor: String(debit), creditMinor: String(credit), ccy: 'USD', fxRateE6: '1000000', customerId: customerIdx, memo };
}

const ENTERPRISE = ['Meridian Mutual Insurance', 'Bluewater Freight Systems', 'Cascade Claims Group', 'Ironbridge Logistics', 'Palisade Insurance Co', 'Redwood Cargo Lines', 'Summit Underwriters', 'Atlas Brokerage Group', 'Lakeshore Health Plans', 'Granite Freight Lines', 'Beacon Specialty Insurance', 'Copperline Shipping', 'Harbor Assurance', 'Northgate 3PL', 'Silverleaf Risk Partners'];
const MID_A = ['Tri-County', 'Evergreen', 'Keystone', 'Bayview', 'Pinecrest', 'Riverside', 'Stonegate', 'Westfield', 'Oakmont', 'Clearwater', 'Highland', 'Fairview', 'Brookline', 'Maple Ridge', 'Sunset', 'Crescent', 'Lighthouse', 'Ridgeway', 'Pioneer', 'Union', 'Liberty', 'Frontier', 'Golden Gate', 'Prairie', 'Coastal', 'Heritage'];
const MID_B = ['Haulers', 'Mutual', 'Forwarding', 'Claims Services', 'Trucking', 'Adjusters', 'Freight', 'Insurance Agency', 'Logistics', 'Risk Advisors'];

export function scaleToQuillmesh(seed: Seed, close: Ym): void {
  const rand = mulberry32(48_000_000);
  const first = ymAdd(close, -17);
  const t = (ym: Ym) => (ym.year * 12 + ym.month) - (first.year * 12 + first.month);
  const before = (a: Ym, b: Ym) => a.year * 12 + a.month < b.year * 12 + b.month;
  const m1 = ymAdd(close, -1);
  const m2 = ymAdd(close, -2);

  // 0. The group's entries, bank lines and close tasks name Quillmesh Inc and Quillmesh Ltd, not the fixture's companies
  // (the loader renames the subsidiaries and the intercompany accounts the same way).
  seed.group = JSON.parse(JSON.stringify(seed.group).replace(/\bLuyten (Inc|Ltd)\b/g, 'Quillmesh $1').replace(/\bCAFOO (INC|LTD)\b/g, 'QUILLMESH $1'));

  // 1. Periods: 15 more closed months before the fixture's first.
  const earlier: string[] = [];
  for (let k = 0; before(ymAdd(first, k), m2); k++) earlier.push(ymStr(ymAdd(first, k)));
  seed.periods = { yms: [...earlier, ...seed.periods.yms], closedYms: [...earlier, ...seed.periods.closedYms] };

  // 2. Customers and annual contracts. Customers sign at the pace of a company that triples its ARR every year: the
  // share signed by month t is 3^((t - 17) / 12), so a third were on board a year before the close and about one in
  // eleven signs in the close month itself (customers who predate the books start in their first month). Each
  // contract renews every 12 months at the same price, so it is one contract over every term up to the one running at
  // the close. A customer whose term ends in the close month has already signed its renewal (invoiced on its first
  // day, after the close), so no contract ends inside the books and ARR only grows. Each term inside the books is
  // invoiced on its first day and paid within the month, so annual cash keeps arriving every month.
  const lastT = t(close);
  const shuffle = mulberry32(48_000_001);
  const names = [...ENTERPRISE, ...Array.from({ length: 65 }, (_, i) => `${MID_A[i % MID_A.length]} ${MID_B[(i * 3) % MID_B.length]}`)];
  const order = names.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(shuffle() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let idx = seed.customers.length;
  const recognized = new Map<string, Line[]>();
  const add = (ym: string, l: Line[]) => recognized.set(ym, [...(recognized.get(ym) ?? []), ...l]);
  const terms: { ym: Ym; c: Seed['customers'][number]; code: string; amount: number; renewal: boolean }[] = [];
  names.forEach((name, i) => {
    const enterprise = i < ENTERPRISE.length;
    const annual = enterprise ? 100_000 + Math.round(rand() * 90_000) : 20_000 + Math.round(rand() * 20_000);
    const monthly = cents(Math.round(annual / 12));
    const u = (order[i] + 0.5) / names.length;
    const s = Math.min(lastT, Math.max(0, Math.ceil(lastT + (12 * Math.log(u)) / Math.log(3))));
    // Terms that started by the close, plus the renewal signed early when the running term ends in the close month.
    const invoiced = Math.floor((lastT - s) / 12) + 1;
    const count = invoiced + ((lastT - s) % 12 === 11 ? 1 : 0);
    const start = ymAdd(first, s);
    const c = { idx: ++idx, name, domain: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`, guarantorPersonaId: '', guarantorName: '', paymentTermsDays: enterprise ? 60 : 30 };
    seed.customers.push(c);
    const code = `QM-${String(i + 1).padStart(3, '0')}`;
    const scheduleLines = Array.from({ length: 12 * count }, (_, k) => ({ ym: ymStr(ymAdd(start, k)), amountMinor: String(monthly), recognized: before(ymAdd(start, k), close) }));
    const plan = enterprise ? 'Enterprise platform, annual, ramped usage included' : 'Team platform, annual, billed upfront';
    seed.contracts.push({
      customerIdx: c.idx,
      code,
      startYm: ymStr(start),
      endYm: ymStr(ymAdd(start, 12 * count - 1)),
      totalMinor: String(monthly * 12 * count),
      plan: 'annual',
      items: [{ kind: 'subscription', priceMinor: String(monthly), qty: '1', sspMinor: String(monthly), description: count > 1 ? `${plan}, renewed ${ymStr(ymAdd(start, 12))}` : plan }],
      scheduleLines,
    });
    for (let k = 0; k < invoiced; k++) terms.push({ ym: ymAdd(start, 12 * k), c, code, amount: monthly * 12, renewal: k > 0 });
    for (const sl of scheduleLines) {
      if (!sl.recognized) continue;
      add(sl.ym, [line('2400', monthly, 0, `Release deferred ${code}`, c.idx), line('4000', 0, monthly, `Subscription revenue ${code}`, c.idx)]);
    }
  });
  // Invoices are numbered in the order they were issued.
  terms.sort((a, b) => t(a.ym) - t(b.ym) || a.c.idx - b.c.idx);
  terms.forEach(({ ym, c, code, amount, renewal }, k) => {
    const number = `INV-${5001 + k}`;
    const issued = micros(ym, 1);
    seed.invoices.push({ customerIdx: c.idx, contractCode: code, number, ym: ymStr(ym), issuedAtMicros: issued, dueAtMicros: plusDays(issued, c.paymentTermsDays), amountMinor: String(amount), status: 'paid' });
    seed.journalEntries.push({ periodYm: ymStr(ym), memo: `${renewal ? 'Renewal' : 'Annual'} invoice ${c.name} (${code}) ${number}`, lines: [line('1100', amount, 0, `Invoice ${number}`, c.idx), line('2400', 0, amount, `Deferred revenue ${code}`, c.idx)] });
    seed.journalEntries.push({ periodYm: ymStr(ym), memo: `Payment received ${c.name} ${number}`, lines: [line('1000', amount, 0, 'Bank receipt', c.idx), line('1100', 0, amount, `Settle ${number}`, c.idx)] });
  });
  for (const [ym, lines] of [...recognized.entries()].sort()) {
    seed.journalEntries.push({ periodYm: ym, memo: `Revenue recognition, Quillmesh annual contracts, ${ym}`, lines });
  }


  // 3. Monthly operating flows, all paid in cash in the month. Payroll counts the US employees on the People page
  // (company.ts) at a loaded $15,400 a month each (salary, payroll taxes, benefits, retirement). After the Series A the
  // company spends on hiring and growth: recruiting, legal and audit, data-annotation contractors and travel.
  const seriesAYm: Ym = { year: 2026, month: 3 };
  for (let k = 0; !before(close, ymAdd(first, k)); k++) {
    const ym = ymAdd(first, k);
    const s = ymStr(ym);
    const g = Math.pow(1.096, t(ym));
    const selfServe = cents(15_000 * g);
    const usage = cents(22_000 * g);
    const headcount = usStaffAt(ymStr(close), s);
    const payroll = cents(headcount * 15_400);
    const sinceA = before(ym, seriesAYm) ? -1 : t(ym) - t(seriesAYm);
    const advisers = sinceA < 0 ? 0 : cents(45_000 + 7_000 * sinceA);
    const contractors = sinceA < 0 ? 0 : cents(30_000 * Math.pow(1.06, sinceA));
    const travel = sinceA < 0 ? 0 : cents(10_000 + 2_000 * sinceA);
    const growth = advisers + contractors + travel;
    const gpu = cents(26_000 * Math.pow(1.075, t(ym)) * (s === ymStr(m1) ? 1.38 : 1));
    const models = cents(11_000 * Math.pow(1.08, t(ym)));
    const tools = cents(9_500 + 450 * t(ym));
    const marketing = cents(18_000 + 2_600 * t(ym) + 12_000 * Math.max(0, sinceA));
    const rent = cents(t(ym) < 9 ? 14_000 : 26_000);
    seed.journalEntries.push({
      periodYm: s,
      memo: `Self-serve subscriptions and per-page usage, ${s} (billing sync)`,
      lines: [line('1000', selfServe + usage, 0, 'Card settlements'), line('4000', 0, selfServe, 'Self-serve subscriptions'), line('4100', 0, usage, 'Per-page usage, metered')],
    });
    seed.journalEntries.push({
      periodYm: s,
      memo: `Operating costs, ${s} (payroll, GPU and model usage, tools, marketing, rent)`,
      lines: [
        line('5300', payroll, 0, `Payroll, ${headcount} US employees (Gusto)`),
        line('5000', gpu, 0, 'GPU inference fleet and storage'),
        line('5000', models, 0, 'Model API usage'),
        line('5100', tools, 0, 'Software and tools'),
        line('5400', marketing, 0, 'Marketing'),
        line('5500', rent, 0, 'Rent and office'),
        ...(growth > 0
          ? [line('5600', advisers, 0, 'Recruiting, legal and audit'), line('5200', contractors, 0, 'Data-annotation contractors'), line('5800', travel, 0, 'Customer and recruiting travel')]
          : []),
        line('1000', 0, payroll + gpu + models + tools + marketing + rent + growth, 'Paid from operating account'),
      ],
    });
  }

  // 4. Financing: opening cash after the pre-seed and seed, then the Series A.
  const seriesA = cents(12_000_000);
  seed.journalEntries.push({ periodYm: '2026-03' > ymStr(first) ? '2026-03' : ymStr(first), memo: 'Series A, $12,000,000 at a $50,000,000 post-money (Harborline Capital lead)', lines: [line('1000', seriesA, 0, 'Wire in, Series A closing'), line('3000', 0, seriesA, 'Series A preferred stock')] });
  // The pre-seed SAFEs and the seed raised $4,250,000 (company.ts). The fixture's opening entry already holds $150,000 of
  // common stock and its group seed $200,000 of capital raised for the UK loan, so the paid-in capital here is the rest:
  // the ledger's share capital ties to the funding records ($16,250,000 with the Series A). The seed closed the month
  // before the books start, so the opening cash is that paid-in capital less what the pre-seed years spent.
  const paidIn = cents(4_250_000 - 150_000 - 200_000);
  const opening = paidIn - cents(Math.round(PRE_BOOKS_SPEND));
  seed.journalEntries.push({
    periodYm: ymStr(first),
    memo: 'Opening balances, Quillmesh (after the pre-seed SAFEs and the seed round)',
    lines: [line('1000', opening, 0, 'Opening cash'), line('3000', 0, paidIn, 'Pre-seed and seed paid-in capital'), line('3100', paidIn - opening, 0, 'Accumulated deficit before the books')],
  });
}
