/**
 * Deterministic demo-data generator for Cafoo Inc.
 * Everything is derived from a fixed PRNG seed and the close month, so every run produces the same books.
 * Money is a string of minor units (cents) so it survives JSON. Times are micros since the Unix epoch as strings.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS, type SeedAccount } from './accounts';
import { buildGroup, type GroupSeed } from './group';
import { scaleToQuillmesh } from './quillmesh';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

// ---------- deterministic PRNG ----------
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
const rand = mulberry32(2026);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

// ---------- time helpers (pure) ----------
type Ym = { year: number; month: number };
const ymStr = (ym: Ym) => `${ym.year}-${String(ym.month).padStart(2, '0')}`;
const ymAdd = (ym: Ym, n: number): Ym => {
  const idx = ym.year * 12 + (ym.month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
};
const micros = (year: number, month: number, day: number, hour = 12) =>
  String(BigInt(Date.UTC(year, month - 1, day, hour)) * 1000n);
const daysInMonth = (ym: Ym) => new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
const midMonth = (ym: Ym, day: number) => micros(ym.year, ym.month, Math.min(day, daysInMonth(ym)));
const plusDays = (m: string, days: number) => String(BigInt(m) + BigInt(days) * 86_400_000_000n);

function resolveClosePeriod(): Ym {
  const env = process.env.CLOSE_PERIOD;
  if (env && /^\d{4}-\d{2}$/.test(env)) {
    const [y, m] = env.split('-').map(Number);
    return { year: y, month: m };
  }
  // Last completed calendar month. The only place a clock is read; the output records the choice.
  const now = new Date();
  return ymAdd({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }, -1);
}

// ---------- CSV personas (names only; request bodies belong to the credit package) ----------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

type Persona = { id: string; name: string; profile: string; decision: string; summary: string };
function loadPersonas(): Persona[] {
  const rows = parseCsv(readFileSync(join(root, 'crs-sandbox-dataset.csv'), 'utf8').replace(/^\uFEFF/, ''));
  const header = rows[0];
  const col = (name: string) => header.indexOf(name);
  const seen = new Map<string, Persona>();
  for (const r of rows.slice(1)) {
    if (r[col('source')] !== 'persona') continue;
    const id = r[col('persona_id')];
    if (!id || seen.has(id)) continue;
    seen.set(id, {
      id,
      name: r[col('persona_name')],
      profile: r[col('profile')],
      decision: r[col('expected_decision')],
      summary: r[col('persona_summary')],
    });
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- output shapes (mirror reducer args) ----------
type Line = {
  accountCode: string;
  debitMinor: string;
  creditMinor: string;
  ccy: string;
  fxRateE6: string;
  customerId?: number;
  vendorId?: number;
  memo: string;
};
type JE = { periodYm: string; memo: string; lines: Line[] };

export type Seed = {
  closeYm: string;
  subsidiary: { code: string; name: string; functionalCcy: string };
  accounts: SeedAccount[];
  periods: { yms: string[]; closedYms: string[] };
  customers: { idx: number; name: string; domain: string; guarantorPersonaId: string; guarantorName: string; paymentTermsDays: number; yelpUrl?: string; jobBoard?: string; linkedinUrl?: string }[];
  vendors: { idx: number; name: string; domain: string; category: string; ownerPersonaId?: string; expenseAccountCode: string; yelpUrl?: string; jobBoard?: string; linkedinUrl?: string }[];
  contracts: {
    customerIdx: number;
    code: string;
    startYm: string;
    endYm: string;
    totalMinor: string;
    plan: 'annual' | 'usage';
    items: { kind: 'subscription' | 'usage'; priceMinor: string; qty: string; sspMinor: string; description: string }[];
    scheduleLines: { ym: string; amountMinor: string; recognized: boolean }[];
  }[];
  invoices: { customerIdx: number; contractCode?: string; number: string; ym: string; issuedAtMicros: string; dueAtMicros: string; amountMinor: string; status: string }[];
  bills: { vendorIdx: number; externalRef: string; ym: string; billedAtMicros: string; dueAtMicros: string; amountMinor: string; expenseAccountCode: string; status: string }[];
  bankTransactions: { bookedAtMicros: string; ym: string; amountMinor: string; ccy: string; description: string; counterparty: string; matched: boolean }[];
  journalEntries: JE[];
  closeTasks: { title: string; description: string; ownerRole: string; sortOrder: number }[];
  anomalies: { id: number; title: string; expect: string }[];
  /** Cafoo Ltd, the eliminations company, FX rates and intercompany entries. Built from its own PRNG (group.ts). */
  group: GroupSeed;
};

