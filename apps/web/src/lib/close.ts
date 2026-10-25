// When can the CFO lock a Period, and what to say about it. Shared by the
// Dashboard and the Close checklist so both screens agree.
import type { DataSource } from './data/source';
import type { AgentMessage, Period } from './data/types';
import { bankExceptionAcceptance, bankExceptionSnapshot, closeOrderRefusal, currentBankExceptions, isBankReconciliationTask } from '@cafoo/ledger-core';

type CloseBooks = Pick<DataSource, 'periods' | 'connection' | 'closeTasks' | 'proposals' | 'agentMessages' | 'bankTransactions' | 'auditEvents'>;

/** The same reviewed bank rows and audit revision the ledger module checks when the CFO accepts exceptions. */
export function bankExceptionState(db: Pick<CloseBooks, 'bankTransactions' | 'auditEvents'>, periodYm: string) {
	const input = {
		periodYm,
		bankRows: db.bankTransactions(),
		auditEvents: db.auditEvents().map(event => ({ ...event, detail: event.detailJson }))
	};
	return {
		rows: currentBankExceptions(input),
		snapshot: bankExceptionSnapshot(input),
		acceptance: bankExceptionAcceptance(input)
	};
}

export interface LockGate {
	period: Period | undefined;
	/** The agents have started (or finished) a close for this Period. */
	started: boolean;
	running: boolean;
	canLock: boolean;
	awaiting: number;
	sentBack: number;
	pendingTasks: number;
	/** Unmatched bank lines through this Period, including earlier months. */
	bankExceptions: ReturnType<typeof bankExceptionState>;
	/** The Advisor's lock request (its latest ruling in the close thread), while the Period is waiting for the lock. */
	request: AgentMessage | undefined;
	/** Plain sentence for why the lock is not available yet ('' when it is). */
	blocker: string;
}

export function lockGate(db: CloseBooks, periodId: string): LockGate {
	const period = db.periods().find((p) => p.id === periodId);
	const closes = db.connection().closes.filter((c) => c.periodYm === periodId);
	const tasks = db.closeTasks().filter((t) => t.periodId === periodId);
	const props = db.proposals().filter((p) => p.periodId === periodId);
	const awaiting = props.filter((p) => p.status === 'awaiting_cfo').length;
	const sentBack = props.filter((p) => p.status === 'sent_back').length;
	const open = props.filter((p) => p.status === 'open').length;
	const bankExceptions = bankExceptionState(db, periodId);
	const exceptionsAccepted = bankExceptions.rows.length > 0 && bankExceptions.acceptance.accepted;
	// Advisor-owned tasks (and the CFO's own lock task) finish when the lock lands. The bank task stays open on purpose
	// after the CFO accepts exceptions (the lines are still unreconciled), so the current acceptance stands in for it,
	// exactly as the module's lockPeriod treats it.
	const pendingTasks = tasks.filter(
		(t) => t.ownerRole !== 'advisor' && t.ownerRole !== 'cfo' && t.status !== 'done' && !(exceptionsAccepted && isBankReconciliationTask({ ownerRole: t.ownerRole, sortOrder: t.order, title: t.title }))
	).length;
	const blockedTasks = tasks.filter((t) => t.status === 'blocked').length;
	const thread = `close:${periodId}`;
	// The Advisor's lock request stands only while the month is waiting for the lock: once the CFO locks it, or
	// unlocks it again, that request is history.
	const request =
		period?.status === 'closing'
			? db
					.agentMessages()
					.filter((m) => m.threadId === thread && m.kind === 'ruling')
					.at(-1)
			: undefined;
	const started = closes.length > 0 || period?.status === 'closing';
	const workflowReady =
		!!period &&
		period.status !== 'closed' &&
		awaiting + sentBack + open === 0 &&
		(period.status === 'closing' || (tasks.length > 0 && pendingTasks === 0));
	// Months lock in order: an earlier month that is not locked holds this one back (the module refuses it too).
	const order = closeOrderRefusal(db.periods().map((p) => ({ ym: p.id, status: p.status })), periodId, 'lock');
	const canLock = workflowReady && !order && blockedTasks === 0 && (bankExceptions.rows.length === 0 || bankExceptions.acceptance.accepted);

	let blocker = '';
	if (period && !canLock && period.status !== 'closed') {
		// A close cannot start out of order either, so a month not started yet names the earlier month instead.
		if (!started) blocker = order ?? 'Start the close first. The agents will work through the checklist.';
		else if (awaiting) blocker = `${awaiting} item${awaiting === 1 ? '' : 's'} still need${awaiting === 1 ? 's' : ''} your confirmation.`;
		else if (sentBack) blocker = `${sentBack} item${sentBack === 1 ? ' you sent back is' : 's you sent back are'} waiting for the agent to resubmit.`;
		else if (open) blocker = `${open} item${open === 1 ? ' is' : 's are'} still in debate.`;
		else if (blockedTasks) blocker = `${blockedTasks} close task${blockedTasks === 1 ? ' is' : 's are'} blocked. Resolve them before locking.`;
		else if (bankExceptions.rows.length && !bankExceptions.acceptance.accepted) blocker = `${bankExceptions.rows.length} unmatched bank line${bankExceptions.rows.length === 1 ? ' needs' : 's need'} your review and explicit acceptance before locking.`;
		else if (order) blocker = order;
		else if (pendingTasks) blocker = `${pendingTasks} task${pendingTasks === 1 ? ' is' : 's are'} not done yet.`;
		else blocker = 'Waiting for the Advisor to request the lock.';
	}

	return { period, started, running: closes.some((c) => c.status === 'running'), canLock, awaiting, sentBack, pendingTasks, bankExceptions, request, blocker };
}

/** The earliest month after `periodId` that still takes postings, if any. */
export function nextOpenPeriod(periods: Period[], periodId: string): Period | undefined {
	return periods.filter((p) => p.id > periodId && p.status !== 'closed').sort((a, b) => a.id.localeCompare(b.id))[0];
}

/**
 * Where a correction (a CFO reversal) to an entry of month `periodId` posts, as the ledger module decides it: that
 * month while it is open, otherwise the earliest open month after it. Undefined when every such month is locked.
 */
export function correctionPeriod(periods: Period[], periodId: string): Period | undefined {
	const own = periods.find((p) => p.id === periodId);
	return own && own.status !== 'closed' ? own : nextOpenPeriod(periods, periodId);
}
