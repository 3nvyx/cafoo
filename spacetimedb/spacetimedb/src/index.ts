import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import spacetimedb, { ContractItemArg, ItemKind, LineArg, overdueSweep, Plan, Role } from './tables';

export { default } from './tables';

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type RoleTag = 'advisor' | 'bookkeeper' | 'revenue' | 'credit' | 'redteam' | 'cfo' | 'ui';

const MATERIALITY_KEY = 'materiality_threshold_minor';
const DEFAULT_MATERIALITY_MINOR = 1_000_000n; // $10,000.00
const MICROS_PER_DAY = 86_400_000_000n;
const OWNER_KEY = 'database_owner';

// ---------- helpers (not exported: only SpacetimeDB registrations may be exported) ----------

function roleOf(ctx: Ctx): RoleTag | null {
  const row = ctx.db.agentIdentity.identity.find(ctx.sender);
  return row ? (row.role.tag as RoleTag) : null;
}

function requireRole(ctx: Ctx, allowed: RoleTag[], what: string): RoleTag {
  const role = roleOf(ctx);
  if (!role || !allowed.includes(role)) {
    throw new SenderError(
      `Only ${allowed.join(' or ')} may ${what}. Your connection is ${role ?? 'not registered'}.`
    );
  }
  return role;
}

function audit(ctx: Ctx, role: string, action: string, targetTable: string, targetId: bigint, detail: string) {
  ctx.db.auditEvent.insert({
    id: 0n,
    actor: ctx.sender,
    actorRole: role,
    action,
    targetTable,
    targetId,
    detail,
    at: ctx.timestamp,
  });
}

function materiality(ctx: Ctx): bigint {
  return ctx.db.settings.key.find(MATERIALITY_KEY)?.valueI64 ?? DEFAULT_MATERIALITY_MINOR;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function accountByCode(ctx: Ctx, code: string) {
  const acct = ctx.db.account.code.find(code);
  if (!acct) throw new SenderError(`Unknown account code ${code}`);
  return acct;
}

function periodById(ctx: Ctx, id: bigint) {
  const p = ctx.db.period.id.find(id);
  if (!p) throw new SenderError(`Unknown period ${id}`);
  return p;
}

function periodByYm(ctx: Ctx, ym: string) {
  const p = ctx.db.period.ym.find(ym);
  if (!p) throw new SenderError(`Unknown period ${ym}`);
  return p;
}

function assertPeriodOpen(ctx: Ctx, periodId: bigint, why?: string) {
  const p = periodById(ctx, periodId);
  if (p.status.tag === 'closed' || ctx.db.periodLock.periodId.find(periodId)) {
    throw new SenderError(`${why ? `${why} ` : ''}Period ${p.ym} is locked. Reopen it before posting.`);
  }
  return p;
}

type LineIn = {
  accountCode: string;
  debitMinor: bigint;
  creditMinor: bigint;
  ccy: string;
  fxRateE6: bigint;
  customerId: bigint | undefined;
  vendorId: bigint | undefined;
  memo: string;
};

function assertBalanced(lines: LineIn[]) {
  if (lines.length < 2) throw new SenderError('A journal entry needs at least two lines.');
  let dr = 0n;
  let cr = 0n;
  for (const l of lines) {
    const hasDr = l.debitMinor > 0n;
    const hasCr = l.creditMinor > 0n;
    if (hasDr === hasCr) {
      throw new SenderError(`Line on ${l.accountCode} must have exactly one of debit or credit above zero.`);
    }
    if (l.debitMinor < 0n || l.creditMinor < 0n) throw new SenderError('Amounts cannot be negative.');
    if (l.fxRateE6 < 0n) throw new SenderError('FX rates must be positive.');
    const rate = l.fxRateE6 === 0n ? 1_000_000n : l.fxRateE6;
    dr += (l.debitMinor * rate) / 1_000_000n;
    cr += (l.creditMinor * rate) / 1_000_000n;
  }
  if (dr !== cr) {
    throw new SenderError(`Entry does not balance: debits ${dr} vs credits ${cr} (minor units).`);
  }
  return dr;
}

/** Currency codes compare case-insensitively ("usd" is USD). */
function ccyKey(ccy: string): string {
  return ccy.trim().toUpperCase();
}

/** Rates recorded in fx_rate for one currency into another in one month (any kind: spot, average, closing). */
function recordedRates(ctx: Ctx, fromCcy: string, toCcy: string, ym: string): bigint[] {
  const from = ccyKey(fromCcy);
  const to = ccyKey(toCcy);
  return [...ctx.db.fxRate.ym.filter(ym)].filter(r => ccyKey(r.fromCcy) === from && ccyKey(r.toCcy) === to).map(r => r.rateE6);
}

function functionalCcyOf(ctx: Ctx, subsidiaryId: bigint): string {
  const sub = ctx.db.subsidiary.id.find(subsidiaryId);
  if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryId}`);
  return ccyKey(sub.functionalCcy);
}

/**
 * Every line's FX rate must be the real one, because balances and the app sum raw minor units while the balance check
 * and materiality use converted amounts: exactly 1.000000 in the subsidiary's own currency, and for another currency
 * a rate recorded in fx_rate for that currency into the subsidiary's currency in the entry's month. A reversal copies
 * the rates of the entry it reverses and nets it to zero, so it is not checked (an entry posted at a bad rate before
 * this rule existed must still be reversible).
 */
function assertRates(ctx: Ctx, subsidiaryId: bigint, periodId: bigint, lines: LineIn[], reversal: boolean) {
  if (reversal) return;
  const functional = functionalCcyOf(ctx, subsidiaryId);
  let ym: string | undefined;
  for (const l of lines) {
    const rate = l.fxRateE6 === 0n ? 1_000_000n : l.fxRateE6;
    if (ccyKey(l.ccy) === functional) {
      if (rate !== 1_000_000n) {
        throw new SenderError(`Line on ${l.accountCode} is in ${functional}, the subsidiary's own currency, so its FX rate must be 1000000 (1.0); got ${l.fxRateE6}.`);
      }
      continue;
    }
    ym ??= periodById(ctx, periodId).ym;
    if (!recordedRates(ctx, l.ccy, functional, ym).includes(rate)) {
      throw new SenderError(`Line on ${l.accountCode} uses ${ccyKey(l.ccy)}/${functional} rate ${rate}, which is not a recorded rate for ${ym}.`);
    }
  }
}

function postEntry(
  ctx: Ctx,
  args: {
    subsidiaryId: bigint;
    periodId: bigint;
    memo: string;
    lines: LineIn[];
    source: 'seed' | 'agent' | 'manual';
    proposalId: bigint | undefined;
    reversalOf: bigint | undefined;
    role: string;
  }
) {
  assertPeriodOpen(ctx, args.periodId);
  const total = assertBalanced(args.lines);
  assertRates(ctx, args.subsidiaryId, args.periodId, args.lines, args.reversalOf !== undefined);
  const je = ctx.db.journalEntry.insert({
    id: 0n,
    subsidiaryId: args.subsidiaryId,
    periodId: args.periodId,
    postedAt: ctx.timestamp,
    memo: args.memo,
    source: { tag: args.source },
    proposalId: args.proposalId,
    postedBy: ctx.sender,
    postedByRole: args.role,
    reversalOf: args.reversalOf,
    totalMinor: total,
  });
  for (const l of args.lines) {
    const acct = accountByCode(ctx, l.accountCode);
    ctx.db.journalLine.insert({
      id: 0n,
      jeId: je.id,
      accountId: acct.id,
      accountCode: acct.code,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
      ccy: l.ccy,
      fxRateE6: l.fxRateE6 === 0n ? 1_000_000n : l.fxRateE6,
      customerId: l.customerId,
      vendorId: l.vendorId,
      memo: l.memo,
    });
  }
  return je;
}

// Proposal payloads travel as JSON because their shape varies by kind. Money is a decimal string of minor units.
type JsonLine = {
  accountCode: string;
  debitMinor: string;
  creditMinor: string;
  ccy?: string;
  fxRateE6?: string;
  customerId?: string;
  vendorId?: string;
  memo?: string;
};
type JournalPayload = {
  subsidiaryId: string;
  periodYm: string;
  memo: string;
  lines: JsonLine[];
  reversesInYm?: string;
  /** Bank transactions this entry explains; they are marked matched and linked to the new entry. */
  bankTxIds?: string[];
  /** Flip unrecognized revenue schedule lines up to this month to recognized, for the customers named on the entry's lines. */
  recognizeScheduleYm?: string;
};
type BankMatchPayload = { matches: { bankTxId: string; targetKind: 'invoice' | 'bill' | 'je'; targetId: string; scoreBp: number }[] };
type RevenueSchedulePayload = { lines: { contractItemId: string; customerId: string; ym: string; amountMinor: string }[] };
type CreditDecisionPayload = { customerId: string; tier: string; paymentTermsDays: number; allowanceMinor?: string; creditCheckIds?: string[] };
type VendorBlockPayload = { vendorId: string; reasonPlain: string };
/** Mirror of vendor_block: the credit agent cites the request ids of the owner checks it recorded. */
type VendorVerifyPayload = { vendorId: string; creditCheckIds: string[]; reasonPlain?: string };

/** Owner checks a vendor_verify proposal must cite, each recorded with APPROVE at tier A or B. */
const VERIFY_PRODUCTS = ['tu_identity_verification', 'fraud_finder'];

/** A whole-number id from a JSON payload, normalized so "05" and "5" are the same id. */
function idOf(x: unknown, what: string): bigint {
  const s = typeof x === 'number' || typeof x === 'bigint' ? String(x) : typeof x === 'string' ? x.trim() : '';
  if (!/^\d+$/.test(s)) throw new SenderError(`${what} must be a whole-number id; got ${JSON.stringify(x ?? null)}.`);
  return BigInt(s);
}

/** A signed amount of minor units from a JSON payload. */
function minorOf(x: unknown, what: string): bigint {
  const s = typeof x === 'number' || typeof x === 'bigint' ? String(x) : typeof x === 'string' ? x.trim() : '';
  if (!/^-?\d+$/.test(s)) throw new SenderError(`${what} must be a whole number of minor units; got ${JSON.stringify(x ?? null)}.`);
  return BigInt(s);
}

/** A list field of a payload: absent is empty; anything but an array is refused. */
function listOf<T>(x: T[] | undefined | null | unknown, what: string): T[] {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) throw new SenderError(`${what} must be a list; got ${JSON.stringify(x)}.`);
  return x as T[];
}

/** Each element of a payload list must be an object. */
function objectsOf<T>(x: unknown, what: string): T[] {
  const list = listOf<unknown>(x, what);
  list.forEach((o, i) => {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new SenderError(`${what}: item ${i + 1} must be an object; got ${JSON.stringify(o)}.`);
  });
  return list as T[];
}

function parseLines(raw: JsonLine[]): LineIn[] {
  if (!Array.isArray(raw)) throw new SenderError('A journal entry needs a list of lines.');
  const lines = objectsOf<JsonLine>(raw, 'lines');
  return lines.map(l => ({
    accountCode: String(l.accountCode ?? ''),
    // An absent or empty amount is zero and an absent or empty rate is 1.0, as before.
    debitMinor: l.debitMinor === undefined || l.debitMinor === '' ? 0n : minorOf(l.debitMinor, `Debit on ${l.accountCode}`),
    creditMinor: l.creditMinor === undefined || l.creditMinor === '' ? 0n : minorOf(l.creditMinor, `Credit on ${l.accountCode}`),
    ccy: ccyKey(l.ccy || 'USD'),
    fxRateE6: l.fxRateE6 === undefined || l.fxRateE6 === '' ? 1_000_000n : minorOf(l.fxRateE6, `FX rate on ${l.accountCode}`),
    customerId: l.customerId ? idOf(l.customerId, 'customerId') : undefined,
    vendorId: l.vendorId ? idOf(l.vendorId, 'vendorId') : undefined,
    memo: String(l.memo ?? ''),
  }));
}

