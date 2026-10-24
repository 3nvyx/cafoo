/**
 * The bank and invoice feed for the first open month after a locked one (October once September is locked).
 * feedPlan is pure and deterministic: the same context and seed give the same events, every external id is built from
 * content (`feed-<ym>-rcpt-<invoice number>`, `-pay-<bill ref>`, `-fee-<day>`, `-card-<day>`, `-payroll-<day>`,
 * `-inv-<invoice number>`), and dates and amounts come from keyed draws, so a plan rebuilt from a later state keeps
 * the ids and contents of the events it still contains. The gateway's feeder ingests the events in order
 * (invoices before their receipts) through ingestBankTransactions / ingestInvoices; `tx` and `invoice` are exactly
 * those reducers' row arguments.
 *
 * The month's mix: exact receipts for last month's open usage invoices (one of them only partly paid, one paid from a
 * partly matching name so it lands in review), the bank's monthly fee, one card purchase, a $48,600 payroll run
 * (material), three new usage invoices under materiality with their exact receipts, and payments of bills due this month to vendors
 * that are not blocked and either verified or paid before. Never a payment to a blocked vendor.
 *
 * No clock, no Node APIs, no imports outside this package.
 */
import { DAY_MICROS, daysInMonth, keyed, microsAt, ymAdd, ymParse, ymStr } from './calendar';

/** What the feed expects the Bookkeeper to make of an event (for smoke tests and the ticker). */
export type FeedExpect = 'auto_match' | 'review' | 'partial' | 'classify' | 'new_invoice';

/** ingestBankTransactions row (FeedBankTxArg). */
export interface FeedBankTx {
  externalId: string;
  bookedAtMicros: bigint;
  amountMinor: bigint;
  ccy: string;
  description: string;
  counterparty: string;
}

/** ingestInvoices row (FeedInvoiceArg). */
export interface FeedInvoice {
  externalId: string;
  customerId: bigint;
  contractCode: string | undefined;
  number: string;
  issuedAtMicros: bigint;
  dueAtMicros: bigint;
  amountMinor: bigint;
}

interface FeedEventBase {
  externalId: string;
  /** Target month, YYYY-MM. */
  ym: string;
  /** When it happens: the booking or issue instant. Events are sorted by it. */
  atMicros: bigint;
  /** At or above the materiality threshold: whatever the Bookkeeper proposes for it waits for the CFO. */
  material: boolean;
  /** One plain sentence for the ticker. */
  notePlain: string;
}

export interface FeedBankTxEvent extends FeedEventBase {
  kind: 'bank_tx';
  subsidiaryCode: string;
  tx: FeedBankTx;
  expect: Exclude<FeedExpect, 'new_invoice'>;
  /** The document a receipt or payment is meant for. */
  target?: { kind: 'invoice' | 'bill'; ref: string };
}

export interface FeedInvoiceEvent extends FeedEventBase {
  kind: 'invoice';
  invoice: FeedInvoice;
  expect: 'new_invoice';
}

export type FeedEvent = FeedBankTxEvent | FeedInvoiceEvent;

/**
 * What the plan reads, for one subsidiary. Ids are database ids. Pass that subsidiary's customers, vendors, contracts,
 * invoices, bills and bank transactions (rows of other subsidiaries are ignored where they can be told apart).
 */
export interface FeedContext {
  /** Target month, YYYY-MM: the first open month whose previous month is locked. */
  ym: string;
  subsidiaryCode?: string;
  ccy?: string;
  customers: readonly { id: bigint; name: string }[];
  /** verification: 'unverified' | 'verified' | 'blocked'. */
  vendors: readonly { id: bigint; name: string; verification: string }[];
  /** plan: 'annual' | 'usage'; unitPriceMinor is the usage item's price per unit. */
  contracts: readonly { code: string; customerId: bigint; plan: string; unitPriceMinor: bigint }[];
  invoices: readonly { number: string; customerId: bigint; contractCode?: string; ym: string; amountMinor: bigint; dueAtMicros: bigint; status: string }[];
  bills: readonly { externalRef: string; vendorId: bigint; ym: string; amountMinor: bigint; dueAtMicros: bigint; status: string }[];
  /** Already-booked bank lines; a bill whose reference is on an outflow is never paid again. */
  bankTransactions: readonly { description: string; amountMinor: bigint }[];
  /** Default $10,000, the module's default materiality threshold. New invoices stay under it. */
  materialityMinor?: bigint;
}

export const FEED_PAYROLL_MINOR = 48_600_00n;
export const FEED_BANK_FEE_MINOR = 45_00n;
export const FEED_NEW_USAGE_INVOICES = 3;
const USAGE_TERMS_DAYS = 30n;

