// Live DataSource: the ledger database over a websocket subscription.
// Every table is mirrored into `$state` arrays of UI rows; reducer calls are
// the CFO's actions. Starting a close goes to the agent gateway over HTTP.
import { DbConnection } from '../../module_bindings';
import type { ChangeEvent, ConnectionState, DataSource } from '../source';
import type * as U from '../types';
import * as M from './map';

const TOKEN_KEY = 'cafoo.stdb.token';

export interface SpacetimeConfig {
	uri: string;
	database: string;
	gateway: string;
}

/** Client table accessor to UI table name. Tables not listed are not mirrored. */
const ACCESSORS = {
	subsidiary: 'subsidiary',
	account: 'account',
	period: 'period',
	periodLock: 'period',
	journalEntry: 'journal_entry',
	journalLine: 'journal_line',
	customer: 'customer',
	contract: 'contract',
	invoice: 'invoice',
	vendor: 'vendor',
	bill: 'bill',
	bankTransaction: 'bank_transaction',
	bankMatch: 'bank_match',
	proposal: 'proposal',
	approval: 'approval',
	agentMessage: 'agent_message',
	closeTask: 'close_task',
	creditCheck: 'credit_check',
	auditEvent: 'audit_event',
	settings: 'settings'
} as const satisfies Record<string, U.TableName>;

type Accessor = keyof typeof ACCESSORS;

interface Mirror {
	subsidiary: U.Subsidiary[];
	account: U.Account[];
	period: U.Period[];
	journal_entry: U.JournalEntry[];
	journal_line: U.JournalLine[];
	customer: U.Customer[];
	contract: U.Contract[];
	invoice: U.Invoice[];
	vendor: U.Vendor[];
	bill: U.Bill[];
	bank_transaction: U.BankTransaction[];
	bank_match: U.BankMatch[];
	proposal: U.Proposal[];
	approval: U.Approval[];
	agent_message: U.AgentMessage[];
	close_task: U.CloseTask[];
	credit_check: U.CreditCheck[];
	audit_event: U.AuditEvent[];
	settings: U.Settings;
}

const empty = (): Mirror => ({
	subsidiary: [],
	account: [],
	period: [],
	journal_entry: [],
	journal_line: [],
	customer: [],
	contract: [],
	invoice: [],
	vendor: [],
	bill: [],
	bank_transaction: [],
	bank_match: [],
	proposal: [],
	approval: [],
	agent_message: [],
	close_task: [],
	credit_check: [],
	audit_event: [],
	settings: { materialityThresholdMinor: '1000000' }
});

