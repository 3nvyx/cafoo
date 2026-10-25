// Demo behaviour for the CRM: deals moving through HubSpot, Zendesk tickets arriving and getting solved, and Stripe
// promotion codes being redeemed. Cafoo only reads these tools, so every change is a non-ledger row update; nothing
// here proposes. Each ticker runs only while its tool is connected.
import { STAGE_PROBABILITY_BP, SLA_HOURS } from '../../../crm';
import { toBig } from '../../money';
import type { DealStage, SupportTicket } from '../../types';
import type { LiveTicker, MockContext, UploadHandler } from './types';

export const handlers: UploadHandler[] = [];

const later = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

// ---------- HubSpot: a scripted afternoon of deal moves, then quiet ----------

type DealMove = { dealId: string; to: DealStage } | { add: { companyName: string; amountMinor: string; ownerName: string; closeInDays: number } };
const DEAL_SCRIPT: DealMove[] = [
	{ dealId: 'dl-02', to: 'qualified' },
	{ dealId: 'dl-05', to: 'negotiation' },
	{ dealId: 'dl-06', to: 'won' },
	{ add: { companyName: 'Wrenfield Pharmacy', amountMinor: '1200000', ownerName: 'Theo Brandt', closeInDays: 60 } },
	{ dealId: 'dl-03', to: 'proposal' },
	{ dealId: 'dl-01', to: 'negotiation' },
	{ dealId: 'dl-09', to: 'proposal' },
	{ add: { companyName: 'Copper Kettle Bakeries', amountMinor: '840000', ownerName: 'Maya Okafor', closeInDays: 75 } },
	{ dealId: 'dl-04', to: 'won' },
	{ dealId: 'dl-02', to: 'proposal' },
	{ dealId: 'dl-05', to: 'lost' }
];

const ORDER: Record<DealStage, number> = { lead: 0, qualified: 1, proposal: 2, negotiation: 3, won: 4, lost: 4 };
/** Whether the tables already show this move, so the script picks up where the data is (also after a demo reset). */
function done(ctx: MockContext, m: DealMove): boolean {
	if ('add' in m) return ctx.t.deal.some((d) => d.companyName === m.add.companyName);
	const d = ctx.t.deal.find((x) => x.id === m.dealId);
	return !d || ORDER[d.stage] >= ORDER[m.to];
}

const hubspot: LiveTicker = {
	name: 'hubspot-deals',
	integrationId: 'hubspot',
	everyMs: 11000,
	tick(ctx) {
		const move = DEAL_SCRIPT.find((m) => !done(ctx, m));
		if (!move) return;
		const now = ctx.now();
		if ('add' in move) {
			ctx.insert('deal', {
				id: ctx.id('dl'),
				source: 'hubspot',
				companyName: move.add.companyName,
				stage: 'lead',
				amountMinor: move.add.amountMinor,
				ccy: 'USD',
				probabilityBp: STAGE_PROBABILITY_BP.lead,
				expectedCloseAt: later(now, move.add.closeInDays * 24),
				ownerName: move.add.ownerName,
				updatedAt: now
			});
		} else {
			const d = ctx.t.deal.find((x) => x.id === move.dealId)!;
			d.stage = move.to;
			d.probabilityBp = STAGE_PROBABILITY_BP[move.to];
			d.updatedAt = now;
			ctx.update('deal', d);
		}
		ctx.synced('hubspot');
	}
};

// ---------- Zendesk: new tickets, first replies, solves ----------