/** A proposal payload: valid JSON and an object (not null, a list or a bare value). */
function parseJson<T>(json: string, kind: string): T {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new SenderError(`Proposal payload for ${kind} is not valid JSON.`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new SenderError(`Proposal payload for ${kind} must be a JSON object; got ${JSON.stringify(v)}.`);
  return v as T;
}

/**
 * Run proposal validation or application so that any unexpected error (a payload shape no check anticipated) is a
 * clean refusal, never an internal error. The transaction still rolls back either way.
 */
function guarded<T>(kind: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof SenderError) throw e;
    throw new SenderError(`The ${kind} proposal could not be processed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Unpaid bills of a vendor: the payments a vendor block holds or a vendor verification releases. */
function openBillsMinor(ctx: Ctx, vendorId: bigint): bigint {
  let total = 0n;
  for (const b of ctx.db.bill.vendorId.filter(vendorId)) if (b.status.tag !== 'paid') total += abs(b.amountMinor);
  return total;
}

/** A calendar month written YYYY-MM. */
function isYm(x: unknown): x is string {
  return typeof x === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(x);
}

/** The rate to use for a currency in a month: the spot rate if one is recorded, else any recorded rate. */
function rateFor(ctx: Ctx, fromCcy: string, toCcy: string, ym: string): bigint | undefined {
  const from = ccyKey(fromCcy);
  const to = ccyKey(toCcy);
  const rows = [...ctx.db.fxRate.ym.filter(ym)].filter(r => ccyKey(r.fromCcy) === from && ccyKey(r.toCcy) === to);
  return (rows.find(r => r.kind.tag === 'spot') ?? rows[0])?.rateE6;
}

/**
 * Amount a proposal really moves or puts at stake, derived from its payload and the ledger so a proposer cannot
 * understate it and slip under the materiality threshold. A journal entry counts at the largest of its raw and
 * converted debits and credits (the ledger and the app sum raw minor units, and a foreign line on either side can be
 * the big one); a revenue schedule at the revenue it plans; a bank match at the cash it settles; a vendor block or
 * verification at the vendor's unpaid bills. A credit decision moves nothing by itself (its allowance arrives as a
 * journal entry).
 */
function computedAmount(ctx: Ctx, kind: string, payloadJson: string): bigint {
  const max = (...xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a), 0n);
  try {
    if (kind === 'journal_entry' || kind === 'accrual') {
      const payload = JSON.parse(payloadJson) as JournalPayload;
      let rawDr = 0n;
      let rawCr = 0n;
      let convDr = 0n;
      let convCr = 0n;
      for (const l of payload.lines ?? []) {
        const dr = abs(BigInt(l.debitMinor || '0'));
        const cr = abs(BigInt(l.creditMinor || '0'));
        const rate = abs(BigInt(l.fxRateE6 || '1000000')) || 1_000_000n;
        rawDr += dr;
        rawCr += cr;
        convDr += (dr * rate) / 1_000_000n;
        convCr += (cr * rate) / 1_000_000n;
      }
      return max(rawDr, rawCr, convDr, convCr);
    }
    if (kind === 'revenue_schedule') {
      const payload = JSON.parse(payloadJson) as RevenueSchedulePayload;
      let total = 0n;
      for (const l of payload.lines ?? []) total += abs(BigInt(l.amountMinor ?? '0'));
      return total;
    }
    if (kind === 'bank_match') {
      const payload = JSON.parse(payloadJson) as BankMatchPayload;
      let total = 0n;
      for (const m of payload.matches ?? []) {
        const tx = ctx.db.bankTransaction.id.find(BigInt(m.bankTxId));
        if (!tx) continue;
        const raw = abs(tx.amountMinor);
        const rate = ccyKey(tx.ccy) === functionalCcyOf(ctx, tx.subsidiaryId) ? 1_000_000n : rateFor(ctx, tx.ccy, functionalCcyOf(ctx, tx.subsidiaryId), tx.ym) ?? 1_000_000n;
        total += max(raw, (raw * rate) / 1_000_000n);
      }
      return total;
    }
    if (kind === 'vendor_block' || kind === 'vendor_verify') {
      const payload = JSON.parse(payloadJson) as { vendorId?: string };
      return payload.vendorId ? openBillsMinor(ctx, BigInt(payload.vendorId)) : 0n;
    }
  } catch {
    /* fall through: a malformed payload is refused by validateProposal */
  }
  return 0n;
}

const PENDING_STATUSES = ['open', 'awaiting_cfo', 'sent_back'];

/** Bank counterparties are free text; a blocked vendor is recognized by its name. */
function sameParty(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Everything a journal or accrual proposal needs to post, checked without writing:
 * - the subsidiary, accounts and an open month exist (and, for an accrual, a later open month for its reversal);
 * - the lines balance at real FX rates, and every line on 2000 Accounts Payable names its vendor;
 * - an entry that pays money out (credits 1000 Cash or cites bank transactions) touches no blocked vendor, by vendor tag
 *   or by a cited bank line whose counterparty is that vendor;
 * - every cited bank transaction is unmatched and in an open month;
 * - subscription revenue (4000) is credited only by a recognition entry (recognizeScheduleYm, not after the entry's
 *   month), whose 4000 lines all name their customer and tie out per customer to the schedule lines it flips, and
 *   which waits while a schedule for one of its customers covering those months is still undecided.
 */
function checkJournal(ctx: Ctx, kind: string, payloadJson: string) {
  const payload = parseJson<JournalPayload>(payloadJson, kind);
  const subsidiaryId = idOf(payload.subsidiaryId, 'subsidiaryId');
  if (!ctx.db.subsidiary.id.find(subsidiaryId)) throw new SenderError(`Unknown subsidiary ${subsidiaryId}`);
  if (!isYm(payload.periodYm)) throw new SenderError(`periodYm must be a month written YYYY-MM; got ${JSON.stringify(payload.periodYm ?? null)}.`);
  const period = periodByYm(ctx, payload.periodYm);
  assertPeriodOpen(ctx, period.id, `An entry for ${period.ym} cannot post.`);
  const lines = parseLines(payload.lines);
  assertBalanced(lines);
  assertRates(ctx, subsidiaryId, period.id, lines, false);
  for (const l of lines) {
    accountByCode(ctx, l.accountCode);
    if (l.accountCode === '2000' && l.vendorId === undefined) throw new SenderError('Every line on 2000 Accounts Payable must name its vendor (vendorId).');
  }
  let next: ReturnType<typeof periodByYm> | undefined;
  if (kind === 'accrual' && payload.reversesInYm) {
    if (!isYm(payload.reversesInYm)) throw new SenderError(`reversesInYm must be a month written YYYY-MM; got ${JSON.stringify(payload.reversesInYm)}.`);
    if (payload.reversesInYm <= period.ym) throw new SenderError(`An accrual for ${period.ym} reverses in a later month, not ${payload.reversesInYm}.`);
    next = periodByYm(ctx, payload.reversesInYm);
    assertPeriodOpen(ctx, next.id, `The accrual's automatic reversal in ${next.ym} cannot post.`);
  }

  const txs: NonNullable<ReturnType<Ctx['db']['bankTransaction']['id']['find']>>[] = [];
  const seenTx = new Set<string>();
  for (const raw of listOf<unknown>(payload.bankTxIds, 'bankTxIds')) {
    const txId = idOf(raw, 'bankTxIds entry');
    if (seenTx.has(txId.toString())) throw new SenderError(`Bank transaction ${txId} is listed twice.`);
    seenTx.add(txId.toString());
    const tx = ctx.db.bankTransaction.id.find(txId);
    if (!tx) throw new SenderError(`Unknown bank transaction ${txId}`);
    if (tx.matched || ctx.db.bankMatch.bankTxId.find(txId)) throw new SenderError(`Bank transaction ${txId} is already matched.`);
    const txPeriod = ctx.db.period.ym.find(tx.ym);
    if (!txPeriod) throw new SenderError(`No period ${tx.ym} for bank transaction ${txId}`);
    assertPeriodOpen(ctx, txPeriod.id, `Bank transaction ${txId} cannot be marked matched.`);
    txs.push(tx);
  }

  // Blocked vendors: nothing may pay them, however the entry is tagged. Voiding a blocked vendor's bill (no cash out)
  // stays possible.
  // A cited bank line pays out only when money went out; a refund coming in from a blocked vendor is fine.
  const outflows = txs.filter(t => t.amountMinor < 0n);
  const paysOut = outflows.length > 0 || lines.some(l => l.accountCode === '1000' && l.creditMinor > 0n);
  if (paysOut) {
    const blocked = [...ctx.db.vendor.iter()].filter(v => v.verification.tag === 'blocked');
    const byTag = blocked.find(v => lines.some(l => l.vendorId === v.id));
    const byBankLine = blocked.find(v => outflows.some(t => sameParty(t.counterparty, v.name)));
    const hit = byTag ?? byBankLine;
    if (hit) throw new SenderError(`Vendor ${hit.name} is blocked; no entry may pay money out to them or account for a payment to them until the block is lifted.`);
  }

  // Subscription revenue comes only from the revenue schedule.
  const toFunctional = (l: LineIn, amount: bigint) => (amount * (l.fxRateE6 === 0n ? 1_000_000n : l.fxRateE6)) / 1_000_000n;
  const revenueLines = lines.filter(l => l.accountCode === '4000');
  const net4000 = revenueLines.reduce((a, l) => a + toFunctional(l, l.creditMinor - l.debitMinor), 0n);
  const flips: NonNullable<ReturnType<Ctx['db']['revenueScheduleLine']['id']['find']>>[] = [];
  const upTo = payload.recognizeScheduleYm;
  // An accrual (or any entry that reverses itself later) would recognize revenue and then take it back next month
  // while the schedule lines stayed flipped, so it may not touch subscription revenue at all.
  if (kind === 'accrual' || payload.reversesInYm) {
    if (upTo !== undefined && upTo !== null && upTo !== '') throw new SenderError('An accrual or an entry that reverses itself cannot recognize schedule lines (recognizeScheduleYm); recognize revenue in a journal entry.');
    if (revenueLines.length > 0) throw new SenderError('An accrual or an entry that reverses itself cannot post to 4000 Subscription Revenue; subscription revenue comes only from a recognition entry.');
  }
  if (upTo !== undefined && upTo !== null && upTo !== '') {
    if (!isYm(upTo)) throw new SenderError(`recognizeScheduleYm must be a month written YYYY-MM; got ${JSON.stringify(upTo)}.`);
    if (upTo > period.ym) throw new SenderError(`An entry for ${period.ym} cannot recognize schedule lines through ${upTo}: revenue is recognized in or after the month it is earned, never before.`);
    if (revenueLines.some(l => l.customerId === undefined)) throw new SenderError('In a recognition entry every line on 4000 Subscription Revenue must name its customer.');
    const customers = [...new Set(lines.filter(l => l.customerId !== undefined).map(l => l.customerId!.toString()))];
    if (customers.length === 0) {
      throw new SenderError('recognizeScheduleYm needs journal lines tagged with the customers whose revenue this entry recognizes.');
    }
    // A schedule still waiting for a ruling would insert lines for these months after this entry recognized their
    // revenue, and a later close would recognize them again. Lines after upTo are not affected.
    for (const sp of ctx.db.proposal.iter()) {
      if (sp.kind.tag !== 'revenue_schedule' || !PENDING_STATUSES.includes(sp.status.tag)) continue;
      let clash: string | undefined;
      try {
        const schedLines = (JSON.parse(sp.payloadJson) as RevenueSchedulePayload).lines;
        clash = customers.find(c => schedLines.some(l => l.ym <= upTo && idOf(l.customerId, 'customerId').toString() === c));
      } catch {
        continue;
      }
      if (clash) {
        throw new SenderError(`Revenue schedule proposal ${sp.id} for customer ${clash} is still ${sp.status.tag.replace('_', ' ')} and covers months through ${upTo}. Recognize that customer's revenue after the schedule is approved.`);
      }
    }
    // Tie-out: per customer, the revenue credited to 4000 equals the unrecognized subscription schedule lines it flips.
    const subscription = new Map<bigint, boolean>();
    const isSubscription = (itemId: bigint) => {
      let v = subscription.get(itemId);
      if (v === undefined) subscription.set(itemId, (v = ctx.db.contractItem.id.find(itemId)?.kind.tag === 'subscription'));
      return v;
    };
    for (const c of customers) {
      const due = [...ctx.db.revenueScheduleLine.customerId.filter(BigInt(c))].filter(sl => !sl.recognized && sl.ym <= upTo && isSubscription(sl.contractItemId));
      const expected = due.reduce((a, sl) => a + sl.amountMinor, 0n);
      const credited = revenueLines.filter(l => l.customerId!.toString() === c).reduce((a, l) => a + toFunctional(l, l.creditMinor - l.debitMinor), 0n);
      if (credited !== expected) {
        throw new SenderError(
          `Customer ${c}: the entry credits ${credited} to 4000 Subscription Revenue, but their unrecognized subscription schedule lines through ${upTo} total ${expected}. The recognition must equal the schedule lines it flips.`
        );
      }
      flips.push(...due);
    }
  } else if (net4000 > 0n) {
    throw new SenderError(
      `This entry credits ${net4000} to 4000 Subscription Revenue without recognizeScheduleYm. Subscription revenue is recognized only from the revenue schedule: set recognizeScheduleYm so the schedule lines it covers are flipped (usage revenue goes to 4100).`
    );
  }
  return { payload, subsidiaryId, period, lines, next, txs, flips };
}

