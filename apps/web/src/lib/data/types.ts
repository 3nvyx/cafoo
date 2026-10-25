// Row types mirroring the ledger tables. Ids are strings, money is a string of
// minor units (cents), times are ISO 8601 strings. See CONTEXT.md for the words.

export type Minor = string;
export type Iso = string;

export type AgentRole = 'advisor' | 'bookkeeper' | 'revenue' | 'credit' | 'consolidation' | 'funding' | 'capital' | 'redteam' | 'feed' | 'cfo';
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
	| 'ic_elimination'
	/** Funding desk: an investor's wire matched to their commitment in a round. */
	| 'funding_receipt'
	/** Capital accountant: a SAFE, note or share issue recorded and classified from its documents. */
	| 'instrument_record'
	/** Capital accountant: interest accrued on convertible notes for a month. */
	| 'interest_accrual'
	/** Capital accountant: SAFEs and notes converted into shares at a priced round. */
	| 'instrument_conversion'
	/** Bookkeeper: one pay run posted from the payroll register. */
	| 'payroll_run'
	/** Bookkeeper: cloud, model-usage and engineering cost split between cost of revenue and R&D. */
	| 'cost_allocation'
	/** Revenue: prepaid credits that expired unused, recognized as revenue (breakage). */
	| 'credit_breakage'
	/** Bookkeeper: an expired or damaged stock lot written off. */
	| 'inventory_writeoff';

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
	| 'public_footprint'
	| 'document'
	| 'funding_round'
	| 'investor'
	| 'commitment'
	| 'instrument'
	| 'cap_table_entry'
	| 'employee'
	| 'pto_request'
	| 'calendar_event'
	| 'pay_run'
	| 'payslip'
	| 'cloud_cost'
	| 'batch'
	| 'integration'
	| 'deal'
	| 'promotion'
	| 'support_ticket';

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

// Uploaded documents. Demo mode loads a bundled sample per kind and replays a recorded parse; nothing leaves the browser.

/** Every kind of file the CFO can hand Cafoo, grouped by where it is uploaded. */
export type DocumentKind =
	// Books
	| 'bank_statement'
	| 'invoices'
	| 'bills'
	| 'contracts'
	// Financing
	| 'safe'
	| 'convertible_note'
	| 'term_sheet'
	| 'side_letter'
	| 'wire_confirmation'
	| 'closing_tracker'
	| 'cap_table'
	| 'valuation_report'
	// People
	| 'payroll_register'
	| 'pto_report'
	// Cost of service
	| 'cloud_bill'
	| 'model_usage';

export type DocumentStatus = 'parsing' | 'parsed' | 'needs_review' | 'applied' | 'rejected';

/** One uploaded file and what was read from it. */
export interface UploadedDocument {
	id: string;
	kind: DocumentKind;
	fileName: string;
	/** Size in bytes, for display. */
	sizeBytes: number;
	uploadedAt: Iso;
	status: DocumentStatus;
	/** The fields read from the file (JSON text): terms of a SAFE, rows of a statement, lines of a cloud bill. */
	extractedJson: string;
	/** One sentence on what the file is and what happens next. */
	summaryPlain: string;
	/** Fields the second reader disagreed on, or that need a person (bespoke clauses). Empty when none. */
	flagsPlain: string[];
	/** The agent that read it. */
	readByRole: AgentRole;
	/** Proposals the file led to. */
	proposalIds: string[];
	subsidiaryId: string;
}

// Financing. Raising money is not income: SAFEs and notes are liabilities, shares are equity. Only interest, fair-value
// changes and grants reach the P&L.

export type InstrumentKind = 'safe_post_money' | 'safe_pre_money' | 'convertible_note' | 'preferred_shares' | 'common_shares' | 'warrant';
/** How the instrument sits on the balance sheet. A person confirms it for anything non-standard. */
export type InstrumentClass = 'liability' | 'equity' | 'temporary_equity';