const NEW_TICKETS: Pick<SupportTicket, 'customerId' | 'requesterName' | 'subject' | 'priority' | 'channel'>[] = [
	{ customerId: 'c03', requesterName: 'Odile Faraday', subject: 'Patients not getting appointment confirmations', priority: 'high', channel: 'email' },
	{ customerId: 'c19', requesterName: 'Kenji Arakawa', subject: 'Copilot menu translations sound too formal', priority: 'low', channel: 'chat' },
	{ customerId: 'c04', requesterName: 'Dana Whitlock', subject: 'Route summaries missing yesterday’s stops', priority: 'urgent', channel: 'slack' },
	{ customerId: 'c12', requesterName: 'Lena Hargrove', subject: 'How do I export the attendance report?', priority: 'normal', channel: 'email' },
	{ customerId: 'c20', requesterName: 'Priya Venn', subject: 'Booking page shows the wrong time zone', priority: 'high', channel: 'phone' },
	{ customerId: 'c09', requesterName: 'Marco Bellweather', subject: 'Add a second card on file', priority: 'low', channel: 'email' }
];

let ticketTurn = 0;
const zendesk: LiveTicker = {
	name: 'zendesk-tickets',
	integrationId: 'zendesk',
	everyMs: 9000,
	tick(ctx) {
		const now = ctx.now();
		const turn = ticketTurn++ % 3;
		const fresh = NEW_TICKETS.find((n) => !ctx.t.support_ticket.some((x) => x.subject === n.subject));
		if (turn === 0 && fresh) {
			ctx.insert('support_ticket', { id: ctx.id('tk'), source: 'zendesk', status: 'new', openedAt: now, slaDueAt: later(now, SLA_HOURS[fresh.priority]), ...fresh });
		} else if (turn === 1) {
			const t = oldest(ctx, (x) => x.status === 'new');
			if (!t) return;
			t.status = 'open';
			t.firstResponseAt = now;
			ctx.update('support_ticket', t);
		} else {
			const t = oldest(ctx, (x) => (x.status === 'open' || x.status === 'pending') && !!x.firstResponseAt);
			if (!t) return;
			t.status = 'solved';
			t.solvedAt = now;
			ctx.update('support_ticket', t);
		}
		ctx.synced('zendesk');
	}
};

const PRIORITY_RANK: Record<SupportTicket['priority'], number> = { urgent: 0, high: 1, normal: 2, low: 3 };
/** The most urgent, then oldest, ticket matching `pred`: the one an agent would pick up next. */
function oldest(ctx: MockContext, pred: (t: SupportTicket) => boolean): SupportTicket | undefined {
	return ctx.t.support_ticket.filter(pred).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.openedAt.localeCompare(b.openedAt))[0];
}

// ---------- Stripe: promotion codes redeemed at checkout ----------

/** What one redemption takes off: 20% of the $150 monthly Copilot add-on, or the fixed amount off. */
const PER_REDEMPTION: Record<string, bigint> = { 'pm-1': 3000n };
const MAX_REDEMPTIONS = 40;

let promoTurn = 0;
const stripePromotions: LiveTicker = {
	name: 'stripe-promotions',
	integrationId: 'stripe',
	everyMs: 15000,
	tick(ctx) {
		const now = ctx.now();
		for (const p of ctx.t.promotion) {
			if (p.status !== 'ended' && p.endsAt && p.endsAt < now) {
				p.status = 'ended';
				ctx.update('promotion', p);
			}
		}
		const live = ctx.t.promotion.filter((p) => p.status === 'active' && p.redemptions < MAX_REDEMPTIONS);
		if (!live.length) return;
		// The percentage code is redeemed most; the credit-pack code about one time in four.
		const turn = promoTurn++;
		const p = live.find((x) => x.amountOffMinor) && turn % 4 === 3 ? live.find((x) => x.amountOffMinor)! : (live.find((x) => x.discountBp) ?? live[0]);
		const off = p.amountOffMinor ? toBig(p.amountOffMinor) : (PER_REDEMPTION[p.id] ?? 0n);
		p.redemptions += 1;
		p.discountGivenMinor = (toBig(p.discountGivenMinor) + off).toString();
		ctx.update('promotion', p);
		ctx.synced('stripe');
	}
};

export const tickers: LiveTicker[] = [hubspot, zendesk, stripePromotions];