/**
 * Check one bank match against the ledger as it stands: the bank line exists, is not already matched (the seed marks
 * earlier months matched without a bank_match row) and sits in an open month; an invoice or bill target is unpaid, not
 * owed to a blocked vendor, paid in the right direction and for exactly the bank amount in the subsidiary's currency.
 * A foreign-currency bank line needs a recorded rate for its month and settles at that rate. A short or partial
 * payment belongs in a journal entry.
 */
function checkBankMatch(ctx: Ctx, m: BankMatchPayload['matches'][number]) {
  const txId = idOf(m.bankTxId, 'bankTxId');
  const tx = ctx.db.bankTransaction.id.find(txId);
  if (!tx) throw new SenderError(`Unknown bank transaction ${txId}`);
  if (tx.matched || ctx.db.bankMatch.bankTxId.find(txId)) throw new SenderError(`Bank transaction ${txId} is already matched.`);
  const txPeriod = ctx.db.period.ym.find(tx.ym);
  if (!txPeriod) throw new SenderError(`No period ${tx.ym} for bank transaction ${txId}`);
  assertPeriodOpen(ctx, txPeriod.id, `Bank transaction ${txId} cannot be matched.`);
  const targetId = idOf(m.targetId, 'targetId');
  const amt = abs(tx.amountMinor);
  const txCcy = ccyKey(tx.ccy);
  const functional = functionalCcyOf(ctx, tx.subsidiaryId);
  const base = { tx, txId, targetId, amt, txPeriod, txCcy, functional, rate: 1_000_000n, converted: amt };
  // Money that went out to a blocked vendor cannot be explained away by any match, whatever the target.
  const blocked = [...ctx.db.vendor.iter()].filter(v => v.verification.tag === 'blocked');
  const paidTo = tx.amountMinor < 0n ? blocked.find(v => sameParty(tx.counterparty, v.name)) : undefined;
  if (paidTo) throw new SenderError(`Bank transaction ${txId} paid ${paidTo.name}, which is blocked; it cannot be matched until the block is lifted.`);
  if (m.targetKind === 'je') {
    if (!ctx.db.journalEntry.id.find(targetId)) throw new SenderError(`Unknown journal entry ${targetId}`);
    const tagged = blocked.find(v => [...ctx.db.journalLine.jeId.filter(targetId)].some(l => l.vendorId === v.id));
    if (tagged) throw new SenderError(`Journal entry ${targetId} is tagged with ${tagged.name}, which is blocked; no bank line can be matched to it until the block is lifted.`);
    return { ...base, inv: undefined, bill: undefined };
  }
  if (m.targetKind !== 'invoice' && m.targetKind !== 'bill') throw new SenderError(`Unknown bank match target ${String(m.targetKind)}`);
  let rate = 1_000_000n;
  if (txCcy !== functional) {
    const r = rateFor(ctx, txCcy, functional, tx.ym);
    if (r === undefined) throw new SenderError(`Bank transaction ${txId} is in ${txCcy}; record a ${txCcy}/${functional} rate for ${tx.ym} before matching it to an ${m.targetKind}.`);
    rate = r;
  }
  const converted = (amt * rate) / 1_000_000n;
  const shown = txCcy === functional ? `${amt}` : `${amt} ${txCcy} = ${converted} ${functional}`;
  if (m.targetKind === 'invoice') {
    const inv = ctx.db.invoice.id.find(targetId);
    if (!inv) throw new SenderError(`Unknown invoice ${targetId}`);
    if (inv.status.tag === 'paid') throw new SenderError(`Invoice ${inv.number} is already paid; bank transaction ${txId} cannot settle it again.`);
    if (tx.amountMinor <= 0n) throw new SenderError(`Bank transaction ${txId} is money going out; an invoice is paid by money coming in.`);
    if (converted !== inv.amountMinor) {
      throw new SenderError(`Bank transaction ${txId} (${shown}) does not equal invoice ${inv.number} (${inv.amountMinor}). Propose a journal entry for a partial or short payment instead.`);
    }
    return { ...base, rate, converted, inv, bill: undefined };
  }
  const bill = ctx.db.bill.id.find(targetId);
  if (!bill) throw new SenderError(`Unknown bill ${targetId}`);
  if (bill.status.tag === 'paid') throw new SenderError(`Bill ${bill.externalRef} is already paid; bank transaction ${txId} cannot settle it again.`);
  const vendor = ctx.db.vendor.id.find(bill.vendorId);
  if (vendor && vendor.verification.tag === 'blocked') throw new SenderError(`Bill ${bill.externalRef} is owed to ${vendor.name}, which is blocked; it cannot be settled until the block is lifted.`);
  if (tx.amountMinor >= 0n) throw new SenderError(`Bank transaction ${txId} is money coming in; a bill is paid by money going out.`);
  if (converted !== bill.amountMinor) {
    throw new SenderError(`Bank transaction ${txId} (${shown}) does not equal bill ${bill.externalRef} (${bill.amountMinor}). Propose a journal entry for a partial payment or overpayment instead.`);
  }
  return { ...base, rate, converted, inv: undefined, bill };
}

/**
 * A vendor_verify proposal holds only if, for each owner check in VERIFY_PRODUCTS, the vendor's latest recorded row is a
 * clean APPROVE at tier A or B and is cited. A later failing check therefore blocks verification even when the
 * proposal cites an older clean one.
 */
function checkVendorVerify(ctx: Ctx, payload: VendorVerifyPayload) {
  const v = ctx.db.vendor.id.find(idOf(payload.vendorId, 'vendorId'));
  if (!v) throw new SenderError(`Unknown vendor ${payload.vendorId}`);
  if (v.verification.tag === 'blocked') throw new SenderError(`Vendor ${v.name} is blocked; a verification proposal cannot unblock it.`);
  if (v.verification.tag === 'verified') throw new SenderError(`Vendor ${v.name} is already verified.`);
  const cited = new Set(listOf<unknown>(payload.creditCheckIds, 'creditCheckIds').map(x => String(x).trim()));
  if (cited.size === 0) throw new SenderError('A vendor verification must cite the request ids of the owner checks it relies on.');
  const rows = [...ctx.db.creditCheck.subjectId.filter(v.id)].filter(c => c.subjectKind.tag === 'vendor');
  const foreign = [...cited].filter(id => !rows.some(c => c.requestId !== '' && c.requestId === id));
  if (foreign.length > 0) throw new SenderError(`Request id(s) ${foreign.join(', ')} are not recorded credit checks for vendor ${v.id}.`);
  const clean = (c: (typeof rows)[number]) => c.decision.toUpperCase() === 'APPROVE' && (c.tier === 'A' || c.tier === 'B');
  const latest: (typeof rows)[number][] = [];
  for (const prod of VERIFY_PRODUCTS) {
    const ofProduct = rows.filter(c => c.product === prod);
    if (ofProduct.length === 0) throw new SenderError(`Vendor ${v.name} has no recorded ${prod} check.`);
    const last = ofProduct.reduce((a, b) => {
      const at = a.createdAt.microsSinceUnixEpoch;
      const bt = b.createdAt.microsSinceUnixEpoch;
      return bt > at || (bt === at && b.id > a.id) ? b : a;
    });
    if (!clean(last)) throw new SenderError(`Vendor ${v.name}'s latest ${prod} check (request ${last.requestId || 'n/a'}) is ${last.decision} at tier ${last.tier}, not a clean APPROVE at tier A or B.`);
    if (!cited.has(last.requestId)) throw new SenderError(`Cite vendor ${v.name}'s latest ${prod} check (request ${last.requestId || 'n/a'}).`);
    latest.push(last);
  }
  if (rows.some(c => cited.has(c.requestId) && !clean(c))) throw new SenderError(`A cited check for vendor ${v.name} is not a clean APPROVE at tier A or B.`);
  const tiers = [...new Set(latest.map(c => c.tier))].join('/');
  const note = payload.reasonPlain?.trim() || `Owner identity and fraud checks passed (tier ${tiers}; requests ${latest.map(c => c.requestId).join(', ')}).`;
  return { v, note };
}


/**
 * Refuse a proposal that could never apply. Runs at proposal time, before a ruling (so an unusable proposal never
 * reaches the CFO's queue) and again when applyProposal applies it, including at the CFO's confirmation, so a conflict
 * that arose meanwhile is reported instead of skipped.
 */
function validateProposal(ctx: Ctx, kind: string, payloadJson: string) {
  guarded(kind, () => validateProposalShapeAndState(ctx, kind, payloadJson));
}

function validateProposalShapeAndState(ctx: Ctx, kind: string, payloadJson: string) {
  if (kind === 'journal_entry' || kind === 'accrual') {
    checkJournal(ctx, kind, payloadJson);
  } else if (kind === 'bank_match') {
    const payload = parseJson<BankMatchPayload>(payloadJson, kind);
    payload.matches = objectsOf<BankMatchPayload['matches'][number]>(payload.matches, 'matches');
    if (payload.matches.length === 0) throw new SenderError('A bank match proposal needs at least one match.');
    const txs = new Set<string>();
    const targets = new Set<string>();
    for (const m of payload.matches) {
      if (typeof m.scoreBp !== 'number' || !Number.isInteger(m.scoreBp) || m.scoreBp < 0 || m.scoreBp > 10000) {
        throw new SenderError(`scoreBp must be a whole number from 0 to 10000; got ${JSON.stringify(m.scoreBp ?? null)}.`);
      }
      const txKey = idOf(m.bankTxId, 'bankTxId').toString();
      if (txs.has(txKey)) throw new SenderError(`Bank transaction ${txKey} appears twice in this proposal.`);
      txs.add(txKey);
      if (m.targetKind !== 'je') {
        const key = `${m.targetKind}:${idOf(m.targetId, 'targetId')}`;
        if (targets.has(key)) throw new SenderError(`The ${m.targetKind} ${idOf(m.targetId, 'targetId')} is matched twice in this proposal; one payment settles it.`);
        targets.add(key);
      }
      checkBankMatch(ctx, m);
    }
  } else if (kind === 'vendor_verify') {
    checkVendorVerify(ctx, parseJson<VendorVerifyPayload>(payloadJson, kind));
  } else if (kind === 'credit_decision') {
    const payload = parseJson<CreditDecisionPayload>(payloadJson, kind);
    if (!ctx.db.customer.id.find(idOf(payload.customerId, 'customerId'))) throw new SenderError(`Unknown customer ${payload.customerId}`);
    if (typeof payload.tier !== 'string' || payload.tier.trim() === '') throw new SenderError('A credit decision needs a tier.');
    if (typeof payload.paymentTermsDays !== 'number' || !Number.isInteger(payload.paymentTermsDays) || payload.paymentTermsDays < 0 || payload.paymentTermsDays > 65535) {
      throw new SenderError(`paymentTermsDays must be a whole number of days; got ${JSON.stringify(payload.paymentTermsDays ?? null)}.`);
    }
    if (payload.allowanceMinor !== undefined && payload.allowanceMinor !== null) minorOf(payload.allowanceMinor, 'allowanceMinor');
    listOf<unknown>(payload.creditCheckIds, 'creditCheckIds');
  } else if (kind === 'vendor_block') {
    const payload = parseJson<VendorBlockPayload>(payloadJson, kind);
    if (!ctx.db.vendor.id.find(idOf(payload.vendorId, 'vendorId'))) throw new SenderError(`Unknown vendor ${payload.vendorId}`);
    if (typeof payload.reasonPlain !== 'string' || payload.reasonPlain.trim() === '') throw new SenderError('A vendor block needs a plain-English reason (reasonPlain).');
  } else if (kind === 'revenue_schedule') {
    // Each line names an existing subscription item of that customer's contract, a real month, and a month that item
    // has no schedule line for yet (here or already in the ledger), so no month's revenue can be planned twice.
    const payload = parseJson<RevenueSchedulePayload>(payloadJson, kind);
    payload.lines = objectsOf<RevenueSchedulePayload['lines'][number]>(payload.lines, 'lines');
    if (payload.lines.length === 0) throw new SenderError('A revenue schedule needs at least one line.');
    const seen = new Set<string>();
    for (const l of payload.lines) {
      if (!isYm(l.ym)) throw new SenderError(`Schedule line month must be written YYYY-MM; got ${JSON.stringify(l.ym ?? null)}.`);
      if (minorOf(l.amountMinor, `Schedule line ${l.ym}`) <= 0n) throw new SenderError(`Schedule line ${l.ym} must be a positive amount.`);
      const itemId = idOf(l.contractItemId, 'contractItemId');
      const customerId = idOf(l.customerId, 'customerId');
      const item = ctx.db.contractItem.id.find(itemId);
      if (!item) throw new SenderError(`Unknown contract item ${itemId}`);
      if (item.kind.tag !== 'subscription') throw new SenderError(`Contract item ${itemId} is ${item.kind.tag}; only subscription items carry a revenue schedule.`);
      if (!ctx.db.customer.id.find(customerId)) throw new SenderError(`Unknown customer ${customerId}`);
      const contract = ctx.db.contract.id.find(item.contractId);
      if (!contract || contract.customerId !== customerId) throw new SenderError(`Contract item ${itemId} belongs to customer ${contract?.customerId ?? 'unknown'}, not ${customerId}.`);
      const key = `${itemId}:${l.ym}`;
      if (seen.has(key)) throw new SenderError(`Contract item ${itemId} has two lines for ${l.ym} in this schedule.`);
      seen.add(key);
      if ([...ctx.db.revenueScheduleLine.contractItemId.filter(itemId)].some(sl => sl.ym === l.ym)) {
        throw new SenderError(`Contract item ${itemId} already has a schedule line for ${l.ym}.`);
      }
    }
  }
}

