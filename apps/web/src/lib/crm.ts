// The small CRM Cafoo keeps, as pure maths over rows read from the connected tools (deals, support tickets,
// promotions) and the books (invoices, contracts, credit packs). Cafoo reads these; it never edits them.
import type { Batch, Contract, Deal, DealStage, Invoice, Minor, Promotion, SupportTicket } from './data/types';
import { toBig } from './data/money';

// ---------- Deals ----------

export const STAGES: DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
export const OPEN_STAGES: DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation'];
/** The CRM's default win probability per stage, basis points. */
export const STAGE_PROBABILITY_BP: Record<DealStage, number> = { lead: 1000, qualified: 2500, proposal: 5000, negotiation: 7500, won: 10000, lost: 0 };

export const isOpenDeal = (d: Pick<Deal, 'stage'>) => OPEN_STAGES.includes(d.stage);

/** The stage after this one on the happy path; null for won and lost. */
export function nextStage(stage: DealStage): DealStage | null {
	const i = OPEN_STAGES.indexOf(stage);
	return i < 0 ? null : i === OPEN_STAGES.length - 1 ? 'won' : OPEN_STAGES[i + 1];
}

export interface Pipeline {
	openCount: number;
	/** Annual value of open deals. */
	openMinor: Minor;
	/** Open deals weighted by their win probability. */
	weightedMinor: Minor;
	wonMinor: Minor;
	/** Won over won + lost, by count; null before any deal closed. */
	winRateBp: number | null;
}

/** Open, weighted, and won pipeline (amounts in each deal's currency; the demo's are all USD). */
export function weightedPipeline(deals: Deal[]): Pipeline {
	let open = 0n, weighted = 0n, won = 0n;
	let openCount = 0, wonCount = 0, lostCount = 0;
	for (const d of deals) {
		const a = toBig(d.amountMinor);
		if (isOpenDeal(d)) {
			openCount++;
			open += a;
			weighted += (a * BigInt(d.probabilityBp)) / 10000n;
		} else if (d.stage === 'won') {
			wonCount++;
			won += a;
		} else lostCount++;
	}
	const closed = wonCount + lostCount;
	return { openCount, openMinor: open.toString(), weightedMinor: weighted.toString(), wonMinor: won.toString(), winRateBp: closed ? Math.round((wonCount / closed) * 10000) : null };
}

/** Deal count and value per stage, in stage order. */
export function pipelineByStage(deals: Deal[]): { stage: DealStage; count: number; amountMinor: Minor }[] {
	return STAGES.map((stage) => {
		const ds = deals.filter((d) => d.stage === stage);
		return { stage, count: ds.length, amountMinor: ds.reduce((t, d) => t + toBig(d.amountMinor), 0n).toString() };
	});
}

// ---------- Support tickets ----------

/** Time to first response the plan promises, by priority, in hours. */
export const SLA_HOURS: Record<SupportTicket['priority'], number> = { urgent: 1, high: 4, normal: 8, low: 24 };

/** 'met' or 'breached' once answered (or overdue unanswered), otherwise 'at_risk' within the last quarter of the window, else 'on_track'. */
export type SlaState = 'met' | 'breached' | 'at_risk' | 'on_track';

export function ticketSla(t: Pick<SupportTicket, 'openedAt' | 'firstResponseAt' | 'slaDueAt'>, now: string): SlaState {
	const due = Date.parse(t.slaDueAt);
	if (t.firstResponseAt) return Date.parse(t.firstResponseAt) <= due ? 'met' : 'breached';
	const n = Date.parse(now);
	if (n > due) return 'breached';
	const window = due - Date.parse(t.openedAt);
	return due - n <= window / 4 ? 'at_risk' : 'on_track';
}

export interface SupportSummary {
	/** Not solved. */
	open: number;
	/** Open tickets past their first-response time without an answer. */
	breached: number;
	atRisk: number;
	/** Answered within SLA over all answered tickets; null before any answer. */
	metRateBp: number | null;
	/** Median minutes to first response over answered tickets; null before any answer. */
	medianFirstResponseMin: number | null;
}

