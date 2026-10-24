import { schema, table, t } from 'spacetimedb/server';

// ---------- enums ----------
export const Role = t.enum('Role', {
  advisor: t.unit(),
  bookkeeper: t.unit(),
  revenue: t.unit(),
  credit: t.unit(),
  redteam: t.unit(),
  cfo: t.unit(),
  ui: t.unit(),
  // Appended: enum variants only ever go at the end.
  consolidation: t.unit(),
  feed: t.unit(),
});

export const AccountType = t.enum('AccountType', {
  asset: t.unit(),
  liability: t.unit(),
  equity: t.unit(),
  revenue: t.unit(),
  expense: t.unit(),
});

export const PeriodStatus = t.enum('PeriodStatus', {
  open: t.unit(),
  closing: t.unit(),
  closed: t.unit(),
});

export const EntrySource = t.enum('EntrySource', {
  seed: t.unit(),
  agent: t.unit(),
  manual: t.unit(),
});

export const ProposalKind = t.enum('ProposalKind', {
  journal_entry: t.unit(),
  bank_match: t.unit(),
  revenue_schedule: t.unit(),
  credit_decision: t.unit(),
  accrual: t.unit(),
  vendor_block: t.unit(),
  vendor_verify: t.unit(),
  fx_revaluation: t.unit(),
  ic_elimination: t.unit(),
});

export const ProposalStatus = t.enum('ProposalStatus', {
  open: t.unit(),
  approved: t.unit(),
  rejected: t.unit(),
  amended: t.unit(),
  awaiting_cfo: t.unit(),
  sent_back: t.unit(),
  superseded: t.unit(),
});

export const Decision = t.enum('Decision', {
  approve: t.unit(),
  reject: t.unit(),
  amend: t.unit(),
});

export const MessageKind = t.enum('MessageKind', {
  statement: t.unit(),
  critique: t.unit(),
  question: t.unit(),
  ruling: t.unit(),
});

export const TaskStatus = t.enum('TaskStatus', {
  todo: t.unit(),
  in_progress: t.unit(),
  blocked: t.unit(),
  done: t.unit(),
});

export const InvoiceStatus = t.enum('InvoiceStatus', {
  open: t.unit(),
  paid: t.unit(),
  overdue: t.unit(),
});

export const BillStatus = t.enum('BillStatus', {
  open: t.unit(),
  paid: t.unit(),
  overdue: t.unit(),
});

export const Verification = t.enum('Verification', {
  unverified: t.unit(),
  verified: t.unit(),
  blocked: t.unit(),
});

export const MatchTarget = t.enum('MatchTarget', {
  invoice: t.unit(),
  bill: t.unit(),
  je: t.unit(),
});

export const SubjectKind = t.enum('SubjectKind', {
  customer: t.unit(),
  vendor: t.unit(),
});

export const Plan = t.enum('Plan', {
  annual: t.unit(),
  usage: t.unit(),
});

export const ItemKind = t.enum('ItemKind', {
  subscription: t.unit(),
  usage: t.unit(),
});

export const FxKind = t.enum('FxKind', {
  spot: t.unit(),
  average: t.unit(),
  closing: t.unit(),
});

export const CharterStatus = t.enum('CharterStatus', {
  draft: t.unit(),
  live: t.unit(),
  retired: t.unit(),
});

export const FeedKind = t.enum('FeedKind', {
  bank_tx: t.unit(),
  invoice: t.unit(),
});

// ---------- shared object types for reducer args ----------
export const LineArg = t.object('LineArg', {
  accountCode: t.string(),
  debitMinor: t.i64(),
  creditMinor: t.i64(),
  ccy: t.string(),
  fxRateE6: t.i64(),
  customerId: t.option(t.u64()),
  vendorId: t.option(t.u64()),
  memo: t.string(),
});

export const ContractItemArg = t.object('ContractItemArg', {
  kind: ItemKind,
  priceMinor: t.i64(),
  qty: t.i64(),
  sspMinor: t.i64(),
  description: t.string(),
});

// ---------- tables ----------
const subsidiary = table(
  { name: 'subsidiary', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().unique(),
    name: t.string(),
    functionalCcy: t.string(),
    parentId: t.option(t.u64()),
    /** The group's elimination company: holds only consolidation eliminations, never trades. */
    isElimination: t.bool().default(false),
  }
);

const account = table(
  { name: 'account', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subsidiaryId: t.u64().index('btree'),
    code: t.string().unique(),
    name: t.string(),
    accountType: AccountType,
    isIntercompany: t.bool(),
    sortOrder: t.u32(),
  }
);

const period = table(
  { name: 'period', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subsidiaryId: t.u64().index('btree'),
    year: t.u16(),
    month: t.u8(),
    ym: t.string().unique(),
    status: PeriodStatus,
  }
);

const periodLock = table(
  { name: 'period_lock', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    periodId: t.u64().unique(),
    lockedBy: t.identity(),
    lockedByRole: t.string(),
    lockedAt: t.timestamp(),
    rationale: t.string(),
  }
);