function applyProposal(ctx: Ctx, p: NonNullable<ReturnType<Ctx['db']['proposal']['id']['find']>>, payloadJson: string, role: string) {
  guarded(p.kind.tag, () => applyProposalChecked(ctx, p, payloadJson, role));
}

function applyProposalChecked(ctx: Ctx, p: NonNullable<ReturnType<Ctx['db']['proposal']['id']['find']>>, payloadJson: string, role: string) {
  const kind = p.kind.tag;
  if (kind === 'journal_entry' || kind === 'accrual') {
    const { payload, subsidiaryId, period, lines, next, txs, flips } = checkJournal(ctx, kind, payloadJson);
    const je = postEntry(ctx, {
      subsidiaryId,
      periodId: period.id,
      memo: String(payload.memo ?? ''),
      lines,
      source: 'agent',
      proposalId: p.id,
      reversalOf: undefined,
      role,
    });
    for (const tx of txs) {
      ctx.db.bankMatch.insert({ id: 0n, bankTxId: tx.id, targetKind: { tag: 'je' }, targetId: je.id, scoreBp: 10000, proposalId: p.id, paymentJeId: undefined });
      ctx.db.bankTransaction.id.update({ ...tx, matched: true });
    }
    for (const sl of flips) ctx.db.revenueScheduleLine.id.update({ ...sl, recognized: true, jeId: je.id });
    if (next) {
      // An accrual reverses automatically in the following month so the bill, when it posts, is not double counted.
      const reversed = lines.map(l => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor, memo: `Reverse accrual: ${l.memo}` }));
      postEntry(ctx, {
        subsidiaryId,
        periodId: next.id,
        memo: `Reversal of accrual: ${String(payload.memo ?? '')}`,
        lines: reversed,
        source: 'agent',
        proposalId: p.id,
        reversalOf: je.id,
        role,
      });
    }
    return;
  }
  validateProposal(ctx, kind, payloadJson);
  if (kind === 'bank_match') {
    const payload = parseJson<BankMatchPayload>(payloadJson, kind);
    for (const m of payload.matches) {
      // Checked against the state as each match applies, so a second match to an invoice the first one paid is refused.
      const { tx, txId, targetId, amt, txPeriod, txCcy, functional, rate, converted, inv, bill } = checkBankMatch(ctx, m);
      const base = { id: 0n, bankTxId: txId, targetId, scoreBp: m.scoreBp, proposalId: p.id };
      // The cash line carries the bank line's currency and rate; the receivable or payable settles in our own currency.
      if (inv) {
        const je = postEntry(ctx, { subsidiaryId: tx.subsidiaryId, periodId: txPeriod.id, memo: `Payment received ${inv.number}: ${tx.description}`, lines: [
          { accountCode: '1000', debitMinor: amt, creditMinor: 0n, ccy: txCcy, fxRateE6: rate, customerId: inv.customerId, vendorId: undefined, memo: 'Bank receipt' },
          { accountCode: '1100', debitMinor: 0n, creditMinor: converted, ccy: functional, fxRateE6: 1_000_000n, customerId: inv.customerId, vendorId: undefined, memo: `Settle ${inv.number}` },
        ], source: 'agent', proposalId: p.id, reversalOf: undefined, role });
        ctx.db.bankMatch.insert({ ...base, targetKind: { tag: 'invoice' }, paymentJeId: je.id });
        ctx.db.invoice.id.update({ ...inv, status: { tag: 'paid' } });
      } else if (bill) {
        const je = postEntry(ctx, { subsidiaryId: tx.subsidiaryId, periodId: txPeriod.id, memo: `Payment ${bill.externalRef}: ${tx.description}`, lines: [
          { accountCode: '2000', debitMinor: converted, creditMinor: 0n, ccy: functional, fxRateE6: 1_000_000n, customerId: undefined, vendorId: bill.vendorId, memo: `Settle ${bill.externalRef}` },
          { accountCode: '1000', debitMinor: 0n, creditMinor: amt, ccy: txCcy, fxRateE6: rate, customerId: undefined, vendorId: bill.vendorId, memo: 'Bank payment' },
        ], source: 'agent', proposalId: p.id, reversalOf: undefined, role });
        ctx.db.bankMatch.insert({ ...base, targetKind: { tag: 'bill' }, paymentJeId: je.id });
        ctx.db.bill.id.update({ ...bill, status: { tag: 'paid' } });
      } else {
        ctx.db.bankMatch.insert({ ...base, targetKind: { tag: 'je' }, paymentJeId: undefined });
      }
      ctx.db.bankTransaction.id.update({ ...tx, matched: true });
    }
    return;
  }
  if (kind === 'revenue_schedule') {
    const payload = parseJson<RevenueSchedulePayload>(payloadJson, kind);
    for (const l of payload.lines) {
      ctx.db.revenueScheduleLine.insert({
        id: 0n,
        contractItemId: idOf(l.contractItemId, 'contractItemId'),
        customerId: idOf(l.customerId, 'customerId'),
        ym: l.ym,
        amountMinor: minorOf(l.amountMinor, `Schedule line ${l.ym}`),
        recognized: false,
        jeId: undefined,
      });
    }
    return;
  }
  if (kind === 'credit_decision') {
    const payload = parseJson<CreditDecisionPayload>(payloadJson, kind);
    const c = ctx.db.customer.id.find(idOf(payload.customerId, 'customerId'));
    if (!c) throw new SenderError(`Unknown customer ${payload.customerId}`);
    ctx.db.customer.id.update({
      ...c,
      creditTier: payload.tier,
      paymentTermsDays: payload.paymentTermsDays,
      allowanceMinor: payload.allowanceMinor ? minorOf(payload.allowanceMinor, 'allowanceMinor') : c.allowanceMinor,
    });
    return;
  }
  if (kind === 'vendor_block') {
    const payload = parseJson<VendorBlockPayload>(payloadJson, kind);
    const v = ctx.db.vendor.id.find(idOf(payload.vendorId, 'vendorId'));
    if (!v) throw new SenderError(`Unknown vendor ${payload.vendorId}`);
    ctx.db.vendor.id.update({ ...v, verification: { tag: 'blocked' }, verificationNote: payload.reasonPlain });
    for (const b of ctx.db.bill.vendorId.filter(v.id)) {
      if (b.status.tag === 'open') ctx.db.bill.id.update({ ...b, status: { tag: 'overdue' } });
    }
    return;
  }
  if (kind === 'vendor_verify') {
    const { v, note } = checkVendorVerify(ctx, parseJson<VendorVerifyPayload>(payloadJson, kind));
    ctx.db.vendor.id.update({ ...v, verification: { tag: 'verified' }, verificationNote: note });
    audit(ctx, role, 'verify_vendor', 'vendor', v.id, `${v.name}: ${note} (proposal ${p.id})`);
    return;
  }
  throw new SenderError(`Unknown proposal kind ${kind}`);
}

type JournalEntryRow = NonNullable<ReturnType<Ctx['db']['journalEntry']['id']['find']>>;
type BankMatchRow = NonNullable<ReturnType<Ctx['db']['bankMatch']['id']['find']>>;

/**
 * Matches recorded before paymentJeId existed (a database upgraded in place) carry no link to their payment entry.
 * Recognize one the way the payment entry was built: same proposal, memo naming the target and the bank line, total
 * equal to the bank amount, posted in the bank line's month, and every line tagged with the target's party.
 */
function isLegacyPaymentMatch(ctx: Ctx, je: JournalEntryRow, m: BankMatchRow): boolean {
  const tx = ctx.db.bankTransaction.id.find(m.bankTxId);
  if (!tx || je.totalMinor !== abs(tx.amountMinor) || ctx.db.period.ym.find(tx.ym)?.id !== je.periodId) return false;
  const lines = [...ctx.db.journalLine.jeId.filter(je.id)];
  if (m.targetKind.tag === 'invoice') {
    const inv = ctx.db.invoice.id.find(m.targetId);
    return !!inv && je.memo === `Payment received ${inv.number}: ${tx.description}` && lines.every(l => l.customerId === inv.customerId);
  }
  const b = ctx.db.bill.id.find(m.targetId);
  return !!b && je.memo === `Payment ${b.externalRef}: ${tx.description}` && lines.every(l => l.vendorId === b.vendorId);
}

/**
 * What reversing an entry must undo outside the ledger, collected before anything is written: bank matches that point
 * at the entry or whose payment entry it is (linked by paymentJeId, or recognized by isLegacyPaymentMatch for matches
 * from before the upgrade), the invoices or bills those payments settled, and the revenue schedule lines it
 * recognized. Refuses when an affected bank transaction sits in a locked month.
 */
function planUnwind(ctx: Ctx, je: JournalEntryRow) {
  const owned: BankMatchRow[] = [];
  // Matches straight at the entry: journal proposals with bankTxIds, or a bank_match proposal targeting a journal entry.
  for (const m of ctx.db.bankMatch.targetId.filter(je.id)) if (m.targetKind.tag === 'je') owned.push(m);
  if (je.proposalId != null) {
    const ofProposal = [...ctx.db.bankMatch.proposalId.filter(je.proposalId)].filter(m => m.targetKind.tag !== 'je');
    const linked = ofProposal.filter(m => m.paymentJeId === je.id);
    owned.push(...linked);
    // A payment entry settles exactly one invoice or bill, so take at most one legacy match.
    const legacy = linked.length === 0 ? ofProposal.find(m => m.paymentJeId === undefined && isLegacyPaymentMatch(ctx, je, m)) : undefined;
    if (legacy) owned.push(legacy);
  }
  for (const m of owned) {
    const tx = ctx.db.bankTransaction.id.find(m.bankTxId);
    const period = tx ? ctx.db.period.ym.find(tx.ym) : undefined;
    if (tx && period && periodLocked(ctx, period.id)) {
      throw new SenderError(
        `Reversing entry ${je.id} would undo the bank reconciliation of ${period.ym}, which is locked: bank line ${tx.id} "${tx.description}" (${tx.amountMinor < 0n ? '-' : ''}${money(abs(tx.amountMinor))} ${ccyKey(tx.ccy)}, ${tx.ym}) would go back to unmatched. Unlock ${period.ym} first, or correct it with a new entry.`
      );
    }
  }
  // Only a recognition entry flips schedule lines, so other entries skip the scan (jeId is an option column and cannot
  // be indexed).
  let recognizes = false;
  if (je.proposalId != null) {
    const src = ctx.db.proposal.id.find(je.proposalId);
    recognizes = !!src && src.payloadJson.includes('recognizeScheduleYm');
  }
  const recognized = recognizes ? [...ctx.db.revenueScheduleLine.iter()].filter(sl => sl.jeId === je.id) : [];
  return { owned, recognized };
}

