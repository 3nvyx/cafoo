import { describe, expect, it } from 'vitest';
import governance from './data/mock/seed/governance.json';
import type { CloseTask, Period, Proposal } from './data/types';
import { checklistProgress, closeSteps } from './close-steps';

const period = (status: Period['status']): Period => ({ id: '2026-09', subsidiaryId: 'us', year: 2026, month: 9, status });
const task = (id: string, ownerRole: CloseTask['ownerRole'], status: CloseTask['status']): CloseTask => ({ id, periodId: '2026-09', title: id, ownerRole, status, order: 1, proposalIds: [] });
const prop = (id: string, proposerRole: Proposal['proposerRole'], status: Proposal['status']): Proposal => ({
	id, periodId: '2026-09', kind: 'journal_entry', payloadJson: '{}', rationale: '', summaryPlain: id, amountMinor: '100', proposerRole, status, createdAt: '2026-10-01T00:00:00Z'
});
const byId = (s: ReturnType<typeof closeSteps>) => Object.fromEntries(s.steps.map((x) => [x.id, x]));

describe('checklistProgress', () => {
	const bank: CloseTask = { ...task('bank', 'bookkeeper', 'in_progress'), title: 'Bank reconciliation', order: 1 };
	const rest = [1, 2, 3, 4, 5, 6].map((n) => ({ ...task('t' + n, 'revenue', 'done'), order: n + 1 }));

	it('counts the bank task as settled once the CFO accepts the bank lines as exceptions', () => {
		expect(checklistProgress([bank, ...rest], '2026-09', true)).toEqual({ total: 7, done: 6, accepted: 1, pct: 100 });
	});

	it('leaves it open without an acceptance, and leaves other open tasks alone', () => {
		expect(checklistProgress([bank, ...rest], '2026-09', false)).toEqual({ total: 7, done: 6, accepted: 0, pct: 86 });
		const other = { ...task('ar', 'revenue', 'todo'), order: 9 };
		expect(checklistProgress([other, ...rest], '2026-09', true)).toMatchObject({ accepted: 0, pct: 86 });
		// A blocked bank task still blocks the lock, so it is not counted as settled.
		expect(checklistProgress([{ ...bank, status: 'blocked' }, ...rest], '2026-09', true)).toMatchObject({ accepted: 0, pct: 86 });
	});
});

describe('close status bar', () => {
	it('lists the six steps in order, nothing started before the close', () => {
		const s = closeSteps({ period: period('open'), tasks: [task('a', 'bookkeeper', 'todo')], proposals: [], started: false, canLock: false });
		expect(s.steps.map((x) => x.id)).toEqual(['bookkeeper', 'revenue', 'credit', 'consolidation', 'cfo_review', 'lock']);
		expect(s.steps.every((x) => x.state === 'not_started')).toBe(true);
		expect(s.percent).toBe(0);
	});

	it('derives running, waiting and counts from the demo close', () => {
		const s = byId(
			closeSteps({ period: period('open'), tasks: governance.closeTasks as CloseTask[], proposals: governance.proposals as Proposal[], started: true, canLock: false })
		);
		// Bookkeeper: bank match approved, accrual approved, entry rejected (the amended accrual is August's); tasks in progress.
		expect(s.bookkeeper).toMatchObject({ state: 'running', made: 3, approved: 2, waitingCfo: 0 });
		// Revenue: the superseded schedule is left out.
		expect(s.revenue).toMatchObject({ made: 1, approved: 1 });
		// Credit: its task is blocked and a decision was sent back.
		expect(s.credit.state).toBe('waiting');
		expect(s.consolidation.state).toBe('not_started');
		expect(s.cfo_review).toMatchObject({ state: 'running', made: 6 });
		expect(s.lock.state).toBe('not_started');
		expect(byId(closeSteps({ period: period('open'), tasks: [], proposals: [], started: false, canLock: false })).cfo_review.state).toBe('not_started');
	});

	it('shows Proposals waiting for the CFO on the step and in CFO review', () => {
		const s = byId(closeSteps({ period: period('open'), tasks: [task('a', 'credit', 'in_progress')], proposals: [prop('p1', 'credit', 'awaiting_cfo'), prop('p2', 'credit', 'approved')], started: true, canLock: false }));
		expect(s.credit).toMatchObject({ state: 'waiting', waitingCfo: 1, approved: 1, made: 2 });
		expect(s.cfo_review).toMatchObject({ state: 'waiting', waitingCfo: 1 });
	});

	it('marks a step done when its tasks are done, and lock waiting when the CFO can lock', () => {
		const tasks = (['bookkeeper', 'revenue', 'credit', 'consolidation'] as const).map((r) => task(r, r, 'done'));
		const s = closeSteps({ period: period('closing'), tasks, proposals: [prop('p1', 'bookkeeper', 'approved')], started: true, canLock: true });
		const m = byId(s);
		expect(m.bookkeeper.state).toBe('done');
		expect(m.cfo_review.state).toBe('done');
		expect(m.lock).toMatchObject({ state: 'waiting', note: 'Ready for you to lock' });
		expect(s.percent).toBe(92);
	});

	it('is 100 percent once the month is locked', () => {
		const s = closeSteps({ period: period('closed'), tasks: [], proposals: [], started: true, canLock: false });
		expect(s.steps.every((x) => x.state === 'done')).toBe(true);
		expect(s.percent).toBe(100);
	});

	it('ignores other months', () => {
		const other = { ...prop('x', 'bookkeeper', 'awaiting_cfo'), periodId: '2026-08' };
		expect(byId(closeSteps({ period: period('open'), tasks: [], proposals: [other], started: false, canLock: false })).bookkeeper.made).toBe(0);
	});
});