const journalEntry = table(
  { name: 'journal_entry', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subsidiaryId: t.u64(),
    periodId: t.u64().index('btree'),
    postedAt: t.timestamp(),
    memo: t.string(),
    source: EntrySource,
    proposalId: t.option(t.u64()),
    postedBy: t.identity(),
    postedByRole: t.string(),
    reversalOf: t.option(t.u64()),
    totalMinor: t.i64(),
  }
);

const journalLine = table(
  { name: 'journal_line', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    jeId: t.u64().index('btree'),
    accountId: t.u64().index('btree'),
    accountCode: t.string(),
    debitMinor: t.i64(),
    creditMinor: t.i64(),
    ccy: t.string(),
    fxRateE6: t.i64(),
    customerId: t.option(t.u64()),
    vendorId: t.option(t.u64()),
    memo: t.string(),
  }
);

const fxRate = table(
  { name: 'fx_rate', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fromCcy: t.string(),
    toCcy: t.string(),
    ym: t.string().index('btree'),
    rateE6: t.i64(),
    kind: FxKind,
  }
);

const customer = table(
  { name: 'customer', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subsidiaryId: t.u64(),
    name: t.string(),
    domain: t.string(),
    guarantorPersonaId: t.string(),
    guarantorName: t.string(),
    creditTier: t.option(t.string()),
    paymentTermsDays: t.u16(),
    allowanceMinor: t.i64(),
  }
);

const contract = table(
  { name: 'contract', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    customerId: t.u64().index('btree'),
    code: t.string().unique(),
    startYm: t.string(),
    endYm: t.string(),
    totalMinor: t.i64(),
    plan: Plan,
  }
);

const contractItem = table(
  { name: 'contract_item', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    contractId: t.u64().index('btree'),
    kind: ItemKind,
    priceMinor: t.i64(),
    qty: t.i64(),
    sspMinor: t.i64(),
    description: t.string(),
  }
);

const revenueScheduleLine = table(
  { name: 'revenue_schedule_line', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    contractItemId: t.u64().index('btree'),
    customerId: t.u64().index('btree'),
    ym: t.string().index('btree'),
    amountMinor: t.i64(),
    recognized: t.bool(),
    jeId: t.option(t.u64()),
  }
);

const invoice = table(
  { name: 'invoice', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    customerId: t.u64().index('btree'),
    contractId: t.option(t.u64()),
    number: t.string().unique(),
    ym: t.string(),
    issuedAt: t.timestamp(),
    dueAt: t.timestamp(),
    amountMinor: t.i64(),
    status: InvoiceStatus,
  }
);

const vendor = table(
  { name: 'vendor', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subsidiaryId: t.u64(),
    name: t.string(),
    domain: t.string(),
    category: t.string(),
    ownerPersonaId: t.option(t.string()),
    verification: Verification,
    verificationNote: t.string(),
  }
);

const bill = table(
  { name: 'bill', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    vendorId: t.u64().index('btree'),
    externalRef: t.string(),
    ym: t.string(),
    billedAt: t.timestamp(),
    dueAt: t.timestamp(),
    amountMinor: t.i64(),
    expenseAccountCode: t.string(),
    status: BillStatus,
  }
);

const bankTransaction = table(
  { name: 'bank_transaction', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subsidiaryId: t.u64(),
    bookedAt: t.timestamp(),
    ym: t.string().index('btree'),
    amountMinor: t.i64(),
    ccy: t.string(),
    description: t.string(),
    counterparty: t.string(),
    matched: t.bool(),
  }
);

const bankMatch = table(
  { name: 'bank_match', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    bankTxId: t.u64().unique(),
    targetKind: MatchTarget,
    targetId: t.u64().index('btree'),
    scoreBp: t.u16(),
    proposalId: t.u64().index('btree'),
    /** The payment entry a bank_match proposal posted for an invoice or bill match; none for a journal-entry match.
     *  Option columns cannot carry an index in the 2.13 TypeScript SDK, so look matches up by proposalId first.
     *  The default lets an existing database upgrade in place; its older matches have none (see isLegacyPaymentMatch). */
    paymentJeId: t.option(t.u64()).default(undefined),
  }
);

const proposal = table(
  { name: 'proposal', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: ProposalKind,
    payloadJson: t.string(),
    rationale: t.string(),
    summaryPlain: t.string(),
    amountMinor: t.i64(),
    proposedBy: t.identity(),
    proposerRole: t.string(),
    status: ProposalStatus,
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    closeTaskId: t.option(t.u64()),
    periodId: t.option(t.u64()),
    threadId: t.string(),
  }
);

const approval = table(
  { name: 'approval', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    proposalId: t.u64().unique(),
    decidedBy: t.identity(),
    decision: Decision,
    amendedPayloadJson: t.option(t.string()),
    rationale: t.string(),
    summaryPlain: t.string(),
    decidedAt: t.timestamp(),
    cfoConfirmedBy: t.option(t.identity()),
    cfoConfirmedAt: t.option(t.timestamp()),
  }
);

