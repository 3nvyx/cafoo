import type {
	Account,
	AgentMessage,
	Approval,
	AuditEvent,
	BankMatch,
	BankTransaction,
	Bill,
	CloseTask,
	CloseTaskStatus,
	Contract,
	CreditCheck,
	Customer,
	Invoice,
	JournalEntry,
	JournalLine,
	LiveActivity,
	Minor,
	Period,
	Proposal,
	ProviderStatus,
	Settings,
	Subsidiary,
	TableName,
	Vendor
} from './types';

export type ChangeKind = 'insert' | 'update' | 'delete';

/** Health of the two live dependencies. Demo mode reports 'demo' and 'online'. */
export interface ConnectionState {
	ledger: 'demo' | 'connecting' | 'live' | 'offline';
	agents: 'online' | 'offline' | 'unknown';
	/** Closes the agents have started, per Period ("yyyy-mm"). 'running' while agents are working. */
	closes: { periodYm: string; status: 'running' | 'done' }[];
	message?: string;
}

/**
 * Who holds the CFO seat, as this browser sees it. The ledger module is the authority: it refuses every CFO action
 * from a connection that does not hold the seat. This only tells the UI what to show.
 * - 'you': this browser holds the seat.
 * - 'other': someone holds it, but not this browser, so it is read-only.
 * - 'unclaimed': nobody holds it yet; the claim link seats whoever opens it.
 * - 'checking': still connecting to the ledger.
 */
export interface CfoSeat {
	status: 'you' | 'other' | 'unclaimed' | 'checking';
	/** The display name the seat holder claimed it with, when someone holds it. */
	holderName?: string;
}

export interface ChangeEvent<T = unknown> {
	table: TableName;
	kind: ChangeKind;
	row: T;
}

/**
 * The one seam between the UI and wherever the books live.
 *
 * Read methods return arrays backed by Svelte 5 `$state`: reading them inside a
 * component, `$derived` or `$effect` tracks changes, so screens re-render when rows
 * arrive. Call them; never mutate what they return. `subscribe` is for side effects
 * that need to know a row arrived (toasts, counters), not for rendering.
 *
 * Actions are the CFO's only levers. Simple and Expert mode call the same ones.
 */
export interface DataSource {
	/** 'mock' replays the scripted demo; 'live' talks to the ledger database. */
	readonly kind: 'mock' | 'live';

	// Reads
	subsidiaries(): Subsidiary[];
	accounts(): Account[];
	periods(): Period[];
	journalEntries(): JournalEntry[];
	journalLines(): JournalLine[];
	customers(): Customer[];
	contracts(): Contract[];
	invoices(): Invoice[];
	vendors(): Vendor[];
	bills(): Bill[];
	bankTransactions(): BankTransaction[];
	bankMatches(): BankMatch[];
	proposals(): Proposal[];
	approvals(): Approval[];
	agentMessages(): AgentMessage[];
	closeTasks(): CloseTask[];
	creditChecks(): CreditCheck[];
	auditEvents(): AuditEvent[];
	settings(): Settings;
	providers(): ProviderStatus[];
	/** What an agent is doing right now, or null when idle. */
	liveActivity(): LiveActivity | null;
	/** The source's clock (Demo mode runs on a fixed demo date). ISO string. */
	now(): string;
	/** Whether the ledger and the agents are reachable. */
	connection(): ConnectionState;
	/** Whether this browser holds the CFO seat. Demo mode: always 'you'. */
	cfoSeat(): CfoSeat;

	/** Called after every row change on `table`. Returns an unsubscribe function. */
	subscribe(table: TableName, cb: (event: ChangeEvent) => void): () => void;

	// Actions
	/**
	 * Claim the empty CFO seat for this browser with the one-time Bootstrap secret from the claim link. The module
	 * refuses a wrong, expired or used secret, and any claim once the seat is held. Demo mode: the viewer is already
	 * the CFO, so this refuses.
	 */
	claimCfo(secret: string, displayName: string): Promise<void>;
	/** Kick off the month-end close: agents start proposing and debating. */
	startClose(periodId: string): Promise<void>;
	/** CFO confirms an Advisor ruling that is above the Materiality threshold. */
	cfoConfirm(proposalId: string): Promise<void>;
	/** CFO sends a Proposal back to its worker agent with a one-line note. */
	cfoSendBack(proposalId: string, notePlain: string): Promise<void>;
	/**
	 * CFO reverses a posted Journal Entry: posts an equal and opposite entry in the entry's own month if that month is
	 * open, otherwise in the earliest open month after it.
	 */
	cfoReverse(jeId: string, reasonPlain: string): Promise<void>;
	setMateriality(minor: Minor): Promise<void>;
	setCloseTaskStatus(taskId: string, status: CloseTaskStatus): Promise<void>;
	/** CFO locks the Period. The Board Pack becomes final. */
	lockPeriod(periodId: string): Promise<void>;
	/** CFO unlocks a locked Period so it can be posted to again. The reason goes to the audit log. */
	unlockPeriod(periodId: string, reasonPlain: string): Promise<void>;
	/** Demo mode only: restore every table to the seed. */
	resetDemo?(): void;
}
