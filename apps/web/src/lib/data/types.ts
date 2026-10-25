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
	/** The Functional currency: the currency this Subsidiary keeps its books in. */
	baseCurrency: string;
	/** Short code ("US", "UK", "ELIM"); every company but the root suffixes its account codes with it ("1000-UK"). */
	code: string;
	/** Unset for the root company. */
	parentId?: string;
	/** The bookkeeping-only company that holds every Elimination. */
	isElimination: boolean;
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface Account {
	id: string;
	subsidiaryId: string;
	code: string;
	name: string;
	type: AccountType;
	/** Records what one group company owes, is owed, charges or is charged by another. */
	isIntercompany?: boolean;
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
	/** In the line's own currency (`ccy`). */
	debitMinor: Minor;
	creditMinor: Minor;
	/** The line's currency; unset means the account's company's Functional currency. */
	ccy?: string;
	/** Line currency to Functional currency, scaled by 1e6 ("1000000" is 1:1); unset means 1:1. */
	fxRateE6?: string;
	customerId?: string;
	vendorId?: string;
}

export type FxRateKind = 'spot' | 'average' | 'closing';

/** One recorded rate: 1 unit of `fromCcy` buys `rateE6 / 1e6` units of `toCcy` in month `ym`. */
export interface FxRate {
	id: string;
	fromCcy: string;
	toCcy: string;
	/** "yyyy-mm" */
	ym: string;
	rateE6: string;
	kind: FxRateKind;
}

export type RiskTier = 'A' | 'B' | 'C' | 'D' | 'BLOCK';

export interface Customer {
	id: string;
	/** The company whose customer this is; unset means the root company. Its invoices are in that company's currency. */
	subsidiaryId?: string;
	name: string;
	domain: string;
	guarantorPersonaId: string;
	/** Display name of the Guarantor (the owner). */
	guarantorName: string;
	creditTier?: RiskTier;
	paymentTermsDays: number;
	yelpUrl?: string;
	/** "board:org", e.g. "greenhouse:stripe" or "ashby:snowflake". */
	jobBoard?: string;
	linkedinUrl?: string;
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
	yelpUrl?: string;
	/** "board:org", e.g. "greenhouse:stripe" or "ashby:snowflake". */
	jobBoard?: string;
	linkedinUrl?: string;
}

/** Where a business can be looked up publicly. Set by the CFO; empty means "no public listing on file". */
export interface Listings {
	yelpUrl?: string;
	jobBoard?: string;
	linkedinUrl?: string;
}

export type FootprintSubject = 'customer' | 'vendor';
export type FootprintSource = 'yelp' | 'jobs' | 'linkedin' | 'search';

/**
 * One fetch of one public source about a Customer or Vendor: what a logged-out visitor could see at `fetchedAt`.
 * Read-only signals for the CFO; nothing here touches the books. Numeric facts are 0 when the source has none.
 */
export interface PublicFootprint {
	id: string;
	subjectKind: FootprintSubject;
	subjectId: string;
	source: FootprintSource;
	sourceUrl: string;
	fetchedAt: Iso;
	status: 'ok' | 'failed';
	error: string;
	summaryPlain: string;
	/** The source's facts as fetched (JSON text). */
	factsJson: string;
	/** 41 = 4.1 stars; 0 = no rating. */
	ratingTenths: number;
	reviewCount: number;
	isClosed: boolean;
	isClaimed: boolean;
	/** 0 = unknown. */
	yearEstablished: number;
	openRoles: number;
	employees: number;
	followers: number;
	/** Fetched live, as opposed to replayed from a recorded fixture. */
	live: boolean;
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
	subsidiaryId: string;
	bookedAt: Iso;
	/** The month ("yyyy-mm") whose bank reconciliation this line belongs to. */
	ym: string;
	/** Positive is money in, negative is money out. */
	amountMinor: Minor;
	ccy: string;
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
	| 'vendor_verify'
	| 'fx_revaluation'
	| 'ic_elimination';

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
	/** The one currency the group reports in (USD). */
	reportingCcy: string;
	/** Whether the CFO has switched the live feed on (the module's feed_enabled setting). */
	feedEnabled: boolean;
}

