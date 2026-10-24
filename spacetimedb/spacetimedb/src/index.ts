import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import spacetimedb, { agentIdentity, ContractItemArg, ItemKind, LineArg, overdueSweep, Plan, Role } from './tables';
import { sha256HexOfString, utf8 } from './sha256';
// The Risk Tier rules, shared with the Credit & Risk agent's cascade: one pure file with no imports, I/O or clock.
import { deriveTier, POLICY as CREDIT_POLICY, TIERS as CREDIT_TIERS, type Tier } from '../../../packages/crs-mcp/src/tiers';

export { default } from './tables';

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type RoleTag = 'advisor' | 'bookkeeper' | 'revenue' | 'credit' | 'redteam' | 'cfo' | 'ui' | 'consolidation' | 'feed';

const MATERIALITY_KEY = 'materiality_threshold_minor';
const DEFAULT_MATERIALITY_MINOR = 1_000_000n; // $10,000.00
const MICROS_PER_DAY = 86_400_000_000n;
const OWNER_KEY = 'database_owner';
const REPORTING_KEY = 'reporting_ccy';
const DEFAULT_REPORTING_CCY = 'USD';
const FEED_KEY = 'feed_enabled';
const FX_SCALE = 1_000_000n;

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

/** n / d rounded half away from zero (the same rounding as ledger-core's divRound). */
function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
}

/** A transaction-currency amount in functional currency at a rate scaled by 1e6, rounded half away from zero like ledger-core's applyFx. */
function applyFx(amountMinor: bigint, rateE6: bigint): bigint {
  return divRound(amountMinor * (rateE6 === 0n ? FX_SCALE : rateE6), FX_SCALE);
}

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
    dr += applyFx(l.debitMinor, l.fxRateE6);
    cr += applyFx(l.creditMinor, l.fxRateE6);
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

/** The reporting currency of the group (settings.reporting_ccy; USD when the row is missing). */
function reportingCcy(ctx: Ctx): string {
  return ccyKey(ctx.db.settings.key.find(REPORTING_KEY)?.valueText || DEFAULT_REPORTING_CCY);
}

/** The group code of an account code: the text before the first "-" ('2950-UK' is 2950). */
function groupCode(code: string): string {
  const i = code.indexOf('-');
  return i < 0 ? code : code.slice(0, i);
}

/** A group account's code in one subsidiary: bare for the root company, '<base>-<SUB>' for any company with a parent. */
function codeFor(ctx: Ctx, subsidiaryId: bigint, base: string): string {
  const sub = ctx.db.subsidiary.id.find(subsidiaryId);
  if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryId}`);
  return sub.parentId === undefined ? base : `${base}-${sub.code}`;
}

/**
 * The closing rate of one currency into another for a month, scaled by 1e6: 1.0 for the same currency, else the
 * recorded closing rate, else the reciprocal of the recorded reverse closing rate (as ledger-core's fxRate).
 */
function closingRate(ctx: Ctx, fromCcy: string, toCcy: string, ym: string): bigint | undefined {
  const from = ccyKey(fromCcy);
  const to = ccyKey(toCcy);
  if (from === to) return FX_SCALE;
  const rows = [...ctx.db.fxRate.ym.filter(ym)].filter(r => r.kind.tag === 'closing' && r.rateE6 > 0n);
  const direct = rows.find(r => ccyKey(r.fromCcy) === from && ccyKey(r.toCcy) === to);
  if (direct) return direct.rateE6;
  const inverse = rows.find(r => ccyKey(r.fromCcy) === to && ccyKey(r.toCcy) === from);
  return inverse ? divRound(FX_SCALE * FX_SCALE, inverse.rateE6) : undefined;
}

/**
 * The closing rate that sizes a functional-currency amount in the reporting currency for a month: that month's, else
 * the latest recorded before it (a schedule line or bill can fall in a month whose rates are not recorded yet). 1.0 in
 * the reporting currency itself; undefined when no closing rate exists at or before the month.
 */
function reportingRate(ctx: Ctx, functionalCcy: string, ym: string): bigint | undefined {
  const reporting = reportingCcy(ctx);
  const from = ccyKey(functionalCcy);
  if (from === reporting) return FX_SCALE;
  const exact = closingRate(ctx, from, reporting, ym);
  if (exact !== undefined) return exact;
  let latest: string | undefined;
  for (const r of ctx.db.fxRate.iter()) {
    if (r.kind.tag !== 'closing' || r.rateE6 <= 0n || r.ym >= ym) continue;
    const a = ccyKey(r.fromCcy);
    const b = ccyKey(r.toCcy);
    if (((a === from && b === reporting) || (a === reporting && b === from)) && (latest === undefined || r.ym > latest)) latest = r.ym;
  }
  return latest === undefined ? undefined : closingRate(ctx, from, reporting, latest);
}

function missingReportingRate(ctx: Ctx, functionalCcy: string, ym: string): string {
  return `no ${ccyKey(functionalCcy)}/${reportingCcy(ctx)} closing rate is recorded for ${ym} or any month before it; record one so its size in ${reportingCcy(ctx)} is known`;
}

/**
 * A subsidiary's functional-currency amount in the reporting currency (reportingRate), so every proposal.amountMinor
 * and the materiality test use one currency. Never 1:1 for another currency: without a rate the proposal is refused.
 */
function toReporting(ctx: Ctx, subsidiaryId: bigint, amountMinor: bigint, ym: string): bigint {
  const sub = ctx.db.subsidiary.id.find(subsidiaryId);
  if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryId}`);
  const rate = reportingRate(ctx, sub.functionalCcy, ym);
  if (rate === undefined) throw new SenderError(`An amount of ${sub.code} in ${ym} cannot be sized: ${missingReportingRate(ctx, sub.functionalCcy, ym)}.`);
  return applyFx(amountMinor, rate);
}

/** A proposal of a subsidiary outside the reporting currency needs a closing rate so its size is known. */
function assertReportingRate(ctx: Ctx, subsidiaryId: bigint, ym: string, what: string) {
  const functional = functionalCcyOf(ctx, subsidiaryId);
  if (reportingRate(ctx, functional, ym) === undefined) throw new SenderError(`${what}: ${missingReportingRate(ctx, functional, ym)}.`);
}