export interface FundingRound {
	id: string;
	subsidiaryId: string;
	/** "Pre-seed 2025", "Seed 2026". */
	name: string;
	targetMinor: Minor;
	ccy: string;
	openedAt: Iso;
	/** The last close, once the round is done. */
	closedAt?: Iso;
	status: 'planned' | 'open' | 'closed';
	leadInvestorId?: string;
	/** Priced rounds only: price per share in minor units times 10^4 (four decimal places of a cent). */
	pricePerShareE4?: string;
	preMoneyMinor?: Minor;
}

export type InvestorKind = 'fund' | 'angel' | 'spv' | 'family_office' | 'corporate' | 'accelerator';

export interface Investor {
	id: string;
	name: string;
	kind: InvestorKind;
	country: string;
	/** Names wires arrive under (the fund's bank, an SPV, a holding company), for matching. */
	payerNames: string[];
	contactName?: string;
}

export type CommitmentStatus = 'committed' | 'signed' | 'funded' | 'short' | 'overdue' | 'withdrawn';

/** One investor's part of a round: what they agreed to send and what has arrived. */
export interface Commitment {
	id: string;
	roundId: string;
	investorId: string;
	instrumentId?: string;
	amountMinor: Minor;
	ccy: string;
	/** What has arrived so far, in the commitment's currency. */
	receivedMinor: Minor;
	status: CommitmentStatus;
	expectedBy?: Iso;
	/** Plain note on a difference ("$35 short: wire fee"). */
	notePlain?: string;
}

export interface Instrument {
	id: string;
	roundId: string;
	investorId: string;
	kind: InstrumentKind;
	principalMinor: Minor;
	ccy: string;
	signedAt?: Iso;
	valuationCapMinor?: Minor;
	/** 2000 = 20% discount. */
	discountBp?: number;
	mfn: boolean;
	proRata: boolean;
	/** Notes only: 600 = 6% simple interest a year. */
	interestBp?: number;
	maturityAt?: Iso;
	/** Shares issued (priced shares) or received on conversion. */
	shares?: number;
	classification: InstrumentClass;
	/** Plain reason for the classification, with the clause it rests on. */
	classificationPlain: string;
	status: 'draft' | 'outstanding' | 'converted' | 'repaid' | 'cancelled';
	/** Uploaded documents the terms were read from. */
	documentIds: string[];
	/** Bespoke terms from a side letter, in plain words. */
	sideTermsPlain?: string;
}

export type SecurityClass = 'common' | 'preferred' | 'options_granted' | 'option_pool' | 'safe' | 'note' | 'warrant';

/** One line of the cap table: a holder's position in one class of security. */
export interface CapTableEntry {
	id: string;
	holderName: string;
	/** Set when the holder is an investor or an employee. */
	investorId?: string;
	employeeId?: string;
	security: SecurityClass;
	/** Shares or options; 0 for SAFEs and notes until they convert. */
	shares: number;
	/** What was paid, for SAFEs and notes the principal. */
	investedMinor: Minor;
	ccy: string;
	asOf: Iso;
}

// People. A fictitious team; salaries in each company's own currency.

export type Department = 'leadership' | 'engineering' | 'research' | 'product' | 'design' | 'sales' | 'marketing' | 'customer_success' | 'operations' | 'finance' | 'people';
export type EmploymentType = 'full_time' | 'part_time' | 'contractor' | 'intern';
/** US: 15th and last day; UK: last working day; contractors: on invoice. */
export type PayFrequency = 'semi_monthly' | 'biweekly' | 'monthly';

export interface DepositSplit {
	bankName: string;
	/** Last four digits only. */
	accountLast4: string;
	accountType: 'checking' | 'savings' | 'current';
	/** Either a fixed amount per pay run or the remainder. */
	amountMinor?: Minor;
	remainder: boolean;
}

