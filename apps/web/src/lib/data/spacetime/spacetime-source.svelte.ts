// Live DataSource: the ledger database over a websocket subscription.
// Every table is mirrored into `$state` arrays of UI rows; reducer calls are
// the CFO's actions. Starting a close goes to the agent gateway over HTTP.
import { DbConnection } from '../../module_bindings';
import type { DataSet } from '../source';
import { byLabel, tableLabel } from '../data-sets';
import type { CfoSeat, ChangeEvent, ConnectionState, DataSource } from '../source';
import type * as U from '../types';
import * as M from './map';

const TOKEN_KEY = 'luyten.stdb.token';

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
	publicFootprint: 'public_footprint',
	settings: 'settings',
	fxRate: 'fx_rate',
	charterVersion: 'charter_version',
	charterEval: 'charter_eval'
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
	public_footprint: U.PublicFootprint[];
	settings: U.Settings;
	fx_rate: U.FxRate[];
	charter_version: U.CharterVersion[];
	charter_eval: U.CharterEval[];
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
	public_footprint: [],
	settings: { materialityThresholdMinor: '1000000', reportingCcy: 'USD', feedEnabled: false },
	fx_rate: [],
	charter_version: [],
	charter_eval: []
});

function readToken(): string | undefined {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

function saveToken(token: string): boolean {
	try {
		localStorage.setItem(TOKEN_KEY, token);
		return localStorage.getItem(TOKEN_KEY) === token;
	} catch {
		/* storage blocked: a new identity next visit, so a claimed CFO seat would not survive a reload */
		return false;
	}
}

/** Reducer errors carry a plain-English message; pass it through to the toast. */
function plain(err: unknown, fallback: string): Error {
	if (err instanceof Error && err.message) return new Error(err.message);
	if (typeof err === 'string' && err) return new Error(err);
	return new Error(fallback);
}

/** A table handle in the SDK's db view (a dotted accessor would be a namespace object instead). */
type TableHandle = {
	count(): number | bigint;
	iter(): Iterable<unknown>;
	onInsert?(cb: () => void): void;
	onDelete?(cb: () => void): void;
	onUpdate?(cb: () => void): void;
};
function isTable(t: unknown): t is TableHandle {
	return !!t && typeof (t as { count?: unknown }).count === 'function' && typeof (t as { iter?: unknown }).iter === 'function';
}

export class SpacetimeDataSource implements DataSource {
	readonly kind = 'live' as const;

	#t: Mirror = $state(empty());
	#company: M.Company = $state(M.emptyCompany());
	#companyDirty = false;
	#conn: ConnectionState = $state({ ledger: 'connecting', agents: 'unknown', closes: [] });
	#seat: CfoSeat = $state({ status: 'checking' });
	#tokenSaved = false;
	#gatewayProviders: U.ProviderStatus[] = $state([]);
	#poll: ReturnType<typeof setTimeout> | null = null;
	#db: DbConnection | null = null;
	#cfg: SpacetimeConfig;
	#subs = new Map<U.TableName, Set<(e: ChangeEvent) => void>>();
	#dirty = new Set<Accessor>();
	/** The Dash bar's raw reads: one version per table, so a change to one table redraws only that table, plus one
	 * for the list of tables and their counts. Changes are gathered for up to 150 ms, so a busy feed redraws calmly. */
	#rawVersions: Record<string, number> = $state({});
	#listVersion = $state(0);
	#rawPending = new Set<string>();
	#rawTimer: ReturnType<typeof setTimeout> | null = null;
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
	publicFootprints = () => this.#t.public_footprint;
	settings = () => this.#t.settings;
	fxRates = () => this.#t.fx_rate;
	charterVersions = () => this.#t.charter_version;
	charterEvals = () => this.#t.charter_eval;
	liveActivity = () => null;
	now = () => new Date().toISOString();
	connection = () => this.#conn;
	cfoSeat = () => this.#seat;
	// Every table the connection subscribed to (subscribeToAllTables), read straight from the SpacetimeDB client cache,
	// including the ones the screens never map (contract items, revenue schedule lines, the agent roster, feed events).
	// A short disconnect keeps the last rows on screen (the client cache outlives the socket); the page says it is offline.
	dataSets = (): DataSet[] => {
		void this.#listVersion;
		const view = this.#tableView();
		if (!view) return [];
		return Object.keys(view)
			.filter((id) => isTable(view[id]))
			.map((id) => ({ id, label: tableLabel(id), count: Number(view[id].count()) }))
			.sort(byLabel);
	};
	dataSetRows = (id: string): Record<string, unknown>[] => {
		void this.#rawVersions[id];
		const view = this.#tableView();
		if (!view || !Object.hasOwn(view, id) || !isTable(view[id])) return [];
		return Array.from(view[id].iter() as Iterable<Record<string, unknown>>);
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	#tableView(): Record<string, any> | null {
		if (!this.#db || this.#conn.ledger === 'connecting') return null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return this.#db.db as any;
	}
	#rawChanged(id: string) {
		this.#rawPending.add(id);
		this.#rawTimer ??= setTimeout(() => {
			this.#rawTimer = null;
			for (const t of this.#rawPending) this.#rawVersions[t] = (this.#rawVersions[t] ?? 0) + 1;
			this.#rawPending.clear();
			this.#listVersion++;
		}, 150);
	}

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
	// Financing, People, Cost of service, batches and the CRM are read-only in live mode: the module seeds them as
	// company records, and their actions (uploads, edits) still run in Demo mode only.
	documents = (): U.UploadedDocument[] => [];
	// Company records outside the ledger, seeded as JSON rows of the company_record table (read-only here).
	fundingRounds = () => this.#company.funding_round;
	investors = () => this.#company.investor;
	commitments = () => this.#company.commitment;
	instruments = () => this.#company.instrument;
	capTable = () => this.#company.cap_table_entry;
	employees = () => this.#company.employee;
	ptoRequests = () => this.#company.pto_request;
	payRuns = () => this.#company.pay_run;
	payslips = () => this.#company.payslip;
	cloudCosts = () => this.#company.cloud_cost;
	batches = () => this.#company.batch;
	integrations = () => this.#company.integration;
	deals = () => this.#company.deal;
	promotions = () => this.#company.promotion;
	supportTickets = () => this.#company.support_ticket;

	async uploadDemoDocument(): Promise<U.UploadedDocument> {
		throw new Error('Uploads work in Demo mode only for now.');
	}
	async connectIntegration(): Promise<void> {
		throw new Error('Connecting tools works in Demo mode only for now.');
	}
	async disconnectIntegration(): Promise<void> {
		throw new Error('Connecting tools works in Demo mode only for now.');
	}
	async decidePtoRequest(): Promise<void> {
		throw new Error('Time off works in Demo mode only for now.');
	}

	async claimCfo(secret: string, displayName: string): Promise<void> {
		if (!this.#db || this.#conn.ledger !== 'live') throw new Error('Not connected to the ledger database yet.');
		// The seat belongs to this connection's identity, which lives in the saved token. If the token cannot be kept,
		// the seat would be lost on the next reload and the one-time secret would be used up for nothing.
		if (!this.#tokenSaved) {
			throw new Error('This browser is blocking site storage, so it cannot keep the CFO seat after a reload. Allow storage for this site (or leave private browsing), then open the claim link again.');
		}
		try {
			await this.#db.reducers.claimCfo({ secret: secret.trim(), displayName: displayName.trim() || 'CFO' });
		} catch (err) {
			throw plain(err, 'Could not claim the CFO seat.');
		}
		// my_agent_identity now shows this connection as the CFO; its update refreshes the seat as well.
		this.#seatFrom(this.#db);
	}

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
			// The gateway answers a refusal (an earlier month not locked, a locked month) as { error: "<plain reason>" }.
			let reason = text;
			try {
				const body = JSON.parse(text) as { error?: unknown };
				if (typeof body?.error === 'string' && body.error.trim()) reason = body.error;
			} catch {
				/* not JSON: show the text as it came */
			}
			throw new Error(reason || `The agent gateway could not start the close (${res.status}).`);
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

	async setFeedEnabled(enabled: boolean): Promise<void> {
		await this.#call(enabled ? 'Could not switch the live feed on.' : 'Could not switch the live feed off.', (c) => c.reducers.setFeedEnabled({ enabled }));
		// The gateway's feeder notices the setting on its own; ask it straight away so the status line follows.
		void this.#pollStatus();
	}

	async setMateriality(minor: U.Minor): Promise<void> {
		await this.#call('Could not change the Materiality threshold.', (c) => c.reducers.setMateriality({ thresholdMinor: BigInt(minor) }));
	}

	async setCloseTaskStatus(taskId: string, status: U.CloseTaskStatus): Promise<void> {
		await this.#call('Could not update this Close Task.', (c) => c.reducers.updateCloseTask({ taskId: BigInt(taskId), status, note: '' }));
	}

	async acceptBankExceptions(periodId: string, expectedSnapshot: string, reasonPlain: string): Promise<void> {
		await this.#call('Could not accept the bank exceptions.', (c) => c.reducers.acceptBankExceptions({ periodYm: periodId, expectedSnapshot, reasonPlain }));
	}

	async lockPeriod(periodId: string): Promise<void> {
		await this.#call('Could not lock this Period.', (c) => c.reducers.lockPeriod({ periodYm: periodId, rationale: 'Locked by the CFO from the close checklist' }));
	}

	async unlockPeriod(periodId: string, reasonPlain: string): Promise<void> {
		await this.#call('Could not unlock this Period.', (c) => c.reducers.unlockPeriod({ periodYm: periodId, rationale: reasonPlain }));
	}

	// Charters: versions, publishing and retiring are module reducers; the catalog and the eval runner live on the gateway.
	async charterCatalog(): Promise<U.CharterCatalog> {
		return (await this.#gateway('GET', '/charters/catalog', 'Could not load the charter catalog from the agent gateway.')) as U.CharterCatalog;
	}

	async saveCharterDraft(d: { role: string; bodyMd: string; mapping: U.CharterMappingEntry[]; summaryPlain: string; basedOnVersionId?: string }): Promise<void> {
		await this.#call('Could not save this Charter draft.', (c) =>
			c.reducers.saveCharterDraft({
				role: d.role,
				bodyMd: d.bodyMd,
				mappingJson: JSON.stringify(d.mapping),
				summaryPlain: d.summaryPlain,
				basedOnVersionId: d.basedOnVersionId ? BigInt(d.basedOnVersionId) : undefined
			})
		);
	}

	async startCharterEval(versionId: string, mode: U.CharterEvalMode): Promise<U.CharterEvalRun> {
		this.#readOnlyCheck();
		return (await this.#gateway('POST', `/charters/${encodeURIComponent(versionId)}/eval`, 'The agent gateway could not start the eval.', { mode })) as U.CharterEvalRun;
	}

	async charterEvalRun(versionId: string): Promise<U.CharterEvalRun> {
		return (await this.#gateway('GET', `/charters/${encodeURIComponent(versionId)}/eval`, 'Could not read the eval status from the agent gateway.')) as U.CharterEvalRun;
	}

	async publishCharter(versionId: string, notePlain: string): Promise<void> {
		await this.#call('Could not publish this Charter version.', (c) => c.reducers.publishCharter({ charterVersionId: BigInt(versionId), notePlain }));
	}

	async retireLiveCharter(role: string, notePlain: string): Promise<void> {
		await this.#call('Could not restore the built-in Charter.', (c) => c.reducers.retireLiveCharter({ role, notePlain }));
	}

	/** One gateway request; its JSON error (or text) becomes the thrown message. */
	async #gateway(method: 'GET' | 'POST', path: string, fallback: string, body?: unknown): Promise<unknown> {
		let res: Response;
		try {
			res = await fetch(`${this.#cfg.gateway}${path}`, {
				method,
				...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {})
			});
		} catch {
			this.#conn.agents = 'offline';
			throw new Error('The agents are offline. Start the agent gateway, then try again.');
		}
		this.#conn.agents = 'online';
		const text = await res.text().catch(() => '');
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			parsed = undefined;
		}
		if (!res.ok) {
			const err = parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : text;
			throw new Error(err ? `${fallback} ${err.charAt(0).toUpperCase()}${err.slice(1)}.` : `${fallback} (${res.status})`);
		}
		if (parsed === undefined) throw new Error(fallback);
		return parsed;
	}

	#readOnlyCheck() {
		if (this.#seat.status === 'unclaimed') throw new Error('This browser is read-only: nobody has claimed the CFO seat yet. Open your claim link to claim it.');
		if (this.#seat.status === 'other') throw new Error('This browser is read-only: it does not hold the CFO seat. Use the browser that claimed it.');
	}

	/** Public web lookups run in the agent gateway (it holds the scraping credentials); never from the browser. */
	async collectFootprint(subjectKind: U.FootprintSubject, subjectId: string): Promise<void> {
		let res: Response;
		try {
			res = await fetch(`${this.#cfg.gateway}/footprint`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ subjectKind, subjectId })
			});
		} catch {
			this.#conn.agents = 'offline';
			throw new Error('The agents are offline. Start the agent gateway, then try again.');
		}
		this.#conn.agents = 'online';
		if (res.ok) return;
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error || (res.status === 409 ? 'A collection is already running for this business.' : `The agents could not start the collection (${res.status}).`));
	}

	async setListings(subjectKind: U.FootprintSubject, subjectId: string, l: U.Listings): Promise<void> {
		const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
		await this.#call('Could not save the public listings.', (c) =>
			c.reducers.setListings({ subjectKind, subjectId: BigInt(subjectId), yelpUrl: clean(l.yelpUrl), jobBoard: clean(l.jobBoard), linkedinUrl: clean(l.linkedinUrl) })
		);
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
				closes?: { periodYm: string; status: string; steps?: unknown; error?: unknown }[];
				providers?: { name: string; mode: string; detail?: string }[];
				feed?: { enabled?: boolean; ym?: string | null; planned?: number; ingested?: number; blockedReason?: string | null };
			};
			if (body.feed) {
				const f = body.feed;
				this.#conn.feed = { enabled: !!f.enabled, ym: f.ym ?? undefined, planned: f.planned ?? 0, ingested: f.ingested ?? 0, blockedReason: f.blockedReason ?? undefined };
			}
			this.#conn.agents = 'online';
			this.#conn.closes = (body.closes ?? []).map((c) => ({
				periodYm: c.periodYm,
				status: c.status === 'error' ? 'error' : c.status === 'running' ? 'running' : 'done',
				steps: Array.isArray(c.steps) ? c.steps.filter((s): s is string => typeof s === 'string') : undefined,
				error: typeof c.error === 'string' ? c.error : undefined
			}));
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
				this.#tokenSaved = saveToken(token);
				this.#wire(conn);
				conn
					.subscriptionBuilder()
					.onApplied(() => {
						for (const a of Object.keys(ACCESSORS) as Accessor[]) this.#dirty.add(a);
						this.#companyDirty = true;
						this.#flush();
						this.#listVersion++;
						for (const id of Object.keys(conn.db)) this.#rawVersions[id] = (this.#rawVersions[id] ?? 0) + 1;
						this.#conn.ledger = 'live';
						this.#seatFrom(conn);
					})
					.subscribeToAllTables();
				// The browser never registers itself as CFO: the module refuses that. The seat is claimed once with the
				// one-time Bootstrap secret on /claim, and stays with this identity through the saved token.
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
		const companyChanged = () => {
			this.#companyDirty = true;
			this.#queue();
		};
		conn.db.companyRecord.onInsert(companyChanged);
		conn.db.companyRecord.onDelete(companyChanged);
		// Any table, mapped or not, keeps the Dash bar's raw view current.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = conn.db as any;
		for (const id of Object.keys(view)) {
			if (!isTable(view[id])) continue;
			const bump = () => this.#rawChanged(id);
			view[id].onInsert?.(bump);
			view[id].onDelete?.(bump);
			view[id].onUpdate?.(bump);
		}
		// This connection's own role and the roster decide what the UI shows about the CFO seat.
		const seat = () => this.#queueSeat();
		for (const table of [conn.db.myAgentIdentity, conn.db.agentRoster]) {
			table.onInsert(seat);
			table.onDelete(seat);
		}
		conn.db.agentRoster.onUpdate(seat);
	}

	#seatQueued = false;
	#queueSeat() {
		if (this.#seatQueued) return;
		this.#seatQueued = true;
		queueMicrotask(() => {
			this.#seatQueued = false;
			if (this.#db) this.#seatFrom(this.#db);
		});
	}

	/**
	 * Who holds the CFO seat: my_agent_identity is this connection's own role (the module's per-caller view of the
	 * private agent_identity table), and agent_roster has a 'cfo' row once anyone claimed the seat. The module still
	 * checks every CFO action; this only decides the banner and the read-only message.
	 */
	#seatFrom(c: DbConnection) {
		if (this.#conn.ledger !== 'live') {
			this.#seat = { status: 'checking' };
			return;
		}
		const holder = Array.from(c.db.agentRoster.iter()).find((r) => r.role === 'cfo');
		const mine = Array.from(c.db.myAgentIdentity.iter()).some((r) => r.role.tag === 'Cfo');
		if (mine) this.#seat = { status: 'you', holderName: holder?.displayName };
		else if (holder) this.#seat = { status: 'other', holderName: holder.displayName };
		else this.#seat = { status: 'unclaimed' };
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
		if (d.has('publicFootprint')) t.public_footprint = all(c.db.publicFootprint.iter()).map(M.publicFootprint).sort(byTime('fetchedAt'));
		if (d.has('auditEvent')) t.audit_event = all(c.db.auditEvent.iter()).map(M.auditEvent).sort(byTime('at'));
		if (d.has('settings')) {
			const rows = all(c.db.settings.iter());
			const threshold = rows.find((s) => s.key === 'materiality_threshold_minor');
			const reporting = rows.find((s) => s.key === 'reporting_ccy');
			const feed = rows.find((s) => s.key === 'feed_enabled');
			t.settings = {
				materialityThresholdMinor: threshold ? threshold.valueI64.toString() : t.settings.materialityThresholdMinor,
				reportingCcy: reporting?.valueText || t.settings.reportingCcy,
				feedEnabled: feed ? feed.valueI64 === 1n : false
			};
		}
		if (d.has('fxRate')) t.fx_rate = all(c.db.fxRate.iter()).map(M.fxRate);
		if (d.has('charterVersion')) t.charter_version = all(c.db.charterVersion.iter()).map(M.charterVersion).sort((a, b) => a.role.localeCompare(b.role) || b.version - a.version);
		if (this.#companyDirty) {
			this.#companyDirty = false;
			this.#company = M.company(c.db.companyRecord.iter());
		}
		if (d.has('charterEval')) t.charter_eval = all(c.db.charterEval.iter()).map(M.charterEval).sort(byTime('ranAt'));
	}

	/**
	 * Run one of the CFO's reducers. The module decides who may act; a browser that does not hold the seat gets a plain
	 * read-only message instead of the module's refusal.
	 */
	async #call(fallback: string, fn: (c: DbConnection) => Promise<unknown>) {
		if (!this.#db || this.#conn.ledger !== 'live') throw new Error('Not connected to the ledger database yet.');
		this.#readOnlyCheck();
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