export function supportSummary(tickets: SupportTicket[], now: string): SupportSummary {
	const open = tickets.filter((t) => t.status !== 'solved');
	const states = open.map((t) => ticketSla(t, now));
	const answered = tickets.filter((t) => t.firstResponseAt);
	const met = answered.filter((t) => ticketSla(t, now) === 'met').length;
	const mins = answered.map((t) => (Date.parse(t.firstResponseAt!) - Date.parse(t.openedAt)) / 60000).sort((a, b) => a - b);
	const median = mins.length ? (mins.length % 2 ? mins[(mins.length - 1) / 2] : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2) : null;
	return {
		open: open.length,
		breached: states.filter((s) => s === 'breached').length,
		atRisk: states.filter((s) => s === 'at_risk').length,
		metRateBp: answered.length ? Math.round((met / answered.length) * 10000) : null,
		medianFirstResponseMin: median === null ? null : Math.round(median)
	};
}

// ---------- Repeat customers ----------

export type RepeatReason = 'paid_in_several_months' | 'expanded' | 'several_contracts' | 'bought_credits_again';

/**
 * Customers who came back for more, with why: paid invoices in two or more months, a contract that grew, more than
 * one contract, or a second credit pack. Computed from the books, never typed in.
 */
export function repeatCustomers(invoices: Invoice[], contracts: Contract[], batches: Batch[] = []): Map<string, RepeatReason[]> {
	const out = new Map<string, RepeatReason[]>();
	const add = (id: string, r: RepeatReason) => {
		const rs = out.get(id) ?? [];
		if (!rs.includes(r)) rs.push(r);
		out.set(id, rs);
	};
	const paidMonths = new Map<string, Set<string>>();
	for (const i of invoices) {
		if (i.status !== 'paid') continue;
		const ms = paidMonths.get(i.customerId) ?? new Set<string>();
		ms.add(i.issuedAt.slice(0, 7));
		paidMonths.set(i.customerId, ms);
	}
	for (const [id, ms] of paidMonths) if (ms.size >= 2) add(id, 'paid_in_several_months');
	const contractCount = new Map<string, number>();
	for (const k of contracts) {
		contractCount.set(k.customerId, (contractCount.get(k.customerId) ?? 0) + 1);
		if (k.priorArrMinor && toBig(k.arrMinor) > toBig(k.priorArrMinor)) add(k.customerId, 'expanded');
	}
	for (const [id, n] of contractCount) if (n >= 2) add(id, 'several_contracts');
	const packs = new Map<string, number>();
	for (const b of batches) if (b.kind === 'credit_pack' && b.customerId) packs.set(b.customerId, (packs.get(b.customerId) ?? 0) + 1);
	for (const [id, n] of packs) if (n >= 2) add(id, 'bought_credits_again');
	return out;
}

/** Repeat customers over customers who have bought anything (an invoice, a contract or a credit pack), basis points. */
export function repeatRateBp(invoices: Invoice[], contracts: Contract[], batches: Batch[] = []): number | null {
	const packBuyers = batches.filter((b) => b.kind === 'credit_pack' && b.customerId).map((b) => b.customerId!);
	const buyers = new Set([...invoices.map((i) => i.customerId), ...contracts.map((k) => k.customerId), ...packBuyers]);
	return buyers.size ? Math.round((repeatCustomers(invoices, contracts, batches).size / buyers.size) * 10000) : null;
}

// ---------- Promotions ----------

export function promotionTotals(promotions: Promotion[]): { active: number; redemptions: number; discountGivenMinor: Minor } {
	return {
		active: promotions.filter((p) => p.status === 'active').length,
		redemptions: promotions.reduce((t, p) => t + p.redemptions, 0),
		discountGivenMinor: promotions.reduce((t, p) => t + toBig(p.discountGivenMinor), 0n).toString()
	};
}
