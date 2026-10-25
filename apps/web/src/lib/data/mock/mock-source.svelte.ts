// In-memory DataSource for Demo mode. Tables live in Svelte 5 `$state`, so every
// read is reactive. Actions mutate rows the way the ledger reducers would.
//
// Period status follows the live module: 'open' while agents work, 'closing' once
// the Advisor has requested the lock (every Proposal resolved), 'closed' once the
// CFO locks it.
import type { CfoSeat, ChangeEvent, ConnectionState, DataSource } from '../source';
import type {
	AgentMessage,
	AgentRole,
	BankMatch,
	CharterCatalog,
	CharterEvalMode,
	CharterEvalRun,
	CharterMappingEntry,
	CloseTaskStatus,
	FootprintSource,
	FootprintSubject,
	JournalLine,
	Listings,
	LiveActivity,
	Minor,
	Proposal,
	ProviderStatus,
	PublicFootprint,
	TableName
} from '../types';
import { editorProblems } from '../../charter';
import { eliminations, formatMinor, isBankReconciliationTask, revaluation, translate, ymFromString, type JournalEntryInput } from '@cafoo/ledger-core';
import { bankExceptionState } from '../../close';
import { toCore } from '../group';
import { roleName } from '../../labels';
import catalogJson from './seed/charters.json';
import { formatMoney, toBig } from '../money';
import { journalLinesOf, parsePayload } from '../payload';
import { accountIdFor, loadSeed, type Tables } from './seed';
import { CLOSE_SCRIPT, type ScriptLine, type Step } from './script';

/** The demo's "now": the morning of October 2, 2026, ticking in real time. */
const DEMO_EPOCH = Date.parse('2026-10-02T11:00:00Z');

const PROVIDERS: ProviderStatus[] = [
	{ id: 'ledger', name: 'Ledger database', purpose: 'Books, Proposals and the agent message bus', mode: 'demo', detail: 'In-browser tables seeded from fixtures' },
	{ id: 'advisor-model', name: 'Advisor and worker models', purpose: 'Proposals, rulings and Plain summaries', mode: 'demo', detail: 'Recorded transcript replayed on Close' },
	{ id: 'redteam-model', name: 'Red Team model', purpose: 'Critiques on a second model', mode: 'demo', detail: 'Recorded critiques' },
	{ id: 'gemini', name: 'Google Gemini', purpose: "The Red Team's second critic: adds what the first critique missed", mode: 'demo', detail: 'Scripted critiques' },
	{ id: 'bank-feed', name: 'Bank feed', purpose: 'Daily bank transactions', mode: 'demo', detail: '30 September transactions from fixtures' },
	{ id: 'credit-cascade', name: 'Credit check cascade', purpose: 'Identity, fraud, credit report, public records', mode: 'demo', detail: 'Sandbox personas, stored request ids' },
	{ id: 'public-web', name: 'Public web data', purpose: 'What a logged-out visitor sees about a customer or vendor', mode: 'demo', detail: 'Recorded Yelp, job board and LinkedIn pages' },
	{ id: 'email', name: 'Email delivery', purpose: 'Board Pack and dunning emails', mode: 'demo', detail: 'Emails are written to the audit log, not sent' }
];

/** Statuses that no longer block the close. 'sent_back' is NOT one: the agent owes a resubmission. */
const RESOLVED: Proposal['status'][] = ['approved', 'rejected', 'amended', 'superseded'];
const UNRESOLVED: Proposal['status'][] = ['open', 'awaiting_cfo', 'sent_back'];
const closeThread = (ym: string) => `close:${ym}`;

export class MockDataSource implements DataSource {
	readonly kind = 'mock' as const;

