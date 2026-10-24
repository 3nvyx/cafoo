// When can the CFO lock a Period, and what to say about it. Shared by the
// Launchpad and the Close checklist so both screens agree.
import type { DataSource } from './data/source';
import type { AgentMessage, Period } from './data/types';

export interface LockGate {
	period: Period | undefined;
	/** The agents have started (or finished) a close for this Period. */
	started: boolean;
	running: boolean;
	canLock: boolean;
	awaiting: number;
	sentBack: number;
	pendingTasks: number;
	/** The Advisor's lock request (its latest ruling in the close thread), while the Period is waiting for the lock. */
	request: AgentMessage | undefined;
	/** Plain sentence for why the lock is not available yet ('' when it is). */
	blocker: string;
}

export function lockGate(db: DataSource, periodId: string): LockGate {
	const period = db.periods().find((p) => p.id === periodId);
	const closes = db.connection().closes.filter((c) => c.periodYm === periodId);
	const tasks = db.closeTasks().filter((t) => t.periodId === periodId);
	const props = db.proposals().filter((p) => p.periodId === periodId);
	const awaiting = props.filter((p) => p.status === 'awaiting_cfo').length;
	const sentBack = props.filter((p) => p.status === 'sent_back').length;
	const open = props.filter((p) => p.status === 'open').length;
	// Advisor-owned tasks (and the CFO's own lock task) finish when the lock lands.
	const pendingTasks = tasks.filter((t) => t.ownerRole !== 'advisor' && t.ownerRole !== 'cfo' && t.status !== 'done').length;
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
	const canLock =
		!!period &&
		period.status !== 'closed' &&
		(period.status === 'closing' || (tasks.length > 0 && pendingTasks === 0 && awaiting + sentBack + open === 0));

	let blocker = '';
	if (period && !canLock && period.status !== 'closed') {
		if (!started) blocker = 'Start the close first. The agents will work through the checklist.';
		else if (awaiting) blocker = `${awaiting} item${awaiting === 1 ? '' : 's'} still need${awaiting === 1 ? 's' : ''} your confirmation.`;
		else if (sentBack) blocker = `${sentBack} item${sentBack === 1 ? ' you sent back is' : 's you sent back are'} waiting for the agent to resubmit.`;
		else if (open) blocker = `${open} item${open === 1 ? ' is' : 's are'} still in debate.`;
		else if (pendingTasks) blocker = `${pendingTasks} task${pendingTasks === 1 ? ' is' : 's are'} not done yet.`;
		else blocker = 'Waiting for the Advisor to request the lock.';
	}

	return { period, started, running: closes.some((c) => c.status === 'running'), canLock, awaiting, sentBack, pendingTasks, request, blocker };
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
