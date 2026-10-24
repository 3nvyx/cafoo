import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import spacetimedb, { ContractItemArg, ItemKind, LineArg, overdueSweep, Plan, Role } from './tables';

export { default } from './tables';

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type RoleTag = 'advisor' | 'bookkeeper' | 'revenue' | 'credit' | 'redteam' | 'cfo' | 'ui';

const MATERIALITY_KEY = 'materiality_threshold_minor';
const DEFAULT_MATERIALITY_MINOR = 1_000_000n; // $10,000.00
const MICROS_PER_DAY = 86_400_000_000n;

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

function assertPeriodOpen(ctx: Ctx, periodId: bigint) {
  const p = periodById(ctx, periodId);
  if (p.status.tag === 'closed' || ctx.db.periodLock.periodId.find(periodId)) {
    throw new SenderError(`Period ${p.ym} is locked. Reopen it before posting.`);
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
  /** Flip unrecognized revenue schedule lines for this month to recognized, linked to the new entry. */
  recognizeScheduleYm?: string;
};
type BankMatchPayload = { matches: { bankTxId: string; targetKind: 'invoice' | 'bill' | 'je'; targetId: string; scoreBp: number }[] };
type RevenueSchedulePayload = { lines: { contractItemId: string; customerId: string; ym: string; amountMinor: string }[] };
type CreditDecisionPayload = { customerId: string; tier: string; paymentTermsDays: number; allowanceMinor?: string; creditCheckIds?: string[] };
type VendorBlockPayload = { vendorId: string; reasonPlain: string };

function parseLines(lines: JsonLine[]): LineIn[] {
  return lines.map(l => ({
    accountCode: l.accountCode,
    debitMinor: BigInt(l.debitMinor ?? '0'),
    creditMinor: BigInt(l.creditMinor ?? '0'),
    ccy: l.ccy ?? 'USD',
    fxRateE6: BigInt(l.fxRateE6 ?? '1000000'),
    customerId: l.customerId ? BigInt(l.customerId) : undefined,
    vendorId: l.vendorId ? BigInt(l.vendorId) : undefined,
    memo: l.memo ?? '',
  }));
}

function parseJson<T>(json: string, kind: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new SenderError(`Proposal payload for ${kind} is not valid JSON.`);
  }
}

/** Amount a proposal really moves, derived from its payload so a proposer cannot understate it. Bank matches and credit decisions move no balances by themselves. */
function computedAmount(kind: string, payloadJson: string): bigint {
  try {
    if (kind === 'journal_entry' || kind === 'accrual') {
      const payload = JSON.parse(payloadJson) as JournalPayload;
      let dr = 0n;
      for (const l of payload.lines ?? []) {
        const rate = BigInt(l.fxRateE6 ?? '1000000') || 1_000_000n;
        dr += (BigInt(l.debitMinor ?? '0') * rate) / 1_000_000n;
      }
      return dr;
    }
    // A revenue schedule is a plan: it moves no balances until a recognition entry is proposed and ruled on.
  } catch {
    /* fall through: a malformed payload fails later in applyProposal */
  }
  return 0n;
}