export interface Employee {
	id: string;
	subsidiaryId: string;
	name: string;
	title: string;
	department: Department;
	managerId?: string;
	email: string;
	location: string;
	startAt: Iso;
	endAt?: Iso;
	type: EmploymentType;
	status: 'active' | 'on_leave' | 'notice' | 'terminated';
	/** Salaried: a year's pay. Hourly: rate per hour in `hourlyRateMinor`. */
	annualSalaryMinor: Minor;
	hourlyRateMinor?: Minor;
	ccy: string;
	payFrequency: PayFrequency;
	/** Employer 401(k) match or UK pension contribution, in basis points of salary. */
	retirementBp: number;
	/** Monthly employer health premium (US) or private medical (UK). */
	benefitsMonthlyMinor: Minor;
	/** Share of this person's time spent running the live service (on-call, support, infrastructure), in basis points.
	 * That share of their cost is cost of revenue; the rest is R&D or operating expense by department. */
	serviceShareBp: number;
	/** Stock options granted, if any. */
	optionsGranted?: number;
	deposit: DepositSplit[];
	pto: PtoPolicy;
}

export interface PtoPolicy {
	/** Hours accrued per pay run; 0 for unlimited policies. */
	accrualHoursPerRun: number;
	unlimited: boolean;
	balanceHours: number;
	usedHoursYtd: number;
	carryoverCapHours?: number;
	sickBalanceHours: number;
}

export type PtoKind = 'vacation' | 'sick' | 'parental' | 'bereavement' | 'jury_duty' | 'unpaid';

export interface PtoRequest {
	id: string;
	employeeId: string;
	kind: PtoKind;
	startAt: Iso;
	endAt: Iso;
	hours: number;
	status: 'pending' | 'approved' | 'declined' | 'taken';
	notePlain?: string;
}

/** What kind of day a calendar entry marks. Each has its own colour pair (bg-tag-*-soft text-on-tag-*-soft). */
export type CalendarTag = 'leave' | 'sick' | 'pay' | 'due' | 'holiday';

/**
 * An entry put on the calendar by hand, such as a company holiday. Time off, paydays and due dates are not stored
 * here; the calendar reads them from their own tables. Days are `YYYY-MM-DD`, both ends included.
 */
export interface CalendarEvent {
	id: string;
	tag: CalendarTag;
	title: string;
	startDay: string;
	endDay: string;
	employeeId?: string;
	notePlain?: string;
}

export type PayRunStatus = 'draft' | 'scheduled' | 'processing' | 'paid';

/** One pay run for one company: its dates, totals and the entry it posted. */
export interface PayRun {
	id: string;
	subsidiaryId: string;
	periodStart: Iso;
	periodEnd: Iso;
	payDate: Iso;
	/** When the provider debits the bank, usually two banking days before payDate. */
	debitDate: Iso;
	status: PayRunStatus;
	ccy: string;
	employeeCount: number;
	grossMinor: Minor;
	/** Taxes withheld from employees. */
	employeeTaxMinor: Minor;
	/** Employer payroll taxes (FICA, FUTA, SUTA; UK employer NI). */
	employerTaxMinor: Minor;
	/** Employee deductions: 401(k) or pension, health premiums. */
	deductionsMinor: Minor;
	/** Employer benefit and retirement contributions. */
	employerBenefitsMinor: Minor;
	netMinor: Minor;
	provider: string;
	proposalId?: string;
	jeId?: string;
}

export interface Payslip {
	id: string;
	payRunId: string;
	employeeId: string;
	hours?: number;
	grossMinor: Minor;
	employeeTaxMinor: Minor;
	deductionsMinor: Minor;
	netMinor: Minor;
	ptoHoursUsed: number;
	ccy: string;
}

// Cost of service: what it takes to run the product for customers.

export type CostProvider = 'aws' | 'gcp' | 'azure' | 'openai' | 'anthropic' | 'together' | 'vercel' | 'datadog' | 'snowflake' | 'github' | 'other';
/** Cost of revenue runs the live product; R&D builds the next one; G&A is the company's own tooling. */
export type CostCategory = 'cost_of_revenue' | 'r_and_d' | 'g_and_a';

