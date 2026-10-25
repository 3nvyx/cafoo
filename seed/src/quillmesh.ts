/**
 * The Quillmesh profile (SEED_PROFILE=quillmesh): scales the test fixture's books up to the demo company in plan.md.
 *
 * The fixture's close stays intact (its customers, planted problems and September bank lines are untouched). On top:
 * - 18 months of periods, April 2025 to the close month, all closed before it;
 * - 80 insurance and logistics customers on annual contracts (15 enterprise, 65 mid-market), each invoiced at the start
 *   of its term, paid in full the month after, with a 12-month revenue schedule recognized through the month before
 *   the close. The Revenue agent recognizes their close-month line like any other contract's;
 * - self-serve subscriptions and per-page usage as one billing-sync entry a month, paid by card;
 * - payroll, GPU and model costs, software, marketing and rent, growing with the company, synced from the payroll and
 *   cloud providers each month (the close month's fixture bills and bank lines come on top);
 * - the seed and Series A rounds in cash and paid-in capital, so the close month ends near $11M of cash.
 * Every new customer's receivables are paid before the close, so Credit & Risk's checks and the Bookkeeper's September
 * work are exactly the fixture's.
 */
import type { Seed } from './generate';

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

  // 1. Periods: 15 more closed months before the fixture's first.
  const earlier: string[] = [];
  for (let k = 0; before(ymAdd(first, k), m2); k++) earlier.push(ymStr(ymAdd(first, k)));
  seed.periods = { yms: [...earlier, ...seed.periods.yms], closedYms: [...earlier, ...seed.periods.closedYms] };

  // 2. Customers and annual contracts. Recent months sign more: the company grows about 3x a year.
  let idx = seed.customers.length;
  let invoiceNo = 5000;
  const recognized = new Map<string, Line[]>();
  const add = (ym: string, l: Line[]) => recognized.set(ym, [...(recognized.get(ym) ?? []), ...l]);
  const names = [...ENTERPRISE, ...Array.from({ length: 65 }, (_, i) => `${MID_A[i % MID_A.length]} ${MID_B[(i * 3) % MID_B.length]}`)];
  names.forEach((name, i) => {
    const enterprise = i < ENTERPRISE.length;
    const annual = enterprise ? 90_000 + Math.round(rand() * 100_000) : 18_000 + Math.round(rand() * 22_000);
    const monthly = cents(Math.round(annual / 12));
    const total = monthly * 12;
    const start = ymAdd(close, -(1 + Math.floor(Math.pow(rand(), 1.6) * 11)));
    const c = { idx: ++idx, name, domain: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`, guarantorPersonaId: '', guarantorName: '', paymentTermsDays: enterprise ? 60 : 30 };
    seed.customers.push(c);
    const code = `QM-${String(i + 1).padStart(3, '0')}`;
    const scheduleLines = Array.from({ length: 12 }, (_, k) => ({ ym: ymStr(ymAdd(start, k)), amountMinor: String(monthly), recognized: before(ymAdd(start, k), close) }));
    seed.contracts.push({
      customerIdx: c.idx,
      code,
      startYm: ymStr(start),
      endYm: ymStr(ymAdd(start, 11)),
      totalMinor: String(total),
      plan: 'annual',
      items: [{ kind: 'subscription', priceMinor: String(monthly), qty: '1', sspMinor: String(monthly), description: enterprise ? 'Enterprise platform, annual, ramped usage included' : 'Team platform, annual, billed upfront' }],
      scheduleLines,
    });
    const issued = micros(start, 1);
    seed.invoices.push({ customerIdx: c.idx, contractCode: code, number: `INV-${++invoiceNo}`, ym: ymStr(start), issuedAtMicros: issued, dueAtMicros: plusDays(issued, c.paymentTermsDays), amountMinor: String(total), status: 'paid' });
    seed.journalEntries.push({ periodYm: ymStr(start), memo: `Annual invoice ${name} (${code})`, lines: [line('1100', total, 0, `Invoice ${code}`, c.idx), line('2400', 0, total, `Deferred revenue ${code}`, c.idx)] });
    // Paid the month after the term starts, and never later than the month before the close.
    const pay = before(ymAdd(start, 1), close) ? ymAdd(start, 1) : m1;
    seed.journalEntries.push({ periodYm: ymStr(pay), memo: `Payment received ${name} ${code}`, lines: [line('1000', total, 0, 'Bank receipt', c.idx), line('1100', 0, total, `Settle ${code}`, c.idx)] });
    for (const sl of scheduleLines) {
      if (!sl.recognized) continue;
      add(sl.ym, [line('2400', monthly, 0, `Release deferred ${code}`, c.idx), line('4000', 0, monthly, `Subscription revenue ${code}`, c.idx)]);
    }
  });
  for (const [ym, lines] of [...recognized.entries()].sort()) {
    seed.journalEntries.push({ periodYm: ym, memo: `Revenue recognition, Quillmesh annual contracts, ${ym}`, lines });
  }

  // 3. Monthly operating flows, all paid in cash in the month. Headcount grows from 22 to 48 in the US.
  let net = 0;
  for (let k = 0; !before(close, ymAdd(first, k)); k++) {
    const ym = ymAdd(first, k);
    const s = ymStr(ym);
    const g = Math.pow(1.096, t(ym));
    const selfServe = cents(15_000 * g);
    const usage = cents(22_000 * g);
    const headcount = Math.round(22 + (26 * t(ym)) / 17);
    const payroll = cents(headcount * 15_400);
    const gpu = cents(26_000 * Math.pow(1.075, t(ym)) * (s === ymStr(m1) ? 1.38 : 1));
    const models = cents(11_000 * Math.pow(1.08, t(ym)));
    const tools = cents(9_500 + 450 * t(ym));
    const marketing = cents(18_000 + 2_600 * t(ym));
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
        line('5300', payroll, 0, `Payroll, ${headcount} people (Gusto)`),
        line('5000', gpu, 0, 'GPU inference fleet and storage'),
        line('5000', models, 0, 'Model API usage'),
        line('5100', tools, 0, 'Software and tools'),
        line('5400', marketing, 0, 'Marketing'),
        line('5500', rent, 0, 'Rent and office'),
        line('1000', 0, payroll + gpu + models + tools + marketing + rent, 'Paid from operating account'),
      ],
    });
    net += selfServe + usage - (payroll + gpu + models + tools + marketing + rent);
  }

  // 4. Financing: opening cash after the pre-seed and seed, then the Series A.
  const seriesA = cents(12_000_000);
  seed.journalEntries.push({ periodYm: '2026-03' > ymStr(first) ? '2026-03' : ymStr(first), memo: 'Series A, $12,000,000 at a $50,000,000 post-money (Harborline Capital lead)', lines: [line('1000', seriesA, 0, 'Wire in, Series A closing'), line('3000', 0, seriesA, 'Series A preferred stock')] });
  // Cash at the close is about $11M: contract cash in, operating flows, the Series A and the opening position.
  const contractCash = seed.contracts.filter(k => k.code.startsWith('QM-')).reduce((n, k) => n + Number(k.totalMinor), 0);
  const opening = Math.max(cents(1_500_000), cents(11_000_000) - (contractCash + net + seriesA));
  const paidIn = cents(4_250_000);
  seed.journalEntries.push({
    periodYm: ymStr(first),
    memo: 'Opening balances, Quillmesh (after the pre-seed SAFEs and the seed round)',
    lines: [line('1000', opening, 0, 'Opening cash'), line('3000', 0, paidIn, 'Pre-seed and seed paid-in capital'), ...(opening >= paidIn ? [line('3100', 0, opening - paidIn, 'Retained earnings')] : [line('3100', paidIn - opening, 0, 'Accumulated deficit')])],
  });
}