/** Apply a planned unwind. An invoice or bill reopens only when no remaining bank match still pays it. */
function applyUnwind(ctx: Ctx, plan: ReturnType<typeof planUnwind>) {
  let reopened = 0;
  const settled: { kind: 'invoice' | 'bill'; id: bigint }[] = [];
  for (const m of plan.owned) {
    ctx.db.bankMatch.id.delete(m.id);
    const tx = ctx.db.bankTransaction.id.find(m.bankTxId);
    if (tx && tx.matched) ctx.db.bankTransaction.id.update({ ...tx, matched: false });
    if (m.targetKind.tag === 'invoice' || m.targetKind.tag === 'bill') settled.push({ kind: m.targetKind.tag, id: m.targetId });
  }
  for (const s of settled) {
    const stillPaid = [...ctx.db.bankMatch.targetId.filter(s.id)].some(x => x.targetKind.tag === s.kind);
    if (stillPaid) continue;
    if (s.kind === 'invoice') {
      const inv = ctx.db.invoice.id.find(s.id);
      if (inv && inv.status.tag === 'paid') {
        const overdue = inv.dueAt.microsSinceUnixEpoch < ctx.timestamp.microsSinceUnixEpoch;
        ctx.db.invoice.id.update({ ...inv, status: { tag: overdue ? 'overdue' : 'open' } });
        reopened++;
      }
    } else {
      const b = ctx.db.bill.id.find(s.id);
      if (b && b.status.tag === 'paid') {
        const blocked = ctx.db.vendor.id.find(b.vendorId)?.verification.tag === 'blocked';
        ctx.db.bill.id.update({ ...b, status: { tag: blocked ? 'overdue' : 'open' } });
        reopened++;
      }
    }
  }
  for (const sl of plan.recognized) ctx.db.revenueScheduleLine.id.update({ ...sl, recognized: false, jeId: undefined });
  return { unmatched: plan.owned.length, reopened, unrecognized: plan.recognized.length };
}

function postMessage(
  ctx: Ctx,
  role: string,
  threadId: string,
  kind: 'statement' | 'critique' | 'question' | 'ruling',
  body: string,
  summaryPlain: string,
  proposalId: bigint | undefined
) {
  return ctx.db.agentMessage.insert({
    id: 0n,
    threadId,
    sender: ctx.sender,
    senderRole: role,
    kind: { tag: kind },
    body,
    summaryPlain,
    proposalId,
    createdAt: ctx.timestamp,
  });
}

// ---------- lifecycle ----------

export const init = spacetimedb.init(ctx => {
  const done: string[] = [];
  // init runs as the identity that published the database: its owner, who may always reset the demo.
  if (!ctx.db.settings.key.find(OWNER_KEY)) {
    ctx.db.settings.insert({ key: OWNER_KEY, valueI64: 0n, valueText: ctx.sender.toHexString() });
    done.push('owner recorded');
  }
  if (!ctx.db.settings.key.find(MATERIALITY_KEY)) {
    ctx.db.settings.insert({ key: MATERIALITY_KEY, valueI64: DEFAULT_MATERIALITY_MINOR, valueText: '' });
    done.push(`materiality ${DEFAULT_MATERIALITY_MINOR}`);
  }
  if (ctx.db.overdueSweep.count() === 0n) {
    ctx.db.overdueSweep.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(60_000_000n) });
    done.push('overdue sweep scheduled');
  }
  if (done.length > 0) audit(ctx, 'system', 'init', 'settings', 0n, done.join('; '));
});

export const overdueSweepTick = spacetimedb.reducer(
  { onSchedule: overdueSweep },
  { timer: overdueSweep.rowType },
  (ctx, _args) => {
    if (!ctx.senderAuth.isInternal) throw new SenderError('The overdue sweep runs on a schedule only.');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const due = [...ctx.db.invoice.iter()].filter(inv => inv.status.tag === 'open' && inv.dueAt.microsSinceUnixEpoch < now);
    for (const inv of due) ctx.db.invoice.id.update({ ...inv, status: { tag: 'overdue' } });
    // Audit only sweeps that changed something, so the once-a-minute timer does not flood the trail.
    if (due.length > 0) audit(ctx, 'system', 'overdue_sweep', 'invoice', 0n, `${due.length} invoice(s) marked overdue: ${due.map(i => i.number).join(', ')}`);
    // Re-arm: interval rows are re-inserted by the scheduler automatically.
  }
);

// ---------- identities and roles ----------

export const registerAgent = spacetimedb.reducer(
  { role: Role, displayName: t.string(), model: t.string() },
  (ctx, { role, displayName, model }) => {
    const tag = role.tag as RoleTag;
    const existing = ctx.db.agentIdentity.identity.find(ctx.sender);
    if (existing) {
      if (existing.role.tag !== tag) throw new SenderError(`This connection is registered as ${existing.role.tag}; roles cannot be changed here.`);
      ctx.db.agentIdentity.identity.update({ ...existing, displayName });
    } else if (tag === 'ui') {
      ctx.db.agentIdentity.insert({ identity: ctx.sender, role, displayName, registeredAt: ctx.timestamp });
    } else if (tag === 'advisor' || tag === 'cfo') {
      // Bootstrap: the first connection to claim advisor or cfo gets it. Later claims need a grant.
      const taken = [...ctx.db.agentIdentity.iter()].some(r => r.role.tag === tag);
      if (taken) throw new SenderError(`The ${tag} role is already held. Ask the advisor to grant it.`);
      ctx.db.agentIdentity.insert({ identity: ctx.sender, role, displayName, registeredAt: ctx.timestamp });
    } else {
      throw new SenderError(`Worker and red team roles must be granted by the advisor (grant_role).`);
    }
    const roster = ctx.db.agentRoster.role.find(tag);
    if (roster) ctx.db.agentRoster.role.update({ ...roster, displayName, model, registeredAt: ctx.timestamp });
    else ctx.db.agentRoster.insert({ role: tag, displayName, registeredAt: ctx.timestamp, model });
    audit(ctx, tag, 'register_agent', 'agent_identity', 0n, displayName);
  }
);

export const grantRole = spacetimedb.reducer(
  { identity: t.identity(), role: Role, displayName: t.string(), model: t.string() },
  (ctx, { identity, role, displayName, model }) => {
    const granter = requireRole(ctx, ['advisor', 'cfo'], 'grant roles');
    const tag = role.tag as RoleTag;
    if ((tag === 'advisor' || tag === 'cfo') && granter !== 'cfo') throw new SenderError('Only the CFO can grant the advisor or cfo role.');
    const existing = ctx.db.agentIdentity.identity.find(identity);
    if (existing && (existing.role.tag === 'advisor' || existing.role.tag === 'cfo') && existing.role.tag !== tag) {
      throw new SenderError('An advisor or cfo identity cannot be demoted here.');
    }
    if (existing) ctx.db.agentIdentity.identity.update({ ...existing, role, displayName });
    else ctx.db.agentIdentity.insert({ identity, role, displayName, registeredAt: ctx.timestamp });
    const roster = ctx.db.agentRoster.role.find(tag);
    if (roster) ctx.db.agentRoster.role.update({ ...roster, displayName, model, registeredAt: ctx.timestamp });
    else ctx.db.agentRoster.insert({ role: tag, displayName, registeredAt: ctx.timestamp, model });
    audit(ctx, roleOf(ctx) ?? 'advisor', 'grant_role', 'agent_identity', 0n, `${tag}: ${displayName}`);
  }
);

// ---------- proposals (worker agents) ----------

export const propose = spacetimedb.reducer(
  {
    kind: t.string(),
    payloadJson: t.string(),
    rationale: t.string(),
    summaryPlain: t.string(),
    amountMinor: t.i64(),
    periodYm: t.string(),
    closeTaskId: t.option(t.u64()),
  },
  (ctx, { kind, payloadJson, rationale, summaryPlain, amountMinor, periodYm, closeTaskId }) => {
    const role = requireRole(ctx, ['bookkeeper', 'revenue', 'credit', 'advisor'], 'propose');
    const kinds = ['journal_entry', 'bank_match', 'revenue_schedule', 'credit_decision', 'accrual', 'vendor_block', 'vendor_verify'];
    if (!kinds.includes(kind)) throw new SenderError(`Unknown proposal kind ${kind}`);
    const allowedKinds: Record<string, string[]> = {
      bookkeeper: ['journal_entry', 'bank_match', 'accrual'],
      revenue: ['journal_entry', 'revenue_schedule'],
      credit: ['journal_entry', 'credit_decision', 'vendor_block', 'vendor_verify'],
      advisor: kinds,
    };
    if (!allowedKinds[role]?.includes(kind)) throw new SenderError(`The ${role} does not propose ${kind}.`);
    if (summaryPlain.trim().length < 10) throw new SenderError('Every proposal needs a plain-English summary.');
    validateProposal(ctx, kind, payloadJson);
    const period = periodYm ? ctx.db.period.ym.find(periodYm) : null;
    // Store the larger of the stated and the computed amount, so the queue and the materiality test see the real size.
    const computed = computedAmount(ctx, kind, payloadJson);
    const stated = abs(amountMinor);
    const p = ctx.db.proposal.insert({
      id: 0n,
      kind: { tag: kind as any },
      payloadJson,
      rationale,
      summaryPlain,
      amountMinor: computed > stated ? computed : stated,
      proposedBy: ctx.sender,
      proposerRole: role,
      status: { tag: 'open' },
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      closeTaskId,
      periodId: period?.id,
      threadId: '',
    });
    const threadId = `proposal:${p.id}`;
    ctx.db.proposal.id.update({ ...p, threadId });
    postMessage(ctx, role, threadId, 'statement', rationale, summaryPlain, p.id);
    if (closeTaskId !== undefined) {
      const task = ctx.db.closeTask.id.find(closeTaskId);
      if (task) {
        const ids = task.evidenceProposalIds ? task.evidenceProposalIds.split(',') : [];
        ids.push(String(p.id));
        ctx.db.closeTask.id.update({
          ...task,
          evidenceProposalIds: ids.join(','),
          status: task.status.tag === 'todo' ? { tag: 'in_progress' } : task.status,
        });
      }
    }
    audit(ctx, role, 'propose', 'proposal', p.id, summaryPlain);
  }
);

export const critique = spacetimedb.reducer(
  { proposalId: t.u64(), body: t.string(), summaryPlain: t.string() },
  (ctx, { proposalId, body, summaryPlain }) => {
    requireRole(ctx, ['redteam'], 'critique');
    const p = ctx.db.proposal.id.find(proposalId);
    if (!p) throw new SenderError(`Unknown proposal ${proposalId}`);
    postMessage(ctx, 'redteam', p.threadId, 'critique', body, summaryPlain, proposalId);
    audit(ctx, 'redteam', 'critique', 'proposal', proposalId, summaryPlain);
  }
);

export const postAgentMessage = spacetimedb.reducer(
  { threadId: t.string(), kind: t.string(), body: t.string(), summaryPlain: t.string(), proposalId: t.option(t.u64()) },
  (ctx, { threadId, kind, body, summaryPlain, proposalId }) => {
    const role = requireRole(ctx, ['advisor', 'bookkeeper', 'revenue', 'credit', 'redteam', 'cfo'], 'post messages');
    const k = kind as 'statement' | 'critique' | 'question' | 'ruling';
    if (!['statement', 'critique', 'question', 'ruling'].includes(k)) throw new SenderError(`Unknown message kind ${kind}`);
    if (k === 'ruling' && role !== 'advisor') throw new SenderError('Only the advisor posts rulings.');
    if (k === 'critique' && role !== 'redteam') throw new SenderError('Only the red team posts critiques.');
    const msg = postMessage(ctx, role, threadId, k, body, summaryPlain, proposalId);
    audit(ctx, role, 'post_agent_message', 'agent_message', msg.id, `${k} in ${threadId}: ${summaryPlain}`);
  }
);

// ---------- rulings (advisor) ----------

export const approveProposal = spacetimedb.reducer(
  { proposalId: t.u64(), rationale: t.string(), summaryPlain: t.string(), amendedPayloadJson: t.option(t.string()) },
  (ctx, { proposalId, rationale, summaryPlain, amendedPayloadJson }) => {
    requireRole(ctx, ['advisor'], 'approve proposals');
    const p = ctx.db.proposal.id.find(proposalId);
    if (!p) throw new SenderError(`Unknown proposal ${proposalId}`);
    if (p.status.tag !== 'open' && p.status.tag !== 'sent_back') {
      throw new SenderError(`Proposal ${proposalId} is ${p.status.tag}, not open.`);
    }
    if (summaryPlain.trim().length < 10) throw new SenderError('Every ruling needs a plain-English summary.');
    const payloadJson = amendedPayloadJson ?? p.payloadJson;
    const decision = amendedPayloadJson !== undefined ? 'amend' : 'approve';
    // Checked before the materiality split, so the Advisor cannot send an unusable proposal to the CFO.
    validateProposal(ctx, p.kind.tag, payloadJson);
    const computed = computedAmount(ctx, p.kind.tag, payloadJson);
    const amountMinor = computed > p.amountMinor ? computed : p.amountMinor;
    const material = amountMinor >= materiality(ctx);
    if (material) {
      ctx.db.proposal.id.update({ ...p, status: { tag: 'awaiting_cfo' }, payloadJson, amountMinor, updatedAt: ctx.timestamp });
    } else {
      applyProposal(ctx, p, payloadJson, 'advisor');
      ctx.db.proposal.id.update({
        ...p,
        status: { tag: decision === 'amend' ? 'amended' : 'approved' },
        payloadJson,
        amountMinor,
        updatedAt: ctx.timestamp,
      });
    }
    const prior = ctx.db.approval.proposalId.find(proposalId);
    if (prior) ctx.db.approval.proposalId.delete(proposalId);
    ctx.db.approval.insert({
      id: 0n,
      proposalId,
      decidedBy: ctx.sender,
      decision: { tag: decision },
      amendedPayloadJson,
      rationale,
      summaryPlain,
      decidedAt: ctx.timestamp,
      cfoConfirmedBy: undefined,
      cfoConfirmedAt: undefined,
    });
    postMessage(ctx, 'advisor', p.threadId, 'ruling', rationale, summaryPlain, proposalId);
    audit(ctx, 'advisor', material ? 'approve_awaiting_cfo' : `approve_${decision}`, 'proposal', proposalId, summaryPlain);
  }
);

