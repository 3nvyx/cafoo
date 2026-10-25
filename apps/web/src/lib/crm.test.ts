import { describe, expect, it } from 'vitest';
import type { Contract, Deal, Invoice, Promotion, SupportTicket } from './data/types';
import { loadSeed } from './data/mock/seed';
import { nextStage, pipelineByStage, promotionTotals, repeatCustomers, repeatRateBp, supportSummary, ticketSla, weightedPipeline } from './crm';

const deal = (p: Partial<Deal>): Deal => ({
	id: 'd',
	source: 'hubspot',
	companyName: 'Test Co',
	stage: 'lead',
	amountMinor: '1000000',
	ccy: 'USD',
	probabilityBp: 1000,
	expectedCloseAt: '2026-11-01T00:00:00Z',
	ownerName: 'Owner',
	updatedAt: '2026-10-01T00:00:00Z',
	...p
});

const ticket = (p: Partial<SupportTicket>): SupportTicket => ({
	id: 't',
	source: 'zendesk',
	requesterName: 'Someone',
	subject: 'Help',
	priority: 'normal',
	status: 'new',
	channel: 'email',
	openedAt: '2026-10-02T08:00:00Z',
	slaDueAt: '2026-10-02T16:00:00Z',
	...p
});

const inv = (customerId: string, issuedAt: string, status: Invoice['status'] = 'paid'): Invoice => ({ id: `${customerId}-${issuedAt}`, number: 'INV', customerId, issuedAt, dueAt: issuedAt, amountMinor: '100', status });
const contract = (customerId: string, p: Partial<Contract> = {}): Contract => ({ id: `k-${customerId}`, customerId, startAt: '2026-01-01T00:00:00Z', billing: 'monthly', arrMinor: '120000', ...p });

describe('deals', () => {
	it('weights open deals by probability and counts the win rate', () => {
		const p = weightedPipeline([
			deal({ stage: 'proposal', amountMinor: '2000000', probabilityBp: 5000 }),
			deal({ stage: 'negotiation', amountMinor: '1000000', probabilityBp: 7500 }),
			deal({ stage: 'won', amountMinor: '3000000', probabilityBp: 10000 }),
			deal({ stage: 'lost', amountMinor: '500000', probabilityBp: 0 })
		]);
		expect(p).toEqual({ openCount: 2, openMinor: '3000000', weightedMinor: '1750000', wonMinor: '3000000', winRateBp: 5000 });
		expect(weightedPipeline([deal({})]).winRateBp).toBeNull();
	});

	it('walks the happy path and groups by stage', () => {
		expect(nextStage('lead')).toBe('qualified');
		expect(nextStage('negotiation')).toBe('won');
		expect(nextStage('won')).toBeNull();
		const g = pipelineByStage([deal({}), deal({}), deal({ stage: 'won' })]);
		expect(g.find((x) => x.stage === 'lead')).toEqual({ stage: 'lead', count: 2, amountMinor: '2000000' });
	});

	it('seeds a pipeline the Metrics page can quote', () => {
		const p = weightedPipeline(loadSeed().deal);
		expect(p.openCount).toBe(39);
		expect(p.openMinor).toBe('66784562');
		expect(p.weightedMinor).toBe('22738704');
	});
});

