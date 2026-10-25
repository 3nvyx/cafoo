// The close status bar: the month-end close as six steps in the order the agents work them, Bookkeeper, Revenue,
// Credit & Risk, Consolidation, CFO review, Lock, each with a state and its Proposal counts. Pure: derived from the
// Period, its close tasks and Proposals, and the lock gate (#lib/close.js), so the Close page and its tests agree.
import { isBankReconciliationTask } from '@luyten/ledger-core';
import type { AgentRole, CloseTask, Period, Proposal } from './data/types';

export type StepState = 'done' | 'running' | 'waiting' | 'not_started';
export type StepId = 'bookkeeper' | 'revenue' | 'credit' | 'consolidation' | 'cfo_review' | 'lock';

export interface CloseStep {
	id: StepId;
	label: string;
	state: StepState;
	/** Proposals made in this step (superseded ones left out); for CFO review, every Proposal of the month. */
	made: number;
	/** Approved, amended or confirmed. */
	approved: number;
	/** Waiting for the CFO's confirmation. */
	waitingCfo: number;
	/** One plain line on what the step is doing. */
	note: string;
}

export interface CloseStepsInput {
	period: Period | undefined;
	tasks: CloseTask[];
	proposals: Proposal[];
	/** From lockGate: the agents have started (or finished) a close for this Period. */
	started: boolean;
	/** From lockGate: the CFO can lock now. */
	canLock: boolean;
}

export interface CloseStatus {
	steps: CloseStep[];
	/** Whole-number percent: a done step counts fully, a running or waiting step half. */
	percent: number;
}

const WORKERS: { id: StepId & AgentRole; label: string }[] = [
	{ id: 'bookkeeper', label: 'Bookkeeper' },
	{ id: 'revenue', label: 'Revenue' },
	{ id: 'credit', label: 'Credit & Risk' },
	{ id: 'consolidation', label: 'Consolidation' }
];

export const STEP_STATE: Record<StepState, { label: string; tone: 'pos' | 'neutral' | 'warn' | 'muted' }> = {
	done: { label: 'Done', tone: 'pos' },
	running: { label: 'Running', tone: 'neutral' },
	waiting: { label: 'Waiting', tone: 'warn' },
	not_started: { label: 'Not started', tone: 'muted' }
};

const APPROVED = new Set<Proposal['status']>(['approved', 'amended']);
const IN_DEBATE = new Set<Proposal['status']>(['open', 'sent_back']);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function counts(props: Proposal[]) {
	const live = props.filter((p) => p.status !== 'superseded');
	return {
		made: live.length,
		approved: live.filter((p) => APPROVED.has(p.status)).length,
		waitingCfo: live.filter((p) => p.status === 'awaiting_cfo').length,
		inDebate: live.filter((p) => IN_DEBATE.has(p.status)).length
	};
}

export function closeSteps(input: CloseStepsInput): CloseStatus {
	const { period, started, canLock } = input;
	const periodId = period?.id;
	const tasks = input.tasks.filter((t) => t.periodId === periodId);
	const proposals = input.proposals.filter((p) => p.periodId === periodId);
	const locked = period?.status === 'closed';

	const workers: CloseStep[] = WORKERS.map(({ id, label }) => {
		const own = tasks.filter((t) => t.ownerRole === id);
		const c = counts(proposals.filter((p) => p.proposerRole === id));
		const allDone = own.length > 0 && own.every((t) => t.status === 'done');
		const blocked = own.some((t) => t.status === 'blocked');
		const working = own.some((t) => t.status === 'in_progress');
		let state: StepState;
		let note: string;
		if (locked || allDone || (started && period?.status === 'closing' && c.inDebate + c.waitingCfo === 0)) {
			state = 'done';
			note = c.made ? `${plural(c.made, 'Proposal')} made, all ruled` : 'Nothing to propose this month';
		} else if (c.waitingCfo || blocked) {
			state = 'waiting';
			note = c.waitingCfo ? `${plural(c.waitingCfo, 'Proposal')} waiting for the CFO` : 'A task is waiting on a decision';
		} else if (c.inDebate || working || (started && c.made > 0)) {
			state = 'running';
			note = c.inDebate ? `${plural(c.inDebate, 'Proposal')} in debate` : 'Working through its tasks';
		} else {
			state = 'not_started';
			note = started ? 'Queued' : 'Starts with the close';
		}
		return { id, label, state, made: c.made, approved: c.approved, waitingCfo: c.waitingCfo, note };
	});

	const all = counts(proposals);
	const ruled = proposals.some((p) => p.status !== 'open' && p.status !== 'superseded');
	let reviewState: StepState;
	let reviewNote: string;
	if (locked || (workers.every((w) => w.state === 'done') && all.waitingCfo === 0 && all.inDebate === 0)) {
		reviewState = 'done';
		reviewNote = all.made ? `${plural(all.approved, 'Proposal')} approved or confirmed` : 'Nothing needed your OK';
	} else if (all.waitingCfo) {
		reviewState = 'waiting';
		reviewNote = `${plural(all.waitingCfo, 'item')} need${all.waitingCfo === 1 ? 's' : ''} your OK`;
	} else if (ruled) {
		reviewState = 'running';
		reviewNote = 'The Advisor is ruling; nothing waits for you yet';
	} else {
		reviewState = 'not_started';
		reviewNote = 'Opens once the Advisor rules';
	}
	const review: CloseStep = { id: 'cfo_review', label: 'CFO review', state: reviewState, made: all.made, approved: all.approved, waitingCfo: all.waitingCfo, note: reviewNote };

	const lockState: StepState = locked ? 'done' : canLock || period?.status === 'closing' ? 'waiting' : 'not_started';
	const lock: CloseStep = {
		id: 'lock',
		label: 'Lock',
		state: lockState,
		made: 0,
		approved: 0,
		waitingCfo: 0,
		note: locked ? 'The month is locked' : canLock ? 'Ready for you to lock' : lockState === 'waiting' ? 'Waiting for the last checks' : 'After every step above'
	};

	const steps = [...workers, review, lock];
	const score = steps.reduce((s, st) => s + (st.state === 'done' ? 1 : st.state === 'not_started' ? 0 : 0.5), 0);
	return { steps, percent: Math.round((score / steps.length) * 100) };
}

export interface ChecklistProgress {
	total: number;
	done: number;
	/** Bank reconciliation tasks left open on purpose because the CFO accepted the remaining bank lines as exceptions. */
	accepted: number;
	/** Whole percent of tasks settled: done, or stood in for by an accepted exception set. */
	pct: number;
}

/**
 * The close checklist's count. The bank task stays open after the CFO accepts exceptions (the lines are still
 * unreconciled), and the lock counts that acceptance in its place (#lib/close.js lockGate); the checklist says so
 * instead of reading "6 of 7 done" next to a locked month.
 */
export function checklistProgress(tasks: CloseTask[], periodId: string, exceptionsAccepted: boolean): ChecklistProgress {
	const own = tasks.filter((t) => t.periodId === periodId);
	const done = own.filter((t) => t.status === 'done').length;
	const accepted = exceptionsAccepted
		? own.filter((t) => t.status !== 'done' && t.status !== 'blocked' && isBankReconciliationTask({ ownerRole: t.ownerRole, sortOrder: t.order, title: t.title })).length
		: 0;
	return { total: own.length, done, accepted, pct: own.length ? Math.round(((done + accepted) / own.length) * 100) : 0 };
}