const settings = table(
  { name: 'settings', public: true },
  {
    key: t.string().primaryKey(),
    valueI64: t.i64(),
    valueText: t.string(),
  }
);

// Private: which identity holds which role. Clients never see tokens or identities of others.
const agentIdentity = table(
  { name: 'agent_identity' },
  {
    identity: t.identity().primaryKey(),
    role: Role,
    displayName: t.string(),
    registeredAt: t.timestamp(),
  }
);

// Public roster so the UI can show who is online, without exposing identities.
const agentRoster = table(
  { name: 'agent_roster', public: true },
  {
    role: t.string().primaryKey(),
    displayName: t.string(),
    registeredAt: t.timestamp(),
    model: t.string(),
  }
);

const agentMessage = table(
  { name: 'agent_message', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    threadId: t.string().index('btree'),
    sender: t.identity(),
    senderRole: t.string(),
    kind: MessageKind,
    body: t.string(),
    summaryPlain: t.string(),
    proposalId: t.option(t.u64()),
    createdAt: t.timestamp(),
  }
);

const closeTask = table(
  { name: 'close_task', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    periodId: t.u64().index('btree'),
    title: t.string(),
    description: t.string(),
    ownerRole: t.string(),
    status: TaskStatus,
    sortOrder: t.u16(),
    evidenceProposalIds: t.string(),
  }
);

const creditCheck = table(
  { name: 'credit_check', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subjectKind: SubjectKind,
    subjectId: t.u64().index('btree'),
    personaId: t.string(),
    product: t.string(),
    requestId: t.string(),
    summaryJson: t.string(),
    tier: t.string(),
    decision: t.string(),
    createdAt: t.timestamp(),
  }
);

const auditEvent = table(
  { name: 'audit_event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    actor: t.identity(),
    actorRole: t.string(),
    action: t.string(),
    targetTable: t.string(),
    targetId: t.u64(),
    detail: t.string(),
    at: t.timestamp(),
  }
);

/**
 * A charter as the CFO's team edited it. Rows are immutable once written except for status and the publish stamp:
 * an edit is a new draft row with version = the role's highest + 1. The shipped charter .md files are the implicit
 * built-in version 0, which applies whenever a role has no live row.
 */
const charterVersion = table(
  { name: 'charter_version', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    role: t.string().index('btree'),
    version: t.u32(),
    status: CharterStatus,
    bodyMd: t.string(),
    /** JSON array of CharterMappingEntry: each charter line mapped to a rule template, a scenario or a custom scenario. */
    mappingJson: t.string(),
    summaryPlain: t.string(),
    basedOnVersionId: t.option(t.u64()),
    authoredBy: t.identity(),
    authoredByRole: t.string(),
    createdAt: t.timestamp(),
    publishedBy: t.option(t.identity()),
    publishedAt: t.option(t.timestamp()),
  }
);

/** One eval run of a charter version, recorded by the gateway's eval runner. publishCharter needs the latest to pass. */
const charterEval = table(
  { name: 'charter_eval', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    charterVersionId: t.u64().index('btree'),
    passed: t.bool(),
    /** 'dry_run' (scratch database, scripted close) or 'snapshot' (recorded ledger). */
    mode: t.string(),
    resultsJson: t.string(),
    summaryPlain: t.string(),
    ranBy: t.identity(),
    ranByRole: t.string(),
    ranAt: t.timestamp(),
  }
);

/** Every row the feed ingested, by its external id, so a replayed feed event is skipped instead of booked twice. */
const feedEvent = table(
  { name: 'feed_event', public: true },
  {
    externalId: t.string().primaryKey(),
    kind: FeedKind,
    /** The bank_transaction or invoice row it created. */
    rowId: t.u64(),
    subsidiaryId: t.u64(),
    ym: t.string().index('btree'),
    ingestedAt: t.timestamp(),
  }
);

/** Private: the SHA-256 of the one-time secret that claims the CFO seat. Armed by the database owner; deleted on claim. */
const cfoBootstrap = table(
  { name: 'cfo_bootstrap' },
  {
    key: t.string().primaryKey(),
    secretSha256: t.string(),
    createdAt: t.timestamp(),
    expiresAt: t.timestamp(),
  }
);

export const overdueSweep = table(
  { name: 'overdue_sweep' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({
  subsidiary,
  account,
  period,
  periodLock,
  journalEntry,
  journalLine,
  fxRate,
  customer,
  contract,
  contractItem,
  revenueScheduleLine,
  invoice,
  vendor,
  bill,
  bankTransaction,
  bankMatch,
  proposal,
  approval,
  settings,
  agentIdentity,
  agentRoster,
  agentMessage,
  closeTask,
  creditCheck,
  auditEvent,
  overdueSweep,
  charterVersion,
  charterEval,
  feedEvent,
  cfoBootstrap,
});

export default spacetimedb;