export const rejectProposal = spacetimedb.reducer(
  { proposalId: t.u64(), rationale: t.string(), summaryPlain: t.string() },
  (ctx, { proposalId, rationale, summaryPlain }) => {
    requireRole(ctx, ['advisor'], 'reject proposals');
    const p = ctx.db.proposal.id.find(proposalId);
    if (!p) throw new SenderError(`Unknown proposal ${proposalId}`);
    if (p.status.tag !== 'open' && p.status.tag !== 'sent_back') throw new SenderError(`Proposal is ${p.status.tag}.`);
    ctx.db.proposal.id.update({ ...p, status: { tag: 'rejected' }, updatedAt: ctx.timestamp });
    const prior = ctx.db.approval.proposalId.find(proposalId);
    if (prior) ctx.db.approval.proposalId.delete(proposalId);
    ctx.db.approval.insert({
      id: 0n,
      proposalId,
      decidedBy: ctx.sender,
      decision: { tag: 'reject' },
      amendedPayloadJson: undefined,
      rationale,
      summaryPlain,
      decidedAt: ctx.timestamp,
      cfoConfirmedBy: undefined,
      cfoConfirmedAt: undefined,
    });
    postMessage(ctx, 'advisor', p.threadId, 'ruling', rationale, summaryPlain, proposalId);
    audit(ctx, 'advisor', 'reject', 'proposal', proposalId, summaryPlain);
  }
);

export const recordCreditCheck = spacetimedb.reducer(
  {
    subjectKind: t.string(),
    subjectId: t.u64(),
    personaId: t.string(),
    product: t.string(),
    requestId: t.string(),
    summaryJson: t.string(),
    tier: t.string(),
    decision: t.string(),
  },
  (ctx, a) => {
    // Recording evidence is the Credit & Risk agent's job; the Advisor rules on proposals that cite it.
    const role = requireRole(ctx, ['credit'], 'record credit checks');
    if (a.subjectKind !== 'customer' && a.subjectKind !== 'vendor') throw new SenderError('subjectKind must be customer or vendor');
    if (a.subjectKind === 'customer' && !ctx.db.customer.id.find(a.subjectId)) throw new SenderError(`Unknown customer ${a.subjectId}`);
    if (a.subjectKind === 'vendor' && !ctx.db.vendor.id.find(a.subjectId)) throw new SenderError(`Unknown vendor ${a.subjectId}`);
    const row = ctx.db.creditCheck.insert({
      id: 0n,
      subjectKind: { tag: a.subjectKind },
      subjectId: a.subjectId,
      personaId: a.personaId,
      product: a.product,
      requestId: a.requestId,
      summaryJson: a.summaryJson,
      tier: a.tier,
      decision: a.decision,
      createdAt: ctx.timestamp,
    });
    // Evidence only: a vendor becomes verified through a ruled vendor_verify proposal, never from a recorded check.
    audit(ctx, role, 'record_credit_check', 'credit_check', row.id, `${a.subjectKind} ${a.subjectId} ${a.product} → ${a.tier}`);
  }
);

export const updateCloseTask = spacetimedb.reducer(
  { taskId: t.u64(), status: t.string(), note: t.string() },
  (ctx, { taskId, status, note }) => {
    const role = requireRole(ctx, ['advisor', 'cfo', 'bookkeeper', 'revenue', 'credit'], 'update close tasks');
    const task = ctx.db.closeTask.id.find(taskId);
    if (!task) throw new SenderError(`Unknown close task ${taskId}`);
    const s = status as 'todo' | 'in_progress' | 'blocked' | 'done';
    if (!['todo', 'in_progress', 'blocked', 'done'].includes(s)) throw new SenderError(`Unknown status ${status}`);
    if (s === 'done' && role !== 'advisor' && role !== 'cfo') throw new SenderError('Only the advisor or the CFO can mark a task done.');
    ctx.db.closeTask.id.update({ ...task, status: { tag: s } });
    audit(ctx, role, 'update_close_task', 'close_task', taskId, `${s} ${note}`);
  }
);

function money(minor: bigint): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const dollars = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${dollars}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** A month cannot lock while one of its close tasks is blocked: someone said it cannot be finished as things stand. */
function assertNoBlockedTasks(ctx: Ctx, periodId: bigint, ym: string, what: string) {
  const blocked = [...ctx.db.closeTask.periodId.filter(periodId)].filter(t => t.status.tag === 'blocked');
  if (blocked.length === 0) return;
  throw new SenderError(`${what}: ${blocked.length} close task(s) for ${ym} are blocked: ${blocked.map(t => `"${t.title}"`).join(', ')}. Resolve them first.`);
}

/** A month cannot lock while subscription revenue earned in it (or before it) is still unrecognized. */
function assertRevenueRecognizedThrough(ctx: Ctx, ym: string, what: string) {
  const subscription = new Map<bigint, boolean>();
  const byCustomer = new Map<bigint, bigint>();
  for (const sl of ctx.db.revenueScheduleLine.iter()) {
    if (sl.recognized || sl.ym > ym) continue;
    let sub = subscription.get(sl.contractItemId);
    if (sub === undefined) subscription.set(sl.contractItemId, (sub = ctx.db.contractItem.id.find(sl.contractItemId)?.kind.tag === 'subscription'));
    if (sub) byCustomer.set(sl.customerId, (byCustomer.get(sl.customerId) ?? 0n) + sl.amountMinor);
  }
  if (byCustomer.size === 0) return;
  const total = [...byCustomer.values()].reduce((a, b) => a + b, 0n);
  const named = [...byCustomer.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, 5)
    .map(([c, amt]) => `${ctx.db.customer.id.find(c)?.name ?? `customer ${c}`} ${money(amt)}`);
  const more = byCustomer.size > 5 ? ` and ${byCustomer.size - 5} more` : '';
  throw new SenderError(
    `${what}: ${money(total)} of subscription revenue through ${ym} is still unrecognized for ${byCustomer.size} customer(s): ${named.join(', ')}${more}. Recognize it first.`
  );
}

export const requestPeriodLock = spacetimedb.reducer(
  { periodYm: t.string(), rationale: t.string(), summaryPlain: t.string() },
  (ctx, { periodYm, rationale, summaryPlain }) => {
    requireRole(ctx, ['advisor'], 'request a period lock');
    const p = periodByYm(ctx, periodYm);
    if (p.status.tag === 'closed') throw new SenderError(`Period ${periodYm} is already closed.`);
    const open = [...ctx.db.proposal.iter()].filter(
      x => x.periodId === p.id && (x.status.tag === 'open' || x.status.tag === 'awaiting_cfo' || x.status.tag === 'sent_back')
    );
    if (open.length > 0) throw new SenderError(`${open.length} proposals for ${periodYm} still need a ruling or the CFO's confirmation.`);
    assertNoBlockedTasks(ctx, p.id, periodYm, `${periodYm} cannot be locked yet`);
    assertRevenueRecognizedThrough(ctx, periodYm, `${periodYm} cannot be locked yet`);
    ctx.db.period.id.update({ ...p, status: { tag: 'closing' } });
    // The Advisor's own tasks (board pack, lock request) are done once the lock is requested; the CFO's click closes the month.
    for (const task of ctx.db.closeTask.periodId.filter(p.id)) {
      if (task.ownerRole === 'advisor' && task.status.tag !== 'done') ctx.db.closeTask.id.update({ ...task, status: { tag: 'done' } });
    }
    postMessage(ctx, 'advisor', `close:${periodYm}`, 'ruling', rationale, summaryPlain, undefined);
    audit(ctx, 'advisor', 'request_period_lock', 'period', p.id, summaryPlain);
  }
);

// ---------- the human CFO ----------

export const cfoConfirm = spacetimedb.reducer(
  { proposalId: t.u64(), note: t.string() },
  (ctx, { proposalId, note }) => {
    requireRole(ctx, ['cfo'], 'confirm material rulings');
    const p = ctx.db.proposal.id.find(proposalId);
    if (!p) throw new SenderError(`Unknown proposal ${proposalId}`);
    if (p.status.tag !== 'awaiting_cfo') throw new SenderError(`Proposal ${proposalId} is not waiting for the CFO.`);
    const appr = ctx.db.approval.proposalId.find(proposalId);
    if (!appr) throw new SenderError('No advisor ruling found for this proposal.');
    applyProposal(ctx, p, p.payloadJson, 'cfo');
    ctx.db.proposal.id.update({
      ...p,
      status: { tag: appr.decision.tag === 'amend' ? 'amended' : 'approved' },
      updatedAt: ctx.timestamp,
    });
    ctx.db.approval.id.update({ ...appr, cfoConfirmedBy: ctx.sender, cfoConfirmedAt: ctx.timestamp });
    // Say what was confirmed, so the feed reads on its own.
    const what = `${p.kind.tag.replace(/_/g, ' ')}${p.amountMinor > 0n ? ` of ${money(p.amountMinor)}` : ''}`;
    postMessage(ctx, 'cfo', p.threadId, 'statement', note ? `Confirmed the ${what}: ${note}` : `Confirmed the ${what}.`, `The CFO confirmed the ${what}: ${p.summaryPlain}`, proposalId);
    audit(ctx, 'cfo', 'cfo_confirm', 'proposal', proposalId, `${what}${note ? `: ${note}` : ''}`);
  }
);

export const cfoSendBack = spacetimedb.reducer(
  { proposalId: t.u64(), notePlain: t.string() },
  (ctx, { proposalId, notePlain }) => {
    requireRole(ctx, ['cfo'], 'send proposals back');
    const p = ctx.db.proposal.id.find(proposalId);
    if (!p) throw new SenderError(`Unknown proposal ${proposalId}`);
    if (p.status.tag !== 'awaiting_cfo' && p.status.tag !== 'open') throw new SenderError(`Proposal is ${p.status.tag}.`);
    ctx.db.proposal.id.update({ ...p, status: { tag: 'sent_back' }, updatedAt: ctx.timestamp });
    postMessage(ctx, 'cfo', p.threadId, 'question', notePlain, notePlain, proposalId);
    audit(ctx, 'cfo', 'cfo_send_back', 'proposal', proposalId, notePlain);
  }
);

/** True when a month takes no more postings: closed, or carrying a lock. */
function periodLocked(ctx: Ctx, periodId: bigint): boolean {
  const p = periodById(ctx, periodId);
  return p.status.tag === 'closed' || !!ctx.db.periodLock.periodId.find(periodId);
}

/**
 * Where a correction to an entry of month `periodId` posts: that month while it is open, otherwise the earliest open
 * month after it for the same subsidiary (a locked month's books stay as they were; the correction goes into the next
 * open month).
 */
function correctionPeriod(ctx: Ctx, periodId: bigint) {
  const p = periodById(ctx, periodId);
  if (!periodLocked(ctx, p.id)) return p;
  const later = [...ctx.db.period.iter()]
    .filter(x => x.subsidiaryId === p.subsidiaryId && x.ym > p.ym && !periodLocked(ctx, x.id))
    .sort((a, b) => (a.ym < b.ym ? -1 : 1));
  if (later.length === 0) throw new SenderError(`${p.ym} is locked and no later month is open to take the correction. Open the next month first.`);
  return later[0]!;
}

