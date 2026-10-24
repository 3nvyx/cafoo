// In-memory DataSource for Demo mode. Tables live in Svelte 5 `$state`, so every
// read is reactive. Actions mutate rows the way the ledger reducers would.
//
// Period status follows the live module: 'open' while agents work, 'closing' once
// the Advisor has requested the lock (every Proposal resolved), 'closed' once the
// CFO locks it.
import type { ChangeEvent, ConnectionState, DataSource } from '../source';
import type { AgentMessage, AgentRole, BankMatch, CloseTaskStatus, JournalLine, LiveActivity, Minor, Proposal, ProviderStatus, TableName } from '../types';
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
	{ id: 'bank-feed', name: 'Bank feed', purpose: 'Daily bank transactions', mode: 'demo', detail: '30 September transactions from fixtures' },
	{ id: 'credit-cascade', name: 'Credit check cascade', purpose: 'Identity, fraud, credit report, public records', mode: 'demo', detail: 'Sandbox personas, stored request ids' },
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
	providers = () => PROVIDERS;
	liveActivity = () => this.#activity;
	now = () => this.#now();
	connection = (): ConnectionState => ({ ledger: 'demo', agents: 'online', closes: this.#closes });

	subscribe(table: TableName, cb: (e: ChangeEvent) => void): () => void {
		let set = this.#subs.get(table);
		if (!set) this.#subs.set(table, (set = new Set()));
		set.add(cb);
		return () => set.delete(cb);
	}

	// Actions
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

	async setMateriality(minor: Minor): Promise<void> {
		const from = this.#t.settings.materialityThresholdMinor;
		this.#t.settings.materialityThresholdMinor = toBig(minor).toString();
		this.#emit('settings', 'update', this.#t.settings);
		this.#audit('cfo', 'settings.materiality', 'settings', 'materiality', { from, to: minor });
	}

	async setCloseTaskStatus(taskId: string, status: CloseTaskStatus): Promise<void> {
		const task = this.#t.close_task.find((t) => t.id === taskId);
		if (!task) throw new Error(`Unknown close task ${taskId}`);
		task.status = status;
		this.#emit('close_task', 'update', task);
		this.#audit('cfo', 'close_task.status', 'close_task', taskId, { status });
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
		const pending = this.#t.close_task.filter((t) => t.periodId === periodId && t.ownerRole !== 'advisor' && t.ownerRole !== 'cfo' && t.status !== 'done');
		if (period.status !== 'closing' && pending.length) throw new Error('Finish every close task before locking.');
		period.status = 'closed';
		period.lockedAt = this.#now();
		this.#emit('period', 'update', period);
		for (const t of this.#t.close_task.filter((t) => t.periodId === periodId && t.status !== 'done')) {
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
		this.#audit('cfo', 'period.unlock', 'period', periodId, { reason });
	}

	/** Demo only: put every table back to the seed. */
	resetDemo(): void {
		for (const t of this.#timers) clearTimeout(t);
		this.#timers = [];
		this.#activity = null;
		this.#closes = [];
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
		for (const t of tasks) {
			if (t.ownerRole === 'cfo' || t.ownerRole === 'advisor' || !t.proposalIds.length) continue;
			const ps = t.proposalIds.map((id) => byId.get(id)).filter((p): p is Proposal => !!p);
			set(t, ps.every((p) => RESOLVED.includes(p.status)) ? 'done' : ps.some((p) => p.status === 'awaiting_cfo') ? 'blocked' : 'in_progress');
		}
		const unresolved = forPeriod.filter((p) => UNRESOLVED.includes(p.status));
		for (const t of tasks.filter((t) => t.ownerRole === 'advisor')) {
			set(t, close.status === 'running' ? 'in_progress' : unresolved.some((p) => p.status === 'awaiting_cfo') ? 'blocked' : unresolved.length ? 'in_progress' : 'done');
		}
		if (close.status === 'done' && !unresolved.length && period.status === 'open') {
			period.status = 'closing';
			this.#emit('period', 'update', period);
			const month = new Date(Date.UTC(period.year, period.month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
			this.#message({
				role: 'advisor',
				kind: 'ruling',
				threadId: closeThread(periodId),
				body: `REQUEST LOCK ${periodId}. All proposals resolved; trial balance ties; no open items.`,
				summary: `Every item for ${month} is resolved and the books balance. The Advisor asks you to lock ${month}.`
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
