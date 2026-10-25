import { describe, expect, it } from 'vitest';
import { closeRunNotes, latestStep } from './close-run';

const ADVISOR = 'Advisor run failed: the provider returned 529 overloaded; applying standard rulings to remaining proposals';
const WAIT = 'CFO wait limit reached; revenue schedules still await a decision, so revenue catch-up remains pending';
const BUDGET = 'the close budget of $15.00 is spent ($15.12); no further Advisor run';

describe('closeRunNotes', () => {
	it('is empty without a close, without steps, and for ordinary steps', () => {
		expect(closeRunNotes(undefined)).toEqual([]);
		expect(closeRunNotes({ status: 'running' })).toEqual([]);
		expect(closeRunNotes({ status: 'done', steps: ['advisor: reviewing', 'tool propose', 'done (success), cost $1.23'] })).toEqual([]);
	});

	it('explains an unavailable Advisor and quotes the reason', () => {
		const [n, ...rest] = closeRunNotes({ status: 'running', steps: [ADVISOR] });
		expect(rest).toEqual([]);
		expect(n.tone).toBe('warn');
		expect(n.title).toBe('The Advisor was unavailable for part of this close');
		expect(n.body).toMatch(/standard rulings/i);
		expect(n.body).toContain('the provider returned 529 overloaded');
	});

	it('says the revenue catch-up did not post when the wait limit is reached, without implying a fix', () => {
		const [n] = closeRunNotes({ status: 'done', steps: [WAIT] });
		expect(n).toMatchObject({ tone: 'warn', title: 'Revenue catch-up did not post in this close' });
		expect(n.href).toBeUndefined();
		expect(n.body).toMatch(/did not post/);
	});

	it('quotes the budget and the spend', () => {
		const [n] = closeRunNotes({ status: 'done', steps: [BUDGET] });
		expect(n.title).toBe('The close budget is spent');
		expect(n.body).toContain('$15.12');
		expect(n.body).toContain('$15.00');
		expect(n.body).toMatch(/no further runs/);
		expect(n).toMatchObject({ href: '/proposals', action: 'Open Proposals' });
	});

	it('reports an errored close, with a fallback reason', () => {
		expect(closeRunNotes({ status: 'error', error: 'SpacetimeDB refused the connection' })).toEqual([
			{ tone: 'neg', title: 'The close stopped with an error', body: 'SpacetimeDB refused the connection' }
		]);
		expect(closeRunNotes({ status: 'error', error: '  ' })[0].body).toBe('No reason was reported.');
		expect(closeRunNotes({ status: 'error' })[0].body).toBe('No reason was reported.');
	});

	it('puts a failed close first, then dedupes the fallbacks in the order they first appeared', () => {
		const notes = closeRunNotes({ status: 'error', steps: [BUDGET, ADVISOR, BUDGET, WAIT, ADVISOR, WAIT] });
		expect(notes.map((n) => n.title)).toEqual([
			'The close stopped with an error',
			'The close budget is spent',
			'The Advisor was unavailable for part of this close',
			'Revenue catch-up did not post in this close'
		]);
	});
});

describe('latestStep', () => {
	it('is undefined without steps', () => {
		expect(latestStep(undefined)).toBeUndefined();
		expect(latestStep({ status: 'running' })).toBeUndefined();
		expect(latestStep({ status: 'running', steps: [] })).toBeUndefined();
		expect(latestStep({ status: 'running', steps: ['   '] })).toBeUndefined();
	});

	it('turns the prefixes into plain words and keeps one line', () => {
		expect(latestStep({ status: 'running', steps: ['tool x', 'advisor: Ruling on the\nrevenue schedule'] })).toBe('Advisor: Ruling on the revenue schedule');
		expect(latestStep({ status: 'running', steps: ['agent: Matched 12 bank lines'] })).toBe('A worker agent: Matched 12 bank lines');
		expect(latestStep({ status: 'running', steps: ['tool mcp__ledger__propose'] })).toBe('Using propose');
		expect(latestStep({ status: 'done', steps: ['done (success), cost $1.23'] })).toBe('Done (success), cost $1.23');
	});
});