function readToken(): string | undefined {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

function saveToken(token: string) {
	try {
		localStorage.setItem(TOKEN_KEY, token);
	} catch {
		/* storage blocked: a new identity next visit, which is fine for the CFO seat */
	}
}

/** Reducer errors carry a plain-English message; pass it through to the toast. */
function plain(err: unknown, fallback: string): Error {
	if (err instanceof Error && err.message) return new Error(err.message);
	if (typeof err === 'string' && err) return new Error(err);
	return new Error(fallback);
}

export class SpacetimeDataSource implements DataSource {
	readonly kind = 'live' as const;

	#t: Mirror = $state(empty());
	#conn: ConnectionState = $state({ ledger: 'connecting', agents: 'unknown', closes: [] });
	#gatewayProviders: U.ProviderStatus[] = $state([]);
	#poll: ReturnType<typeof setTimeout> | null = null;
	#db: DbConnection | null = null;
	#cfg: SpacetimeConfig;
	#subs = new Map<U.TableName, Set<(e: ChangeEvent) => void>>();
	#dirty = new Set<Accessor>();
	#flushQueued = false;

	constructor(cfg: SpacetimeConfig) {
		this.#cfg = cfg;
		if (typeof window !== 'undefined') {
			this.#connect();
			void this.#pollStatus();
		}
	}

	// Reads
	subsidiaries = () => this.#t.subsidiary;
	accounts = () => this.#t.account;
	periods = () => this.#t.period;
	journalEntries = () => this.#t.journal_entry;
	journalLines = () => this.#t.journal_line;
	customers = () => this.#t.customer;
	contracts = () => this.#t.contract;
	invoices = () => this.#t.invoice;
	vendors = () => this.#t.vendor;
	bills = () => this.#t.bill;
	bankTransactions = () => this.#t.bank_transaction;
	bankMatches = () => this.#t.bank_match;
	proposals = () => this.#t.proposal;
	approvals = () => this.#t.approval;
	agentMessages = () => this.#t.agent_message;
	closeTasks = () => this.#t.close_task;
	creditChecks = () => this.#t.credit_check;
	auditEvents = () => this.#t.audit_event;
	settings = () => this.#t.settings;
	liveActivity = () => null;
	now = () => new Date().toISOString();
	connection = () => this.#conn;
	providers = (): U.ProviderStatus[] => [
		{ id: 'ledger', name: 'Ledger database', purpose: 'Books, Proposals and the agent message bus', mode: 'live', detail: `${this.#cfg.uri} / ${this.#cfg.database} (${this.#conn.ledger})` },
		{ id: 'agents', name: 'Agent gateway', purpose: 'Starts the close; runs the worker agents, Red Team and Advisor', mode: 'live', detail: `${this.#cfg.gateway} (${this.#conn.agents})` },
		...this.#gatewayProviders
	];

	subscribe(table: U.TableName, cb: (e: ChangeEvent) => void): () => void {
		let set = this.#subs.get(table);
		if (!set) this.#subs.set(table, (set = new Set()));
		set.add(cb);
		return () => set.delete(cb);
	}

	// Actions
	async startClose(periodId: string): Promise<void> {
		let res: Response;
		try {
			res = await fetch(`${this.#cfg.gateway}/close`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ periodYm: periodId })
			});
		} catch {
			this.#conn.agents = 'offline';
			throw new Error('The agents are offline. Start the agent gateway, then try again.');
		}
		if (!res.ok) {
			this.#conn.agents = 'online';
			const text = await res.text().catch(() => '');
			throw new Error(text || `The agent gateway could not start the close (${res.status}).`);
		}
		this.#conn.agents = 'online';
		void this.#pollStatus();
	}

	async cfoConfirm(proposalId: string): Promise<void> {
		await this.#call('Could not approve this Proposal.', (c) => c.reducers.cfoConfirm({ proposalId: BigInt(proposalId), note: '' }));
	}

	async cfoSendBack(proposalId: string, notePlain: string): Promise<void> {
		await this.#call('Could not send this Proposal back.', (c) => c.reducers.cfoSendBack({ proposalId: BigInt(proposalId), notePlain }));
	}

	async cfoReverse(jeId: string, reasonPlain: string): Promise<void> {
		await this.#call('Could not reverse this Journal Entry.', (c) => c.reducers.cfoReverse({ jeId: BigInt(jeId), reasonPlain }));
	}

	async setMateriality(minor: U.Minor): Promise<void> {
		await this.#call('Could not change the Materiality threshold.', (c) => c.reducers.setMateriality({ thresholdMinor: BigInt(minor) }));
	}

	async setCloseTaskStatus(taskId: string, status: U.CloseTaskStatus): Promise<void> {
		await this.#call('Could not update this Close Task.', (c) => c.reducers.updateCloseTask({ taskId: BigInt(taskId), status, note: '' }));
	}

	async lockPeriod(periodId: string): Promise<void> {
		await this.#call('Could not lock this Period.', (c) => c.reducers.lockPeriod({ periodYm: periodId, rationale: 'Locked by the CFO from the close checklist' }));
	}

	async unlockPeriod(periodId: string, reasonPlain: string): Promise<void> {
		await this.#call('Could not unlock this Period.', (c) => c.reducers.unlockPeriod({ periodYm: periodId, rationale: reasonPlain }));
	}

	/**
	 * Ask the gateway which closes exist. Re-polls every 3 s while one is running,
	 * then stops. Called on startup and after starting a close.
	 */
	async #pollStatus() {
		if (this.#poll) {
			clearTimeout(this.#poll);
			this.#poll = null;
		}
		try {
			const res = await fetch(`${this.#cfg.gateway}/status`);
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as {
				closes?: { periodYm: string; status: string }[];
				providers?: { name: string; mode: string; detail?: string }[];
			};
			this.#conn.agents = 'online';
			this.#conn.closes = (body.closes ?? []).map((c) => ({ periodYm: c.periodYm, status: c.status === 'running' ? 'running' : 'done' }));
			this.#gatewayProviders = (body.providers ?? [])
				.filter((p) => !/spacetime/i.test(p.name))
				.map((p, i) => ({ id: `gw-${i}`, name: p.name, purpose: 'Reported by the agent gateway', mode: p.mode === 'live' ? 'live' : 'demo', detail: p.detail ?? '' }));
		} catch {
			this.#conn.agents = 'offline';
		}
		if (this.#conn.closes.some((c) => c.status === 'running')) this.#poll = setTimeout(() => void this.#pollStatus(), 3000);
	}

	// Connection
	#connect() {
		this.#conn.ledger = 'connecting';
		this.#db = DbConnection.builder()
			.withUri(this.#cfg.uri)
			.withDatabaseName(this.#cfg.database)
			.withToken(readToken())
			.onConnect((conn, _identity, token) => {
				saveToken(token);
				this.#wire(conn);
				conn
					.subscriptionBuilder()
					.onApplied(() => {
						for (const a of Object.keys(ACCESSORS) as Accessor[]) this.#dirty.add(a);
						this.#flush();
						this.#conn.ledger = 'live';
					})
					.subscribeToAllTables();
				// The browser is the CFO seat. A second browser reuses the token, so
				// "role already held" is expected and harmless.
				conn.reducers.registerAgent({ role: { tag: 'Cfo' }, displayName: 'CFO', model: 'human' }).catch(() => {});
			})
			.onConnectError((_ctx, err) => {
				this.#conn.ledger = 'offline';
				this.#conn.message = err?.message || 'Cannot reach the ledger database.';
			})
			.onDisconnect(() => {
				this.#conn.ledger = 'offline';
				this.#conn.message = 'Disconnected from the ledger database.';
			})
			.build();
	}

	#wire(conn: DbConnection) {
		for (const a of Object.keys(ACCESSORS) as Accessor[]) {
			// The table handles share one shape; the per-table generics are not needed here.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const table = (conn.db as any)[a];
			if (!table) continue;
			const mark = (kind: ChangeEvent['kind']) => (_ctx: unknown, row: unknown, newRow?: unknown) => {
				this.#dirty.add(a);
				this.#queue();
				this.#emit(ACCESSORS[a], kind, newRow ?? row);
			};
			table.onInsert?.(mark('insert'));
			table.onDelete?.(mark('delete'));
			table.onUpdate?.(mark('update'));
		}
	}

	#queue() {
		if (this.#flushQueued) return;
		this.#flushQueued = true;
		queueMicrotask(() => {
			this.#flushQueued = false;
			this.#flush();
		});
	}

	/** Rebuild the UI mirror for every table that changed since the last flush. */
	#flush() {
		const c = this.#db;
		if (!c) return;
		const d = this.#dirty;
		this.#dirty = new Set();
		const all = <T>(it: Iterable<T>) => Array.from(it);
		const periodsChanged = d.has('period') || d.has('periodLock');
		const periodRows = all(c.db.period.iter());
		const ym: M.PeriodYm = new Map(periodRows.map((p) => [String(p.id), p.ym]));
		const t = this.#t;

		if (periodsChanged) {
			const locks = all(c.db.periodLock.iter());
			t.period = periodRows.map((p) => M.period(p, locks)).sort((a, b) => a.id.localeCompare(b.id));
		}
		if (d.has('subsidiary')) t.subsidiary = all(c.db.subsidiary.iter()).map(M.subsidiary);
		if (d.has('account')) t.account = all(c.db.account.iter()).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)).map(M.account);
		if (d.has('journalEntry') || periodsChanged) t.journal_entry = all(c.db.journalEntry.iter()).map((r) => M.journalEntry(r, ym)).sort(byTime('postedAt'));
		if (d.has('journalLine')) t.journal_line = all(c.db.journalLine.iter()).map(M.journalLine);
		if (d.has('customer')) t.customer = all(c.db.customer.iter()).map(M.customer).sort((a, b) => a.name.localeCompare(b.name));
		if (d.has('contract')) t.contract = all(c.db.contract.iter()).map(M.contract);
		if (d.has('invoice')) t.invoice = all(c.db.invoice.iter()).map(M.invoice);
		if (d.has('vendor')) t.vendor = all(c.db.vendor.iter()).map(M.vendor).sort((a, b) => a.name.localeCompare(b.name));
		if (d.has('bill')) t.bill = all(c.db.bill.iter()).map(M.bill);
		if (d.has('bankTransaction')) t.bank_transaction = all(c.db.bankTransaction.iter()).map(M.bankTransaction).sort(byTime('bookedAt'));
		if (d.has('bankMatch')) t.bank_match = all(c.db.bankMatch.iter()).map(M.bankMatch);
		if (d.has('proposal') || periodsChanged) t.proposal = all(c.db.proposal.iter()).map((r) => M.proposal(r, ym)).sort(byTime('createdAt'));
		if (d.has('approval')) t.approval = all(c.db.approval.iter()).map(M.approval);
		if (d.has('agentMessage')) t.agent_message = all(c.db.agentMessage.iter()).map(M.agentMessage).sort(byTime('createdAt'));
		if (d.has('closeTask') || periodsChanged) t.close_task = all(c.db.closeTask.iter()).map((r) => M.closeTask(r, ym)).sort((a, b) => a.order - b.order);
		if (d.has('creditCheck')) t.credit_check = all(c.db.creditCheck.iter()).map(M.creditCheck);
		if (d.has('auditEvent')) t.audit_event = all(c.db.auditEvent.iter()).map(M.auditEvent).sort(byTime('at'));
		if (d.has('settings')) {
			const row = all(c.db.settings.iter()).find((s) => s.key === 'materiality_threshold_minor');
			if (row) t.settings = { materialityThresholdMinor: row.valueI64.toString() };
		}
	}

	async #call(fallback: string, fn: (c: DbConnection) => Promise<unknown>) {
		if (!this.#db || this.#conn.ledger !== 'live') throw new Error('Not connected to the ledger database yet.');
		try {
			await fn(this.#db);
		} catch (err) {
			throw plain(err, fallback);
		}
	}

	#emit(table: U.TableName, kind: ChangeEvent['kind'], row: unknown) {
		const set = this.#subs.get(table);
		if (!set) return;
		for (const cb of set) {
			try {
				cb({ table, kind, row });
			} catch (err) {
				console.error(err);
			}
		}
	}
}

function byTime<K extends string>(key: K) {
	return (a: Record<K, string>, b: Record<K, string>) => a[key].localeCompare(b[key]);
}