const BUSINESSES = [
  ['Okafor Dental Group', 'okafordental.com'],
  ['Whitfield Property Partners', 'whitfieldpp.com'],
  ['Reyes Creative Studio', 'reyescreative.co'],
  ['Lindqvist Woodworks', 'lindqvistwood.com'],
  ['Dalton Auto Repair', 'daltonautorepair.com'],
  ['Morrissey Fitness', 'morrisseyfit.com'],
  ['Bellamy Landscaping', 'bellamylandscape.com'],
  ['Venkatesan Tax Advisors', 'venkatesantax.com'],
  ['Holloway Roofing', 'hollowayroofing.com'],
  ['Kowalczyk Veterinary', 'kowalczykvet.com'],
  ['Szabo Catering Co', 'szabocatering.com'],
  ['Anand Logistics', 'anandlogistics.io'],
  ['Brennan Media Labs', 'brennanmedialabs.com'],
  ['Pettigrew Hardware', 'pettigrewhardware.com'],
  ['Farragut Family Pharmacy', 'farragutrx.com'],
  ['Oyelaran Legal Services', 'oyelaranlegal.com'],
  ['Castellanos Architecture', 'castellanosarch.com'],
  ['Abernathy Plumbing', 'abernathyplumbing.com'],
  ['Bansho Ramen', 'banshoramen.com'],
  ['Whitcomb Antiques', 'whitcombantiques.com'],
];

const VENDORS: Seed['vendors'] = [
  { idx: 1, name: 'Northwind Cloud', domain: 'northwindcloud.com', category: 'Hosting & infrastructure', expenseAccountCode: '5000' },
  { idx: 2, name: 'Lumen Analytics', domain: 'lumenanalytics.io', category: 'Software & tools', ownerPersonaId: 'P10', expenseAccountCode: '5100' },
  { idx: 3, name: 'Harbor Payroll', domain: 'harborpayroll.com', category: 'Payroll', expenseAccountCode: '5300' },
  { idx: 4, name: 'Signal & Co Marketing', domain: 'signalandco.com', category: 'Marketing', expenseAccountCode: '5400' },
  { idx: 5, name: 'Meridian Workspace', domain: 'meridianworkspace.com', category: 'Rent & office', expenseAccountCode: '5500' },
  { idx: 6, name: 'Aldridge Legal LLP', domain: 'aldridgelegal.com', category: 'Professional services', expenseAccountCode: '5600' },
  { idx: 7, name: 'Kestrel Design Collective', domain: 'kestreldesign.co', category: 'Contractors', expenseAccountCode: '5200' },
  { idx: 8, name: 'Pinecone Support Desk', domain: 'pineconesupport.com', category: 'Software & tools', expenseAccountCode: '5100' },
  { idx: 9, name: 'Granite Insurance', domain: 'graniteinsure.com', category: 'Insurance', expenseAccountCode: '5500' },
  { idx: 10, name: 'Ferry Street Coffee', domain: 'ferrystreetcoffee.com', category: 'Office supplies', expenseAccountCode: '5500' },
  { idx: 11, name: 'Beacon Recruiting', domain: 'beaconrecruit.com', category: 'Professional services', expenseAccountCode: '5600' },
  { idx: 12, name: 'Orbit Travel', domain: 'orbittravel.com', category: 'Travel', expenseAccountCode: '5800' },
  { idx: 13, name: 'Tidewater Contractors', domain: 'tidewatercontract.com', category: 'Contractors', expenseAccountCode: '5200' },
  { idx: 14, name: 'Brennan Data Services LLC', domain: 'brennandataservices.com', category: 'Contractors', ownerPersonaId: 'P13', expenseAccountCode: '5200' },
  { idx: 15, name: 'Pettigrew Consulting', domain: 'pettigrewconsulting.net', category: 'Professional services', ownerPersonaId: 'P14', expenseAccountCode: '5600' },
  // A public company we pay for payment processing: no owner check, but a public footprint (LinkedIn, job board).
  { idx: 16, name: 'Stripe', domain: 'stripe.com', category: 'Payment processing', expenseAccountCode: '6000', linkedinUrl: 'https://www.linkedin.com/company/stripe', jobBoard: 'greenhouse:stripe' },
];

