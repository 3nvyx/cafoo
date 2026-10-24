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
	/** The Advisor's latest ruling in the close thread, e.g. its lock request. */
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
	const request = db
		.agentMessages()
		.filter((m) => m.threadId === thread && m.kind === 'ruling')
		.at(-1);
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