export const cfoReverse = spacetimedb.reducer(
  { jeId: t.u64(), reasonPlain: t.string() },
  (ctx, { jeId, reasonPlain }) => {
    requireRole(ctx, ['cfo'], 'reverse entries');
    const je = ctx.db.journalEntry.id.find(jeId);
    if (!je) throw new SenderError(`Unknown journal entry ${jeId}`);
    // Undoing a CFO reversal would bring an entry back without redoing its side effects; post a new entry instead.
    if (je.source.tag === 'manual' && je.reversalOf != null) throw new SenderError(`Entry ${jeId} is itself a reversal; post a new entry instead of reversing it.`);
    // One pass over the entries (reversalOf is an option column and cannot be indexed): which entries reverse which.
    const reversalsOf = new Map<bigint, JournalEntryRow[]>();
    for (const x of ctx.db.journalEntry.iter()) {
      if (x.reversalOf == null) continue;
      const list = reversalsOf.get(x.reversalOf);
      if (list) list.push(x);
      else reversalsOf.set(x.reversalOf, [x]);
    }
    // An approved accrual posts its own next-month reversal: source agent, the accrual's proposal, reversalOf the
    // accrual. Every other reversal (the CFO's) is posted manually with no proposal, so only those block a reversal.
    const isAutoAccrualReversal = (x: JournalEntryRow) =>
      x.source.tag === 'agent' &&
      x.proposalId != null &&
      x.proposalId === je.proposalId &&
      ctx.db.proposal.id.find(x.proposalId)?.kind.tag === 'accrual';
    const reversals = reversalsOf.get(jeId) ?? [];
    if (reversals.some(x => !isAutoAccrualReversal(x))) throw new SenderError(`Entry ${jeId} was already reversed.`);
    // Reversing an accrual must cancel it in both months: the accrual itself, and its automatic reversal in the
    // next month (unless the CFO already reversed that one directly). Otherwise the next month keeps a credit
    // for an accrual that no longer exists.
    const autoReversals = reversals.filter(r => !reversalsOf.has(r.id));
    // Every check runs before the first write, so a refusal leaves nothing half done. A correction to a locked month
    // posts in the next open month; undoing a locked month's bank reconciliation is refused (planUnwind).
    const target = correctionPeriod(ctx, je.periodId);
    const autoTargets = autoReversals.map(r => ({ r, period: correctionPeriod(ctx, r.periodId) }));
    const plan = planUnwind(ctx, je);
    const flip = (id: bigint) =>
      [...ctx.db.journalLine.jeId.filter(id)].map(l => ({
        accountCode: l.accountCode,
        debitMinor: l.creditMinor,
        creditMinor: l.debitMinor,
        ccy: l.ccy,
        fxRateE6: l.fxRateE6,
        customerId: l.customerId,
        vendorId: l.vendorId,
        memo: `Reversal: ${l.memo}`,
      }));
    const movedNote = (fromPeriodId: bigint, to: { id: bigint; ym: string }) =>
      fromPeriodId === to.id ? '' : ` (posted in ${to.ym} because ${periodById(ctx, fromPeriodId).ym} is locked)`;
    const rev = postEntry(ctx, {
      subsidiaryId: je.subsidiaryId,
      periodId: target.id,
      memo: `Reversal of entry ${jeId}${movedNote(je.periodId, target)}: ${reasonPlain}`,
      lines: flip(jeId),
      source: 'manual',
      proposalId: undefined,
      reversalOf: jeId,
      role: 'cfo',
    });
    const cancelled: bigint[] = [];
    for (const { r, period } of autoTargets) {
      postEntry(ctx, {
        subsidiaryId: r.subsidiaryId,
        periodId: period.id,
        memo: `Reversal of entry ${r.id} (automatic reversal of accrual ${jeId})${movedNote(r.periodId, period)}: ${reasonPlain}`,
        lines: flip(r.id),
        source: 'manual',
        proposalId: undefined,
        reversalOf: r.id,
        role: 'cfo',
      });
      cancelled.push(r.id);
    }
    const undone = applyUnwind(ctx, plan);
    const autoNote = cancelled.length > 0 ? `; automatic accrual reversal(s) ${cancelled.join(', ')} also reversed` : '';
    audit(
      ctx,
      'cfo',
      'cfo_reverse',
      'journal_entry',
      rev.id,
      `${reasonPlain} (reverses entry ${jeId} in ${target.ym}; ${undone.unmatched} bank match(es) undone, ${undone.reopened} invoice/bill(s) reopened, ${undone.unrecognized} schedule line(s) unrecognized${autoNote})`
    );
  }
);

export const lockPeriod = spacetimedb.reducer(
  { periodYm: t.string(), rationale: t.string() },
  (ctx, { periodYm, rationale }) => {
    requireRole(ctx, ['cfo'], 'lock periods');
    const p = periodByYm(ctx, periodYm);
    if (ctx.db.periodLock.periodId.find(p.id)) throw new SenderError(`Period ${periodYm} is already locked.`);
    const pending = [...ctx.db.proposal.iter()].filter(
      x => x.periodId === p.id && (x.status.tag === 'open' || x.status.tag === 'awaiting_cfo' || x.status.tag === 'sent_back')
    );
    if (pending.length > 0) throw new SenderError(`${pending.length} proposal(s) for ${periodYm} still need a decision before the month can lock.`);
    assertNoBlockedTasks(ctx, p.id, periodYm, `${periodYm} cannot be locked yet`);
    assertRevenueRecognizedThrough(ctx, periodYm, `${periodYm} cannot be locked yet`);
    ctx.db.periodLock.insert({
      id: 0n,
      periodId: p.id,
      lockedBy: ctx.sender,
      lockedByRole: 'cfo',
      lockedAt: ctx.timestamp,
      rationale,
    });
    ctx.db.period.id.update({ ...p, status: { tag: 'closed' } });
    for (const task of ctx.db.closeTask.periodId.filter(p.id)) {
      if (task.status.tag !== 'done') ctx.db.closeTask.id.update({ ...task, status: { tag: 'done' } });
    }
    postMessage(ctx, 'cfo', `close:${periodYm}`, 'statement', rationale, `The CFO closed ${periodYm}.`, undefined);
    audit(ctx, 'cfo', 'lock_period', 'period', p.id, rationale);
  }
);

export const unlockPeriod = spacetimedb.reducer(
  { periodYm: t.string(), rationale: t.string() },
  (ctx, { periodYm, rationale }) => {
    requireRole(ctx, ['cfo'], 'unlock periods');
    const p = periodByYm(ctx, periodYm);
    const lock = ctx.db.periodLock.periodId.find(p.id);
    if (!lock) throw new SenderError(`Period ${periodYm} is not locked.`);
    ctx.db.periodLock.periodId.delete(p.id);
    ctx.db.period.id.update({ ...p, status: { tag: 'open' } });
    postMessage(ctx, 'cfo', `close:${periodYm}`, 'statement', rationale, `The CFO reopened ${periodYm}${rationale.trim() ? `: ${rationale.trim()}` : '.'}`, undefined);
    audit(ctx, 'cfo', 'unlock_period', 'period', p.id, rationale);
  }
);

export const setMateriality = spacetimedb.reducer(
  { thresholdMinor: t.i64() },
  (ctx, { thresholdMinor }) => {
    requireRole(ctx, ['cfo'], 'change the materiality threshold');
    if (thresholdMinor < 0n) throw new SenderError('The threshold cannot be negative.');
    const row = ctx.db.settings.key.find(MATERIALITY_KEY);
    if (row) ctx.db.settings.key.update({ ...row, valueI64: thresholdMinor });
    else ctx.db.settings.insert({ key: MATERIALITY_KEY, valueI64: thresholdMinor, valueText: '' });
    audit(ctx, 'cfo', 'set_materiality', 'settings', 0n, String(thresholdMinor));
  }
);

// ---------- seeding (advisor, or an empty database) ----------

const SEALED_KEY = 'setup_sealed';

function requireSeeder(ctx: Ctx) {
  const role = roleOf(ctx);
  const sealed = (ctx.db.settings.key.find(SEALED_KEY)?.valueI64 ?? 0n) === 1n;
  if (role === 'cfo') return role;
  if (sealed) throw new SenderError('Setup is sealed: only the CFO can change seed data now. Reset the demo to reseed.');
  if (role === 'advisor') return role;
  // Setup mode: until an advisor or CFO identity exists, any connection may seed.
  const privileged = [...ctx.db.agentIdentity.iter()].some(r => r.role.tag === 'advisor' || r.role.tag === 'cfo');
  if (!privileged) return 'seed';
  throw new SenderError('Only the advisor or the CFO may seed once roles exist.');
}

export const sealSetup = spacetimedb.reducer((ctx) => {
  const role = requireSeeder(ctx);
  const row = ctx.db.settings.key.find(SEALED_KEY);
  if (row) ctx.db.settings.key.update({ ...row, valueI64: 1n });
  else ctx.db.settings.insert({ key: SEALED_KEY, valueI64: 1n, valueText: '' });
  audit(ctx, role, 'seal_setup', 'settings', 0n, 'Seed data sealed; seeding is now CFO-only.');
});

export const seedSubsidiary = spacetimedb.reducer(
  { code: t.string(), name: t.string(), functionalCcy: t.string(), parentCode: t.option(t.string()) },
  (ctx, { code, name, functionalCcy, parentCode }) => {
    const role = requireSeeder(ctx);
    if (ctx.db.subsidiary.code.find(code)) return;
    const parent = parentCode ? ctx.db.subsidiary.code.find(parentCode) : null;
    const sub = ctx.db.subsidiary.insert({ id: 0n, code, name, functionalCcy: ccyKey(functionalCcy), parentId: parent?.id });
    audit(ctx, role, 'seed_subsidiary', 'subsidiary', sub.id, `${code} ${name} (${functionalCcy})`);
  }
);

const AccountArg = t.object('AccountArg', {
  code: t.string(),
  name: t.string(),
  accountType: t.string(),
  isIntercompany: t.bool(),
  sortOrder: t.u32(),
});

export const seedAccounts = spacetimedb.reducer(
  { subsidiaryCode: t.string(), accounts: t.array(AccountArg) },
  (ctx, { subsidiaryCode, accounts }) => {
    const role = requireSeeder(ctx);
    const sub = ctx.db.subsidiary.code.find(subsidiaryCode);
    if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryCode}`);
    let added = 0;
    for (const a of accounts) {
      if (ctx.db.account.code.find(a.code)) continue;
      added++;
      ctx.db.account.insert({
        id: 0n,
        subsidiaryId: sub.id,
        code: a.code,
        name: a.name,
        accountType: { tag: a.accountType as any },
        isIntercompany: a.isIntercompany,
        sortOrder: a.sortOrder,
      });
    }
    if (added > 0) audit(ctx, role, 'seed_accounts', 'account', sub.id, `${added} of ${accounts.length} account(s) added to ${subsidiaryCode}`);
  }
);

export const seedPeriods = spacetimedb.reducer(
  { subsidiaryCode: t.string(), yms: t.array(t.string()), closedYms: t.array(t.string()) },
  (ctx, { subsidiaryCode, yms, closedYms }) => {
    const role = requireSeeder(ctx);
    const sub = ctx.db.subsidiary.code.find(subsidiaryCode);
    if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryCode}`);
    const added: string[] = [];
    for (const ym of yms) {
      if (ctx.db.period.ym.find(ym)) continue;
      added.push(ym);
      const [y, m] = ym.split('-').map(Number);
      const closed = closedYms.includes(ym);
      const p = ctx.db.period.insert({
        id: 0n,
        subsidiaryId: sub.id,
        year: y,
        month: m,
        ym,
        status: { tag: closed ? 'closed' : 'open' },
      });
      if (closed) {
        ctx.db.periodLock.insert({
          id: 0n,
          periodId: p.id,
          lockedBy: ctx.sender,
          lockedByRole: 'seed',
          lockedAt: ctx.timestamp,
          rationale: 'Closed before the demo period.',
        });
      }
    }
    if (added.length > 0) audit(ctx, role, 'seed_periods', 'period', sub.id, `${added.length} period(s) added to ${subsidiaryCode}: ${added.join(', ')}; locked: ${closedYms.filter(y => added.includes(y)).join(', ') || 'none'}`);
  }
);

export const seedFxRate = spacetimedb.reducer(
  { fromCcy: t.string(), toCcy: t.string(), ym: t.string(), rateE6: t.i64(), kind: t.string() },
  (ctx, a) => {
    const role = requireSeeder(ctx);
    const row = ctx.db.fxRate.insert({ id: 0n, fromCcy: ccyKey(a.fromCcy), toCcy: ccyKey(a.toCcy), ym: a.ym, rateE6: a.rateE6, kind: { tag: a.kind as any } });
    audit(ctx, role, 'seed_fx_rate', 'fx_rate', row.id, `${a.fromCcy}/${a.toCcy} ${a.ym} ${a.kind} ${a.rateE6}`);
  }
);