/** One line of a cloud or model-usage bill for one month. */
export interface CloudCost {
	id: string;
	subsidiaryId: string;
	provider: CostProvider;
	/** "EC2", "S3", "GPU inference (H100)", "Claude API". */
	service: string;
	ym: string;
	environment: 'production' | 'staging' | 'development' | 'shared';
	category: CostCategory;
	amountMinor: Minor;
	ccy: string;
	usageQuantity: number;
	/** "GPU-hours", "M tokens", "GB-month". */
	usageUnit: string;
	/** Product or feature the cost serves, from the provider's tags. */
	product?: string;
	/** The bill line came from this uploaded document. */
	documentId?: string;
}

// Batches: prepaid usage-credit packs a customer bought, and stock lots the company holds. Both can expire.

export interface Batch {
	id: string;
	subsidiaryId: string;
	kind: 'credit_pack' | 'stock_lot';
	sku: string;
	name: string;
	/** Credit packs: the customer who bought it. */
	customerId?: string;
	/** Stock lots: the vendor it came from. */
	vendorId?: string;
	quantity: number;
	remaining: number;
	/** "M tokens", "GPU-hours", "units". */
	unit: string;
	/** Credit packs: what the customer paid. Stock lots: what the lot cost. */
	amountMinor: Minor;
	ccy: string;
	acquiredAt: Iso;
	expiresAt?: Iso;
	status: 'active' | 'expiring' | 'expired' | 'depleted';
}

// Integrations: the tools Cafoo reads from instead of rebuilding them (CRM, support, billing, payroll, cloud, cap table).

export type IntegrationCategory = 'crm' | 'support' | 'billing' | 'payroll' | 'cloud' | 'model_usage' | 'cap_table';

export interface Integration {
	/** "hubspot", "zendesk", "stripe", "gusto", "aws", "openai", "carta". */
	id: string;
	name: string;
	category: IntegrationCategory;
	status: 'available' | 'syncing' | 'connected' | 'error';
	connectedAt?: Iso;
	/** The last time a record arrived from it; drives "Updated 12s ago". */
	lastSyncAt?: Iso;
	recordsSynced: number;
	/** What Cafoo reads from it, in plain words. */
	readsPlain: string;
	notePlain?: string;
}

// CRM, kept small: Cafoo reads these from the connected CRM, support and billing tools; it does not edit them.

export type DealStage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';

export interface Deal {
	id: string;
	/** The integration it came from. */
	source: string;
	companyName: string;
	customerId?: string;
	stage: DealStage;
	/** Annual contract value. */
	amountMinor: Minor;
	ccy: string;
	probabilityBp: number;
	expectedCloseAt: Iso;
	ownerName: string;
	updatedAt: Iso;
}

export interface Promotion {
	id: string;
	source: string;
	code: string;
	descriptionPlain: string;
	/** Percentage off (2000 = 20%), or a fixed amount off. */
	discountBp?: number;
	amountOffMinor?: Minor;
	ccy: string;
	startsAt: Iso;
	endsAt?: Iso;
	redemptions: number;
	/** Discount given so far, a positive amount. */
	discountGivenMinor: Minor;
	status: 'scheduled' | 'active' | 'ended';
}

export interface SupportTicket {
	id: string;
	source: string;
	customerId?: string;
	requesterName: string;
	subject: string;
	priority: 'low' | 'normal' | 'high' | 'urgent';
	status: 'new' | 'open' | 'pending' | 'solved';
	channel: 'email' | 'chat' | 'phone' | 'slack';
	openedAt: Iso;
	firstResponseAt?: Iso;
	solvedAt?: Iso;
	slaDueAt: Iso;
}

export { formatMoney, toNumber, sumMinor, negMinor } from './money';