/** Every line must sit on an account of the entry's own subsidiary. */
function assertAccountsOf(ctx: Ctx, subsidiaryId: bigint, lines: { accountCode: string }[]) {
  for (const l of lines) {
    const acct = accountByCode(ctx, l.accountCode);
    if (acct.subsidiaryId !== subsidiaryId) {
      const own = ctx.db.subsidiary.id.find(subsidiaryId)?.code ?? String(subsidiaryId);
      const other = ctx.db.subsidiary.id.find(acct.subsidiaryId)?.code ?? String(acct.subsidiaryId);
      throw new SenderError(`Account ${acct.code} belongs to ${other}, not ${own}: an entry posts only to its own company's accounts.`);
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
  assertAccountsOf(ctx, args.subsidiaryId, args.lines);
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

/** Unpaid bills of a vendor in the reporting currency: the payments a vendor block holds or a vendor verification releases. */
function openBillsMinor(ctx: Ctx, vendorId: bigint): bigint {
  const vendor = ctx.db.vendor.id.find(vendorId);
  let total = 0n;
  for (const b of ctx.db.bill.vendorId.filter(vendorId)) {
    if (b.status.tag !== 'paid') total += vendor ? toReporting(ctx, vendor.subsidiaryId, abs(b.amountMinor), b.ym) : abs(b.amountMinor);
  }
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
 * Amount a proposal really moves or puts at stake, in the reporting currency, derived from its payload and the ledger
 * so a proposer cannot understate it and slip under the materiality threshold. A journal entry counts at the largest of
 * its raw and converted debits and credits (the ledger and the app sum raw minor units, and a foreign line on either
 * side can be the big one); a revenue schedule at the revenue it plans; a bank match at the cash it settles; a vendor
 * block or verification at the vendor's unpaid bills; a revaluation or elimination at the sum of its functional debits.
 * A credit decision moves nothing by itself (its allowance arrives as a journal entry). A subsidiary outside the
 * reporting currency converts at the month's closing rate.
 */
function computedAmount(ctx: Ctx, kind: string, payloadJson: string): bigint {
  const max = (...xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a), 0n);
  // The new kinds are validated before this runs, so a failure here is a refusal, never a silent zero.
  if (kind === 'fx_revaluation' || kind === 'ic_elimination') {
    return guarded(kind, () => {
      const payload = parseJson<{ subsidiaryId: string; periodYm: string; lines: JsonLine[] }>(payloadJson, kind);
      const subsidiaryId = idOf(payload.subsidiaryId, 'subsidiaryId');
      let debits = 0n;
      for (const l of parseLines(payload.lines)) debits += applyFx(l.debitMinor, l.fxRateE6);
      assertReportingRate(ctx, subsidiaryId, payload.periodYm, `The ${kind.replace('_', ' ')} for ${payload.periodYm}`);
      return toReporting(ctx, subsidiaryId, debits, payload.periodYm);
    });
  }
  try {
    if (kind === 'journal_entry' || kind === 'accrual') {
      const payload = JSON.parse(payloadJson) as JournalPayload;
      const subsidiaryId = BigInt(payload.subsidiaryId);
      const reporting = reportingCcy(ctx);
      const inReportingBooks = functionalCcyOf(ctx, subsidiaryId) === reporting;
      let rawDr = 0n;
      let rawCr = 0n;
      let convDr = 0n;
      let convCr = 0n;
      let repDr = 0n;
      let repCr = 0n;
      for (const l of payload.lines ?? []) {
        const dr = abs(BigInt(l.debitMinor || '0'));
        const cr = abs(BigInt(l.creditMinor || '0'));
        const rate = abs(BigInt(l.fxRateE6 || '1000000')) || 1_000_000n;
        rawDr += dr;
        rawCr += cr;
        convDr += applyFx(dr, rate);
        convCr += applyFx(cr, rate);
        if (!inReportingBooks) {
          // Each line from its own currency: one already in the reporting currency as it is, any other through the
          // subsidiary's currency at the closing rate.
          const own = ccyKey(l.ccy || 'USD') === reporting;
          repDr += own ? dr : toReporting(ctx, subsidiaryId, applyFx(dr, rate), payload.periodYm);
          repCr += own ? cr : toReporting(ctx, subsidiaryId, applyFx(cr, rate), payload.periodYm);
        }
      }
      return inReportingBooks ? max(rawDr, rawCr, convDr, convCr) : max(repDr, repCr);
    }
    if (kind === 'revenue_schedule') {
      const payload = JSON.parse(payloadJson) as RevenueSchedulePayload;
      let total = 0n;
      for (const l of payload.lines ?? []) {
        const amount = abs(BigInt(l.amountMinor ?? '0'));
        const customer = ctx.db.customer.id.find(BigInt(l.customerId));
        if (!customer) throw new SenderError(`Unknown customer ${l.customerId}`);
        total += toReporting(ctx, customer.subsidiaryId, amount, l.ym);
      }
      return total;
    }
    if (kind === 'bank_match') {
      const payload = JSON.parse(payloadJson) as BankMatchPayload;
      let total = 0n;
      for (const m of payload.matches ?? []) {
        const tx = ctx.db.bankTransaction.id.find(BigInt(m.bankTxId));
        if (!tx) continue;
        const raw = abs(tx.amountMinor);
        const functional = functionalCcyOf(ctx, tx.subsidiaryId);
        const rate = ccyKey(tx.ccy) === functional ? 1_000_000n : rateFor(ctx, tx.ccy, functional, tx.ym) ?? 1_000_000n;
        total += toReporting(ctx, tx.subsidiaryId, max(raw, applyFx(raw, rate)), tx.ym);
      }
      return total;
    }
    if (kind === 'vendor_block' || kind === 'vendor_verify') {
      const payload = JSON.parse(payloadJson) as { vendorId?: string };
      return payload.vendorId ? openBillsMinor(ctx, BigInt(payload.vendorId)) : 0n;
    }
  } catch (e) {
    // A refusal (e.g. no rate to size a foreign amount) stands; anything else is a malformed payload that
    // validateProposal has already refused.
    if (e instanceof SenderError) throw e;
  }
  return 0n;
}

const PENDING_STATUSES = ['open', 'awaiting_cfo', 'sent_back'];

/** Bank counterparties are free text; a blocked vendor is recognized by its name. */
function sameParty(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Bank lines cited by Proposals still waiting (open, awaiting the CFO, or sent back), other than `selfId`: line id →
 * the first such Proposal. A bank match cites its matches' lines; a journal entry or accrual its bankTxIds. Two waiting
 * Proposals must never explain the same bank line (e.g. the continuous Bookkeeper and a close racing each other).
 * A sent-back Proposal is resubmitted by ruling on it again, which passes its own id here, so it never blocks itself.
 */
function pendingBankCitations(ctx: Ctx, selfId: bigint | undefined): Map<string, bigint> {
  const cited = new Map<string, bigint>();
  for (const p of ctx.db.proposal.iter()) {
    if (p.id === selfId || !PENDING_STATUSES.includes(p.status.tag)) continue;
    const kind = p.kind.tag;
    if (kind !== 'bank_match' && kind !== 'journal_entry' && kind !== 'accrual') continue;
    let ids: unknown[] = [];
    try {
      const payload = JSON.parse(p.payloadJson) as { matches?: unknown; bankTxIds?: unknown } | null;
      if (kind === 'bank_match') ids = Array.isArray(payload?.matches) ? payload.matches.map(m => (m && typeof m === 'object' ? (m as { bankTxId?: unknown }).bankTxId : undefined)) : [];
      else ids = Array.isArray(payload?.bankTxIds) ? payload.bankTxIds : [];
    } catch {
      continue;
    }
    for (const x of ids) {
      try {
        const id = idOf(x, 'bankTxId').toString();
        if (!cited.has(id)) cited.set(id, p.id);
      } catch {
        /* a malformed id in an old payload cites nothing */
      }
    }
  }
  return cited;
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
function checkJournal(ctx: Ctx, kind: string, payloadJson: string, selfId: bigint | undefined) {
  const payload = parseJson<JournalPayload>(payloadJson, kind);
  const subsidiaryId = idOf(payload.subsidiaryId, 'subsidiaryId');
  const sub = ctx.db.subsidiary.id.find(subsidiaryId);
  if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryId}`);
  // Anything posted there by hand would distort or pre-empt the group's eliminations.
  if (sub.isElimination) throw new SenderError(`${sub.code} is the elimination company; it takes only ic_elimination proposals.`);
  if (!isYm(payload.periodYm)) throw new SenderError(`periodYm must be a month written YYYY-MM; got ${JSON.stringify(payload.periodYm ?? null)}.`);
  const period = periodByYm(ctx, payload.periodYm);
  assertPeriodOpen(ctx, period.id, `An entry for ${period.ym} cannot post.`);
  const lines = parseLines(payload.lines);
  assertBalanced(lines);
  assertRates(ctx, subsidiaryId, period.id, lines, false);
  assertAccountsOf(ctx, subsidiaryId, lines);
  for (const l of lines) {
    if (groupCode(l.accountCode) === '2000' && l.vendorId === undefined) throw new SenderError(`Every line on ${l.accountCode} Accounts Payable must name its vendor (vendorId).`);
  }
  assertReportingRate(ctx, subsidiaryId, period.ym, `An entry for ${period.ym}`);
  let next: ReturnType<typeof periodByYm> | undefined;
  if (kind === 'accrual' && payload.reversesInYm) {
    if (!isYm(payload.reversesInYm)) throw new SenderError(`reversesInYm must be a month written YYYY-MM; got ${JSON.stringify(payload.reversesInYm)}.`);
    if (payload.reversesInYm <= period.ym) throw new SenderError(`An accrual for ${period.ym} reverses in a later month, not ${payload.reversesInYm}.`);
    next = periodByYm(ctx, payload.reversesInYm);
    assertPeriodOpen(ctx, next.id, `The accrual's automatic reversal in ${next.ym} cannot post.`);
  }

  const txs: NonNullable<ReturnType<Ctx['db']['bankTransaction']['id']['find']>>[] = [];
  const seenTx = new Set<string>();
  const rawTxIds = listOf<unknown>(payload.bankTxIds, 'bankTxIds');
  const citedBy = rawTxIds.length > 0 ? pendingBankCitations(ctx, selfId) : new Map<string, bigint>();
  for (const raw of rawTxIds) {
    const txId = idOf(raw, 'bankTxIds entry');
    if (seenTx.has(txId.toString())) throw new SenderError(`Bank transaction ${txId} is listed twice.`);
    seenTx.add(txId.toString());
    const tx = ctx.db.bankTransaction.id.find(txId);
    if (!tx) throw new SenderError(`Unknown bank transaction ${txId}`);
    if (tx.subsidiaryId !== subsidiaryId) {
      const owner = ctx.db.subsidiary.id.find(tx.subsidiaryId)?.code ?? String(tx.subsidiaryId);
      throw new SenderError(`Bank transaction ${txId} is ${owner}'s; an entry for ${sub.code} cannot reconcile another company's bank line.`);
    }
    if (tx.matched || ctx.db.bankMatch.bankTxId.find(txId)) throw new SenderError(`Bank transaction ${txId} is already matched.`);
    const other = citedBy.get(txId.toString());
    if (other !== undefined) throw new SenderError(`Bank transaction ${txId} is already cited by pending proposal ${other}.`);
    const txPeriod = ctx.db.period.ym.find(tx.ym);
    if (!txPeriod) throw new SenderError(`No period ${tx.ym} for bank transaction ${txId}`);
    assertPeriodOpen(ctx, txPeriod.id, `Bank transaction ${txId} cannot be marked matched.`);
    txs.push(tx);
  }

  // Blocked vendors: nothing may pay them, however the entry is tagged. Voiding a blocked vendor's bill (no cash out)
  // stays possible.
  // A cited bank line pays out only when money went out; a refund coming in from a blocked vendor is fine.
  const outflows = txs.filter(t => t.amountMinor < 0n);
  const paysOut = outflows.length > 0 || lines.some(l => groupCode(l.accountCode) === '1000' && l.creditMinor > 0n);
  if (paysOut) {
    const blocked = [...ctx.db.vendor.iter()].filter(v => v.verification.tag === 'blocked');
    const byTag = blocked.find(v => lines.some(l => l.vendorId === v.id));
    const byBankLine = blocked.find(v => outflows.some(t => sameParty(t.counterparty, v.name)));
    const hit = byTag ?? byBankLine;
    if (hit) throw new SenderError(`Vendor ${hit.name} is blocked; no entry may pay money out to them or account for a payment to them until the block is lifted.`);
  }

  // Subscription revenue comes only from the revenue schedule.
  const toFunctional = (l: LineIn, amount: bigint) => applyFx(amount, l.fxRateE6);
  const revenueLines = lines.filter(l => groupCode(l.accountCode) === '4000');
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
  assertReportingRate(ctx, tx.subsidiaryId, tx.ym, `Bank transaction ${txId}`);
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
    const target = ctx.db.journalEntry.id.find(targetId);
    if (!target) throw new SenderError(`Unknown journal entry ${targetId}`);
    if (target.subsidiaryId !== tx.subsidiaryId) {
      const code = (id: bigint) => ctx.db.subsidiary.id.find(id)?.code ?? String(id);
      throw new SenderError(`Journal entry ${targetId} is ${code(target.subsidiaryId)}'s, but bank transaction ${txId} is ${code(tx.subsidiaryId)}'s; a bank line is reconciled only by its own company's entry.`);
    }
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
  const converted = applyFx(amt, rate);
  const shown = txCcy === functional ? `${amt}` : `${amt} ${txCcy} = ${converted} ${functional}`;
  const companyOf = (id: bigint) => ctx.db.subsidiary.id.find(id)?.code ?? String(id);
  if (m.targetKind === 'invoice') {
    const inv = ctx.db.invoice.id.find(targetId);
    if (!inv) throw new SenderError(`Unknown invoice ${targetId}`);
    const owner = ctx.db.customer.id.find(inv.customerId)?.subsidiaryId;
    if (owner !== undefined && owner !== tx.subsidiaryId) throw new SenderError(`Invoice ${inv.number} belongs to ${companyOf(owner)}, but bank transaction ${txId} is ${companyOf(tx.subsidiaryId)}'s; a bank line settles only its own company's invoices.`);
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
  if (vendor && vendor.subsidiaryId !== tx.subsidiaryId) throw new SenderError(`Bill ${bill.externalRef} belongs to ${companyOf(vendor.subsidiaryId)}, but bank transaction ${txId} is ${companyOf(tx.subsidiaryId)}'s; a bank line settles only its own company's bills.`);
  if (vendor && vendor.verification.tag === 'blocked') throw new SenderError(`Bill ${bill.externalRef} is owed to ${vendor.name}, which is blocked; it cannot be settled until the block is lifted.`);
  if (tx.amountMinor >= 0n) throw new SenderError(`Bank transaction ${txId} is money coming in; a bill is paid by money going out.`);
  if (converted !== bill.amountMinor) {
    throw new SenderError(`Bank transaction ${txId} (${shown}) does not equal bill ${bill.externalRef} (${bill.amountMinor}). Propose a journal entry for a partial payment or overpayment instead.`);
  }
  return { ...base, rate, converted, inv: undefined, bill };
}

type CreditCheckRow = NonNullable<ReturnType<Ctx['db']['creditCheck']['id']['find']>>;

/** The recorded credit checks on one customer (its guarantor) or one vendor (its owner). */
function checksOf(ctx: Ctx, kind: 'customer' | 'vendor', subjectId: bigint): CreditCheckRow[] {
  return [...ctx.db.creditCheck.subjectId.filter(subjectId)].filter(r => r.subjectKind.tag === kind);
}

/** The newest of some recorded checks (by recording time, then id). `rows` must not be empty. */
function latestCheck(rows: CreditCheckRow[]): CreditCheckRow {
  return rows.reduce((a, b) => {
    const at = a.createdAt.microsSinceUnixEpoch;
    const bt = b.createdAt.microsSinceUnixEpoch;
    return bt > at || (bt === at && b.id > a.id) ? b : a;
  });
}

/** Every cited request id must name one of `rows` (a row recorded without a request id can never be cited). */
function refuseForeignCitations(cited: Set<string>, rows: CreditCheckRow[], subject: string) {
  const foreign = [...cited].filter(id => !rows.some(r => r.requestId !== '' && r.requestId === id));
  if (foreign.length > 0) throw new SenderError(`Request id(s) ${foreign.join(', ')} are not recorded credit checks for ${subject}.`);
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
  const rows = checksOf(ctx, 'vendor', v.id);
  refuseForeignCitations(cited, rows, `vendor ${v.id}`);
  const clean = (c: (typeof rows)[number]) => c.decision.toUpperCase() === 'APPROVE' && (c.tier === 'A' || c.tier === 'B');
  const latest: (typeof rows)[number][] = [];
  for (const prod of VERIFY_PRODUCTS) {
    const ofProduct = rows.filter(c => c.product === prod);
    if (ofProduct.length === 0) throw new SenderError(`Vendor ${v.name} has no recorded ${prod} check.`);
    const last = latestCheck(ofProduct);
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
 * A credit_decision holds only if its evidence supports it: the tier is one of A, B, C, D or BLOCK and is the tier the
 * books derived for every cited check (recordCreditCheck derives it from the recorded facts) and for the customer's
 * latest check, so a newer, worse check cannot be passed over for an older, cleaner one; and the payment terms are no
 * longer than the tier allows (a BLOCK gets none). Tighter terms are allowed. The latest check need not be cited
 * itself: a provider call can come back without a request id, and such a row can never be cited. Because the rule is
 * on its tier, a newer check at the same tier also leaves a decision that is waiting for its ruling valid.
 */
function checkCreditDecision(ctx: Ctx, payload: CreditDecisionPayload) {
  const c = ctx.db.customer.id.find(idOf(payload.customerId, 'customerId'));
  if (!c) throw new SenderError(`Unknown customer ${payload.customerId}`);
  const tier = payload.tier as Tier;
  if (typeof tier !== 'string' || !CREDIT_TIERS.includes(tier)) throw new SenderError(`tier must be one of ${CREDIT_TIERS.join(', ')}; got ${JSON.stringify(payload.tier ?? null)}.`);
  const terms = payload.paymentTermsDays;
  if (typeof terms !== 'number' || !Number.isInteger(terms) || terms < 0 || terms > 65535) {
    throw new SenderError(`paymentTermsDays must be a whole number of days; got ${JSON.stringify(terms ?? null)}.`);
  }
  const maxTerms = CREDIT_POLICY.paymentTermsDays[tier] ?? 0;
  if (terms > maxTerms) throw new SenderError(`Tier ${tier} allows at most ${maxTerms}-day payment terms; got ${terms}.`);
  if (payload.allowanceMinor !== undefined && payload.allowanceMinor !== null) minorOf(payload.allowanceMinor, 'allowanceMinor');
  const ids = listOf<unknown>(payload.creditCheckIds, 'creditCheckIds');
  const cited = new Set<string>();
  for (const x of ids) {
    if (typeof x !== 'string' || x.trim() === '') throw new SenderError(`creditCheckIds lists request ids; got ${JSON.stringify(x ?? null)}.`);
    cited.add(x.trim());
  }
  if (cited.size === 0) throw new SenderError(`A credit decision must cite the request ids of the credit checks it rests on (creditCheckIds).`);
  const rows = checksOf(ctx, 'customer', c.id);
  refuseForeignCitations(cited, rows, `customer ${c.id}`);
  const latest = latestCheck(rows);
  if (latest.tier !== tier) {
    throw new SenderError(`${c.name}'s latest credit check (request ${latest.requestId || 'n/a'}, ${latest.product}) derives tier ${latest.tier}, not ${tier}; a decision rests on the newest evidence.`);
  }
  const off = rows.find(r => cited.has(r.requestId) && r.tier !== tier);
  if (off) throw new SenderError(`Credit check ${off.requestId} (${off.product}) on ${c.name}'s guarantor derives tier ${off.tier}, not ${tier}: a credit decision takes the tier its evidence derives.`);
  return { c, tier };
}


// ---------- consolidation: revaluation and elimination proposals ----------

type JournalLineRow = NonNullable<ReturnType<Ctx['db']['journalLine']['id']['find']>>;

/** A calendar month n months after ym (n may be negative). */
function ymAdd(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const i = y! * 12 + (m! - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** A posted line in its entry's functional currency, signed debit-positive, converted per line like ledger-core. */
function functionalOf(l: JournalLineRow): bigint {
  return applyFx(l.debitMinor, l.fxRateE6) - applyFx(l.creditMinor, l.fxRateE6);
}

/** Posted lines on one account in months up to and including ym ('through'), or in ym only ('in'). */
function accountLines(ctx: Ctx, accountId: bigint, ym: string, mode: 'through' | 'in'): JournalLineRow[] {
  const entryYm = new Map<bigint, string>();
  const out: JournalLineRow[] = [];
  for (const l of ctx.db.journalLine.accountId.filter(accountId)) {
    let lym = entryYm.get(l.jeId);
    if (lym === undefined) {
      const je = ctx.db.journalEntry.id.find(l.jeId);
      lym = (je && ctx.db.period.id.find(je.periodId)?.ym) || '';
      entryYm.set(l.jeId, lym);
    }
    if (lym === '' || (mode === 'through' ? lym > ym : lym !== ym)) continue;
    out.push(l);
  }
  return out;
}

/** Net (debit − credit) per account code of some proposed lines. */
function netByAccount(lines: LineIn[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const l of lines) net.set(l.accountCode, (net.get(l.accountCode) ?? 0n) + l.debitMinor - l.creditMinor);
  return net;
}

/** The proposed lines must net exactly to what the ledger implies, account by account, and touch nothing else. */
function assertNets(lines: LineIn[], expected: Map<string, bigint>, what: string, basis: string) {
  const actual = netByAccount(lines);
  for (const code of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(code) ?? 0n;
    const got = actual.get(code) ?? 0n;
    if (want !== got) {
      throw new SenderError(
        expected.has(code)
          ? `The ${what} lines net ${got} on ${code}, but ${basis} gives ${want} (minor units, debit positive).`
          : `The ${what} lines post ${got} to ${code}, which ${basis} does not involve.`
      );
    }
  }
}

/** Every line in the subsidiary's own currency at rate 1.0. */
function assertFunctionalLines(lines: LineIn[], functional: string, code: string, what: string) {
  for (const l of lines) {
    if (ccyKey(l.ccy) !== functional || (l.fxRateE6 === 0n ? FX_SCALE : l.fxRateE6) !== FX_SCALE) {
      throw new SenderError(`${what} lines post in ${code}'s own currency (${functional}) at rate 1000000; the line on ${l.accountCode} is ${ccyKey(l.ccy)} at ${l.fxRateE6}.`);
    }
  }
}

/** Another proposal of this kind still waiting (open, awaiting the CFO or sent back) that the predicate matches. */
function pendingTwin(ctx: Ctx, kind: string, selfId: bigint | undefined, same: (payload: Record<string, unknown>) => boolean): bigint | undefined {
  for (const p of ctx.db.proposal.iter()) {
    if (p.kind.tag !== kind || !PENDING_STATUSES.includes(p.status.tag) || p.id === selfId) continue;
    try {
      const other = JSON.parse(p.payloadJson) as Record<string, unknown>;
      if (other && typeof other === 'object' && same(other)) return p.id;
    } catch {
      continue;
    }
  }
  return undefined;
}

const sameId = (a: unknown, b: bigint) => {
  try {
    return idOf(a, 'id') === b;
  } catch {
    return false;
  }
};

type FxRevaluationItem = {
  accountCode: string;
  ccy: string;
  txnBalanceMinor: string;
  closingRateE6: string;
  bookedFunctionalMinor: string;
  targetFunctionalMinor: string;
  deltaMinor: string;
};
type FxRevaluationPayload = { subsidiaryId: string; periodYm: string; rateYm?: string; memo?: string; items: FxRevaluationItem[]; lines: JsonLine[] };

/**
 * A revaluation restates one subsidiary's foreign-currency asset and liability balances at the month's closing rate.
 * Every figure is recomputed from the posted ledger and fx_rate and must equal the payload: per item the balance in
 * the item's currency, the booked functional balance, the closing rate, the target (balance at that rate) and the
 * delta (target − booked). The lines move each item account by its delta and post the opposite to the subsidiary's
 * 7100 FX gain or loss, in its own currency, and touch nothing else.
 */
function checkFxRevaluation(ctx: Ctx, payloadJson: string, selfId: bigint | undefined) {
  const payload = parseJson<FxRevaluationPayload>(payloadJson, 'fx_revaluation');
  const subsidiaryId = idOf(payload.subsidiaryId, 'subsidiaryId');
  const sub = ctx.db.subsidiary.id.find(subsidiaryId);
  if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryId}`);
  if (sub.isElimination) throw new SenderError(`${sub.code} is the elimination company; it holds only eliminations and has no foreign balances to revalue.`);
  if (!isYm(payload.periodYm)) throw new SenderError(`periodYm must be a month written YYYY-MM; got ${JSON.stringify(payload.periodYm ?? null)}.`);
  const period = periodByYm(ctx, payload.periodYm);
  assertPeriodOpen(ctx, period.id, `A revaluation for ${period.ym} cannot post.`);
  const ym = period.ym;
  if (payload.rateYm !== undefined && payload.rateYm !== null && payload.rateYm !== '' && payload.rateYm !== ym) {
    throw new SenderError(`rateYm must be the revaluation month ${ym}, not ${JSON.stringify(payload.rateYm)}: a month's balances are restated at that month's closing rate.`);
  }
  const functional = ccyKey(sub.functionalCcy);
  assertReportingRate(ctx, sub.id, ym, `A revaluation of ${sub.code} for ${ym}`);
  const items = objectsOf<FxRevaluationItem>(payload.items, 'items');
  if (items.length === 0) throw new SenderError('A revaluation needs at least one item.');
  const expected = new Map<string, bigint>();
  let gain = 0n;
  let moved = 0n;
  for (const it of items) {
    const acct = accountByCode(ctx, String(it.accountCode ?? '').trim());
    if (acct.subsidiaryId !== sub.id) throw new SenderError(`Item account ${acct.code} does not belong to ${sub.code}.`);
    if (expected.has(acct.code)) throw new SenderError(`Account ${acct.code} appears twice in this revaluation; revalue each account once.`);
    if (acct.accountType.tag !== 'asset' && acct.accountType.tag !== 'liability') {
      throw new SenderError(`Account ${acct.code} is ${acct.accountType.tag}; only asset and liability balances are revalued (income and expense stay at the month's average rate).`);
    }
    const ccy = ccyKey(String(it.ccy ?? ''));
    if (!/^[A-Z]{3}$/.test(ccy)) throw new SenderError(`Item ${acct.code} needs a three-letter currency; got ${JSON.stringify(it.ccy ?? null)}.`);
    if (ccy === functional) throw new SenderError(`Item ${acct.code} is in ${ccy}, ${sub.code}'s own currency; only foreign-currency balances are revalued.`);
    const rate = closingRate(ctx, ccy, functional, ym);
    if (rate === undefined) throw new SenderError(`No ${ccy}/${functional} closing rate is recorded for ${ym}; record it before revaluing ${acct.code}.`);
    let txn = 0n;
    let booked = 0n;
    for (const l of accountLines(ctx, acct.id, ym, 'through')) {
      if (ccyKey(l.ccy) === ccy) txn += l.debitMinor - l.creditMinor;
      booked += functionalOf(l);
    }
    const target = applyFx(txn, rate);
    const delta = target - booked;
    const figures: [keyof FxRevaluationItem, bigint, string][] = [
      ['txnBalanceMinor', txn, `its ${ccy} balance through ${ym}`],
      ['closingRateE6', rate, `the ${ccy}/${functional} closing rate for ${ym}`],
      ['bookedFunctionalMinor', booked, `its booked ${functional} balance through ${ym}`],
      ['targetFunctionalMinor', target, `its ${ccy} balance at the ${ym} closing rate`],
      ['deltaMinor', delta, 'target minus booked'],
    ];
    for (const [field, actual, meaning] of figures) {
      const stated = minorOf(it[field], `Item ${acct.code} ${field}`);
      if (stated !== actual) throw new SenderError(`Item ${acct.code}: ${field} is ${stated}, but ${meaning} is ${actual}.`);
    }
    expected.set(acct.code, delta);
    gain += delta;
    moved += abs(delta);
  }
  if (moved === 0n) throw new SenderError(`Every item already stands at the ${ym} closing rate; there is nothing to revalue.`);
  const offset = codeFor(ctx, sub.id, '7100');
  if (expected.has(offset)) throw new SenderError(`${offset} is the FX gain or loss account; it cannot also be revalued.`);
  expected.set(offset, -gain);
  const lines = parseLines(payload.lines);
  assertBalanced(lines);
  assertFunctionalLines(lines, functional, sub.code, 'Revaluation');
  assertAccountsOf(ctx, sub.id, lines);
  assertNets(lines, expected, 'revaluation', `the revaluation of ${sub.code} at the ${ym} closing rate`);
  const twin = pendingTwin(ctx, 'fx_revaluation', selfId, o => sameId(o.subsidiaryId, sub.id) && o.periodYm === ym);
  if (twin !== undefined) throw new SenderError(`Revaluation proposal ${twin} for ${sub.code} in ${ym} is still waiting; decide it before proposing another.`);
  return { payload, sub, period, lines };
}

type IcPair = {
  label?: string;
  sourceSubsidiaryId: string;
  sourceAccountCode: string;
  counterSubsidiaryId: string;
  counterAccountCode: string;
  amountMinor: string;
  counterTranslatedMinor?: string;
  differenceMinor?: string;
};
type IcEliminationPayload = { subsidiaryId: string; periodYm: string; memo?: string; basis: string; reversesInYm?: string; pairs: IcPair[]; lines: JsonLine[] };

/** The group's intercompany pairs by source group code (the same pairs as ledger-core's IC_PAIRS). */
const IC_GROUP_PAIRS: Record<string, { counter: string; basis: 'balance' | 'activity' }> = {
  '1900': { counter: '2900', basis: 'balance' },
  '1950': { counter: '2950', basis: 'balance' },
  '4900': { counter: '5900', basis: 'activity' },
};
/** The account type the other company books the mirror of a balance or charge in. */
const MIRROR_TYPE: Record<string, string> = { asset: 'liability', liability: 'asset', revenue: 'expense', expense: 'revenue' };

/**
 * An elimination removes balances (basis 'balance', cumulative, reversed the next month) or one month's income and
 * expense (basis 'activity') that group companies have with each other, by posting to the elimination company. Each
 * pair's amount must equal the source account's balance or month activity in its reporting-currency company; the lines
 * move <source group>-ELIM by minus that amount and <counter group>-ELIM by plus it, on intercompany accounts of the
 * elimination company, and nothing else. A month already eliminated on that basis, or still waiting for a ruling, is
 * refused.
 */
function checkIcElimination(ctx: Ctx, payloadJson: string, selfId: bigint | undefined) {
  const payload = parseJson<IcEliminationPayload>(payloadJson, 'ic_elimination');
  const subsidiaryId = idOf(payload.subsidiaryId, 'subsidiaryId');
  const sub = ctx.db.subsidiary.id.find(subsidiaryId);
  if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryId}`);
  if (!sub.isElimination) throw new SenderError(`${sub.code} is not the elimination company; eliminations post only to the group's elimination company.`);
  const reporting = reportingCcy(ctx);
  const functional = ccyKey(sub.functionalCcy);
  if (functional !== reporting) throw new SenderError(`The elimination company keeps its books in ${functional}, not the reporting currency ${reporting}.`);
  if (!isYm(payload.periodYm)) throw new SenderError(`periodYm must be a month written YYYY-MM; got ${JSON.stringify(payload.periodYm ?? null)}.`);
  const period = periodByYm(ctx, payload.periodYm);
  assertPeriodOpen(ctx, period.id, `An elimination for ${period.ym} cannot post.`);
  const ym = period.ym;
  const basis = payload.basis;
  if (basis !== 'balance' && basis !== 'activity') throw new SenderError(`basis must be "balance" or "activity"; got ${JSON.stringify(basis ?? null)}.`);
  const rev = payload.reversesInYm;
  const hasRev = rev !== undefined && rev !== null && rev !== '';
  let next: ReturnType<typeof periodByYm> | undefined;
  if (basis === 'balance') {
    if (!hasRev) throw new SenderError(`A balance elimination reverses the next month (reversesInYm ${ymAdd(ym, 1)}), because the next close eliminates the balance again.`);
    if (rev !== ymAdd(ym, 1)) throw new SenderError(`A balance elimination for ${ym} reverses in ${ymAdd(ym, 1)}, not ${JSON.stringify(rev)}.`);
    next = periodByYm(ctx, rev);
    assertPeriodOpen(ctx, next.id, `The elimination's automatic reversal in ${next.ym} cannot post.`);
  } else if (hasRev) {
    throw new SenderError(`An activity elimination removes ${ym}'s intercompany income and expense only; it does not reverse (drop reversesInYm).`);
  }
  const pairs = objectsOf<IcPair>(payload.pairs, 'pairs');
  if (pairs.length === 0) throw new SenderError('An elimination needs at least one pair.');
  const where = basis === 'balance' ? `balance through ${ym}` : `activity in ${ym}`;
  const expected = new Map<string, bigint>();
  const used = new Set<string>();
  let total = 0n;
  for (const [i, pair] of pairs.entries()) {
    const label = String(pair.label ?? `pair ${i + 1}`);
    const company = (raw: unknown, side: string) => {
      const id = idOf(raw, `Pair "${label}" ${side}SubsidiaryId`);
      const c = ctx.db.subsidiary.id.find(id);
      if (!c) throw new SenderError(`Pair "${label}": unknown ${side} subsidiary ${id}.`);
      if (c.isElimination) throw new SenderError(`Pair "${label}": the ${side} side cannot be the elimination company.`);
      return c;
    };
    const src = company(pair.sourceSubsidiaryId, 'source');
    const cnt = company(pair.counterSubsidiaryId, 'counter');
    if (src.id === cnt.id) throw new SenderError(`Pair "${label}": source and counter are both ${src.code}; an elimination pairs two different companies.`);
    if (ccyKey(src.functionalCcy) !== reporting) {
      throw new SenderError(`Pair "${label}": the source side must be a ${reporting} company so its amount needs no translation; ${src.code} keeps ${ccyKey(src.functionalCcy)} books.`);
    }
    const account = (code: unknown, owner: typeof src, side: string) => {
      const a = accountByCode(ctx, String(code ?? '').trim());
      if (a.subsidiaryId !== owner.id) throw new SenderError(`Pair "${label}": ${side} account ${a.code} does not belong to ${owner.code}.`);
      if (!a.isIntercompany) throw new SenderError(`Pair "${label}": ${side} account ${a.code} is not an intercompany account.`);
      return a;
    };
    const srcAcct = account(pair.sourceAccountCode, src, 'source');
    const cntAcct = account(pair.counterAccountCode, cnt, 'counter');
    for (const a of [srcAcct, cntAcct]) {
      if (used.has(a.code)) throw new SenderError(`Pair "${label}": ${a.code} already appears in another pair; each intercompany account is eliminated once.`);
      used.add(a.code);
    }
    const def = IC_GROUP_PAIRS[groupCode(srcAcct.code)];
    const known = Object.entries(IC_GROUP_PAIRS).map(([s, d]) => `${s} with ${d.counter}`).join(', ');
    if (!def) throw new SenderError(`Pair "${label}": ${srcAcct.code} is not the source side of an intercompany pair (${known}).`);
    if (groupCode(cntAcct.code) !== def.counter) throw new SenderError(`Pair "${label}": ${srcAcct.code} pairs with group code ${def.counter}, not ${cntAcct.code}.`);
    if (def.basis !== basis) throw new SenderError(`Pair "${label}": ${groupCode(srcAcct.code)} with ${def.counter} is eliminated on the ${def.basis} basis, not ${basis}.`);
    if (MIRROR_TYPE[srcAcct.accountType.tag] !== cntAcct.accountType.tag) {
      throw new SenderError(`Pair "${label}": ${cntAcct.code} is ${cntAcct.accountType.tag}, but it must mirror ${srcAcct.code} (${srcAcct.accountType.tag}) as ${MIRROR_TYPE[srcAcct.accountType.tag] ?? 'its opposite'}.`);
    }
    const pnl = (t: string) => t === 'revenue' || t === 'expense';
    if (basis === 'balance' && pnl(srcAcct.accountType.tag)) throw new SenderError(`Pair "${label}": ${srcAcct.code} is ${srcAcct.accountType.tag}; a balance elimination pairs asset and liability balances (use basis "activity").`);
    if (basis === 'activity' && !pnl(srcAcct.accountType.tag)) throw new SenderError(`Pair "${label}": ${srcAcct.code} is ${srcAcct.accountType.tag}; an activity elimination pairs income and expense (use basis "balance").`);
    let signed = 0n;
    for (const l of accountLines(ctx, srcAcct.id, ym, basis === 'balance' ? 'through' : 'in')) signed += functionalOf(l);
    const stated = minorOf(pair.amountMinor, `Pair "${label}" amountMinor`);
    if (stated !== abs(signed)) throw new SenderError(`Pair "${label}": amountMinor is ${stated}, but ${srcAcct.code} in ${src.code} shows ${abs(signed)} (${where}).`);
    for (const f of ['counterTranslatedMinor', 'differenceMinor'] as const) {
      if (pair[f] !== undefined && pair[f] !== null) minorOf(pair[f], `Pair "${label}" ${f}`);
    }
    const srcElim = codeFor(ctx, sub.id, groupCode(srcAcct.code));
    const cntElim = codeFor(ctx, sub.id, groupCode(cntAcct.code));
    expected.set(srcElim, (expected.get(srcElim) ?? 0n) - signed);
    expected.set(cntElim, (expected.get(cntElim) ?? 0n) + signed);
    total += abs(signed);
  }
  if (total === 0n) throw new SenderError(`Every pair is zero; there is nothing to eliminate (${where}).`);
  const lines = parseLines(payload.lines);
  assertBalanced(lines);
  assertFunctionalLines(lines, functional, sub.code, 'Elimination');
  assertAccountsOf(ctx, sub.id, lines);
  for (const l of lines) {
    if (!accountByCode(ctx, l.accountCode).isIntercompany) throw new SenderError(`Elimination lines post only to intercompany accounts; ${l.accountCode} is not one.`);
  }
  assertNets(lines, expected, 'elimination', `the pairs' ${where}`);
  const twin = pendingTwin(ctx, 'ic_elimination', selfId, o => sameId(o.subsidiaryId, sub.id) && o.periodYm === ym && o.basis === basis);
  if (twin !== undefined) throw new SenderError(`Elimination proposal ${twin} (${basis}, ${ym}) is still waiting; decide it before proposing another.`);
  for (const code of expected.keys()) {
    const acct = ctx.db.account.code.find(code);
    if (!acct) continue;
    let carried = 0n;
    for (const l of accountLines(ctx, acct.id, ym, basis === 'balance' ? 'through' : 'in')) carried += functionalOf(l);
    if (carried !== 0n) throw new SenderError(`${code} already carries ${carried} (${where}): ${ym} is already eliminated on the ${basis} basis. Reverse that elimination first.`);
  }
  return { payload, sub, period, next, lines };
}

/**
 * Refuse a proposal that could never apply. Runs at proposal time, before a ruling (so an unusable proposal never
 * reaches the CFO's queue) and again when applyProposal applies it, including at the CFO's confirmation, so a conflict
 * that arose meanwhile is reported instead of skipped.
 */
function validateProposal(ctx: Ctx, kind: string, payloadJson: string, selfId?: bigint) {
  guarded(kind, () => validateProposalShapeAndState(ctx, kind, payloadJson, selfId));
}

function validateProposalShapeAndState(ctx: Ctx, kind: string, payloadJson: string, selfId: bigint | undefined) {
  if (kind === 'journal_entry' || kind === 'accrual') {
    checkJournal(ctx, kind, payloadJson, selfId);
  } else if (kind === 'fx_revaluation') {
    checkFxRevaluation(ctx, payloadJson, selfId);
  } else if (kind === 'ic_elimination') {
    checkIcElimination(ctx, payloadJson, selfId);
  } else if (kind === 'bank_match') {
    const payload = parseJson<BankMatchPayload>(payloadJson, kind);
    payload.matches = objectsOf<BankMatchPayload['matches'][number]>(payload.matches, 'matches');
    if (payload.matches.length === 0) throw new SenderError('A bank match proposal needs at least one match.');
    const txs = new Set<string>();
    const targets = new Set<string>();
    const citedBy = pendingBankCitations(ctx, selfId);
    for (const m of payload.matches) {
      if (typeof m.scoreBp !== 'number' || !Number.isInteger(m.scoreBp) || m.scoreBp < 0 || m.scoreBp > 10000) {
        throw new SenderError(`scoreBp must be a whole number from 0 to 10000; got ${JSON.stringify(m.scoreBp ?? null)}.`);
      }
      const txKey = idOf(m.bankTxId, 'bankTxId').toString();
      if (txs.has(txKey)) throw new SenderError(`Bank transaction ${txKey} appears twice in this proposal.`);
      txs.add(txKey);
      const other = citedBy.get(txKey);
      if (other !== undefined) throw new SenderError(`Bank transaction ${txKey} is already cited by pending proposal ${other}.`);
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
    checkCreditDecision(ctx, parseJson<CreditDecisionPayload>(payloadJson, kind));
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
    const { payload, subsidiaryId, period, lines, next, txs, flips } = checkJournal(ctx, kind, payloadJson, p.id);
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
  if (kind === 'fx_revaluation') {
    const { payload, sub, period, lines } = checkFxRevaluation(ctx, payloadJson, p.id);
    postEntry(ctx, { subsidiaryId: sub.id, periodId: period.id, memo: String(payload.memo ?? `Revaluation at the ${period.ym} closing rate`), lines, source: 'agent', proposalId: p.id, reversalOf: undefined, role });
    return;
  }
  if (kind === 'ic_elimination') {
    const { payload, sub, period, next, lines } = checkIcElimination(ctx, payloadJson, p.id);
    const memo = String(payload.memo ?? `Intercompany elimination for ${period.ym}`);
    const je = postEntry(ctx, { subsidiaryId: sub.id, periodId: period.id, memo, lines, source: 'agent', proposalId: p.id, reversalOf: undefined, role });
    if (next) {
      // A balance elimination reverses next month, as an accrual does, because the next close eliminates the then-current balance.
      const reversed = lines.map(l => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor, memo: `Reverse elimination: ${l.memo}` }));
      postEntry(ctx, { subsidiaryId: sub.id, periodId: next.id, memo: `Reversal of elimination: ${memo}`, lines: reversed, source: 'agent', proposalId: p.id, reversalOf: je.id, role });
    }
    return;
  }
  validateProposal(ctx, kind, payloadJson, p.id);
  if (kind === 'bank_match') {
    const payload = parseJson<BankMatchPayload>(payloadJson, kind);
    for (const m of payload.matches) {
      // Checked against the state as each match applies, so a second match to an invoice the first one paid is refused.
      const { tx, txId, targetId, amt, txPeriod, txCcy, functional, rate, converted, inv, bill } = checkBankMatch(ctx, m);
      const base = { id: 0n, bankTxId: txId, targetId, scoreBp: m.scoreBp, proposalId: p.id };
      const cash = codeFor(ctx, tx.subsidiaryId, '1000');
      // The cash line carries the bank line's currency and rate; the receivable or payable settles in our own currency.
      if (inv) {
        const je = postEntry(ctx, { subsidiaryId: tx.subsidiaryId, periodId: txPeriod.id, memo: `Payment received ${inv.number}: ${tx.description}`, lines: [
          { accountCode: cash, debitMinor: amt, creditMinor: 0n, ccy: txCcy, fxRateE6: rate, customerId: inv.customerId, vendorId: undefined, memo: 'Bank receipt' },
          { accountCode: codeFor(ctx, tx.subsidiaryId, '1100'), debitMinor: 0n, creditMinor: converted, ccy: functional, fxRateE6: 1_000_000n, customerId: inv.customerId, vendorId: undefined, memo: `Settle ${inv.number}` },
        ], source: 'agent', proposalId: p.id, reversalOf: undefined, role });
        ctx.db.bankMatch.insert({ ...base, targetKind: { tag: 'invoice' }, paymentJeId: je.id });
        ctx.db.invoice.id.update({ ...inv, status: { tag: 'paid' } });
      } else if (bill) {
        const je = postEntry(ctx, { subsidiaryId: tx.subsidiaryId, periodId: txPeriod.id, memo: `Payment ${bill.externalRef}: ${tx.description}`, lines: [
          { accountCode: codeFor(ctx, tx.subsidiaryId, '2000'), debitMinor: converted, creditMinor: 0n, ccy: functional, fxRateE6: 1_000_000n, customerId: undefined, vendorId: bill.vendorId, memo: `Settle ${bill.externalRef}` },
          { accountCode: cash, debitMinor: 0n, creditMinor: amt, ccy: txCcy, fxRateE6: rate, customerId: undefined, vendorId: bill.vendorId, memo: 'Bank payment' },
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

/**
 * No identity approves or confirms a Proposal it proposed. Roles hold one identity each, but the CFO can promote a
 * worker to Advisor or CFO, and that identity's own earlier Proposals would otherwise pass the gate on its word alone.
 */
function refuseOwnProposal(ctx: Ctx, p: NonNullable<ReturnType<Ctx['db']['proposal']['id']['find']>>, what: 'approve' | 'confirm') {
  if (p.proposedBy.isEqual(ctx.sender)) {
    throw new SenderError(`Proposal ${p.id} was proposed by this identity (as ${p.proposerRole}); no identity may ${what} its own Proposal. Another ${what === 'approve' ? 'Advisor' : 'CFO'} must decide it.`);
  }
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
  if (!ctx.db.settings.key.find(REPORTING_KEY)) {
    ctx.db.settings.insert({ key: REPORTING_KEY, valueI64: 0n, valueText: DEFAULT_REPORTING_CCY });
    done.push(`reporting currency ${DEFAULT_REPORTING_CCY}`);
  }
  if (!ctx.db.settings.key.find(FEED_KEY)) {
    ctx.db.settings.insert({ key: FEED_KEY, valueI64: 0n, valueText: '' });
    done.push('live feed off');
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

/**
 * The caller's own agent_identity row, if it has one. agent_identity stays private (it maps every identity to a role);
 * this view lets a client see only its own role, so the CFO app can tell whether it holds the seat.
 */
export const myAgentIdentity = spacetimedb.view({ name: 'my_agent_identity', public: true }, t.option(agentIdentity.rowType), ctx => ctx.db.agentIdentity.identity.find(ctx.sender) ?? undefined);

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
    } else if (tag === 'cfo') {
      // The CFO seat is a person's. It is claimed with the one-time secret the database owner armed (claimCfo), or
      // granted by the CFO; never taken by whichever connection asks first.
      throw new SenderError('Claim the CFO seat with the one-time bootstrap secret printed at setup.');
    } else if (tag === 'advisor') {
      // Bootstrap: the first connection to claim advisor gets it. Later claims need a grant.
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
    // Worker agents only. The Advisor rules on Proposals and never authors one, so no Proposal is ever ruled on by the
    // identity that wrote it (approveProposal and cfoConfirm also refuse that outright).
    const role = requireRole(ctx, ['bookkeeper', 'revenue', 'credit', 'consolidation'], 'propose');
    const kinds = ['journal_entry', 'bank_match', 'revenue_schedule', 'credit_decision', 'accrual', 'vendor_block', 'vendor_verify', 'fx_revaluation', 'ic_elimination'];
    if (!kinds.includes(kind)) throw new SenderError(`Unknown proposal kind ${kind}`);
    const allowedKinds: Record<string, string[]> = {
      bookkeeper: ['journal_entry', 'bank_match', 'accrual'],
      revenue: ['journal_entry', 'revenue_schedule'],
      credit: ['journal_entry', 'credit_decision', 'vendor_block', 'vendor_verify'],
      consolidation: ['fx_revaluation', 'ic_elimination'],
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
    const role = requireRole(ctx, ['advisor', 'bookkeeper', 'revenue', 'credit', 'consolidation', 'redteam', 'cfo'], 'post messages');
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
    refuseOwnProposal(ctx, p, 'approve');
    if (p.status.tag !== 'open' && p.status.tag !== 'sent_back') {
      throw new SenderError(`Proposal ${proposalId} is ${p.status.tag}, not open.`);
    }
    if (summaryPlain.trim().length < 10) throw new SenderError('Every ruling needs a plain-English summary.');
    const payloadJson = amendedPayloadJson ?? p.payloadJson;
    const decision = amendedPayloadJson !== undefined ? 'amend' : 'approve';
    // Checked before the materiality split, so the Advisor cannot send an unusable proposal to the CFO.
    validateProposal(ctx, p.kind.tag, payloadJson, p.id);
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

/**
 * Record one row of a Credit Check: the evidence of one product call, with the cascade's facts in summaryJson.facts.
 * The tier and decision on the row are derived here from those facts by the shared tier rules (deriveTier, as of the
 * moment of recording), never taken from the caller, and a check is evidence only about the customer's own guarantor or
 * the vendor's own owner.
 */
export const recordCreditCheck = spacetimedb.reducer(
  {
    subjectKind: t.string(),
    subjectId: t.u64(),
    personaId: t.string(),
    product: t.string(),
    requestId: t.string(),
    summaryJson: t.string(),
  },
  (ctx, a) => {
    // Recording evidence is the Credit & Risk agent's job; the Advisor rules on proposals that cite it.
    const role = requireRole(ctx, ['credit'], 'record credit checks');
    let subject: string;
    let persona: string | undefined;
    if (a.subjectKind === 'customer') {
      const c = ctx.db.customer.id.find(a.subjectId);
      if (!c) throw new SenderError(`Unknown customer ${a.subjectId}`);
      subject = `customer ${c.id} (${c.name})`;
      persona = c.guarantorPersonaId;
      if (a.personaId !== persona) throw new SenderError(`The guarantor of ${subject} is ${persona}; a check on ${a.personaId} is not evidence about them.`);
    } else if (a.subjectKind === 'vendor') {
      const v = ctx.db.vendor.id.find(a.subjectId);
      if (!v) throw new SenderError(`Unknown vendor ${a.subjectId}`);
      subject = `vendor ${v.id} (${v.name})`;
      persona = v.ownerPersonaId;
      if (!persona) throw new SenderError(`${subject} has no owner on file, so there is no one to check.`);
      if (a.personaId !== persona) throw new SenderError(`The owner of ${subject} is ${persona}; a check on ${a.personaId} is not evidence about them.`);
    } else {
      throw new SenderError('subjectKind must be customer or vendor');
    }
    let summary: unknown;
    try {
      summary = JSON.parse(a.summaryJson);
    } catch {
      throw new SenderError('summaryJson is not valid JSON.');
    }
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) throw new SenderError('summaryJson must be the evidence row as a JSON object.');
    let derived: ReturnType<typeof deriveTier>;
    try {
      // Lookback windows run to the moment of recording: the module's clock, never a date the caller picks.
      derived = deriveTier((summary as { facts?: unknown }).facts, new Date(Number(ctx.timestamp.microsSinceUnixEpoch / 1000n)));
    } catch (e) {
      throw new SenderError(`The ${a.product} check on ${subject} cannot be recorded: ${e instanceof Error ? e.message : String(e)}. Record the cascade's facts with each evidence row (summaryJson.facts); the books derive the tier from them.`);
    }
    const row = ctx.db.creditCheck.insert({
      id: 0n,
      subjectKind: { tag: a.subjectKind },
      subjectId: a.subjectId,
      personaId: a.personaId,
      product: a.product,
      requestId: a.requestId,
      summaryJson: a.summaryJson,
      tier: derived.tier,
      decision: derived.decision,
      createdAt: ctx.timestamp,
    });
    // Evidence only: a vendor becomes verified through a ruled vendor_verify proposal, never from a recorded check.
    const why = derived.reasons.map(r => r.code).join(', ') || 'no negative reason';
    audit(ctx, role, 'record_credit_check', 'credit_check', row.id, `${a.subjectKind} ${a.subjectId} ${a.product} → ${derived.tier}/${derived.decision} (derived: ${why})`);
  }
);

export const updateCloseTask = spacetimedb.reducer(
  { taskId: t.u64(), status: t.string(), note: t.string() },
  (ctx, { taskId, status, note }) => {
    const role = requireRole(ctx, ['advisor', 'cfo', 'bookkeeper', 'revenue', 'credit', 'consolidation'], 'update close tasks');
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
    refuseOwnProposal(ctx, p, 'confirm');
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
    // A balance elimination (ic_elimination) posts its next-month reversal the same way.
    const isAutoAccrualReversal = (x: JournalEntryRow) =>
      x.source.tag === 'agent' &&
      x.proposalId != null &&
      x.proposalId === je.proposalId &&
      ['accrual', 'ic_elimination'].includes(ctx.db.proposal.id.find(x.proposalId)?.kind.tag ?? '');
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
  { code: t.string(), name: t.string(), functionalCcy: t.string(), parentCode: t.option(t.string()), isElimination: t.bool() },
  (ctx, { code, name, functionalCcy, parentCode, isElimination }) => {
    const role = requireSeeder(ctx);
    if (ctx.db.subsidiary.code.find(code)) return;
    const parent = parentCode ? ctx.db.subsidiary.code.find(parentCode) : null;
    if (parentCode && !parent) throw new SenderError(`Unknown parent subsidiary ${parentCode}; seed it first.`);
    if (isElimination && !parent) throw new SenderError('An elimination subsidiary sits under the group parent; name its parentCode.');
    const sub = ctx.db.subsidiary.insert({ id: 0n, code, name, functionalCcy: ccyKey(functionalCcy), parentId: parent?.id, isElimination });
    audit(ctx, role, 'seed_subsidiary', 'subsidiary', sub.id, `${code} ${name} (${functionalCcy})${isElimination ? ', elimination company' : ''}`);
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
    assertAccountsOf(ctx, sub.id, lines);
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
    // A reseeded close month would qualify as a feed month (its previous month is locked), so the feed goes off.
    const feedRow = ctx.db.settings.key.find(FEED_KEY);
    if (feedRow) ctx.db.settings.key.update({ ...feedRow, valueI64: 0n });
    // Charter versions and evals, identities and the armed CFO claim survive a reset; the books and the feed log do not.
    const tables: Array<keyof Ctx['db']> = [
      'journalLine', 'journalEntry', 'bankMatch', 'bankTransaction', 'revenueScheduleLine', 'contractItem', 'contract',
      'invoice', 'bill', 'vendor', 'customer', 'periodLock', 'period', 'account', 'fxRate', 'subsidiary',
      'proposal', 'approval', 'agentMessage', 'closeTask', 'creditCheck', 'auditEvent', 'feedEvent',
    ];
    for (const name of tables) {
      const table = ctx.db[name] as any;
      for (const row of [...table.iter()]) {
        const pk = 'id' in row ? 'id' : 'key' in row ? 'key' : 'externalId' in row ? 'externalId' : null;
        if (pk) table[pk].delete(row[pk]);
      }
    }
    audit(ctx, role ?? (isOwner ? 'owner' : 'cfo'), 'reset_demo', 'all', 0n, 'Demo data cleared.');
  }
);

// ---------- CFO seat bootstrap ----------

const BOOTSTRAP_KEY = 'cfo';
const MAX_BOOTSTRAP_TTL_MINUTES = 7 * 24 * 60;

function cfoExists(ctx: Ctx): boolean {
  return [...ctx.db.agentIdentity.iter()].some(r => r.role.tag === 'cfo');
}

function isDatabaseOwner(ctx: Ctx): boolean {
  const owner = ctx.db.settings.key.find(OWNER_KEY)?.valueText;
  return !!owner && owner === ctx.sender.toHexString();
}

function isoOf(ts: Timestamp): string {
  return new Date(Number(ts.microsSinceUnixEpoch / 1000n)).toISOString();
}

/**
 * The database owner (whoever published it; in practice the seed loader through the spacetime CLI) arms a one-time
 * claim for the CFO seat by storing only the SHA-256 of a random secret. The secret itself never reaches the module
 * until someone claims with it.
 */
export const armCfoBootstrap = spacetimedb.reducer(
  { secretSha256: t.string(), ttlMinutes: t.u32() },
  (ctx, { secretSha256, ttlMinutes }) => {
    if (!isDatabaseOwner(ctx)) {
      throw new SenderError('Only the database owner can arm the CFO bootstrap (run `pnpm cfo:bootstrap`, which calls it through the spacetime CLI as the publisher).');
    }
    if (cfoExists(ctx)) throw new SenderError('The CFO seat is already claimed; nothing to arm.');
    const hash = secretSha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new SenderError('secretSha256 must be the 64-character hex SHA-256 of the secret.');
    if (ttlMinutes < 1 || ttlMinutes > MAX_BOOTSTRAP_TTL_MINUTES) throw new SenderError(`ttlMinutes must be between 1 and ${MAX_BOOTSTRAP_TTL_MINUTES} (a week).`);
    const expiresAt = new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(ttlMinutes) * 60_000_000n);
    const row = { key: BOOTSTRAP_KEY, secretSha256: hash, createdAt: ctx.timestamp, expiresAt };
    if (ctx.db.cfoBootstrap.key.find(BOOTSTRAP_KEY)) ctx.db.cfoBootstrap.key.update(row);
    else ctx.db.cfoBootstrap.insert(row);
    audit(ctx, 'owner', 'arm_cfo_bootstrap', 'cfo_bootstrap', 0n, `CFO claim armed until ${isoOf(expiresAt)}.`);
  }
);

/** Claim the CFO seat with the one-time secret. A wrong or expired secret is refused; the claim is single-use. */
export const claimCfo = spacetimedb.reducer(
  { secret: t.string(), displayName: t.string() },
  (ctx, { secret, displayName }) => {
    if (cfoExists(ctx)) throw new SenderError('The CFO seat is already claimed. Ask the CFO for a grant, or reset the database to claim it again.');
    const armed = ctx.db.cfoBootstrap.key.find(BOOTSTRAP_KEY);
    if (!armed) throw new SenderError('No CFO claim is armed for this database. Run `pnpm cfo:bootstrap` for a new claim link.');
    if (armed.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) {
      throw new SenderError(`The CFO claim link expired at ${isoOf(armed.expiresAt)}. Run \`pnpm cfo:bootstrap\` for a new one.`);
    }
    if (sha256HexOfString(secret.trim()) !== armed.secretSha256) throw new SenderError('That is not the claim secret armed for this database.');
    const existing = ctx.db.agentIdentity.identity.find(ctx.sender);
    if (existing && existing.role.tag !== 'ui') {
      throw new SenderError(`This connection is registered as ${existing.role.tag}; claim the CFO seat from a fresh connection.`);
    }
    const name = displayName.trim() || 'CFO';
    const row = { identity: ctx.sender, role: { tag: 'cfo' as const }, displayName: name, registeredAt: ctx.timestamp };
    if (existing) ctx.db.agentIdentity.identity.update(row);
    else ctx.db.agentIdentity.insert(row);
    const roster = ctx.db.agentRoster.role.find('cfo');
    if (roster) ctx.db.agentRoster.role.update({ ...roster, displayName: name, model: 'human', registeredAt: ctx.timestamp });
    else ctx.db.agentRoster.insert({ role: 'cfo', displayName: name, registeredAt: ctx.timestamp, model: 'human' });
    ctx.db.cfoBootstrap.key.delete(BOOTSTRAP_KEY);
    audit(ctx, 'cfo', 'claim_cfo', 'agent_identity', 0n, `${name} claimed the CFO seat with the bootstrap secret.`);
  }
);

// ---------- live feed (bank and invoice rows from the gateway's feeder) ----------

const FeedBankTxArg = t.object('FeedBankTxArg', {
  externalId: t.string(),
  bookedAtMicros: t.i64(),
  amountMinor: t.i64(),
  ccy: t.string(),
  description: t.string(),
  counterparty: t.string(),
});

const FeedInvoiceArg = t.object('FeedInvoiceArg', {
  externalId: t.string(),
  customerId: t.u64(),
  contractCode: t.option(t.string()),
  number: t.string(),
  issuedAtMicros: t.i64(),
  dueAtMicros: t.i64(),
  amountMinor: t.i64(),
});

/** The UTC calendar month (YYYY-MM) of a timestamp in microseconds, without relying on the runtime's Date. */
function ymOfMicros(micros: bigint): string {
  let days = micros / MICROS_PER_DAY;
  if (micros < 0n && micros % MICROS_PER_DAY !== 0n) days -= 1n;
  // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
  const z = Number(days) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

function feedEnabled(ctx: Ctx): boolean {
  return (ctx.db.settings.key.find(FEED_KEY)?.valueI64 ?? 0n) === 1n;
}

/** The feed may book only as the feed role, while the CFO has it switched on. */
function requireFeed(ctx: Ctx) {
  requireRole(ctx, ['feed'], 'ingest feed rows');
  if (!feedEnabled(ctx)) throw new SenderError('The live feed is off; the CFO turns it on in Settings.');
}

/**
 * The feed books only into an open month whose previous month exists and was locked by the CFO (a seeded lock does
 * not count, so on fresh demo data the close month is never a feed month): October once the CFO locks September. It
 * stops once the month's own close has started (any of its close tasks has left todo; a Proposal filed against a close
 * task moves it to in progress), and it never books into the first month of the books.
 */
function feedPeriod(ctx: Ctx, ym: string, what: string) {
  const p = ctx.db.period.ym.find(ym);
  if (!p) throw new SenderError(`${what}: the books have no ${ym} period.`);
  if (p.status.tag !== 'open' || periodLocked(ctx, p.id)) throw new SenderError(`${what}: ${ym} is ${p.status.tag}; the feed books only into the open month.`);
  const prevYm = ymAdd(ym, -1);
  const prev = ctx.db.period.ym.find(prevYm);
  if (!prev) throw new SenderError(`${what}: the books have no ${prevYm} period before ${ym}; the feed runs only in the first open month after a locked month.`);
  const lock = ctx.db.periodLock.periodId.find(prev.id);
  if (!lock || !periodLocked(ctx, prev.id)) {
    throw new SenderError(`${what}: ${prev.ym} is not locked yet; the feed runs only in the first open month after a locked month.`);
  }
  if (lock.lockedByRole !== 'cfo') {
    throw new SenderError(`${what}: ${prev.ym} was locked by the ${lock.lockedByRole === 'seed' ? 'seed data' : lock.lockedByRole}, not closed by the CFO; the feed starts only in the month after one the CFO locked.`);
  }
  const started = [...ctx.db.closeTask.periodId.filter(p.id)].find(t => t.status.tag !== 'todo');
  if (started) {
    throw new SenderError(`${what}: the ${ym} close has started (close task "${started.title}" is ${started.status.tag.replace('_', ' ')}); the feed stops once a month's close opens.`);
  }
  return p;
}

function feedExternalId(raw: string, what: string): string {
  const id = raw.trim();
  if (id === '' || id.length > 200) throw new SenderError(`${what}: externalId must be 1 to 200 characters.`);
  return id;
}

export const setFeedEnabled = spacetimedb.reducer(
  { enabled: t.bool() },
  (ctx, { enabled }) => {
    requireRole(ctx, ['cfo'], 'switch the live feed');
    const row = ctx.db.settings.key.find(FEED_KEY);
    const v = enabled ? 1n : 0n;
    if (row) ctx.db.settings.key.update({ ...row, valueI64: v });
    else ctx.db.settings.insert({ key: FEED_KEY, valueI64: v, valueText: '' });
    audit(ctx, 'cfo', 'set_feed_enabled', 'settings', 0n, enabled ? 'The CFO turned the live feed on.' : 'The CFO turned the live feed off.');
  }
);

export const ingestBankTransactions = spacetimedb.reducer(
  { subsidiaryCode: t.string(), txs: t.array(FeedBankTxArg) },
  (ctx, { subsidiaryCode, txs }) => {
    requireFeed(ctx);
    const sub = ctx.db.subsidiary.code.find(subsidiaryCode);
    if (!sub) throw new SenderError(`Unknown subsidiary ${subsidiaryCode}`);
    if (sub.isElimination) throw new SenderError(`${sub.code} is the elimination company; it has no bank account.`);
    let added = 0;
    let skipped = 0;
    const yms = new Set<string>();
    for (const x of txs) {
      const externalId = feedExternalId(x.externalId, 'Bank line');
      if (ctx.db.feedEvent.externalId.find(externalId)) {
        skipped++;
        continue;
      }
      const what = `Bank line ${externalId}`;
      if (x.amountMinor === 0n) throw new SenderError(`${what}: the amount cannot be zero.`);
      const ccy = ccyKey(x.ccy);
      if (!/^[A-Z]{3}$/.test(ccy)) throw new SenderError(`${what}: currency must be a three-letter code; got ${JSON.stringify(x.ccy)}.`);
      if (x.description.trim() === '') throw new SenderError(`${what}: a bank line needs its description.`);
      const ym = ymOfMicros(x.bookedAtMicros);
      feedPeriod(ctx, ym, what);
      const tx = ctx.db.bankTransaction.insert({
        id: 0n,
        subsidiaryId: sub.id,
        bookedAt: new Timestamp(x.bookedAtMicros),
        ym,
        amountMinor: x.amountMinor,
        ccy,
        description: x.description,
        counterparty: x.counterparty,
        matched: false,
      });
      ctx.db.feedEvent.insert({ externalId, kind: { tag: 'bank_tx' }, rowId: tx.id, subsidiaryId: sub.id, ym, ingestedAt: ctx.timestamp });
      added++;
      yms.add(ym);
    }
    if (added > 0 || skipped > 0) {
      audit(ctx, 'feed', 'ingest_bank_transactions', 'bank_transaction', sub.id, `${added} bank line(s) booked for ${sub.code}${yms.size ? ` in ${[...yms].join(', ')}` : ''}; ${skipped} already ingested and skipped.`);
    }
  }
);

export const ingestInvoices = spacetimedb.reducer(
  { invoices: t.array(FeedInvoiceArg) },
  (ctx, { invoices }) => {
    requireFeed(ctx);
    let added = 0;
    let skipped = 0;
    const numbers: string[] = [];
    for (const a of invoices) {
      const externalId = feedExternalId(a.externalId, 'Invoice');
      const number = a.number.trim();
      if (ctx.db.feedEvent.externalId.find(externalId) || (number !== '' && ctx.db.invoice.number.find(number))) {
        skipped++;
        continue;
      }
      const what = `Invoice ${number || externalId}`;
      if (number === '') throw new SenderError(`${what}: an invoice needs its number.`);
      const customer = ctx.db.customer.id.find(a.customerId);
      if (!customer) throw new SenderError(`${what}: unknown customer ${a.customerId}.`);
      let contractId: bigint | undefined;
      if (a.contractCode) {
        const contract = ctx.db.contract.code.find(a.contractCode);
        if (!contract) throw new SenderError(`${what}: unknown contract ${a.contractCode}.`);
        if (contract.customerId !== customer.id) throw new SenderError(`${what}: contract ${a.contractCode} belongs to another customer.`);
        contractId = contract.id;
      }
      if (a.amountMinor <= 0n) throw new SenderError(`${what}: the amount must be above zero.`);
      if (a.dueAtMicros < a.issuedAtMicros) throw new SenderError(`${what}: it cannot fall due before it is issued.`);
      const ym = ymOfMicros(a.issuedAtMicros);
      feedPeriod(ctx, ym, what);
      const inv = ctx.db.invoice.insert({
        id: 0n,
        customerId: customer.id,
        contractId,
        number,
        ym,
        issuedAt: new Timestamp(a.issuedAtMicros),
        dueAt: new Timestamp(a.dueAtMicros),
        amountMinor: a.amountMinor,
        status: { tag: 'open' },
      });
      ctx.db.feedEvent.insert({ externalId, kind: { tag: 'invoice' }, rowId: inv.id, subsidiaryId: customer.subsidiaryId, ym, ingestedAt: ctx.timestamp });
      added++;
      numbers.push(number);
    }
    if (added > 0 || skipped > 0) {
      audit(ctx, 'feed', 'ingest_invoices', 'invoice', 0n, `${added} invoice(s) booked${numbers.length ? `: ${numbers.join(', ')}` : ''}; ${skipped} already ingested and skipped.`);
    }
  }
);

// ---------- charters (versions, evals, publishing) ----------

const CHARTER_ROLES = ['advisor', 'bookkeeper', 'revenue', 'credit', 'redteam', 'consolidation'];
const MAX_CHARTER_BYTES = 20 * 1024;
const MAX_MAPPING_BYTES = 128 * 1024;
const MAX_EVAL_RESULTS_BYTES = 512 * 1024;
const CHARTER_MODES = ['dry_run', 'snapshot'];

type CharterRow = NonNullable<ReturnType<Ctx['db']['charterVersion']['id']['find']>>;

function charterRole(role: string): string {
  const r = role.trim().toLowerCase();
  if (!CHARTER_ROLES.includes(r)) throw new SenderError(`Charters exist for ${CHARTER_ROLES.join(', ')}; not for ${JSON.stringify(role)}.`);
  return r;
}

function charterById(ctx: Ctx, id: bigint): CharterRow {
  const v = ctx.db.charterVersion.id.find(id);
  if (!v) throw new SenderError(`Unknown charter version ${id}`);
  return v;
}

function liveCharter(ctx: Ctx, role: string): CharterRow | undefined {
  return [...ctx.db.charterVersion.role.filter(role)].find(v => v.status.tag === 'live');
}

/** Save an edited charter as a new draft version. Drafts change nothing until the CFO publishes one that passed its eval. */
export const saveCharterDraft = spacetimedb.reducer(
  { role: t.string(), bodyMd: t.string(), mappingJson: t.string(), summaryPlain: t.string(), basedOnVersionId: t.option(t.u64()) },
  (ctx, { role, bodyMd, mappingJson, summaryPlain, basedOnVersionId }) => {
    const author = requireRole(ctx, ['cfo', 'ui'], 'save charter drafts');
    const r = charterRole(role);
    if (bodyMd.trim() === '') throw new SenderError('A charter needs its text.');
    const bytes = utf8(bodyMd).length;
    if (bytes > MAX_CHARTER_BYTES) throw new SenderError(`A charter is at most 20 KB; this one is ${Math.ceil(bytes / 1024)} KB.`);
    if (utf8(mappingJson).length > MAX_MAPPING_BYTES) throw new SenderError('The line mapping is at most 128 KB.');
    let mapping: unknown;
    try {
      mapping = JSON.parse(mappingJson);
    } catch {
      throw new SenderError('mappingJson is not valid JSON.');
    }
    if (!Array.isArray(mapping)) throw new SenderError('mappingJson must be a JSON list of line mappings.');
    if (mapping.some(m => m === null || typeof m !== 'object' || Array.isArray(m))) throw new SenderError('Every entry of mappingJson must be an object.');
    if (summaryPlain.trim().length < 10) throw new SenderError('Every charter draft needs a plain-English summary of the change.');
    if (basedOnVersionId !== undefined) {
      const base = charterById(ctx, basedOnVersionId);
      if (base.role !== r) throw new SenderError(`Charter version ${basedOnVersionId} is a ${base.role} charter, not ${r}.`);
    }
    const version = [...ctx.db.charterVersion.role.filter(r)].reduce((a, v) => (v.version > a ? v.version : a), 0) + 1;
    const row = ctx.db.charterVersion.insert({
      id: 0n,
      role: r,
      version,
      status: { tag: 'draft' },
      bodyMd,
      mappingJson,
      summaryPlain: summaryPlain.trim(),
      basedOnVersionId,
      authoredBy: ctx.sender,
      authoredByRole: author,
      createdAt: ctx.timestamp,
      publishedBy: undefined,
      publishedAt: undefined,
    });
    audit(ctx, author, 'save_charter_draft', 'charter_version', row.id, `${r} charter draft v${version}: ${summaryPlain.trim()}`);
  }
);

/** The gateway's eval runner records each run's result; publishing needs the latest run of that version to pass. */
export const recordCharterEval = spacetimedb.reducer(
  { charterVersionId: t.u64(), passed: t.bool(), mode: t.string(), resultsJson: t.string(), summaryPlain: t.string() },
  (ctx, { charterVersionId, passed, mode, resultsJson, summaryPlain }) => {
    requireRole(ctx, ['advisor'], 'record charter evals');
    const v = charterById(ctx, charterVersionId);
    if (v.status.tag === 'live') throw new SenderError(`Version ${v.version} of the ${v.role} charter is already live; evaluate a draft.`);
    if (!CHARTER_MODES.includes(mode)) throw new SenderError(`mode must be ${CHARTER_MODES.join(' or ')}; got ${JSON.stringify(mode)}.`);
    if (utf8(resultsJson).length > MAX_EVAL_RESULTS_BYTES) throw new SenderError('Eval results are at most 512 KB.');
    try {
      JSON.parse(resultsJson);
    } catch {
      throw new SenderError('resultsJson is not valid JSON.');
    }
    if (summaryPlain.trim().length < 10) throw new SenderError('Every eval result needs a plain-English summary.');
    const row = ctx.db.charterEval.insert({
      id: 0n,
      charterVersionId,
      passed,
      mode,
      resultsJson,
      summaryPlain: summaryPlain.trim(),
      ranBy: ctx.sender,
      ranByRole: 'advisor',
      ranAt: ctx.timestamp,
    });
    audit(ctx, 'advisor', 'record_charter_eval', 'charter_eval', row.id, `${v.role} charter v${v.version} ${mode} eval ${passed ? 'passed' : 'failed'}: ${summaryPlain.trim()}`);
  }
);

/** Publish a charter version as the role's live charter. CFO only, and only when its latest eval was a passing dry run. */
export const publishCharter = spacetimedb.reducer(
  { charterVersionId: t.u64(), notePlain: t.string() },
  (ctx, { charterVersionId, notePlain }) => {
    requireRole(ctx, ['cfo'], 'publish charters');
    const v = charterById(ctx, charterVersionId);
    if (v.status.tag === 'live') throw new SenderError(`Version ${v.version} of the ${v.role} charter is already live.`);
    const evals = [...ctx.db.charterEval.charterVersionId.filter(v.id)];
    const latest = evals.reduce<(typeof evals)[number] | undefined>((a, b) => {
      if (!a) return b;
      const at = a.ranAt.microsSinceUnixEpoch;
      const bt = b.ranAt.microsSinceUnixEpoch;
      return bt > at || (bt === at && b.id > a.id) ? b : a;
    }, undefined);
    if (!latest) throw new SenderError(`Run an eval of version ${v.version} of the ${v.role} charter first; a charter publishes only after its latest eval passes.`);
    if (!latest.passed) throw new SenderError(`The latest eval of version ${v.version} of the ${v.role} charter failed: ${latest.summaryPlain}`);
    // A snapshot run only replays the recorded ledger; publishing needs the full close the draft would actually run.
    if (latest.mode !== 'dry_run') {
      throw new SenderError(`The latest eval of version ${v.version} of the ${v.role} charter was a ${latest.mode} run; a charter publishes only after a passing dry run (a full close on a scratch database).`);
    }
    const prior = liveCharter(ctx, v.role);
    if (prior) ctx.db.charterVersion.id.update({ ...prior, status: { tag: 'retired' } });
    ctx.db.charterVersion.id.update({ ...v, status: { tag: 'live' }, publishedBy: ctx.sender, publishedAt: ctx.timestamp });
    const note = notePlain.trim();
    const replaced = prior ? `version ${prior.version}` : 'the built-in charter';
    postMessage(
      ctx,
      'cfo',
      `charter:${v.role}`,
      'statement',
      `Published version ${v.version} of the ${v.role} charter, replacing ${replaced}${note ? `: ${note}` : '.'}`,
      `The CFO published version ${v.version} of the ${v.role} charter: ${note || v.summaryPlain}`,
      undefined
    );
    audit(ctx, 'cfo', 'publish_charter', 'charter_version', v.id, `${v.role} v${v.version} live (replaces ${replaced}; ${latest.mode} eval ${latest.id} passed)${note ? `: ${note}` : ''}`);
  }
);

/** Retire a role's live charter; the shipped built-in charter (version 0) applies again. CFO only. */
export const retireLiveCharter = spacetimedb.reducer(
  { role: t.string(), notePlain: t.string() },
  (ctx, { role, notePlain }) => {
    requireRole(ctx, ['cfo'], 'retire charters');
    const r = charterRole(role);
    const live = liveCharter(ctx, r);
    if (!live) throw new SenderError(`The ${r} has no published charter; the built-in charter already applies.`);
    ctx.db.charterVersion.id.update({ ...live, status: { tag: 'retired' } });
    const note = notePlain.trim();
    postMessage(
      ctx,
      'cfo',
      `charter:${r}`,
      'statement',
      `Retired version ${live.version} of the ${r} charter; the built-in charter applies again${note ? `: ${note}` : '.'}`,
      `The CFO restored the built-in ${r} charter${note ? `: ${note}` : '.'}`,
      undefined
    );
    audit(ctx, 'cfo', 'retire_live_charter', 'charter_version', live.id, `${r} v${live.version} retired; built-in applies${note ? `: ${note}` : ''}`);
  }
);

// Silence unused-import checks for enums referenced only in table definitions.
void ItemKind;