function applyProposal(ctx: Ctx, p: NonNullable<ReturnType<Ctx['db']['proposal']['id']['find']>>, payloadJson: string, role: string) {
  const kind = p.kind.tag;
  if (kind === 'journal_entry' || kind === 'accrual') {
    const payload = parseJson<JournalPayload>(payloadJson, kind);
    const period = periodByYm(ctx, payload.periodYm);
    const je = postEntry(ctx, {
      subsidiaryId: BigInt(payload.subsidiaryId),
      periodId: period.id,
      memo: payload.memo,
      lines: parseLines(payload.lines),
      source: 'agent',
      proposalId: p.id,
      reversalOf: undefined,
      role,
    });
    for (const idStr of payload.bankTxIds ?? []) {
      const txId = BigInt(idStr);
      const tx = ctx.db.bankTransaction.id.find(txId);
      if (!tx || ctx.db.bankMatch.bankTxId.find(txId)) continue;
      ctx.db.bankMatch.insert({ id: 0n, bankTxId: txId, targetKind: { tag: 'je' }, targetId: je.id, scoreBp: 10000, proposalId: p.id });
      ctx.db.bankTransaction.id.update({ ...tx, matched: true });
    }
    if (payload.recognizeScheduleYm) {
      for (const sl of ctx.db.revenueScheduleLine.iter()) {
        if (!sl.recognized && sl.ym <= payload.recognizeScheduleYm) ctx.db.revenueScheduleLine.id.update({ ...sl, recognized: true, jeId: je.id });
      }
    }
    if (kind === 'accrual' && payload.reversesInYm) {
      // An accrual reverses automatically in the following month so the bill, when it posts, is not double counted.
      const next = periodByYm(ctx, payload.reversesInYm);
      const lines = parseLines(payload.lines).map(l => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor, memo: `Reverse accrual: ${l.memo}` }));
      postEntry(ctx, {
        subsidiaryId: BigInt(payload.subsidiaryId),
        periodId: next.id,
        memo: `Reversal of accrual: ${payload.memo}`,
        lines,
        source: 'agent',
        proposalId: p.id,
        reversalOf: je.id,
        role,
      });
    }
    return;
  }
  if (kind === 'bank_match') {
    const payload = parseJson<BankMatchPayload>(payloadJson, kind);
    for (const m of payload.matches) {
      const txId = BigInt(m.bankTxId);
      const tx = ctx.db.bankTransaction.id.find(txId);
      if (!tx) throw new SenderError(`Unknown bank transaction ${m.bankTxId}`);
      if (ctx.db.bankMatch.bankTxId.find(txId)) continue;
      const targetId = BigInt(m.targetId);
      ctx.db.bankMatch.insert({
        id: 0n,
        bankTxId: txId,
        targetKind: { tag: m.targetKind },
        targetId,
        scoreBp: m.scoreBp,
        proposalId: p.id,
      });
      ctx.db.bankTransaction.id.update({ ...tx, matched: true });
      const amt = tx.amountMinor < 0n ? -tx.amountMinor : tx.amountMinor;
      const period = ctx.db.period.ym.find(tx.ym);
      if (!period) throw new SenderError(`No period ${tx.ym} for bank transaction ${txId}`);
      if (m.targetKind === 'invoice') {
        const inv = ctx.db.invoice.id.find(targetId);
        if (!inv) throw new SenderError(`Unknown invoice ${targetId}`);
        ctx.db.invoice.id.update({ ...inv, status: { tag: 'paid' } });
        postEntry(ctx, { subsidiaryId: tx.subsidiaryId, periodId: period.id, memo: `Payment received ${inv.number}: ${tx.description}`, lines: [
          { accountCode: '1000', debitMinor: amt, creditMinor: 0n, ccy: tx.ccy, fxRateE6: 1_000_000n, customerId: inv.customerId, vendorId: undefined, memo: 'Bank receipt' },
          { accountCode: '1100', debitMinor: 0n, creditMinor: amt, ccy: tx.ccy, fxRateE6: 1_000_000n, customerId: inv.customerId, vendorId: undefined, memo: `Settle ${inv.number}` },
        ], source: 'agent', proposalId: p.id, reversalOf: undefined, role });
      } else if (m.targetKind === 'bill') {
        const b = ctx.db.bill.id.find(targetId);
        if (!b) throw new SenderError(`Unknown bill ${targetId}`);
        ctx.db.bill.id.update({ ...b, status: { tag: 'paid' } });
        postEntry(ctx, { subsidiaryId: tx.subsidiaryId, periodId: period.id, memo: `Payment ${b.externalRef}: ${tx.description}`, lines: [
          { accountCode: '2000', debitMinor: amt, creditMinor: 0n, ccy: tx.ccy, fxRateE6: 1_000_000n, customerId: undefined, vendorId: b.vendorId, memo: `Settle ${b.externalRef}` },
          { accountCode: '1000', debitMinor: 0n, creditMinor: amt, ccy: tx.ccy, fxRateE6: 1_000_000n, customerId: undefined, vendorId: b.vendorId, memo: 'Bank payment' },
        ], source: 'agent', proposalId: p.id, reversalOf: undefined, role });
      }
    }
    return;
  }
  if (kind === 'revenue_schedule') {
    const payload = parseJson<RevenueSchedulePayload>(payloadJson, kind);
    for (const l of payload.lines) {
      ctx.db.revenueScheduleLine.insert({
        id: 0n,
        contractItemId: BigInt(l.contractItemId),
        customerId: BigInt(l.customerId),
        ym: l.ym,
        amountMinor: BigInt(l.amountMinor),
        recognized: false,
        jeId: undefined,
      });
    }
    return;
  }
  if (kind === 'credit_decision') {
    const payload = parseJson<CreditDecisionPayload>(payloadJson, kind);
    const c = ctx.db.customer.id.find(BigInt(payload.customerId));
    if (!c) throw new SenderError(`Unknown customer ${payload.customerId}`);
    ctx.db.customer.id.update({
      ...c,
      creditTier: payload.tier,
      paymentTermsDays: payload.paymentTermsDays,
      allowanceMinor: payload.allowanceMinor ? BigInt(payload.allowanceMinor) : c.allowanceMinor,
    });
    return;
  }
  if (kind === 'vendor_block') {
    const payload = parseJson<VendorBlockPayload>(payloadJson, kind);
    const v = ctx.db.vendor.id.find(BigInt(payload.vendorId));
    if (!v) throw new SenderError(`Unknown vendor ${payload.vendorId}`);
    ctx.db.vendor.id.update({ ...v, verification: { tag: 'blocked' }, verificationNote: payload.reasonPlain });
    for (const b of ctx.db.bill.vendorId.filter(v.id)) {
      if (b.status.tag === 'open') ctx.db.bill.id.update({ ...b, status: { tag: 'overdue' } });
    }
    return;
  }
  throw new SenderError(`Unknown proposal kind ${kind}`);
}