/** What the live feed is doing, as the agent gateway reports it (GET /status, `feed`). */
export interface FeedStatus {
	enabled: boolean;
	/** The month the feed books into (the open month after the latest one the CFO locked). */
	ym?: string;
	planned: number;
	ingested: number;
	/** Why nothing is arriving, in plain words, when nothing can. */
	blockedReason?: string;
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
	| 'settings'
	| 'fx_rate'
	| 'charter_version'
	| 'charter_eval'
	| 'public_footprint';

// Charters. The shapes mirror the agent gateway's contracts (apps/agents/src/charter/types.ts and routes.ts).

/** The agents that have a Charter. */
export type CharterRole = 'advisor' | 'bookkeeper' | 'revenue' | 'credit' | 'redteam' | 'consolidation';
export type CharterStatus = 'draft' | 'live' | 'retired';
/** dry_run: the full eval (a whole close on a scratch database); snapshot: the quick check against the recorded close. */
export type CharterEvalMode = 'dry_run' | 'snapshot';

/** One numbered, unchangeable text of a Charter with its line mapping. */
export interface CharterVersion {
	id: string;
	role: string;
	version: number;
	status: CharterStatus;
	bodyMd: string;
	mappingJson: string;
	summaryPlain: string;
	basedOnVersionId?: string;
	authoredByRole: string;
	createdAt: Iso;
	publishedAt?: Iso;
}

/** One recorded run of a Charter version's scenarios and rule probes. */
export interface CharterEval {
	id: string;
	charterVersionId: string;
	passed: boolean;
	mode: CharterEvalMode;
	/** The eval report (JSON text): coverage, probes, scenarios. */
	resultsJson: string;
	summaryPlain: string;
	ranByRole: string;
	ranAt: Iso;
}

export type CharterMappingTarget =
	| { kind: 'rule'; template: string; params?: Record<string, unknown> }
	| { kind: 'scenario'; scenario: string; vars?: Record<string, string | number | boolean | null> }
	| { kind: 'custom_scenario'; yaml: string };

/** One charter line ("May 2", "Must never 1", "Escalates 3", "Plain summary") mapped to what checks it. */
export interface CharterMappingEntry {
	label: string;
	text: string;
	target: CharterMappingTarget;
}

/** One input a rule template takes. bp: basis points shown as a percentage; minor: money in minor units. */
export interface CharterParamSpec {
	name: string;
	labelPlain: string;
	type: 'bp' | 'minor' | 'kinds' | 'int' | 'text';
	default?: string | number | string[];
	min?: number;
	max?: number;
	options?: string[];
}

export interface CharterTemplate {
	id: string;
	/** The role whose Charter may use it, or '*' for any worker agent. */
	role: string;
	titlePlain: string;
	params: CharterParamSpec[];
	/** The shipped line this template may stand on, tightening that line's rule. */
	tightensLine?: string;
}

/** What a charter line can map to, and each role's Built-in Charter with its default mapping. */
export interface CharterCatalog {
	templates: CharterTemplate[];
	scenarios: { id: string; agent: string; charterLine: string }[];
	builtin: Record<string, { bodyMd: string; mapping: CharterMappingEntry[] }>;
}

/** The eval runner's progress for one version, as the gateway reports it. */
export interface CharterEvalRun {
	versionId?: string;
	status: 'idle' | 'running' | 'done' | 'error';
	mode?: CharterEvalMode;
	passed?: boolean;
	publishable?: boolean;
	steps: string[];
	error?: string;
	startedAt?: Iso;
	finishedAt?: Iso;
}

/** What an agent is doing right now (drives the "is writing" indicator). */
export interface LiveActivity {
	role: AgentRole;
	labelPlain: string;
	proposalId?: string;
}

export { formatMoney, toNumber, sumMinor, negMinor } from './money';