	#t: Tables = $state(loadSeed());
	#activity: LiveActivity | null = $state(null);
	#closes: ConnectionState['closes'] = $state([]);
	#subs = new Map<TableName, Set<(e: ChangeEvent) => void>>();
	#timers: ReturnType<typeof setTimeout>[] = [];
	#boot = Date.now();
	#seq = 0;
	#evalRuns = new Map<string, CharterEvalRun>();
	#collecting = new Set<string>();

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
	providers = () => PROVIDERS;
	liveActivity = () => this.#activity;
	now = () => this.#now();
	connection = (): ConnectionState => ({
		ledger: 'demo',
		agents: 'online',
		closes: this.#closes,
		feed: { enabled: this.#t.settings.feedEnabled, planned: 0, ingested: 0, blockedReason: 'Demo mode has no live feed; connect the ledger and the agent gateway to stream bank lines and invoices.' }
	});
	/** Demo mode has one viewer, and they are the CFO. */
	cfoSeat = (): CfoSeat => ({ status: 'you', holderName: 'CFO' });

	subscribe(table: TableName, cb: (e: ChangeEvent) => void): () => void {
		let set = this.#subs.get(table);
		if (!set) this.#subs.set(table, (set = new Set()));
		set.add(cb);
		return () => set.delete(cb);
	}

	// Actions
	async claimCfo(): Promise<void> {
		throw new Error('Demo mode has no seat to claim: you are already the CFO. Claim links are for the live ledger.');
	}

	async startClose(periodId: string): Promise<void> {
		const period = this.#t.period.find((p) => p.id === periodId);
		if (!period) throw new Error(`Unknown period ${periodId}`);
		if (period.status !== 'open') throw new Error('This period is already locked or waiting for your lock.');
		if (this.#closes.some((c) => c.periodYm === periodId)) return;
		this.#closes.push({ periodYm: periodId, status: 'running' });
		this.#audit('cfo', 'close.start', 'period', periodId, {});
		for (const step of CLOSE_SCRIPT) {
			this.#timers.push(setTimeout(() => this.#run(step, periodId), step.at));
		}
	}

	async cfoConfirm(proposalId: string): Promise<void> {
		const p = this.#proposal(proposalId);
		if (p.status !== 'awaiting_cfo') throw new Error('Only rulings awaiting your confirmation can be confirmed.');
		p.status = 'approved';
		this.#emit('proposal', 'update', p);
		const approval = this.#t.approval.find((a) => a.proposalId === proposalId);
		if (approval) {
			approval.cfoConfirmedAt = this.#now();
			this.#emit('approval', 'update', approval);
		}
		this.#message({ proposalId, role: 'cfo', kind: 'statement', body: `CONFIRM ${proposalId}.`, summary: 'You confirmed it.' });
		this.#audit('cfo', 'proposal.confirm', 'proposal', proposalId, {});
		this.#applyApproved(p);
		this.#settle(p.periodId);
	}

	async cfoSendBack(proposalId: string, notePlain: string): Promise<void> {
		const p = this.#proposal(proposalId);
		if (p.status !== 'awaiting_cfo') throw new Error('Only rulings awaiting your confirmation can be sent back.');
		const note = notePlain.trim() || 'Please take another look.';
		p.status = 'sent_back';
		this.#emit('proposal', 'update', p);
		this.#message({ proposalId, role: 'cfo', kind: 'statement', body: `Sent back: ${note}`, summary: `You sent it back: ${note}` });
		this.#audit('cfo', 'proposal.send_back', 'proposal', proposalId, { note });
		this.#settle(p.periodId);
		this.#later(1500, () =>
			this.#message({
				proposalId,
				role: p.proposerRole,
				kind: 'statement',
				body: `Acknowledged CFO note on ${proposalId}: "${note}". Gathering evidence; will resubmit as a new proposal.`,
				summary: 'Understood. I will look again and resubmit.'
			})
		);
		this.#later(4500, () => this.#resubmit(p, note));
	}

	/**
	 * Posts in the entry's own month if it is open, otherwise in the earliest open month after it, and undoes the bank
	 * reconciliation the entry carries. Refused while that bank line's month is locked, as the ledger module does.
	 */
	async cfoReverse(jeId: string, reasonPlain: string): Promise<void> {
		const je = this.#t.journal_entry.find((j) => j.id === jeId);
		if (!je) throw new Error(`Unknown journal entry ${jeId}`);
		if (je.source === 'manual' && je.reversesJeId) throw new Error('This entry is itself a reversal. Post a new entry instead of reversing it.');
		if (this.#t.journal_entry.some((j) => j.reversesJeId === jeId && j.source !== 'agent')) throw new Error('This entry was already reversed.');
		const open = this.#t.period
			.filter((p) => p.id >= je.periodId && p.status !== 'closed')
			.sort((a, b) => a.id.localeCompare(b.id))[0];
		if (!open) throw new Error(`Period ${je.periodId} and every later period are locked. Unlock one before reversing.`);
		const owned = this.#t.bank_match.filter((m) => (m.targetKind === 'journal_entry' && m.targetId === jeId) || m.paymentJeId === jeId);
		for (const m of owned) {
			const tx = this.#t.bank_transaction.find((t) => t.id === m.bankTransactionId);
			if (tx && this.#t.period.find((p) => p.id === tx.ym)?.status === 'closed') {
				throw new Error(`Reversing this entry would undo the bank reconciliation of ${tx.ym}, which is locked: bank line "${tx.description}" would go back to unmatched. Unlock ${tx.ym} first, or correct it with a new entry.`);
			}
		}
		const lines = this.#t.journal_line.filter((l) => l.jeId === jeId).map((l) => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor }));
		const reason = reasonPlain.trim() || 'Reversed by the CFO';
		const id = this.#postEntry({ periodId: open.id, memo: `Reversal of "${je.memo}": ${reason}`, source: 'manual', postedByRole: 'cfo', reversesJeId: jeId, lines });
		this.#unwind(owned);
		this.#audit('cfo', 'journal_entry.reverse', 'journal_entry', jeId, { reversalId: id, reason, unmatched: owned.length });
	}

	/** A reversed entry's bank matches go away: the bank lines are unmatched again and what they paid is unpaid. */
	#unwind(owned: BankMatch[]) {
		for (const m of owned) {
			this.#t.bank_match = this.#t.bank_match.filter((x) => x.id !== m.id);
			this.#emit('bank_match', 'delete', m);
			const tx = this.#t.bank_transaction.find((t) => t.id === m.bankTransactionId);
			if (tx?.matched) {
				tx.matched = false;
				this.#emit('bank_transaction', 'update', tx);
			}
			if (this.#t.bank_match.some((x) => x.targetKind === m.targetKind && x.targetId === m.targetId)) continue;
			const doc = m.targetKind === 'invoice' ? this.#t.invoice.find((i) => i.id === m.targetId) : m.targetKind === 'bill' ? this.#t.bill.find((b) => b.id === m.targetId) : undefined;
			if (doc?.status === 'paid') {
				doc.status = doc.dueAt < this.#now() ? 'overdue' : 'open';
				this.#emit(m.targetKind === 'invoice' ? 'invoice' : 'bill', 'update', doc);
			}
		}
	}

	async setFeedEnabled(enabled: boolean): Promise<void> {
		this.#t.settings.feedEnabled = enabled;
		this.#emit('settings', 'update', this.#t.settings);
		this.#audit('cfo', 'set_feed_enabled', 'settings', 'feed_enabled', { enabled });
	}

	async setMateriality(minor: Minor): Promise<void> {
		const from = this.#t.settings.materialityThresholdMinor;
		this.#t.settings.materialityThresholdMinor = toBig(minor).toString();
		this.#emit('settings', 'update', this.#t.settings);
		this.#audit('cfo', 'settings.materiality', 'settings', 'materiality', { from, to: minor });
	}

	async setCloseTaskStatus(taskId: string, status: CloseTaskStatus): Promise<void> {
		const task = this.#t.close_task.find((t) => t.id === taskId);
		if (!task) throw new Error(`Unknown close task ${taskId}`);
		task.status = status === 'done' && isBankReconciliationTask({ ownerRole: task.ownerRole, sortOrder: task.order, title: task.title }) && bankExceptionState(this, task.periodId).rows.length ? 'in_progress' : status;
		this.#emit('close_task', 'update', task);
		this.#audit('cfo', 'close_task.status', 'close_task', taskId, { status: task.status });
	}

	async acceptBankExceptions(periodId: string, expectedSnapshot: string, reasonPlain: string): Promise<void> {
		const period = this.#t.period.find((p) => p.id === periodId);
		if (!period) throw new Error(`Unknown period ${periodId}`);
		if (period.status === 'closed') throw new Error('Unlock this Period before reviewing bank exceptions.');
		const reason = reasonPlain.trim();
		if (!reason) throw new Error('Give a reason for accepting the unresolved bank exceptions.');
		const state = bankExceptionState(this, periodId);
		if (!state.rows.length) throw new Error('No unmatched bank exceptions remain through this Period.');
		if (expectedSnapshot !== state.snapshot) throw new Error('The bank exceptions changed since you reviewed them. Refresh and review the current lines before accepting.');
		this.#audit('cfo', 'accept_bank_exceptions', 'period', periodId, { periodYm: periodId, snapshot: state.snapshot, reasonPlain: reason });
		for (const task of this.#t.close_task.filter((t) => t.periodId === periodId && t.status === 'done' && isBankReconciliationTask({ ownerRole: t.ownerRole, sortOrder: t.order, title: t.title }))) {
			task.status = 'in_progress';
			this.#emit('close_task', 'update', task);
		}
		this.#settle(periodId);
	}

	async lockPeriod(periodId: string): Promise<void> {
		const period = this.#t.period.find((p) => p.id === periodId);
		if (!period) throw new Error(`Unknown period ${periodId}`);
		if (period.status === 'closed') throw new Error('This period is already locked.');
		const unresolved = this.#t.proposal.filter((p) => p.periodId === periodId && UNRESOLVED.includes(p.status));
		if (unresolved.length) {
			const sentBack = unresolved.filter((p) => p.status === 'sent_back').length;
			throw new Error(
				sentBack
					? `${sentBack} sent-back item${sentBack === 1 ? ' is' : 's are'} still waiting for the agent to resubmit.`
					: `${unresolved.length} item${unresolved.length === 1 ? ' is' : 's are'} not resolved yet.`
			);
		}
		const blocked = this.#t.close_task.filter((t) => t.periodId === periodId && t.status === 'blocked');
		if (blocked.length) throw new Error(`${blocked.length} Close Task${blocked.length === 1 ? ' is' : 's are'} blocked.`);
		const bank = bankExceptionState(this, periodId);
		if (bank.rows.length && !bank.acceptance.accepted) throw new Error('Unmatched bank lines need your explicit acceptance before locking.');
		const pending = this.#t.close_task.filter((t) => t.periodId === periodId && t.ownerRole !== 'advisor' && t.ownerRole !== 'cfo' && t.status !== 'done');
		if (period.status !== 'closing' && pending.length) throw new Error('Finish every close task before locking.');
		period.status = 'closed';
		period.lockedAt = this.#now();
		this.#emit('period', 'update', period);
		for (const t of this.#t.close_task.filter((t) => t.periodId === periodId && t.status !== 'done')) {
			if (bank.rows.length && isBankReconciliationTask({ ownerRole: t.ownerRole, sortOrder: t.order, title: t.title })) continue;
			t.status = 'done';
			this.#emit('close_task', 'update', t);
		}
		this.#message({ role: 'cfo', kind: 'statement', body: `LOCK ${periodId}.`, summary: 'You locked the period. The Board Pack is final.', threadId: closeThread(periodId) });
		this.#audit('cfo', 'period.lock', 'period', periodId, {});
	}

	async unlockPeriod(periodId: string, reasonPlain: string): Promise<void> {
		const period = this.#t.period.find((p) => p.id === periodId);
		if (!period) throw new Error(`Unknown period ${periodId}`);
		if (period.status !== 'closed') throw new Error(`Period ${periodId} is not locked.`);
		const reason = reasonPlain.trim() || 'Unlocked by the CFO';
		period.status = 'open';
		period.lockedAt = undefined;
		this.#emit('period', 'update', period);
		this.#message({ role: 'cfo', kind: 'statement', body: `UNLOCK ${periodId}: ${reason}`, summary: `You unlocked the period: ${reason}`, threadId: closeThread(periodId) });
		this.#audit('cfo', 'unlock_period', 'period', periodId, { reason });
	}

	// Charters. Demo mode has no eval runner: an eval checks the line mapping the way the editor does (every line mapped,
	// every shipped rule kept) and replays the steps a real run reports. The publish and retire rules are the module's.
	async charterCatalog(): Promise<CharterCatalog> {
		return structuredClone(catalogJson) as unknown as CharterCatalog;
	}

	async saveCharterDraft(d: { role: string; bodyMd: string; mapping: CharterMappingEntry[]; summaryPlain: string; basedOnVersionId?: string }): Promise<void> {
		if (!d.bodyMd.trim()) throw new Error('A charter needs its text.');
		if (d.summaryPlain.trim().length < 10) throw new Error('Every charter draft needs a plain-English summary of the change.');
		const version = this.#t.charter_version.filter((v) => v.role === d.role).reduce((a, v) => Math.max(a, v.version), 0) + 1;
		const row = {
			id: this.#id('cv'),
			role: d.role,
			version,
			status: 'draft' as const,
			bodyMd: d.bodyMd,
			mappingJson: JSON.stringify(d.mapping),
			summaryPlain: d.summaryPlain.trim(),
			basedOnVersionId: d.basedOnVersionId,
			authoredByRole: 'cfo',
			createdAt: this.#now()
		};
		this.#t.charter_version.push(row);
		this.#emit('charter_version', 'insert', row);
		this.#audit('cfo', 'save_charter_draft', 'charter_version', row.id, { role: d.role, version });
	}

	async startCharterEval(versionId: string, mode: CharterEvalMode): Promise<CharterEvalRun> {
		const v = this.#t.charter_version.find((x) => x.id === versionId);
		if (!v) throw new Error(`There is no charter version ${versionId}.`);
		if (v.status === 'live') throw new Error(`Version ${v.version} of the ${v.role} charter is already published.`);
		if ([...this.#evalRuns.values()].some((r) => r.status === 'running')) throw new Error('Another eval is still running; wait for it to finish.');
		const run: CharterEvalRun = { versionId, status: 'running', mode, steps: [], startedAt: this.#now() };
		this.#evalRuns.set(versionId, run);
		const live = () => this.#evalRuns.get(versionId)!;
		const steps = mode === 'dry_run'
			? ['Checking that every line is mapped to a rule or a scenario', 'Publishing a fresh ledger to the scratch database', 'Loading the demo company', `Running the 2026-09 close with the draft ${v.role} charter`, 'Running the eval scenarios on the dry-run close']
			: ['Checking that every line is mapped to a rule or a scenario', 'Running the eval scenarios on the recorded close'];
		steps.forEach((m, i) => this.#later(700 * (i + 1), () => live().steps.push(m)));
		this.#later(700 * (steps.length + 1), async () => {
			const catalog = await this.charterCatalog();
			let mapping: CharterMappingEntry[] = [];
			try {
				mapping = JSON.parse(v.mappingJson);
			} catch {
				/* reported as a problem below */
			}
			const problems = editorProblems(catalog, v.role, v.bodyMd, mapping);
			const passed = problems.length === 0;
			const words = mode === 'dry_run' ? 'dry run' : 'check against the recorded close';
			const summaryPlain = passed
				? mode === 'dry_run'
					? `The ${roleName(v.role as AgentRole)} charter, version ${v.version}, passed its dry run in Demo mode: every line is mapped and every shipped rule stays, so the CFO can publish it.`
					: `The ${roleName(v.role as AgentRole)} charter, version ${v.version}, passed its check against the recorded close in Demo mode; it needs a passing dry run before the CFO can publish it.`
				: `The ${roleName(v.role as AgentRole)} charter, version ${v.version}, failed its ${words}: ${problems.length === 1 ? 'one mapping problem' : `${problems.length} mapping problems`} must be fixed first.`;
			const report = { versionId, role: v.role, mode, demo: true, coverage: { ok: passed, problems }, probes: [], scenarios: [], passed, publishable: passed && mode === 'dry_run' };
			const row = { id: this.#id('ce'), charterVersionId: versionId, passed, mode, resultsJson: JSON.stringify(report), summaryPlain, ranByRole: 'advisor', ranAt: this.#now() };
			this.#t.charter_eval.push(row);
			this.#emit('charter_eval', 'insert', row);
			this.#audit('advisor', 'record_charter_eval', 'charter_eval', row.id, { versionId, mode, passed });
			const r = live();
			r.steps.push(report.publishable ? 'Recorded a passing dry run: the CFO can publish this version' : passed ? 'Recorded a passing quick check; a dry run must pass before the CFO can publish' : 'Recorded a failing eval');
			r.status = 'done';
			r.passed = passed;
			r.publishable = report.publishable;
			r.finishedAt = this.#now();
		});
		return structuredClone(run);
	}

	async charterEvalRun(versionId: string): Promise<CharterEvalRun> {
		const r = this.#evalRuns.get(versionId);
		return r ? structuredClone(r) : { versionId, status: 'idle', steps: [] };
	}

	async publishCharter(versionId: string, notePlain: string): Promise<void> {
		const v = this.#t.charter_version.find((x) => x.id === versionId);
		if (!v) throw new Error(`Unknown charter version ${versionId}`);
		if (v.status === 'live') throw new Error(`Version ${v.version} of the ${v.role} charter is already live.`);
		const evals = this.#t.charter_eval.filter((e) => e.charterVersionId === versionId);
		const latest = evals[evals.length - 1];
		if (!latest) throw new Error(`Run an eval of version ${v.version} of the ${v.role} charter first; a charter publishes only after its latest eval passes.`);
		if (!latest.passed) throw new Error(`The latest eval of version ${v.version} of the ${v.role} charter failed: ${latest.summaryPlain}`);
		if (latest.mode !== 'dry_run') throw new Error(`The latest eval of version ${v.version} of the ${v.role} charter was a quick check; a charter publishes only after a passing dry run (a full close on a scratch database).`);
		const prior = this.#t.charter_version.find((x) => x.role === v.role && x.status === 'live');
		if (prior) {
			prior.status = 'retired';
			this.#emit('charter_version', 'update', prior);
		}
		v.status = 'live';
		v.publishedAt = this.#now();
		this.#emit('charter_version', 'update', v);
		const note = notePlain.trim();
		this.#message({ role: 'cfo', kind: 'statement', threadId: `charter:${v.role}`, body: `Published version ${v.version} of the ${v.role} charter, replacing ${prior ? `version ${prior.version}` : 'the built-in charter'}${note ? `: ${note}` : '.'}`, summary: `You published version ${v.version} of the ${v.role} charter.` });
		this.#audit('cfo', 'publish_charter', 'charter_version', v.id, { role: v.role, version: v.version });
	}

	async retireLiveCharter(role: string, notePlain: string): Promise<void> {
		const live = this.#t.charter_version.find((x) => x.role === role && x.status === 'live');
		if (!live) throw new Error(`The ${role} has no published charter; the built-in charter already applies.`);
		live.status = 'retired';
		this.#emit('charter_version', 'update', live);
		const note = notePlain.trim();
		this.#message({ role: 'cfo', kind: 'statement', threadId: `charter:${role}`, body: `Retired version ${live.version} of the ${role} charter; the built-in charter applies again${note ? `: ${note}` : '.'}`, summary: `You restored the built-in ${role} charter.` });
		this.#audit('cfo', 'retire_live_charter', 'charter_version', live.id, { role });
	}

	/**
	 * Scripted collection: each listing on file "fetches" in turn from about 3 s, replaying the recorded page when the
	 * seed has one (Bansho Ramen's Yelp page, Stripe's LinkedIn and job board) and failing in plain words otherwise.
	 */
	async collectFootprint(subjectKind: FootprintSubject, subjectId: string): Promise<void> {
		const subject = subjectKind === 'customer' ? this.#t.customer.find((c) => c.id === subjectId) : this.#t.vendor.find((v) => v.id === subjectId);
		if (!subject) throw new Error(`Unknown ${subjectKind} ${subjectId}`);
		const key = `${subjectKind}:${subjectId}`;
		if (this.#collecting.has(key)) throw new Error('A collection is already running for this business.');
		const wanted: { source: FootprintSource; url: string }[] = [];
		if (subject.yelpUrl) wanted.push({ source: 'yelp', url: subject.yelpUrl });
		if (subject.jobBoard) wanted.push({ source: 'jobs', url: subject.jobBoard });
		if (subject.linkedinUrl) wanted.push({ source: 'linkedin', url: subject.linkedinUrl });
		if (!wanted.length) throw new Error('No public listing on file. Add a Yelp page, job board or LinkedIn page first.');
		this.#collecting.add(key);
		this.#audit('cfo', 'footprint.collect', 'public_footprint', key, { sources: wanted.map((w) => w.source) });
		wanted.forEach((w, i) =>
			this.#later(3000 + i * 1400, () => {
				const recorded = this.#t.public_footprint.findLast((r) => r.subjectKind === subjectKind && r.subjectId === subjectId && r.source === w.source && r.status === 'ok' && !r.id.includes('-live-'));
				const row: PublicFootprint = recorded
					? { ...recorded, id: this.#id('fp'), sourceUrl: recorded.sourceUrl, fetchedAt: this.#now(), live: false }
					: {
						id: this.#id('fp'),
						subjectKind,
						subjectId,
						source: w.source,
						sourceUrl: /^https?:/.test(w.url) ? w.url : '',
						fetchedAt: this.#now(),
						status: 'failed',
						error: 'Demo mode has no recorded copy of this page, so nothing was fetched. Connect the live agents to look it up.',
						summaryPlain: '',
						factsJson: '{}',
						ratingTenths: 0,
						reviewCount: 0,
						isClosed: false,
						isClaimed: false,
						yearEstablished: 0,
						openRoles: 0,
						employees: 0,
						followers: 0,
						live: false
					};
				this.#t.public_footprint.push(row);
				this.#emit('public_footprint', 'insert', row);
				if (i === wanted.length - 1) this.#collecting.delete(key);
			})
		);
	}

	async setListings(subjectKind: FootprintSubject, subjectId: string, l: Listings): Promise<void> {
		const subject = subjectKind === 'customer' ? this.#t.customer.find((c) => c.id === subjectId) : this.#t.vendor.find((v) => v.id === subjectId);
		if (!subject) throw new Error(`Unknown ${subjectKind} ${subjectId}`);
		const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
		subject.yelpUrl = clean(l.yelpUrl);
		subject.jobBoard = clean(l.jobBoard);
		subject.linkedinUrl = clean(l.linkedinUrl);
		this.#emit(subjectKind, 'update', subject);
		this.#audit('cfo', 'set_listings', subjectKind, subjectId, { yelpUrl: subject.yelpUrl, jobBoard: subject.jobBoard, linkedinUrl: subject.linkedinUrl });
	}

	/** Demo only: put every table back to the seed. */
	resetDemo(): void {
		for (const t of this.#timers) clearTimeout(t);
		this.#timers = [];
		this.#activity = null;
		this.#closes = [];
		this.#evalRuns.clear();
		this.#collecting.clear();
		this.#t = loadSeed();
		this.#boot = Date.now();
	}

	// Script runner
	#run(step: Step, periodId: string) {
		switch (step.type) {
			case 'activity':
				this.#activity = { role: step.role, labelPlain: step.label, proposalId: step.proposalId };
				break;
			case 'idle': {
				this.#activity = null;
				const c = this.#closes.find((x) => x.periodYm === periodId);
				if (c) c.status = 'done';
				this.#settle(periodId);
				break;
			}
			case 'message':
				this.#message({ proposalId: step.proposalId, role: step.role, kind: step.kind, body: step.body, summary: step.summary, threadId: step.proposalId ? undefined : closeThread(periodId) });
				break;
			case 'status': {
				const p = this.#t.proposal.find((x) => x.id === step.proposalId);
				if (p) {
					p.status = step.status;
					this.#emit('proposal', 'update', p);
					this.#settle(periodId);
				}
				break;
			}
			case 'task': {
				const task = this.#t.close_task.find((t) => t.id === step.taskId);
				if (task) {
					task.status = step.status;
					this.#emit('close_task', 'update', task);
				}
				break;
			}
			case 'vendor': {
				const v = this.#t.vendor.find((x) => x.id === step.vendorId);
				if (v) {
					v.verification = step.verification;
					v.notePlain = step.note;
					this.#emit('vendor', 'update', v);
				}
				break;
			}
			case 'propose': {
				const sp = step.proposal;
				this.#addProposal(
					{ id: sp.id, periodId, kind: sp.kind, payloadJson: JSON.stringify(sp.payload), rationale: sp.rationale, summaryPlain: sp.summaryPlain, amountMinor: sp.amountMinor, proposerRole: sp.proposerRole, status: 'open', createdAt: this.#now() },
					sp.taskId
				);
				this.#message({ proposalId: sp.id, role: sp.proposerRole, kind: 'statement', body: step.body, summary: step.summary });
				break;
			}
			case 'rule': {
				const p = this.#t.proposal.find((x) => x.id === step.proposalId);
				if (p) this.#rule(p, step.body, step.summary, step.rationale);
				break;
			}
			case 'consolidate':
				this.#consolidate(periodId, step.taskId);
				break;
			case 'wrapup': {
				const waiting = this.#t.proposal.filter((p) => p.periodId === periodId && p.status === 'awaiting_cfo');
				const n = waiting.length;
				this.#message({
					role: 'advisor',
					kind: 'statement',
					threadId: closeThread(periodId),
					body: `Rulings complete for ${periodId}. ${n} item${n === 1 ? '' : 's'} at or above materiality await CFO: ${waiting.map((p) => p.id).join(', ') || 'none'}.`,
					summary: n ? `Every item has a ruling. ${n} ${n === 1 ? 'is' : 'are'} over your threshold and need${n === 1 ? 's' : ''} your OK.` : 'Every item has a ruling and nothing needs you.'
				});
				break;
			}
		}
	}

	/**
	 * The Consolidation agent's three Proposals for the month, computed from the books as they stand by the ledger engine
	 * (the same revaluation() and eliminations() the scripted close and the module use): Cafoo Ltd's dollar balances
	 * revalued at the closing rate, the balances the companies owe each other, and the month's service fees.
	 */
	#consolidate(periodId: string, taskId: string) {
		const t = this.#t;
		const core = toCore({ subsidiaries: t.subsidiary, accounts: t.account, entries: t.journal_entry, lines: t.journal_line, rates: t.fx_rate, reportingCcy: t.settings.reportingCcy });
		const ym = ymFromString(periodId);
		const uk = core.entities.find((e) => !e.isElimination && e.parentId !== null);
		const fx = uk && core.accounts.find((a) => a.subsidiaryId === uk.id && a.code.startsWith('7100'));
		const byId = new Map(core.accounts.map((a) => [a.id, a]));
		const lines = (entry: JournalEntryInput): ScriptLine[] =>
			entry.lines.map((l) => ({ account: byId.get(l.accountId)!.code, debitMinor: l.debitMinor.toString(), creditMinor: l.creditMinor.toString() }));
		const debits = (entry: JournalEntryInput, ccy: string) =>
			translate(entry.lines.reduce((s, l) => s + l.debitMinor, 0n), core.rates, ccy, t.settings.reportingCcy, ym, 'closing');
		const propose = (id: string, kind: Proposal['kind'], entry: JournalEntryInput, ccy: string, summary: string, rationale: string, body: string) => {
			this.#addProposal(
				{ id, periodId, kind, payloadJson: JSON.stringify({ memo: entry.memo, lines: lines(entry) }), rationale, summaryPlain: summary, amountMinor: debits(entry, ccy).toString(), proposerRole: 'consolidation', status: 'open', createdAt: this.#now() },
				taskId
			);
			this.#message({ proposalId: id, role: 'consolidation', kind: 'statement', body, summary });
		};
		if (uk && fx) {
			const rev = revaluation({ entity: uk, lines: core.lines, accountsById: byId, rates: core.rates, ym, periodId: 0n, fxGainLossAccountId: fx.id });
			if (rev.entry) {
				const gain = formatMinor(rev.gainMinor, uk.functionalCcy);
				propose('pr-c1', 'fx_revaluation', rev.entry, uk.functionalCcy, `Restate what ${uk.name} owes in dollars at the month's closing rate, a ${gain} gain.`, `Revaluation of ${rev.items.length} foreign-currency balances at the closing rate.`, `PROPOSE pr-c1: ${rev.entry.memo}; gain ${gain}.`);
			}
		}
		const el = eliminations({ entities: core.entities, accounts: core.accounts, lines: core.lines, rates: core.rates, reportingCcy: t.settings.reportingCcy, ym, periodId: 0n });
		const usd = (n: bigint) => formatMinor(n, t.settings.reportingCcy);
		if (el.balance.entry) {
			const total = el.balance.pairs.reduce((s, p) => s + p.amountMinor, 0n);
			propose('pr-c2', 'ic_elimination', el.balance.entry, t.settings.reportingCcy, `Remove the ${usd(total)} the group companies owe each other from the group's reports; it reverses next month.`, 'Balance elimination, posted to the Elimination subsidiary.', `PROPOSE pr-c2: ${el.balance.entry.memo}.`);
		}
		if (el.activity.entry) {
			const total = el.activity.pairs.reduce((s, p) => s + p.amountMinor, 0n);
			const diff = el.activity.pairs.reduce((s, p) => s + p.differenceMinor, 0n);
			propose('pr-c3', 'ic_elimination', el.activity.entry, t.settings.reportingCcy, `Remove this month's ${usd(total)} of service fees between the group companies from the group's reports.`, `Activity elimination; the two sides differ by ${usd(diff < 0n ? -diff : diff)} of translation rounding.`, `PROPOSE pr-c3: ${el.activity.entry.memo}.`);
		}
	}

	/** Advisor ruling: posts below materiality, waits for the CFO at or above it. */
	#rule(p: Proposal, body: string, summary: string, rationale: string) {
		const threshold = toBig(this.#t.settings.materialityThresholdMinor);
		const material = toBig(p.amountMinor) >= threshold;
		const limit = formatMoney(this.#t.settings.materialityThresholdMinor, { whole: true });
		const base = summary.replace(/\.$/, '');
		const done = journalLinesOf(parsePayload(p.payloadJson)).length ? ' and posted it.' : '.';
		const approval = {
			id: this.#id('ap'),
			proposalId: p.id,
			decision: 'approve' as const,
			rationale,
			summaryPlain: material ? `${base}. It is at or over your ${limit} threshold, so it needs your confirmation.` : `${base}${done}`,
			at: this.#now()
		};
		this.#t.approval.push(approval);
		this.#emit('approval', 'insert', approval);
		this.#message({
			proposalId: p.id,
			role: 'advisor',
			kind: 'ruling',
			body: material ? `${body} At or above materiality (${limit}): awaiting CFO confirmation.` : `${body} Below materiality (${limit}): posting now.`,
			summary: material ? `${base}. It needs your OK.` : `${base}${done}`
		});
		p.status = material ? 'awaiting_cfo' : 'approved';
		this.#emit('proposal', 'update', p);
		if (!material) this.#applyApproved(p);
		this.#settle(p.periodId);
	}

	/** After a send-back, the worker agent resubmits a revised Proposal that supersedes the old one. */
	#resubmit(old: Proposal, note: string) {
		if (old.status !== 'sent_back') return;
		let n = 2;
		while (this.#t.proposal.some((p) => p.id === `${old.id}-v${n}`)) n++;
		const id = `${old.id}-v${n}`;
		const task = this.#t.close_task.find((t) => t.proposalIds.includes(old.id));
		const fresh = this.#addProposal({ ...old, id, status: 'open', createdAt: this.#now(), summaryPlain: `Resubmitted after your note ("${note}"): ${old.summaryPlain}`, supersededBy: undefined }, task?.id);
		old.status = 'superseded';
		old.supersededBy = id;
		this.#emit('proposal', 'update', old);
		this.#message({ proposalId: id, role: old.proposerRole, kind: 'statement', body: `Resubmission of ${old.id} after CFO note: "${note}". Evidence re-checked; same entry proposed.`, summary: 'I looked again and resubmitted it with your note addressed.' });
		this.#later(1500, () => this.#rule(fresh, `APPROVE ${id}.`, 'Advisor approved the resubmission.', `Resubmitted after CFO note: ${note}`));
	}

	#addProposal(p: Proposal, taskId?: string): Proposal {
		this.#t.proposal.push(p);
		const row = this.#t.proposal[this.#t.proposal.length - 1];
		this.#emit('proposal', 'insert', row);
		const task = taskId ? this.#t.close_task.find((t) => t.id === taskId) : undefined;
		if (task && !task.proposalIds.includes(p.id)) {
			task.proposalIds.push(p.id);
			if (task.status === 'todo' || task.status === 'blocked') task.status = 'in_progress';
			this.#emit('close_task', 'update', task);
		}
		return row;
	}

	// Effects of an approved Proposal on the books
	#applyApproved(p: Proposal) {
		let payload: { memo?: string; lines?: ScriptLine[]; bankTransactionId?: string; invoiceId?: string; scoreBp?: number; bucket?: 'exact' | 'strong' | 'weak' } = {};
		try {
			payload = JSON.parse(p.payloadJson);
		} catch {
			/* raw payload is not JSON: nothing to post */
		}
		const jeId = !payload.lines?.length
			? undefined
			: this.#postEntry({
				periodId: p.periodId,
				memo: payload.memo ?? p.summaryPlain,
				source: 'agent',
				postedByRole: 'advisor',
				proposalId: p.id,
				lines: payload.lines.map((l) => ({ id: '', jeId: '', accountId: accountIdFor(l.account), debitMinor: l.debitMinor, creditMinor: l.creditMinor, customerId: l.customerId, vendorId: l.vendorId }))
			});
		if (p.kind === 'bank_match' && payload.bankTransactionId) {
			const bt = this.#t.bank_transaction.find((b) => b.id === payload.bankTransactionId);
			if (bt) {
				bt.matched = true;
				this.#emit('bank_transaction', 'update', bt);
			}
			if (payload.invoiceId) {
				const inv = this.#t.invoice.find((i) => i.id === payload.invoiceId);
				if (inv) {
					inv.status = 'paid';
					this.#emit('invoice', 'update', inv);
				}
				const m = { id: this.#id('bm'), bankTransactionId: payload.bankTransactionId, targetKind: 'invoice' as const, targetId: payload.invoiceId, scoreBp: payload.scoreBp ?? 9000, bucket: payload.bucket ?? 'strong', proposalId: p.id, paymentJeId: jeId };
				this.#t.bank_match.push(m);
				this.#emit('bank_match', 'insert', m);
			}
		}
	}

	#postEntry(e: { periodId: string; memo: string; source: 'agent' | 'manual'; postedByRole: AgentRole; proposalId?: string; reversesJeId?: string; lines: JournalLine[] }): string {
		const id = this.#id('je');
		const je = { id, periodId: e.periodId, postedAt: this.#now(), memo: e.memo, source: e.source, postedByRole: e.postedByRole, proposalId: e.proposalId, reversesJeId: e.reversesJeId };
		this.#t.journal_entry.push(je);
		e.lines.forEach((l, i) => this.#t.journal_line.push({ ...l, id: `${id}-l${i + 1}`, jeId: id }));
		this.#emit('journal_entry', 'insert', je);
		this.#audit(e.postedByRole, 'journal_entry.post', 'journal_entry', id, { proposalId: e.proposalId });
		return id;
	}

	/** Recompute task status from evidence, then request the lock once nothing is unresolved. */
	#settle(periodId: string) {
		const close = this.#closes.find((c) => c.periodYm === periodId);
		const period = this.#t.period.find((p) => p.id === periodId);
		if (!close || !period || period.status === 'closed') return;
		const tasks = this.#t.close_task.filter((t) => t.periodId === periodId);
		const byId = new Map(this.#t.proposal.map((p) => [p.id, p]));
		const forPeriod = this.#t.proposal.filter((p) => p.periodId === periodId);
		const set = (t: (typeof tasks)[number], next: CloseTaskStatus) => {
			if (t.status === next) return;
			t.status = next;
			this.#emit('close_task', 'update', t);
		};
		const bank = bankExceptionState(this, periodId);
		for (const t of tasks) {
			if (t.ownerRole === 'cfo' || t.ownerRole === 'advisor' || !t.proposalIds.length) continue;
			const ps = t.proposalIds.map((id) => byId.get(id)).filter((p): p is Proposal => !!p);
			if (bank.rows.length && isBankReconciliationTask({ ownerRole: t.ownerRole, sortOrder: t.order, title: t.title })) {
				set(t, ps.some((p) => p.status === 'awaiting_cfo') ? 'blocked' : 'in_progress');
				continue;
			}
			set(t, ps.every((p) => RESOLVED.includes(p.status)) ? 'done' : ps.some((p) => p.status === 'awaiting_cfo') ? 'blocked' : 'in_progress');
		}
		const unresolved = forPeriod.filter((p) => UNRESOLVED.includes(p.status));
		for (const t of tasks.filter((t) => t.ownerRole === 'advisor')) {
			set(t, close.status === 'running' ? 'in_progress' : unresolved.some((p) => p.status === 'awaiting_cfo') ? 'blocked' : unresolved.length ? 'in_progress' : 'done');
		}
		if (close.status === 'done' && !unresolved.length && period.status === 'open' && (!bank.rows.length || bank.acceptance.accepted)) {
			period.status = 'closing';
			this.#emit('period', 'update', period);
			const month = new Date(Date.UTC(period.year, period.month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
			this.#message({
				role: 'advisor',
				kind: 'ruling',
				threadId: closeThread(periodId),
				body: `REQUEST LOCK ${periodId}. All proposals resolved; trial balance ties. ${bank.rows.length ? `${bank.rows.length} bank exception(s) accepted by the CFO remain unmatched.` : 'No bank exceptions remain.'}`,
				summary: `The proposals for ${month} are resolved and the books balance. ${bank.rows.length ? `${bank.rows.length} accepted bank exception(s) remain unmatched. ` : ''}The Advisor asks you to lock ${month}.`
			});
			this.#audit('advisor', 'period.request_lock', 'period', periodId, {});
		}
	}

	// Helpers
	#later(ms: number, fn: () => void) {
		this.#timers.push(setTimeout(fn, ms));
	}

	#proposal(id: string): Proposal {
		const p = this.#t.proposal.find((x) => x.id === id);
		if (!p) throw new Error(`Unknown proposal ${id}`);
		return p;
	}

	#message(m: { proposalId?: string; role: AgentRole; kind: AgentMessage['kind']; body: string; summary: string; threadId?: string }) {
		const msg: AgentMessage = { id: this.#id('m'), threadId: m.threadId ?? `th-${m.proposalId}`, senderRole: m.role, kind: m.kind, body: m.body, summaryPlain: m.summary, proposalId: m.proposalId, createdAt: this.#now() };
		this.#t.agent_message.push(msg);
		this.#emit('agent_message', 'insert', msg);
	}

	#audit(actorRole: AgentRole | 'system', action: string, targetTable: TableName, targetId: string, detail: object) {
		const ev = { id: this.#id('ae'), actorRole, action, targetTable, targetId, detailJson: JSON.stringify(detail), at: this.#now() };
		this.#t.audit_event.push(ev);
		this.#emit('audit_event', 'insert', ev);
	}

	#emit(table: TableName, kind: ChangeEvent['kind'], row: unknown) {
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

	#now(): string {
		return new Date(DEMO_EPOCH + (Date.now() - this.#boot)).toISOString();
	}

	#id(prefix: string): string {
		this.#seq += 1;
		return `${prefix}-live-${this.#seq}`;
	}
}
