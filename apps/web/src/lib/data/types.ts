// Row types mirroring the ledger tables. Ids are strings, money is a string of
// minor units (cents), times are ISO 8601 strings. See CONTEXT.md for the words.

export type Minor = string;
export type Iso = string;

export type AgentRole = 'advisor' | 'bookkeeper' | 'revenue' | 'credit' | 'consolidation' | 'redteam' | 'feed' | 'cfo';
/** Who posted or acted. 'seed' is opening data loaded by the seed scripts. */
export type PostedByRole = AgentRole | 'system' | 'seed';

export interface Subsidiary {
	id: string;
	name: string;
	baseCurrency: string;
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface Account {
	id: string;
	subsidiaryId: string;
	code: string;
	name: string;
	type: AccountType;
}

export type PeriodStatus = 'open' | 'closing' | 'closed';

export interface Period {
	/** e.g. "2026-09" */
	id: string;
	subsidiaryId: string;
	year: number;
	month: number;
	status: PeriodStatus;
	lockedAt?: Iso;
}

export type JournalSource = 'seed' | 'agent' | 'manual';

export interface JournalEntry {
	id: string;
	periodId: string;
	postedAt: Iso;
	memo: string;
	source: JournalSource;
	proposalId?: string;
	postedByRole: PostedByRole;
	reversesJeId?: string;
}

export interface JournalLine {
	id: string;
	jeId: string;
	accountId: string;
	debitMinor: Minor;
	creditMinor: Minor;
	customerId?: string;
	vendorId?: string;
}

export type RiskTier = 'A' | 'B' | 'C' | 'D' | 'BLOCK';

export interface Customer {
	id: string;
	name: string;
	domain: string;
	guarantorPersonaId: string;
	/** Display name of the Guarantor (the owner). */
	guarantorName: string;
	creditTier?: RiskTier;
	paymentTermsDays: number;
}

export interface Contract {
	id: string;
	customerId: string;
	startAt: Iso;
	endAt?: Iso;
	billing: 'monthly' | 'annual';
	arrMinor: Minor;
	/** ARR before the last change, when it changed. */
	priorArrMinor?: Minor;
	changedAt?: Iso;
}

export type InvoiceStatus = 'open' | 'paid' | 'overdue';

export interface Invoice {
	id: string;
	number: string;
	customerId: string;
	issuedAt: Iso;
	dueAt: Iso;
	amountMinor: Minor;
	status: InvoiceStatus;
}

export type VendorVerification = 'unverified' | 'verified' | 'blocked';

export interface Vendor {
	id: string;
	name: string;
	category: string;
	verification: VendorVerification;
	notePlain?: string;
}

export interface Bill {
	id: string;
	number: string;
	vendorId: string;
	issuedAt: Iso;
	dueAt: Iso;
	amountMinor: Minor;
	status: InvoiceStatus;
}

export interface BankTransaction {
	id: string;
	bookedAt: Iso;
	/** The month ("yyyy-mm") whose bank reconciliation this line belongs to. */
	ym: string;
	/** Positive is money in, negative is money out. */
	amountMinor: Minor;
	description: string;
	counterparty: string;
	matched: boolean;
}

export type MatchBucket = 'exact' | 'strong' | 'weak';

export interface BankMatch {
	id: string;
	bankTransactionId: string;
	targetKind: 'invoice' | 'bill' | 'journal_entry';
	targetId: string;
	/** Confidence in basis points, 0..10000. */
	scoreBp: number;
	bucket: MatchBucket;
	/** The Proposal that made the match. */
	proposalId?: string;
	/** The payment entry the match posted (invoice and bill targets). */
	paymentJeId?: string;
}

export type ProposalKind =
	| 'journal_entry'
	| 'bank_match'
	| 'revenue_schedule'
	| 'credit_decision'
	| 'accrual'
	| 'vendor_block'
	| 'vendor_verify';

export type ProposalStatus =
	| 'open'
	| 'approved'
	| 'rejected'
	| 'amended'
	| 'awaiting_cfo'
	| 'sent_back'
	| 'superseded';

export interface Proposal {
	id: string;
	periodId: string;
	kind: ProposalKind;
	/** Raw payload as the worker agent sent it (JSON text). */
	payloadJson: string;
	rationale: string;
	summaryPlain: string;
	amountMinor: Minor;
	proposerRole: AgentRole;
	status: ProposalStatus;
	createdAt: Iso;
	supersededBy?: string;
}

export type ApprovalDecision = 'approve' | 'reject' | 'amend';

export interface Approval {
	id: string;
	proposalId: string;
	decision: ApprovalDecision;
	rationale: string;
	summaryPlain: string;
	at: Iso;
	cfoConfirmedAt?: Iso;
}

export type MessageKind = 'statement' | 'critique' | 'question' | 'ruling';

export interface AgentMessage {
	id: string;
	threadId: string;
	senderRole: AgentRole;
	kind: MessageKind;
	body: string;
	summaryPlain: string;
	proposalId?: string;
	createdAt: Iso;
}

export type CloseTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

export interface CloseTask {
	id: string;
	periodId: string;
	title: string;
	ownerRole: AgentRole;
	status: CloseTaskStatus;
	order: number;
	/** Proposals that serve as evidence for this task. */
	proposalIds: string[];
}

export interface CreditCheck {
	id: string;
	subjectKind: 'customer' | 'vendor';
	subjectId: string;
	personaId: string;
	tier: RiskTier;
	/** Stored cascade results (JSON text). */
	summaryJson: string;
	requestId: string;
	checkedAt: Iso;
}

export interface AuditEvent {
	id: string;
	actorRole: PostedByRole;
	action: string;
	targetTable: TableName;
	targetId: string;
	detailJson: string;
	at: Iso;
}

export interface Settings {
	materialityThresholdMinor: Minor;
}

export interface ProviderStatus {
	id: string;
	name: string;
	purpose: string;
	mode: 'demo' | 'live';
	detail: string;
}

export type TableName =
	| 'subsidiary'
	| 'account'
	| 'period'
	| 'journal_entry'
	| 'journal_line'
	| 'customer'
	| 'contract'
	| 'invoice'
	| 'vendor'
	| 'bill'
	| 'bank_transaction'
	| 'bank_match'
	| 'proposal'
	| 'approval'
	| 'agent_message'
	| 'close_task'
	| 'credit_check'
	| 'audit_event'
	| 'settings';

/** What an agent is doing right now (drives the "is writing" indicator). */
export interface LiveActivity {
	role: AgentRole;
	labelPlain: string;
	proposalId?: string;
}

export { formatMoney, toNumber, sumMinor, negMinor } from './money';