function main() {
  const close = resolveClosePeriod();
  const closeYm = ymStr(close);
  const m1 = ymAdd(close, -1);
  const m2 = ymAdd(close, -2);
  const next = ymAdd(close, 1);
  const personas = loadPersonas();
  if (personas.length !== 20) throw new Error(`Expected 20 personas, found ${personas.length}`);

  const seed: Seed = {
    closeYm,
    subsidiary: { code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD' },
    accounts: ACCOUNTS,
    // The month after next is open too, so the next month's balance elimination has a month to reverse into.
    periods: { yms: [ymStr(m2), ymStr(m1), closeYm, ymStr(next), ymStr(ymAdd(close, 2))], closedYms: [ymStr(m2), ymStr(m1)] },
    customers: [],
    vendors: VENDORS,
    contracts: [],
    invoices: [],
    bills: [],
    bankTransactions: [],
    journalEntries: [],
    closeTasks: [],
    anomalies: [],
    group: buildGroup(close),
  };

  // ---------- customers ----------
  personas.forEach((p, i) => {
    const [name, domain] = BUSINESSES[i];
    seed.customers.push({
      idx: i + 1,
      name,
      domain,
      guarantorPersonaId: p.id,
      guarantorName: p.name,
      paymentTermsDays: 30,
      // Customer 19 (the cafe owner persona) has a real public listing for the public-footprint demo.
      ...(i + 1 === 19 ? { yelpUrl: 'https://www.yelp.com/biz/bansho-ramen-berkeley-3' } : {}),
    });
  });

  // ---------- opening balances (posted in the first, closed month) ----------
  seed.journalEntries.push({
    periodYm: ymStr(m2),
    memo: 'Opening balances',
    lines: [
      line('1000', 185_000_00, 0, 'Opening cash'),
      line('1500', 42_000_00, 0, 'Opening equipment'),
      line('1200', 18_000_00, 0, 'Opening prepaid insurance'),
      line('3000', 0, 150_000_00, 'Common stock'),
      line('3100', 0, 95_000_00, 'Retained earnings'),
    ],
  });

  // ---------- contracts, invoices, revenue ----------
  // 14 annual subscription contracts, 6 usage contracts. Customer 7 (P07) carries the large overdue AR.
  const usageCustomers = new Set([3, 5, 11, 13, 16, 20]);
  let invoiceNo = 1040;
  const nextInvoice = () => `INV-${++invoiceNo}`;
  const monthlyPrices = [150000, 220000, 290000, 350000, 480000, 620000, 800000]; // $1,500 .. $8,000 per month

  for (const c of seed.customers) {
    const code = `C-${String(c.idx).padStart(3, '0')}`;
    if (usageCustomers.has(c.idx)) {
      const unit = pick([45, 60, 90, 120]) * 100; // per 1k events
      const start = ymAdd(close, -between(2, 8));
      const items = [{ kind: 'usage' as const, priceMinor: String(unit), qty: '1', sspMinor: String(unit), description: 'Metered events, per 1,000' }];
      seed.contracts.push({
        customerIdx: c.idx,
        code,
        startYm: ymStr(start),
        endYm: ymStr(ymAdd(start, 11)),
        totalMinor: '0',
        plan: 'usage',
        items,
        scheduleLines: [],
      });
      // Monthly usage invoices in arrears for m2, m1 (paid) and close month (open, billed on the 1st of next month... here: issued end of month)
      for (const ym of [m2, m1, close]) {
        const qty = between(40, 180);
        const amount = qty * unit;
        const issued = midMonth(ym, daysInMonth(ym));
        const status = ym === close ? 'open' : 'paid';
        seed.invoices.push({
          customerIdx: c.idx,
          contractCode: code,
          number: nextInvoice(),
          ym: ymStr(ym),
          issuedAtMicros: issued,
          dueAtMicros: plusDays(issued, 30),
          amountMinor: String(amount),
          status,
        });
        // Revenue recognized in the usage month: Dr AR / Cr Usage Revenue (posted for closed months; the close month is the Revenue agent's job)
        if (ym !== close) {
          seed.journalEntries.push({
            periodYm: ymStr(ym),
            memo: `Usage revenue ${c.name} ${ymStr(ym)}`,
            lines: [line('1100', amount, 0, `Invoice for ${c.name}`, { customerIdx: c.idx }), line('4100', 0, amount, 'Metered usage', { customerIdx: c.idx })],
          });
        }
      }
      continue;
    }

    // Annual subscription
    const monthly = c.idx === 7 ? 400000 : pick(monthlyPrices); // customer 7: $4,000/mo → $48,000/yr
    const start = c.idx === 7 ? ymAdd(close, -2) : c.idx === 14 ? m1 : ymAdd(close, -between(0, 9));
    const end = ymAdd(start, 11);
    const total = monthly * 12;
    const items = [{ kind: 'subscription' as const, priceMinor: String(monthly), qty: '1', sspMinor: String(monthly), description: 'Platform subscription, annual, billed upfront' }];

    // Schedule lines: one per month of the term. Recognized for months before the close month.
    // Anomaly 2: C-014 billed in m1 with NO schedule lines at all.
    const scheduleLines: Seed['contracts'][number]['scheduleLines'] = [];
    if (c.idx !== 14) {
      for (let k = 0; k < 12; k++) {
        const ym = ymAdd(start, k);
        const beforeClose = ym.year * 12 + ym.month < close.year * 12 + close.month;
        scheduleLines.push({ ym: ymStr(ym), amountMinor: String(monthly), recognized: beforeClose });
      }
    }
    seed.contracts.push({ customerIdx: c.idx, code, startYm: ymStr(start), endYm: ymStr(end), totalMinor: String(total), plan: 'annual', items, scheduleLines });

    // Invoice at start of term. Terms: customer 7 is overdue and unpaid.
    const issued = midMonth(start, 1);
    const startBeforeClose = start.year * 12 + start.month < close.year * 12 + close.month;
    const paid = c.idx === 7 ? false : startBeforeClose ? rand() < 0.85 : false;
    const status = c.idx === 7 ? 'overdue' : paid ? 'paid' : 'open';
    seed.invoices.push({
      customerIdx: c.idx,
      contractCode: code,
      number: nextInvoice(),
      ym: ymStr(start),
      issuedAtMicros: issued,
      dueAtMicros: plusDays(issued, 30),
      amountMinor: String(total),
      status,
    });
    // Billing entry: Dr AR / Cr Deferred Revenue, in the start period if it is within our seeded periods, else in m2 as opening.
    const billYm = start.year * 12 + start.month < m2.year * 12 + m2.month ? m2 : start;
    seed.journalEntries.push({
      periodYm: ymStr(billYm),
      memo: `Annual invoice ${c.name} (${code})`,
      lines: [line('1100', total, 0, `Invoice ${code}`, { customerIdx: c.idx }), line('2400', 0, total, `Deferred revenue ${code}`, { customerIdx: c.idx })],
    });
    // Recognition entries for months before the close month that fall within seeded periods (m2, m1); earlier months collapse into m2.
    let earlier = 0;
    for (const sl of scheduleLines) {
      if (!sl.recognized) continue;
      const [y, mo] = sl.ym.split('-').map(Number);
      const idx = y * 12 + mo;
      if (idx < m2.year * 12 + m2.month) earlier += monthly;
      else {
        seed.journalEntries.push({
          periodYm: sl.ym,
          memo: `Revenue recognition ${c.name} ${sl.ym}`,
          lines: [line('2400', monthly, 0, `Release deferred ${code}`, { customerIdx: c.idx }), line('4000', 0, monthly, `Subscription revenue ${code}`, { customerIdx: c.idx })],
        });
      }
    }
    // Revenue earned before the first seeded month belongs to earlier, already-closed years: it is an opening balance
    // (deferred revenue released into retained earnings), not revenue of the first seeded month's P&L. The balance sheet
    // is the same either way.
    if (earlier > 0) {
      seed.journalEntries.push({
        periodYm: ymStr(m2),
        memo: `Opening balance: revenue recognized before ${ymStr(m2)} for ${c.name}`,
        lines: [line('2400', earlier, 0, `Deferred revenue released before ${ymStr(m2)} (${code})`, { customerIdx: c.idx }), line('3100', 0, earlier, `Retained earnings: revenue earned before ${ymStr(m2)} (${code})`)],
      });
    }
    // Cash receipt for paid invoices: bank inflow + JE in the month after issue (or m2 if earlier), matched.
    if (paid) {
      const payYm = ymAdd(start, 1).year * 12 + ymAdd(start, 1).month < m2.year * 12 + m2.month ? m2 : ymAdd(start, 1);
      const payYmClamped = payYm.year * 12 + payYm.month >= close.year * 12 + close.month ? m1 : payYm;
      const when = midMonth(payYmClamped, between(3, 25));
      seed.bankTransactions.push({ matched: false, bookedAtMicros: when, ym: ymStr(payYmClamped), amountMinor: String(total), ccy: 'USD', description: `ACH CREDIT ${c.name.toUpperCase()} ${code}`, counterparty: c.name });
      seed.journalEntries.push({
        periodYm: ymStr(payYmClamped),
        memo: `Payment received ${c.name} ${code}`,
        lines: [line('1000', total, 0, 'Bank receipt', { customerIdx: c.idx }), line('1100', 0, total, `Settle ${code}`, { customerIdx: c.idx })],
      });
    }
  }

  // Usage invoice receipts for m2 and m1 (paid), posted and matched; the close-month receipts arrive in the close month, unmatched.
  for (const inv of seed.invoices.filter(i => i.status === 'paid' && seed.contracts.find(c => c.code === i.contractCode)?.plan === 'usage')) {
    const [y, mo] = inv.ym.split('-').map(Number);
    const payYm = ymAdd({ year: y, month: mo }, 1);
    const cust = seed.customers[inv.customerIdx - 1];
    const amt = Number(inv.amountMinor);
    if (payYm.year * 12 + payYm.month >= close.year * 12 + close.month) {
      // receipt lands in the close month: unmatched bank inflow, no JE yet (Bookkeeper matches it)
      seed.bankTransactions.push({ matched: false, bookedAtMicros: midMonth(close, between(2, 12)), ym: closeYm, amountMinor: String(amt), ccy: 'USD', description: `ACH CREDIT ${cust.name.toUpperCase()} ${inv.number}`, counterparty: cust.name });
      inv.status = 'open';
    } else {
      const when = midMonth(payYm, between(3, 20));
      seed.bankTransactions.push({ matched: false, bookedAtMicros: when, ym: ymStr(payYm), amountMinor: String(amt), ccy: 'USD', description: `ACH CREDIT ${cust.name.toUpperCase()} ${inv.number}`, counterparty: cust.name });
      seed.journalEntries.push({
        periodYm: ymStr(payYm),
        memo: `Payment received ${cust.name} ${inv.number}`,
        lines: [line('1000', amt, 0, 'Bank receipt', { customerIdx: cust.idx }), line('1100', 0, amt, `Settle ${inv.number}`, { customerIdx: cust.idx })],
      });
    }
  }

  // Close-month customer receipts for open annual invoices issued in the close month (a few pay fast): unmatched inflows.
  for (const inv of seed.invoices.filter(i => i.status === 'open' && i.ym === closeYm && rand() < 0.5)) {
    const cust = seed.customers[inv.customerIdx - 1];
    seed.bankTransactions.push({ matched: false, bookedAtMicros: midMonth(close, between(10, 27)), ym: closeYm, amountMinor: inv.amountMinor, ccy: 'USD', description: `WIRE IN ${cust.name.toUpperCase()} REF ${inv.number}`, counterparty: cust.name });
  }

  // ---------- vendors, bills, payments ----------
  const monthlyBill: Record<number, number> = { 1: 1240000, 2: 189000, 3: 0, 4: 650000, 5: 1200000, 6: 480000, 7: 720000, 8: 99000, 9: 310000, 10: 18500, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0 };
  let billNo = 7000;
  for (const ym of [m2, m1, close]) {
    for (const v of seed.vendors) {
      const amt = monthlyBill[v.idx];
      if (!amt) continue;
      const ref = `${v.name.split(' ')[0].toUpperCase()}-${ymStr(ym).replace('-', '')}-${++billNo}`;
      const billed = midMonth(ym, between(1, 5));
      const isClose = ym === close;
      seed.bills.push({ vendorIdx: v.idx, externalRef: ref, ym: ymStr(ym), billedAtMicros: billed, dueAtMicros: plusDays(billed, 30), amountMinor: String(amt), expenseAccountCode: v.expenseAccountCode, status: isClose ? 'open' : 'paid' });
      // Expense recognition JE (Dr expense / Cr AP) for every month including the close month (bills are recorded when received)
      seed.journalEntries.push({
        periodYm: ymStr(ym),
        memo: `Bill ${v.name} ${ref}`,
        lines: [line(v.expenseAccountCode, amt, 0, v.category, { vendorIdx: v.idx }), line('2000', 0, amt, `AP ${ref}`, { vendorIdx: v.idx })],
      });
      // Payment: closed months paid and matched with JE; close month: bank outflow present, unmatched, no JE.
      const payWhen = midMonth(ym, between(15, 27));
      seed.bankTransactions.push({ matched: false, bookedAtMicros: payWhen, ym: ymStr(ym), amountMinor: String(-amt), ccy: 'USD', description: `ACH DEBIT ${v.name.toUpperCase()} ${ref}`, counterparty: v.name });
      if (!isClose) {
        seed.journalEntries.push({
          periodYm: ymStr(ym),
          memo: `Payment ${v.name} ${ref}`,
          lines: [line('2000', amt, 0, `Settle ${ref}`, { vendorIdx: v.idx }), line('1000', 0, amt, 'Bank payment', { vendorIdx: v.idx })],
        });
      } else if (v.idx === 1) {
        // Anomaly 1: duplicate payment to Northwind Cloud, same reference, three days later.
        seed.bankTransactions.push({ matched: false, bookedAtMicros: plusDays(payWhen, 3), ym: closeYm, amountMinor: String(-amt), ccy: 'USD', description: `ACH DEBIT ${v.name.toUpperCase()} ${ref}`, counterparty: v.name });
      }
    }
  }
  // Anomaly 3: first bill from the P13-owned vendor, open, awaiting payment, unverified.
  {
    const v = seed.vendors[13];
    const billed = midMonth(close, 18);
    seed.bills.push({ vendorIdx: v.idx, externalRef: `BDS-0001`, ym: closeYm, billedAtMicros: billed, dueAtMicros: plusDays(billed, 15), amountMinor: '2475000', expenseAccountCode: v.expenseAccountCode, status: 'open' });
    seed.journalEntries.push({
      periodYm: closeYm,
      memo: `Bill ${v.name} BDS-0001 (data migration project)`,
      lines: [line(v.expenseAccountCode, 2475000, 0, 'Data migration project', { vendorIdx: v.idx }), line('2000', 0, 2475000, 'AP BDS-0001', { vendorIdx: v.idx })],
    });
  }
  // The P14-owned vendor has sent a proposal but no bill yet: it appears only as a vendor needing verification.
  // Anomaly 4: contractor invoice for close-month work, dated the 3rd of the next month. No accrual exists.
  {
    const v = seed.vendors[12];
    const billed = midMonth(next, 3);
    seed.bills.push({ vendorIdx: v.idx, externalRef: `TWC-${closeYm.replace('-', '')}`, ym: closeYm, billedAtMicros: billed, dueAtMicros: plusDays(billed, 30), amountMinor: '1860000', expenseAccountCode: v.expenseAccountCode, status: 'open' });
  }

  // Payroll, card and bank-fee noise in the close month (unmatched outflows the Bookkeeper must classify)
  seed.bankTransactions.push(
    { matched: false, bookedAtMicros: midMonth(close, 15), ym: closeYm, amountMinor: '-4860000', ccy: 'USD', description: 'HARBOR PAYROLL DIRECT DEP 15TH', counterparty: 'Harbor Payroll' },
    { matched: false, bookedAtMicros: midMonth(close, 30), ym: closeYm, amountMinor: '-4860000', ccy: 'USD', description: 'HARBOR PAYROLL DIRECT DEP EOM', counterparty: 'Harbor Payroll' },
    { matched: false, bookedAtMicros: midMonth(close, 4), ym: closeYm, amountMinor: '-4500', ccy: 'USD', description: 'MONTHLY SERVICE FEE', counterparty: 'Bank' },
    { matched: false, bookedAtMicros: midMonth(close, 9), ym: closeYm, amountMinor: '-38900', ccy: 'USD', description: 'CARD PURCHASE FERRY STREET COFFEE', counterparty: 'Ferry Street Coffee' },
    { matched: false, bookedAtMicros: midMonth(close, 21), ym: closeYm, amountMinor: '-129900', ccy: 'USD', description: 'CARD PURCHASE ORBIT TRAVEL SFO-NYC', counterparty: 'Orbit Travel' },
    { matched: false, bookedAtMicros: midMonth(close, 22), ym: closeYm, amountMinor: '-89000', ccy: 'USD', description: 'ACH DEBIT QUILLSTACK INC SUBSCRIPTION', counterparty: 'Quillstack Inc' }
  );
  // Prior-month noise, matched (fees/coffee/payroll with JEs) to make the ledger look lived-in
  for (const ym of [m2, m1]) {
    const fee = 4500;
    seed.bankTransactions.push({ matched: false, bookedAtMicros: midMonth(ym, 4), ym: ymStr(ym), amountMinor: String(-fee), ccy: 'USD', description: 'MONTHLY SERVICE FEE', counterparty: 'Bank' });
    seed.journalEntries.push({ periodYm: ymStr(ym), memo: 'Bank service fee', lines: [line('6000', fee, 0, 'Monthly fee'), line('1000', 0, fee, 'Bank fee')] });
  }

  // ---------- close tasks ----------
  seed.closeTasks = [
    { title: 'Reconcile the bank feed', description: 'Match every bank transaction in the close month to an invoice, a bill, or a new entry. Flag anything unusual.', ownerRole: 'bookkeeper', sortOrder: 1 },
    { title: 'Recognize revenue and roll deferred revenue', description: 'Post the month\'s revenue recognition for every active contract and confirm the deferred revenue balance ties out.', ownerRole: 'revenue', sortOrder: 2 },
    { title: 'Review payables and accruals', description: 'Confirm every bill for the month is recorded, accrue work done but not yet billed, and catch duplicate payments.', ownerRole: 'bookkeeper', sortOrder: 3 },
    { title: 'Credit review and allowance', description: 'Check the guarantors behind open receivables and set aside an allowance where the risk warrants it.', ownerRole: 'credit', sortOrder: 4 },
    { title: 'Verify new vendors before payment', description: 'Confirm identity and fraud risk for any vendor being paid for the first time.', ownerRole: 'credit', sortOrder: 5 },
    { title: 'Board pack and period lock', description: 'Render the P&L, balance sheet and ARR waterfall, then ask the CFO to lock the month.', ownerRole: 'advisor', sortOrder: 6 },
  ];

  seed.anomalies = [
    { id: 1, title: 'Duplicate payment to Northwind Cloud', expect: 'Bookkeeper proposes a reversal and a receivable from the vendor for the second debit.' },
    { id: 2, title: 'Contract C-014 has no revenue schedule', expect: 'Revenue proposes the full 12-month schedule and the close-month recognition entry.' },
    { id: 3, title: 'First payment pending to a vendor owned by a synthetic identity (P13)', expect: 'Credit & Risk proposes a vendor block before payment.' },
    { id: 4, title: 'Contractor invoice dated after month end for close-month work', expect: 'Bookkeeper proposes an accrual that reverses next month.' },
    { id: 5, title: 'Customer 7 guarantor is in an active Chapter 13 plan with $48,000 overdue', expect: 'Credit & Risk proposes a 100% allowance.' },
    { id: 6, title: 'Lumen Analytics, with an open bill, has an owner (P10) who was never checked', expect: 'Credit & Risk records clean identity and fraud checks and proposes a vendor check; the Advisor\'s approval marks the vendor verified.' },
  ];

  // Prior-month bank activity is already matched (its entries are seeded); the close month is the Bookkeeper's job.
  // The demo company's scale (plan.md). The default profile is the test fixture, whose exact figures CI asserts.
  if (process.env.SEED_PROFILE === 'quillmesh') scaleToQuillmesh(seed, close);

  for (const t of seed.bankTransactions) t.matched = t.ym !== closeYm;
  // Open invoices past due at the end of the close month are overdue from the start.
  const closeEnd = BigInt(micros(close.year, close.month, daysInMonth(close), 23));
  for (const inv of seed.invoices) if (inv.status === 'open' && BigInt(inv.dueAtMicros) < closeEnd) inv.status = 'overdue';
  mkdirSync(join(root, 'seed', 'out'), { recursive: true });
  writeFileSync(join(root, 'seed', 'out', 'seed.json'), JSON.stringify(seed, null, 2));
  const totals = {
    closeYm,
    customers: seed.customers.length,
    vendors: seed.vendors.length,
    contracts: seed.contracts.length,
    invoices: seed.invoices.length,
    bills: seed.bills.length,
    bankTransactions: seed.bankTransactions.length,
    journalEntries: seed.journalEntries.length,
  };
  console.log(JSON.stringify(totals));
}

function line(accountCode: string, debit: number, credit: number, memo: string, ref: { customerIdx?: number; vendorIdx?: number } = {}): Line {
  return {
    accountCode,
    debitMinor: String(debit),
    creditMinor: String(credit),
    ccy: 'USD',
    fxRateE6: '1000000',
    customerId: ref.customerIdx,
    vendorId: ref.vendorIdx,
    memo,
  };
}

main();