const abs = (v: bigint) => (v < 0n ? -v : v);

function money(minor: bigint): string {
  const a = abs(minor);
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = a % 100n;
  return `${minor < 0n ? '-' : ''}$${whole}${cents === 0n ? '' : `.${cents.toString().padStart(2, '0')}`}`;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const pad2 = (n: number) => String(n).padStart(2, '0');

export function feedPlan(ctx: FeedContext, opts: { seed?: number } = {}): FeedEvent[] {
  const seed = opts.seed ?? 2027;
  const target = ymParse(ctx.ym);
  const ym = ymStr(target);
  const prev = ymStr(ymAdd(target, -1));
  const sub = ctx.subsidiaryCode ?? 'US';
  const materiality = ctx.materialityMinor ?? 10_000_00n;
  const ccy = ctx.ccy ?? 'USD';
  const last = daysInMonth(target);
  const monthStart = microsAt(target, 1, 0);
  const monthEnd = microsAt(ymAdd(target, 1), 1, 0);
  const draw = (key: string) => keyed(`${seed}|${ym}|${key}`);
  const int = (key: string, lo: number, hi: number) => (hi <= lo ? lo : lo + Math.floor(draw(key) * (hi - lo + 1)));
  const clampDay = (d: number) => Math.min(Math.max(d, 1), last);
  const at = (day: number) => microsAt(target, clampDay(day));
  const dayOf = (micros: bigint) => Number((micros - monthStart) / DAY_MICROS) + 1;
  /** A day in the month within `spread` days before the due date (the month's last day when due later). */
  const nearDue = (due: bigint, key: string, spread: number) => {
    const anchor = due < monthStart ? 1 : due >= monthEnd ? last : dayOf(due);
    return clampDay(anchor - int(key, 0, spread));
  };

  const customers = new Map(ctx.customers.map(c => [c.id, c]));
  const vendors = new Map(ctx.vendors.map(v => [v.id, v]));
  const contracts = new Map(ctx.contracts.map(k => [k.code, k]));
  const invoices = ctx.invoices.filter(i => customers.has(i.customerId));
  const bills = ctx.bills.filter(b => vendors.has(b.vendorId));
  // Collision pools use every earlier document whatever its status, so a plan rebuilt after some get paid is unchanged.
  const invoiceAmounts = invoices.filter(i => i.ym < ym).map(i => i.amountMinor);
  const billAmounts = bills.map(b => b.amountMinor);
  /** True when `amount` is within 1% of any amount in the pool: the matcher would score it as a near-exact candidate. */
  const near = (amount: bigint, pool: readonly bigint[]) => pool.some(a => abs(a - amount) * 100n <= a);
  const avoid = (amount: bigint, pool: readonly bigint[], step: bigint) => {
    let v = amount;
    while (v <= 0n || near(v, pool)) v += step;
    return v;
  };

  const events: FeedEvent[] = [];
  const bankTx = (
    id: string,
    day: number,
    amountMinor: bigint,
    description: string,
    counterparty: string,
    expect: FeedBankTxEvent['expect'],
    notePlain: string,
    target?: FeedBankTxEvent['target']
  ) => {
    const bookedAtMicros = at(day);
    const e: FeedBankTxEvent = {
      kind: 'bank_tx',
      externalId: id,
      ym,
      atMicros: bookedAtMicros,
      subsidiaryCode: sub,
      tx: { externalId: id, bookedAtMicros, amountMinor, ccy, description, counterparty },
      expect,
      material: abs(amountMinor) >= materiality,
      notePlain,
    };
    if (target) e.target = target;
    events.push(e);
  };
  const nameOf = (customerId: bigint) => customers.get(customerId)?.name ?? `customer ${customerId}`;

  // ---------- last month's usage invoices: who pays in part, who pays from a partly matching name ----------
  // Roles are drawn over all of last month's usage invoices, paid or not, so they never shift when some get paid.
  const usage = invoices
    .filter(i => i.ym === prev && contracts.get(i.contractCode ?? '')?.plan === 'usage')
    .slice()
    .sort((a, b) => draw(`role:${a.number}`) - draw(`role:${b.number}`) || (a.number < b.number ? -1 : 1));
  const partial = usage.length >= 2 ? usage[0] : undefined;
  const review = usage.length >= 3 ? usage[1] : undefined;

  // ---------- new usage invoices this month, then their receipts ----------
  const busy = new Set([partial, review].filter(x => x !== undefined).map(x => x.customerId));
  const maxNumber = invoices
    .filter(i => i.ym < ym)
    .map(i => /^INV-(\d+)$/.exec(i.number)?.[1])
    .reduce((m, n) => (n !== undefined && Number(n) > m ? Number(n) : m), 1000);
  const chosen = ctx.contracts
    .filter(k => k.plan === 'usage' && k.unitPriceMinor > 0n && customers.has(k.customerId) && !busy.has(k.customerId))
    .slice()
    .sort((a, b) => draw(`new:${a.code}`) - draw(`new:${b.code}`) || (a.code < b.code ? -1 : 1))
    .slice(0, FEED_NEW_USAGE_INVOICES)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const taken = [...invoiceAmounts];
  chosen.forEach((k, i) => {
    const number = `INV-${maxNumber + i + 1}`;
    const name = nameOf(k.customerId);
    const issuedAtMicros = at(i + 1);
    const dueAtMicros = issuedAtMicros + USAGE_TERMS_DAYS * DAY_MICROS;
    const maxQty = Number((materiality - 1n) / k.unitPriceMinor);
    const qty = BigInt(int(`qty:${number}`, Math.min(40, maxQty), Math.min(180, maxQty)));
    let amountMinor = avoid(qty * k.unitPriceMinor, taken, k.unitPriceMinor);
    if (amountMinor >= materiality) amountMinor = avoid(k.unitPriceMinor, taken, k.unitPriceMinor);
    taken.push(amountMinor);
    const invId = `feed-${ym}-inv-${number}`;
    events.push({
      kind: 'invoice',
      externalId: invId,
      ym,
      atMicros: issuedAtMicros,
      invoice: { externalId: invId, customerId: k.customerId, contractCode: k.code, number, issuedAtMicros, dueAtMicros, amountMinor },
      expect: 'new_invoice',
      material: false,
      notePlain: `Invoice ${number} for ${money(amountMinor)} of metered usage went to ${name}.`,
    });
    bankTx(`feed-${ym}-rcpt-${number}`, Math.max(nearDue(dueAtMicros, `day:${number}`, 1), i + 2), amountMinor, `ACH CREDIT ${name.toUpperCase()} ${number}`, name, 'auto_match',
      `${name} paid invoice ${number} in full, ${money(amountMinor)}.`, { kind: 'invoice', ref: number });
  });

  // ---------- receipts for last month's open usage invoices (the partial one also avoids the new invoices' amounts) ----------
  for (const inv of usage) {
    if (inv.status === 'paid') continue;
    const name = nameOf(inv.customerId);
    const id = `feed-${ym}-rcpt-${inv.number}`;
    const tgt = { kind: 'invoice' as const, ref: inv.number };
    if (inv === partial) {
      const pct = BigInt(int(`pct:${inv.number}`, 35, 65));
      const amount = avoid(((inv.amountMinor * pct) / 100n / 100n) * 100n, taken, 100n);
      bankTx(id, nearDue(inv.dueAtMicros, `day:${inv.number}`, 2), amount, `ACH CREDIT ${name.toUpperCase()} PART PAYMENT ${inv.number}`, name, 'partial',
        `${name} paid ${money(amount)} of the ${money(inv.amountMinor)} on invoice ${inv.number}, so the rest is still owed.`, tgt);
    } else if (inv === review) {
      const first = name.split(/\s+/)[0] ?? name;
      const payer = `${first} Holdings`;
      // Far from the due date, so only the amount and part of the name match: the review bucket.
      const dueDay = inv.dueAtMicros >= monthEnd ? last + 1 : dayOf(inv.dueAtMicros);
      const day = dueDay - 10 >= 2 ? int(`day:${inv.number}`, 2, Math.min(dueDay - 10, 12)) : int(`day:${inv.number}`, Math.min(dueDay + 10, last), last);
      bankTx(id, day, inv.amountMinor, `ACH CREDIT ${payer.toUpperCase()}`, payer, 'review',
        `A ${money(inv.amountMinor)} payment from ${payer} looks like ${name}'s invoice ${inv.number}, but the name only partly matches.`, tgt);
    } else {
      bankTx(id, nearDue(inv.dueAtMicros, `day:${inv.number}`, 2), inv.amountMinor, `ACH CREDIT ${name.toUpperCase()} ${inv.number}`, name, 'auto_match',
        `${name} paid invoice ${inv.number} in full, ${money(inv.amountMinor)}.`, tgt);
    }
  }

  // ---------- bank fee, card purchase, payroll ----------
  bankTx(`feed-${ym}-fee-04`, 4, -FEED_BANK_FEE_MINOR, 'MONTHLY SERVICE FEE', 'Bank', 'classify', `The bank charged its ${money(FEED_BANK_FEE_MINOR)} monthly service fee.`);
  const cardDay = int('card:day', 8, 12);
  const card = avoid(BigInt(int('card:amount', 250_00, 480_00)), billAmounts, 100n);
  bankTx(`feed-${ym}-card-${pad2(cardDay)}`, cardDay, -card, 'CARD PURCHASE FERRY STREET COFFEE', 'Ferry Street Coffee', 'classify', `A ${money(card)} card purchase at Ferry Street Coffee needs booking.`);
  bankTx(`feed-${ym}-payroll-15`, 15, -FEED_PAYROLL_MINOR, 'HARBOR PAYROLL DIRECT DEP 15TH', 'Harbor Payroll', 'classify',
    `Payroll of ${money(FEED_PAYROLL_MINOR)} went out; at this size the CFO confirms how it is booked.`);

  // ---------- bills due this month ----------
  const paidBefore = new Set(bills.filter(b => b.status === 'paid').map(b => b.vendorId));
  const outflows = ctx.bankTransactions.filter(t => t.amountMinor < 0n).map(t => norm(t.description));
  const due = bills
    .filter(b => b.status !== 'paid' && b.dueAtMicros >= monthStart && b.dueAtMicros < monthEnd)
    .filter(b => {
      const v = vendors.get(b.vendorId);
      if (!v || v.verification === 'blocked') return false;
      if (v.verification !== 'verified' && !paidBefore.has(v.id)) return false;
      const ref = norm(b.externalRef);
      return ref.length >= 3 && !outflows.some(d => d.includes(ref));
    })
    .slice()
    .sort((a, b) => (a.externalRef < b.externalRef ? -1 : a.externalRef > b.externalRef ? 1 : 0));
  for (const b of due) {
    const v = vendors.get(b.vendorId)!;
    bankTx(`feed-${ym}-pay-${b.externalRef}`, nearDue(b.dueAtMicros, `pay:${b.externalRef}`, 1), -b.amountMinor, `ACH DEBIT ${v.name.toUpperCase()} ${b.externalRef}`, v.name, 'auto_match',
      `Paid ${v.name}'s bill ${b.externalRef}, ${money(b.amountMinor)}.`, { kind: 'bill', ref: b.externalRef });
  }

  const kindRank = (e: FeedEvent) => (e.kind === 'invoice' ? 0 : 1);
  events.sort((a, b) => (a.atMicros < b.atMicros ? -1 : a.atMicros > b.atMicros ? 1 : kindRank(a) - kindRank(b) || (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0)));
  const ids = new Set<string>();
  for (const e of events) {
    if (ids.has(e.externalId)) throw new Error(`feed plan produced ${e.externalId} twice`);
    ids.add(e.externalId);
  }
  return events;
}

/** The seed.json fields feedContextFromSeed reads (generate.ts writes them). */
export interface SeedForFeed {
  closeYm: string;
  customers: readonly { idx: number; name: string }[];
  vendors: readonly { idx: number; name: string }[];
  contracts: readonly { customerIdx: number; code: string; plan: string; items: readonly { kind: string; priceMinor: string }[] }[];
  invoices: readonly { customerIdx: number; contractCode?: string; number: string; ym: string; dueAtMicros: string; amountMinor: string; status: string }[];
  bills: readonly { vendorIdx: number; externalRef: string; ym: string; dueAtMicros: string; amountMinor: string; status: string }[];
  bankTransactions: readonly { description: string; amountMinor: string }[];
}

/** A FeedContext from seed.json as generated (before any close), for the month after the close month. Ids are seed indexes. */
export function feedContextFromSeed(seed: SeedForFeed, ym = ymStr(ymAdd(ymParse(seed.closeYm), 1))): FeedContext {
  return {
    ym,
    customers: seed.customers.map(c => ({ id: BigInt(c.idx), name: c.name })),
    vendors: seed.vendors.map(v => ({ id: BigInt(v.idx), name: v.name, verification: 'unverified' })),
    contracts: seed.contracts.map(k => ({
      code: k.code,
      customerId: BigInt(k.customerIdx),
      plan: k.plan,
      unitPriceMinor: BigInt(k.items.find(i => i.kind === 'usage')?.priceMinor ?? '0'),
    })),
    invoices: seed.invoices.map(i => ({
      number: i.number,
      customerId: BigInt(i.customerIdx),
      contractCode: i.contractCode,
      ym: i.ym,
      amountMinor: BigInt(i.amountMinor),
      dueAtMicros: BigInt(i.dueAtMicros),
      status: i.status,
    })),
    bills: seed.bills.map(b => ({ externalRef: b.externalRef, vendorId: BigInt(b.vendorIdx), ym: b.ym, amountMinor: BigInt(b.amountMinor), dueAtMicros: BigInt(b.dueAtMicros), status: b.status })),
    bankTransactions: seed.bankTransactions.map(t => ({ description: t.description, amountMinor: BigInt(t.amountMinor) })),
  };
}