const CustomerArg = t.object('CustomerArg', {
  name: t.string(),
  domain: t.string(),
  guarantorPersonaId: t.string(),
  guarantorName: t.string(),
  paymentTermsDays: t.u16(),
});

export const seedCustomers = spacetimedb.reducer(
  { subsidiaryCode: t.string(), customers: t.array(CustomerArg) },
  (ctx, { subsidiaryCode, customers }) => {
    const role = requireSeeder(ctx);
    const sub = ctx.db.subsidiary.code.find(subsidiaryCode);
    if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryCode}`);
    for (const c of customers) {
      ctx.db.customer.insert({
        id: 0n,
        subsidiaryId: sub.id,
        name: c.name,
        domain: c.domain,
        guarantorPersonaId: c.guarantorPersonaId,
        guarantorName: c.guarantorName,
        creditTier: undefined,
        paymentTermsDays: c.paymentTermsDays,
        allowanceMinor: 0n,
      });
    }
    if (customers.length > 0) audit(ctx, role, 'seed_customers', 'customer', sub.id, `${customers.length} customer(s) added to ${subsidiaryCode}`);
  }
);

const VendorArg = t.object('VendorArg', {
  name: t.string(),
  domain: t.string(),
  category: t.string(),
  ownerPersonaId: t.option(t.string()),
});

export const seedVendors = spacetimedb.reducer(
  { subsidiaryCode: t.string(), vendors: t.array(VendorArg) },
  (ctx, { subsidiaryCode, vendors }) => {
    const role = requireSeeder(ctx);
    const sub = ctx.db.subsidiary.code.find(subsidiaryCode);
    if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryCode}`);
    for (const v of vendors) {
      ctx.db.vendor.insert({
        id: 0n,
        subsidiaryId: sub.id,
        name: v.name,
        domain: v.domain,
        category: v.category,
        ownerPersonaId: v.ownerPersonaId,
        verification: { tag: 'unverified' },
        verificationNote: '',
      });
    }
    if (vendors.length > 0) audit(ctx, role, 'seed_vendors', 'vendor', sub.id, `${vendors.length} vendor(s) added to ${subsidiaryCode}`);
  }
);

export const seedContract = spacetimedb.reducer(
  {
    customerId: t.u64(),
    code: t.string(),
    startYm: t.string(),
    endYm: t.string(),
    totalMinor: t.i64(),
    plan: Plan,
    items: t.array(ContractItemArg),
  },
  (ctx, a) => {
    const role = requireSeeder(ctx);
    if (ctx.db.contract.code.find(a.code)) return;
    const c = ctx.db.contract.insert({
      id: 0n,
      customerId: a.customerId,
      code: a.code,
      startYm: a.startYm,
      endYm: a.endYm,
      totalMinor: a.totalMinor,
      plan: a.plan,
    });
    for (const it of a.items) {
      ctx.db.contractItem.insert({
        id: 0n,
        contractId: c.id,
        kind: it.kind,
        priceMinor: it.priceMinor,
        qty: it.qty,
        sspMinor: it.sspMinor,
        description: it.description,
      });
    }
    audit(ctx, role, 'seed_contract', 'contract', c.id, `${a.code} for customer ${a.customerId}: ${a.items.length} item(s), ${a.totalMinor} minor`);
  }
);

export const seedRevenueScheduleLines = spacetimedb.reducer(
  {
    contractCode: t.string(),
    customerId: t.u64(),
    lines: t.array(t.object('SeedScheduleLine', { ym: t.string(), amountMinor: t.i64(), recognized: t.bool() })),
  },
  (ctx, { contractCode, customerId, lines }) => {
    const role = requireSeeder(ctx);
    const c = ctx.db.contract.code.find(contractCode);
    if (!c) throw new SenderError(`Unknown contract ${contractCode}`);
    const items = [...ctx.db.contractItem.contractId.filter(c.id)];
    const item = items.find(i => i.kind.tag === 'subscription') ?? items[0];
    if (!item) throw new SenderError(`Contract ${contractCode} has no items`);
    for (const l of lines) {
      ctx.db.revenueScheduleLine.insert({
        id: 0n,
        contractItemId: item.id,
        customerId,
        ym: l.ym,
        amountMinor: l.amountMinor,
        recognized: l.recognized,
        jeId: undefined,
      });
    }
    if (lines.length > 0) audit(ctx, role, 'seed_revenue_schedule', 'revenue_schedule_line', c.id, `${lines.length} schedule line(s) for ${contractCode} (${lines.filter(l => l.recognized).length} already recognized)`);
  }
);

export const seedInvoice = spacetimedb.reducer(
  {
    customerId: t.u64(),
    contractCode: t.option(t.string()),
    number: t.string(),
    ym: t.string(),
    issuedAtMicros: t.i64(),
    dueAtMicros: t.i64(),
    amountMinor: t.i64(),
    status: t.string(),
  },
  (ctx, a) => {
    const role = requireSeeder(ctx);
    if (ctx.db.invoice.number.find(a.number)) return;
    const contract = a.contractCode ? ctx.db.contract.code.find(a.contractCode) : null;
    const inv = ctx.db.invoice.insert({
      id: 0n,
      customerId: a.customerId,
      contractId: contract?.id,
      number: a.number,
      ym: a.ym,
      issuedAt: new Timestamp(a.issuedAtMicros),
      dueAt: new Timestamp(a.dueAtMicros),
      amountMinor: a.amountMinor,
      status: { tag: a.status as any },
    });
    audit(ctx, role, 'seed_invoice', 'invoice', inv.id, `${a.number} ${a.ym} ${a.amountMinor} minor (${a.status})`);
  }
);

export const seedBill = spacetimedb.reducer(
  {
    vendorId: t.u64(),
    externalRef: t.string(),
    ym: t.string(),
    billedAtMicros: t.i64(),
    dueAtMicros: t.i64(),
    amountMinor: t.i64(),
    expenseAccountCode: t.string(),
    status: t.string(),
  },
  (ctx, a) => {
    const role = requireSeeder(ctx);
    const b = ctx.db.bill.insert({
      id: 0n,
      vendorId: a.vendorId,
      externalRef: a.externalRef,
      ym: a.ym,
      billedAt: new Timestamp(a.billedAtMicros),
      dueAt: new Timestamp(a.dueAtMicros),
      amountMinor: a.amountMinor,
      expenseAccountCode: a.expenseAccountCode,
      status: { tag: a.status as any },
    });
    audit(ctx, role, 'seed_bill', 'bill', b.id, `${a.externalRef} ${a.ym} ${a.amountMinor} minor (${a.status})`);
  }
);

const BankTxArg = t.object('BankTxArg', {
  bookedAtMicros: t.i64(),
  ym: t.string(),
  amountMinor: t.i64(),
  ccy: t.string(),
  description: t.string(),
  counterparty: t.string(),
  matched: t.bool(),
});

export const seedBankTransactions = spacetimedb.reducer(
  { subsidiaryCode: t.string(), txs: t.array(BankTxArg) },
  (ctx, { subsidiaryCode, txs }) => {
    const role = requireSeeder(ctx);
    const sub = ctx.db.subsidiary.code.find(subsidiaryCode);
    if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryCode}`);
    for (const x of txs) {
      ctx.db.bankTransaction.insert({
        id: 0n,
        subsidiaryId: sub.id,
        bookedAt: new Timestamp(x.bookedAtMicros),
        ym: x.ym,
        amountMinor: x.amountMinor,
        ccy: ccyKey(x.ccy),
        description: x.description,
        counterparty: x.counterparty,
        matched: x.matched,
      });
    }
    if (txs.length > 0) audit(ctx, role, 'seed_bank_transactions', 'bank_transaction', sub.id, `${txs.length} bank transaction(s) added to ${subsidiaryCode} (${txs.filter(x => x.matched).length} pre-matched)`);
  }
);

export const seedJournalEntry = spacetimedb.reducer(
  { subsidiaryCode: t.string(), periodYm: t.string(), memo: t.string(), lines: t.array(LineArg) },
  (ctx, { subsidiaryCode, periodYm, memo, lines }) => {
    const role = requireSeeder(ctx);
    const sub = ctx.db.subsidiary.code.find(subsidiaryCode);
    if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryCode}`);
    const period = periodByYm(ctx, periodYm);
    // Seed entries may land in already-closed periods (opening balances), so bypass the lock check.
    const total = assertBalanced(lines as LineIn[]);
    assertRates(ctx, sub.id, period.id, lines as LineIn[], false);
    const je = ctx.db.journalEntry.insert({
      id: 0n,
      subsidiaryId: sub.id,
      periodId: period.id,
      postedAt: ctx.timestamp,
      memo,
      source: { tag: 'seed' },
      proposalId: undefined,
      postedBy: ctx.sender,
      postedByRole: role,
      reversalOf: undefined,
      totalMinor: total,
    });
    for (const l of lines) {
      const acct = accountByCode(ctx, l.accountCode);
      ctx.db.journalLine.insert({
        id: 0n,
        jeId: je.id,
        accountId: acct.id,
        accountCode: acct.code,
        debitMinor: l.debitMinor,
        creditMinor: l.creditMinor,
        ccy: l.ccy,
        fxRateE6: l.fxRateE6 === 0n ? 1_000_000n : l.fxRateE6,
        customerId: l.customerId,
        vendorId: l.vendorId,
        memo: l.memo,
      });
    }
    audit(ctx, role, 'seed_journal_entry', 'journal_entry', je.id, `${periodYm}: ${memo} (${lines.length} lines, ${total} minor)`);
  }
);

const CloseTaskArg = t.object('CloseTaskArg', {
  title: t.string(),
  description: t.string(),
  ownerRole: t.string(),
  sortOrder: t.u16(),
});

export const seedCloseTasks = spacetimedb.reducer(
  { periodYm: t.string(), tasks: t.array(CloseTaskArg) },
  (ctx, { periodYm, tasks }) => {
    const role = requireSeeder(ctx);
    const p = periodByYm(ctx, periodYm);
    for (const task of tasks) {
      ctx.db.closeTask.insert({
        id: 0n,
        periodId: p.id,
        title: task.title,
        description: task.description,
        ownerRole: task.ownerRole,
        status: { tag: 'todo' },
        sortOrder: task.sortOrder,
        evidenceProposalIds: '',
      });
    }
    if (tasks.length > 0) audit(ctx, role, 'seed_close_tasks', 'close_task', p.id, `${tasks.length} close task(s) for ${periodYm}`);
  }
);

export const resetDemo = spacetimedb.reducer(
  { confirm: t.string() },
  (ctx, { confirm }) => {
    // Wiping the books is the CFO's call, or the database owner's (whoever published it, e.g. via the spacetime CLI).
    // The Advisor, an agent identity, may only reset while setup is unsealed, i.e. during the initial load.
    const role = roleOf(ctx);
    const owner = ctx.db.settings.key.find(OWNER_KEY)?.valueText;
    const isOwner = !!owner && owner === ctx.sender.toHexString();
    const sealedRow = ctx.db.settings.key.find(SEALED_KEY);
    const sealed = (sealedRow?.valueI64 ?? 0n) === 1n;
    if (role !== 'cfo' && !isOwner && !(role === 'advisor' && !sealed)) {
      throw new SenderError(
        sealed && role === 'advisor'
          ? 'Setup is sealed: only the CFO or the database owner can reset the demo now (pnpm demo:reset falls back to the spacetime CLI, which runs as the owner).'
          : `Only the CFO or the database owner may reset the demo. Your connection is ${role ?? 'not registered'}.`
      );
    }
    if (confirm !== 'RESET') throw new SenderError('Pass confirm = "RESET".');
    if (sealedRow) ctx.db.settings.key.update({ ...sealedRow, valueI64: 0n });
    const tables: Array<keyof Ctx['db']> = [
      'journalLine', 'journalEntry', 'bankMatch', 'bankTransaction', 'revenueScheduleLine', 'contractItem', 'contract',
      'invoice', 'bill', 'vendor', 'customer', 'periodLock', 'period', 'account', 'fxRate', 'subsidiary',
      'proposal', 'approval', 'agentMessage', 'closeTask', 'creditCheck', 'auditEvent',
    ];
    for (const name of tables) {
      const table = ctx.db[name] as any;
      for (const row of [...table.iter()]) {
        const pk = 'id' in row ? 'id' : 'key' in row ? 'key' : null;
        if (pk) table[pk].delete(row[pk]);
      }
    }
    audit(ctx, role ?? (isOwner ? 'owner' : 'cfo'), 'reset_demo', 'all', 0n, 'Demo data cleared.');
  }
);

// Silence unused-import checks for enums referenced only in table definitions.
void ItemKind;