/**
 * Undo the non-ledger side effects an entry produced when it posted, so the next close can redo them:
 * bank matches that point at the entry (or whose payment entry it is) go back to unmatched, the invoice or bill
 * they settled goes back to unpaid once no other match still settles it, and revenue schedule lines it recognized
 * go back to unrecognized.
 */
function unwindEntrySideEffects(ctx: Ctx, je: NonNullable<ReturnType<Ctx['db']['journalEntry']['id']['find']>>) {
  let unmatched = 0;
  let reopened = 0;
  let unrecognized = 0;
  // A bank_match proposal posts exactly one payment entry per invoice/bill match, so an entry owns at most one.
  let paymentMatchFound = false;
  const settled: { kind: 'invoice' | 'bill'; id: bigint }[] = [];
  const matches = [...ctx.db.bankMatch.iter()];
  for (const m of matches) {
    const tx = ctx.db.bankTransaction.id.find(m.bankTxId);
    let owned = false;
    if (m.targetKind.tag === 'je') {
      // Journal proposals with bankTxIds, or a bank_match proposal that pointed straight at this entry.
      owned = m.targetId === je.id;
    } else if (!paymentMatchFound && tx && je.proposalId !== undefined && m.proposalId === je.proposalId) {
      // The payment entry's memo is built from the target and the bank line, its total is the bank amount, and it
      // posts in the bank line's month. Two bank lines with the same description can settle the same invoice or bill
      // (a duplicate payment), so all three must agree, and only the first such match is taken.
      const sameAmount = je.totalMinor === abs(tx.amountMinor);
      const samePeriod = ctx.db.period.ym.find(tx.ym)?.id === je.periodId;
      if (sameAmount && samePeriod) {
        // Bill references are not unique across vendors, so the party on the entry's lines must match too.
        const lines = [...ctx.db.journalLine.jeId.filter(je.id)];
        if (m.targetKind.tag === 'invoice') {
          const inv = ctx.db.invoice.id.find(m.targetId);
          owned = !!inv && je.memo === `Payment received ${inv.number}: ${tx.description}` && lines.every(l => l.customerId === inv.customerId);
        } else {
          const b = ctx.db.bill.id.find(m.targetId);
          owned = !!b && je.memo === `Payment ${b.externalRef}: ${tx.description}` && lines.every(l => l.vendorId === b.vendorId);
        }
        if (owned) {
          paymentMatchFound = true;
          settled.push({ kind: m.targetKind.tag === 'invoice' ? 'invoice' : 'bill', id: m.targetId });
        }
      }
    }
    if (!owned) continue;
    ctx.db.bankMatch.id.delete(m.id);
    if (tx && tx.matched) ctx.db.bankTransaction.id.update({ ...tx, matched: false });
    unmatched++;
  }
  // Reopen a settled invoice or bill only when no remaining bank match still pays it.
  for (const s of settled) {
    const stillPaid = [...ctx.db.bankMatch.iter()].some(x => x.targetKind.tag === s.kind && x.targetId === s.id);
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
  const recognized = [...ctx.db.revenueScheduleLine.iter()].filter(sl => sl.jeId === je.id);
  for (const sl of recognized) {
    ctx.db.revenueScheduleLine.id.update({ ...sl, recognized: false, jeId: undefined });
    unrecognized++;
  }
  return { unmatched, reopened, unrecognized };
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
    const kinds = ['journal_entry', 'bank_match', 'revenue_schedule', 'credit_decision', 'accrual', 'vendor_block'];
    if (!kinds.includes(kind)) throw new SenderError(`Unknown proposal kind ${kind}`);
    const allowedKinds: Record<string, string[]> = {
      bookkeeper: ['journal_entry', 'bank_match', 'accrual'],
      revenue: ['journal_entry', 'revenue_schedule'],
      credit: ['journal_entry', 'credit_decision', 'vendor_block'],
      advisor: kinds,
    };
    if (!allowedKinds[role]?.includes(kind)) throw new SenderError(`The ${role} does not propose ${kind}.`);
    if (summaryPlain.trim().length < 10) throw new SenderError('Every proposal needs a plain-English summary.');
    const period = periodYm ? ctx.db.period.ym.find(periodYm) : null;
    const p = ctx.db.proposal.insert({
      id: 0n,
      kind: { tag: kind as any },
      payloadJson,
      rationale,
      summaryPlain,
      amountMinor: abs(amountMinor),
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
    const computed = computedAmount(p.kind.tag, payloadJson);
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
    const role = requireRole(ctx, ['credit', 'advisor'], 'record credit checks');
    if (a.subjectKind !== 'customer' && a.subjectKind !== 'vendor') throw new SenderError('subjectKind must be customer or vendor');
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
    audit(ctx, role, 'record_credit_check', 'credit_check', row.id, `${a.subjectKind} ${a.subjectId} ${a.product} → ${a.tier}`);
    // A clean owner check (approve at tier A or B) verifies the vendor so later closes skip it. Blocking still needs a
    // ruled vendor_block proposal, and a blocked vendor is never flipped back to verified here.
    if (a.subjectKind === 'vendor' && a.decision.toUpperCase() === 'APPROVE' && (a.tier === 'A' || a.tier === 'B')) {
      const v = ctx.db.vendor.id.find(a.subjectId);
      if (v && v.verification.tag === 'unverified') {
        ctx.db.vendor.id.update({ ...v, verification: { tag: 'verified' }, verificationNote: `Owner check passed (tier ${a.tier}, request ${a.requestId || 'n/a'}).` });
        audit(ctx, role, 'verify_vendor', 'vendor', v.id, `Owner check passed at tier ${a.tier}`);
      }
    }
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
    postMessage(ctx, 'cfo', p.threadId, 'statement', note || 'Confirmed.', 'The CFO confirmed this.', proposalId);
    audit(ctx, 'cfo', 'cfo_confirm', 'proposal', proposalId, note);
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

export const cfoReverse = spacetimedb.reducer(
  { jeId: t.u64(), reasonPlain: t.string() },
  (ctx, { jeId, reasonPlain }) => {
    requireRole(ctx, ['cfo'], 'reverse entries');
    const je = ctx.db.journalEntry.id.find(jeId);
    if (!je) throw new SenderError(`Unknown journal entry ${jeId}`);
    // Undoing a CFO reversal would bring an entry back without redoing its side effects; post a new entry instead.
    if (je.source.tag === 'manual' && je.reversalOf != null) throw new SenderError(`Entry ${jeId} is itself a reversal; post a new entry instead of reversing it.`);
    // An approved accrual posts its own next-month reversal: source agent, the accrual's proposal, reversalOf the
    // accrual. Every other reversal (the CFO's) is posted manually with no proposal, so only those block a reversal.
    const isAutoAccrualReversal = (x: NonNullable<typeof je>) =>
      x.source.tag === 'agent' &&
      x.proposalId != null &&
      x.proposalId === je.proposalId &&
      ctx.db.proposal.id.find(x.proposalId)?.kind.tag === 'accrual';
    const reversals = [...ctx.db.journalEntry.iter()].filter(x => x.reversalOf === jeId);
    if (reversals.some(x => !isAutoAccrualReversal(x))) throw new SenderError(`Entry ${jeId} was already reversed.`);
    // Reversing an accrual must cancel it in both months: the accrual itself, and its automatic reversal in the
    // next month (unless the CFO already reversed that one directly). Otherwise the next month keeps a credit
    // for an accrual that no longer exists.
    const autoReversals = reversals.filter(r => ![...ctx.db.journalEntry.iter()].some(x => x.reversalOf === r.id));
    for (const r of autoReversals) {
      const rp = periodById(ctx, r.periodId);
      if (rp.status.tag === 'closed' || ctx.db.periodLock.periodId.find(rp.id)) {
        throw new SenderError(
          `Entry ${jeId} is an accrual whose automatic reversal (entry ${r.id}) is in locked period ${rp.ym}. Unlock ${rp.ym} first, then reverse the accrual; both months are reversed together.`
        );
      }
    }
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
    const rev = postEntry(ctx, {
      subsidiaryId: je.subsidiaryId,
      periodId: je.periodId,
      memo: `Reversal of entry ${jeId}: ${reasonPlain}`,
      lines: flip(jeId),
      source: 'manual',
      proposalId: undefined,
      reversalOf: jeId,
      role: 'cfo',
    });
    const cancelled: bigint[] = [];
    for (const r of autoReversals) {
      postEntry(ctx, {
        subsidiaryId: r.subsidiaryId,
        periodId: r.periodId,
        memo: `Reversal of entry ${r.id} (automatic reversal of accrual ${jeId}): ${reasonPlain}`,
        lines: flip(r.id),
        source: 'manual',
        proposalId: undefined,
        reversalOf: r.id,
        role: 'cfo',
      });
      cancelled.push(r.id);
    }
    const undone = unwindEntrySideEffects(ctx, je);
    const autoNote = cancelled.length > 0 ? `; automatic accrual reversal(s) ${cancelled.join(', ')} also reversed` : '';
    audit(
      ctx,
      'cfo',
      'cfo_reverse',
      'journal_entry',
      rev.id,
      `${reasonPlain} (reverses entry ${jeId}; ${undone.unmatched} bank match(es) undone, ${undone.reopened} invoice/bill(s) reopened, ${undone.unrecognized} schedule line(s) unrecognized${autoNote})`
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
    const sub = ctx.db.subsidiary.insert({ id: 0n, code, name, functionalCcy, parentId: parent?.id });
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
    audit(ctx, role, 'seed_accounts', 'account', sub.id, `${added} of ${accounts.length} account(s) added to ${subsidiaryCode}`);
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
    audit(ctx, role, 'seed_periods', 'period', sub.id, `${added.length} period(s) added to ${subsidiaryCode}: ${added.join(', ')}; locked: ${closedYms.filter(y => added.includes(y)).join(', ') || 'none'}`);
  }
);

export const seedFxRate = spacetimedb.reducer(
  { fromCcy: t.string(), toCcy: t.string(), ym: t.string(), rateE6: t.i64(), kind: t.string() },
  (ctx, a) => {
    const role = requireSeeder(ctx);
    const row = ctx.db.fxRate.insert({ id: 0n, fromCcy: a.fromCcy, toCcy: a.toCcy, ym: a.ym, rateE6: a.rateE6, kind: { tag: a.kind as any } });
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
    audit(ctx, role, 'seed_customers', 'customer', sub.id, `${customers.length} customer(s) added to ${subsidiaryCode}`);
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
    audit(ctx, role, 'seed_vendors', 'vendor', sub.id, `${vendors.length} vendor(s) added to ${subsidiaryCode}`);
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
    audit(ctx, role, 'seed_revenue_schedule', 'revenue_schedule_line', c.id, `${lines.length} schedule line(s) for ${contractCode} (${lines.filter(l => l.recognized).length} already recognized)`);
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
        ccy: x.ccy,
        description: x.description,
        counterparty: x.counterparty,
        matched: x.matched,
      });
    }
    audit(ctx, role, 'seed_bank_transactions', 'bank_transaction', sub.id, `${txs.length} bank transaction(s) added to ${subsidiaryCode} (${txs.filter(x => x.matched).length} pre-matched)`);
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
    audit(ctx, role, 'seed_close_tasks', 'close_task', p.id, `${tasks.length} close task(s) for ${periodYm}`);
  }
);

export const resetDemo = spacetimedb.reducer(
  { confirm: t.string() },
  (ctx, { confirm }) => {
    requireRole(ctx, ['advisor', 'cfo'], 'reset the demo');
    if (confirm !== 'RESET') throw new SenderError('Pass confirm = "RESET".');
    const sealedRow = ctx.db.settings.key.find(SEALED_KEY);
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
    audit(ctx, roleOf(ctx) ?? 'cfo', 'reset_demo', 'all', 0n, 'Demo data cleared.');
  }
);

// Silence unused-import checks for enums referenced only in table definitions.
void ItemKind;
