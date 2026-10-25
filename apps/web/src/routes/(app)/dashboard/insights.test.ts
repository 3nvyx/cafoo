import { describe, expect, it } from 'vitest';
import { agentStatus, allowanceByCurrency, barPct, blockedVendors, closeProgress, proposalCounts, stepIndex, tierCounts } from './insights';
import type { AgentMessage, CloseTask, CreditCheck, Customer, Invoice, Proposal, Subsidiary, Vendor } from '#lib/data/types.js';

const task = (id: string, status: CloseTask['status'], order: number, periodId = '2026-09'): CloseTask => ({ id, periodId, title: id, ownerRole: 'bookkeeper', status, order, proposalIds: [] });
const prop = (id: string, status: Proposal['status'], proposerRole: Proposal['proposerRole'] = 'bookkeeper', createdAt = '2026-09-30T10:00:00Z', periodId = '2026-09'): Proposal => ({
	id,
	periodId,
	kind: 'accrual',
	payloadJson: '{}',
	rationale: '',
	summaryPlain: `${id} summary`,
	amountMinor: '100',
	proposerRole,
	status,
	createdAt
});
const msg = (senderRole: AgentMessage['senderRole'], createdAt: string, summaryPlain: string): AgentMessage => ({ id: `${senderRole}-${createdAt}`, threadId: 't', senderRole, kind: 'statement', body: summaryPlain, summaryPlain, createdAt });
const cust = (id: string, creditTier?: Customer['creditTier'], subsidiaryId?: string): Customer => ({ id, name: id, domain: '', guarantorPersonaId: '', guarantorName: '', creditTier, paymentTermsDays: 30, subsidiaryId });
const check = (subjectKind: CreditCheck['subjectKind'], subjectId: string, tier: CreditCheck['tier'], checkedAt: string): CreditCheck => ({ id: `${subjectId}-${checkedAt}`, subjectKind, subjectId, personaId: '', tier, summaryJson: '{}', requestId: '', checkedAt });

describe('closeProgress', () => {
	it('counts one Period in checklist order', () => {
		const p = closeProgress([task('b', 'done', 2), task('a', 'done', 1), task('c', 'blocked', 3), task('d', 'todo', 4), task('x', 'done', 1, '2026-08')], '2026-09');
		expect(p.steps.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(p).toMatchObject({ total: 4, done: 2, blocked: 1, todo: 1, inProgress: 0, pct: 50 });
	});
	it('is zero with no steps', () => {
		expect(closeProgress([], '2026-09')).toMatchObject({ total: 0, pct: 0 });
	});
});

describe('proposalCounts', () => {
	it('buckets statuses and filters by Period', () => {
		const c = proposalCounts([prop('1', 'approved'), prop('2', 'amended'), prop('3', 'awaiting_cfo'), prop('4', 'open'), prop('5', 'rejected'), prop('6', 'superseded'), prop('7', 'approved', 'bookkeeper', '2026-08-01T00:00:00Z', '2026-08')], '2026-09');
		expect(c).toEqual({ approved: 2, awaiting: 1, debate: 1, rejected: 1, other: 1, total: 6 });
		expect(proposalCounts([prop('7', 'approved', 'bookkeeper', '2026-08-01T00:00:00Z', '2026-08')]).total).toBe(1);
	});
});

describe('agentStatus', () => {
	it('takes the newest of messages and Proposals, and counts open Proposals', () => {
		const [bk, rv] = agentStatus(
			['bookkeeper', 'revenue'],
			[msg('bookkeeper', '2026-09-30T09:00:00Z', 'Matched the bank'), msg('bookkeeper', '2026-09-30T11:00:00Z', 'Posted accruals')],
			[prop('1', 'open', 'bookkeeper', '2026-09-30T10:00:00Z'), prop('2', 'awaiting_cfo'), prop('3', 'approved')]
		);
		expect(bk.last).toEqual({ at: '2026-09-30T11:00:00Z', summary: 'Posted accruals' });
		expect(bk.open).toBe(2);
		expect(bk.proposed).toBe(3);
		expect(rv).toEqual({ role: 'revenue', last: null, open: 0, proposed: 0 });
	});
});

describe('credit', () => {
	const customers = [cust('a', 'A'), cust('b', 'B'), cust('c'), cust('uk', 'C', 'sub-uk')];
	const checks = [check('customer', 'b', 'A', '2026-01-01'), check('customer', 'b', 'D', '2026-09-01'), check('customer', 'c', 'BLOCK', '2026-09-01'), check('vendor', 'v2', 'BLOCK', '2026-09-01')];

	it('uses the latest check, then the customer row', () => {
		expect(tierCounts([...customers, cust('none')], checks)).toEqual({ A: 1, B: 0, C: 1, D: 1, BLOCK: 1, unrated: 1 });
	});

	it('totals the Allowance per currency', () => {
		const subs: Subsidiary[] = [
			{ id: 'sub-us', name: 'US', baseCurrency: 'USD', code: 'US', isElimination: false },
			{ id: 'sub-uk', name: 'UK', baseCurrency: 'GBP', code: 'UK', parentId: 'sub-us', isElimination: false }
		];
		const inv = (customerId: string, amountMinor: string, status: Invoice['status'] = 'open'): Invoice => ({ id: `${customerId}-${amountMinor}`, number: '1', customerId, issuedAt: '2026-09-01', dueAt: '2026-10-01', amountMinor, status });
		// a: 1% of 10,000 = 100; b (now D): 75% of 1,000 = 750; c (BLOCK): 100% of 500; uk (C): 10% of 2,000 = 200 GBP.
		const out = allowanceByCurrency(customers, checks, [inv('a', '10000'), inv('b', '1000'), inv('c', '500'), inv('uk', '2000'), inv('a', '9999', 'paid')], subs);
		expect(out).toEqual([
			{ currency: 'GBP', minor: '200' },
			{ currency: 'USD', minor: '1350' }
		]);
	});

	it('finds blocked vendors from verification or a BLOCK check', () => {
		const v = (id: string, verification: Vendor['verification']): Vendor => ({ id, name: id, category: '', verification });
		expect(blockedVendors([v('v1', 'blocked'), v('v2', 'verified'), v('v3', 'unverified')], checks).map((x) => x.id)).toEqual(['v1', 'v2']);
	});
});

describe('charts', () => {
	it('steps months with arrow keys and clamps at the ends', () => {
		expect(stepIndex(null, 'ArrowLeft', 5)).toBe(3);
		expect(stepIndex(0, 'ArrowLeft', 5)).toBe(0);
		expect(stepIndex(4, 'ArrowRight', 5)).toBe(4);
		expect(stepIndex(2, 'Home', 5)).toBe(0);
		expect(stepIndex(2, 'End', 5)).toBe(4);
		expect(stepIndex(2, 'Enter', 5)).toBeNull();
		expect(stepIndex(null, 'ArrowLeft', 0)).toBeNull();
	});
	it('sizes bars against the largest', () => {
		expect(barPct(5, 10)).toBe(50);
		expect(barPct(1, 1000)).toBe(2);
		expect(barPct(0, 10)).toBe(0);
		expect(barPct(3, 0)).toBe(0);
	});
});