describe('support SLA', () => {
	const now = '2026-10-02T11:00:00Z';
	it('judges answered tickets by their first reply and unanswered ones by the clock', () => {
		expect(ticketSla(ticket({ firstResponseAt: '2026-10-02T09:00:00Z' }), now)).toBe('met');
		expect(ticketSla(ticket({ firstResponseAt: '2026-10-02T17:00:00Z' }), now)).toBe('breached');
		expect(ticketSla(ticket({ slaDueAt: '2026-10-02T10:00:00Z' }), now)).toBe('breached');
		expect(ticketSla(ticket({ slaDueAt: '2026-10-02T12:00:00Z' }), now)).toBe('at_risk');
		expect(ticketSla(ticket({}), now)).toBe('on_track');
	});

	it('summarizes open, breached and answered-in-time tickets', () => {
		const s = supportSummary(
			[
				ticket({ id: 'a', firstResponseAt: '2026-10-02T08:30:00Z', status: 'open' }),
				ticket({ id: 'b', firstResponseAt: '2026-10-02T17:00:00Z', status: 'solved' }),
				ticket({ id: 'c', slaDueAt: '2026-10-02T10:00:00Z' })
			],
			now
		);
		expect(s).toEqual({ open: 2, breached: 1, atRisk: 0, metRateBp: 5000, medianFirstResponseMin: 285 });
	});
});

describe('repeat customers', () => {
	it('finds customers who paid in two months, expanded, signed twice or bought credits again', () => {
		const r = repeatCustomers(
			[inv('a', '2026-08-01T00:00:00Z'), inv('a', '2026-09-01T00:00:00Z'), inv('b', '2026-09-01T00:00:00Z'), inv('b', '2026-09-20T00:00:00Z'), inv('c', '2026-08-01T00:00:00Z', 'open'), inv('c', '2026-09-01T00:00:00Z', 'open')],
			[contract('d', { priorArrMinor: '100000' }), contract('e'), { ...contract('e'), id: 'k-e2' }, contract('f', { priorArrMinor: '200000' })],
			[{ id: 'p1', subsidiaryId: 's', kind: 'credit_pack', sku: 'x', name: 'x', customerId: 'g', quantity: 1, remaining: 1, unit: 'M tokens', amountMinor: '1', ccy: 'USD', acquiredAt: '', status: 'active' }, { id: 'p2', subsidiaryId: 's', kind: 'credit_pack', sku: 'x', name: 'x', customerId: 'g', quantity: 1, remaining: 1, unit: 'M tokens', amountMinor: '1', ccy: 'USD', acquiredAt: '', status: 'active' }]
		);
		expect(Object.fromEntries(r)).toEqual({ a: ['paid_in_several_months'], d: ['expanded'], e: ['several_contracts'], g: ['bought_credits_again'] });
	});

	it('flags the seeded repeat customers', () => {
		const t = loadSeed();
		expect([...repeatCustomers(t.invoice, t.contract, t.batch).keys()].sort()).toEqual(['c01', 'c03', 'c04', 'c05', 'c07', 'c08', 'c09', 'c10', 'c11', 'c12', 'c13', 'c16', 'c17']);
		expect(repeatRateBp(t.invoice, t.contract, t.batch)).toBe(6500);
	});

	it('counts credit-pack buyers in the denominator too, so the rate never passes 100%', () => {
		const p = (id: string, customerId: string) => ({ id, subsidiaryId: 's', kind: 'credit_pack' as const, sku: 'x', name: 'x', customerId, quantity: 1, remaining: 1, unit: 'M tokens', amountMinor: '1', ccy: 'USD', acquiredAt: '', status: 'active' as const });
		// Only pack buyers: g bought twice (repeat), h once.
		expect(repeatRateBp([], [], [p('1', 'g'), p('2', 'g'), p('3', 'h')])).toBe(5000);
		expect(repeatRateBp([], [], [p('1', 'g'), p('2', 'g')])).toBe(10000);
	});
});

describe('promotions', () => {
	it('totals redemptions and discount given', () => {
		const p = (x: Partial<Promotion>): Promotion => ({ id: 'p', source: 'stripe', code: 'X', descriptionPlain: '', ccy: 'USD', startsAt: '', redemptions: 2, discountGivenMinor: '1000', status: 'active', ...x });
		expect(promotionTotals([p({}), p({ status: 'ended', redemptions: 3, discountGivenMinor: '500' })])).toEqual({ active: 1, redemptions: 5, discountGivenMinor: '1500' });
	});
});
