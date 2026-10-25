// Pure read-side maths for the Overview's panels: close progress, agent status, credit Risk Tiers, Proposals by
// status, and the arrow-key stepping the charts use. No side effects and no `db`, so every figure is unit-tested.
import { allowanceFor } from '#lib/data/derive.js';
import type { AgentMessage, AgentRole, CloseTask, CreditCheck, Customer, Invoice, Minor, Proposal, RiskTier, Subsidiary, Vendor } from '#lib/data/types.js';

// ---- Close progress ----

export interface CloseProgress {
	total: number;
	done: number;
	inProgress: number;
	blocked: number;
	todo: number;
	/** Whole percent of steps done. */
	pct: number;
	/** The Period's steps in checklist order. */
	steps: CloseTask[];
}

export function closeProgress(tasks: CloseTask[], periodId: string): CloseProgress {
	const steps = tasks.filter((t) => t.periodId === periodId).sort((a, b) => a.order - b.order);
	const count = (s: CloseTask['status']) => steps.filter((t) => t.status === s).length;
	const done = count('done');
	return { total: steps.length, done, inProgress: count('in_progress'), blocked: count('blocked'), todo: count('todo'), pct: steps.length ? Math.round((done / steps.length) * 100) : 0, steps };
}

// ---- Proposals by status ----

export type ProposalBucket = 'approved' | 'awaiting' | 'debate' | 'rejected';
export const PROPOSAL_BUCKETS: ProposalBucket[] = ['approved', 'awaiting', 'debate', 'rejected'];
export const PROPOSAL_BUCKET_LABEL: Record<ProposalBucket, string> = { approved: 'Approved', awaiting: 'Awaiting CFO', debate: 'In debate', rejected: 'Rejected' };

/**
 * Proposals counted into the four buckets the Overview draws. Amended counts as approved; sent back and superseded
 * are left out of the chart and reported as `other`.
 */
export function proposalCounts(proposals: Proposal[], periodId?: string): Record<ProposalBucket, number> & { other: number; total: number } {
	const out = { approved: 0, awaiting: 0, debate: 0, rejected: 0, other: 0, total: 0 };
	for (const p of proposals) {
		if (periodId && p.periodId !== periodId) continue;
		out.total++;
		if (p.status === 'approved' || p.status === 'amended') out.approved++;
		else if (p.status === 'awaiting_cfo') out.awaiting++;
		else if (p.status === 'open') out.debate++;
		else if (p.status === 'rejected') out.rejected++;
		else out.other++;
	}
	return out;
}

// ---- Agent status ----

export const DASHBOARD_ROLES: AgentRole[] = ['bookkeeper', 'revenue', 'credit', 'consolidation', 'redteam', 'advisor'];

export interface AgentStatus {
	role: AgentRole;
	/** The role's latest message or Proposal, whichever is newer. */
	last: { at: string; summary: string } | null;
	/** The role's Proposals still in debate or awaiting the CFO. */
	open: number;
	/** Every Proposal the role has made. */
	proposed: number;
}

export function agentStatus(roles: AgentRole[], messages: AgentMessage[], proposals: Proposal[]): AgentStatus[] {
	return roles.map((role) => {
		let last: AgentStatus['last'] = null;
		for (const m of messages) if (m.senderRole === role && (!last || m.createdAt > last.at)) last = { at: m.createdAt, summary: m.summaryPlain || m.body };
		let open = 0;
		let proposed = 0;
		for (const p of proposals) {
			if (p.proposerRole !== role) continue;
			proposed++;
			if (p.status === 'open' || p.status === 'awaiting_cfo') open++;
			if (!last || p.createdAt > last.at) last = { at: p.createdAt, summary: p.summaryPlain };
		}
		return { role, last, open, proposed };
	});
}

// ---- Credit ----

export const TIERS: RiskTier[] = ['A', 'B', 'C', 'D', 'BLOCK'];

/** The latest credit check per subject of one kind, by subject id. */
export function latestChecks(checks: CreditCheck[], kind: CreditCheck['subjectKind']): Map<string, CreditCheck> {
	const out = new Map<string, CreditCheck>();
	for (const c of checks) {
		if (c.subjectKind !== kind) continue;
		const prev = out.get(c.subjectId);
		if (!prev || c.checkedAt > prev.checkedAt) out.set(c.subjectId, c);
	}
	return out;
}

/** Each customer's Risk Tier: the latest credit check, else the tier on the customer row; unset when neither has one. */
export function customerTiers(customers: Customer[], checks: CreditCheck[]): Map<string, RiskTier | undefined> {
	const latest = latestChecks(checks, 'customer');
	return new Map(customers.map((c) => [c.id, latest.get(c.id)?.tier ?? c.creditTier]));
}

/** Customers per Risk Tier, plus how many are not rated yet. */
export function tierCounts(customers: Customer[], checks: CreditCheck[]): Record<RiskTier, number> & { unrated: number } {
	const out = { A: 0, B: 0, C: 0, D: 0, BLOCK: 0, unrated: 0 };
	for (const tier of customerTiers(customers, checks).values()) {
		if (tier) out[tier]++;
		else out.unrated++;
	}
	return out;
}

/**
 * The target Allowance across every rated customer, per currency (a customer's invoices are in its company's
 * currency, so the totals are never added across currencies). Sorted by currency code.
 */
export function allowanceByCurrency(customers: Customer[], checks: CreditCheck[], invoices: Invoice[], subsidiaries: Subsidiary[]): { currency: string; minor: Minor }[] {
	const tiers = customerTiers(customers, checks);
	const root = subsidiaries.find((s) => !s.parentId);
	const ccyOf = (id?: string) => subsidiaries.find((s) => s.id === id)?.baseCurrency ?? root?.baseCurrency ?? 'USD';
	const totals = new Map<string, bigint>();
	for (const c of customers) {
		const tier = tiers.get(c.id);
		if (!tier) continue;
		const ccy = ccyOf(c.subsidiaryId);
		totals.set(ccy, (totals.get(ccy) ?? 0n) + BigInt(allowanceFor({ ...c, creditTier: tier }, invoices)));
	}
	return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, v]) => ({ currency, minor: v.toString() }));
}

/** Vendors that may not be paid: blocked on verification, or a latest credit check of BLOCK. */
export function blockedVendors(vendors: Vendor[], checks: CreditCheck[]): Vendor[] {
	const latest = latestChecks(checks, 'vendor');
	return vendors.filter((v) => v.verification === 'blocked' || latest.get(v.id)?.tier === 'BLOCK');
}

// ---- Charts ----

/** The month index an arrow, Home or End key moves to from `i` among `n` months; null for any other key. */
export function stepIndex(i: number | null, key: string, n: number): number | null {
	if (!n) return null;
	const at = i ?? n - 1;
	if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, at - 1);
	if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(n - 1, at + 1);
	if (key === 'Home') return 0;
	if (key === 'End') return n - 1;
	return null;
}

/** Bar width as a whole percent of the largest value; a non-zero value always shows at least a sliver. */
export function barPct(value: number, max: number): number {
	if (max <= 0 || value <= 0) return 0;
	return Math.max(2, Math.round((value / max) * 100));
}
