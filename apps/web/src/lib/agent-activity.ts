// What each agent did and which tools stand behind it, for the Agents page. Pure: built from the recorded Proposals,
// agent messages and Credit Checks. The tool names are the ones on the role's harness for that kind of work
// (apps/agents/src/harness, shown on Charters); they describe the work, they are not a log of model calls.
import type { AgentMessage, AgentRole, CreditCheck, Proposal, ProposalKind } from './data/types';

export const ACTIVITY_ROLES = ['bookkeeper', 'revenue', 'credit', 'consolidation', 'redteam', 'advisor'] as const;
export type ActivityRole = (typeof ACTIVITY_ROLES)[number];

export interface ActivityItem {
	id: string;
	at: string;
	/** What happened, in one plain line. */
	text: string;
	/** The kind of work ("Bank Match", "Credit Check", "Critique"). */
	label: string;
	tools: string[];
	proposalId?: string;
	status?: Proposal['status'];
}

export interface AgentActivity {
	role: ActivityRole;
	items: ActivityItem[];
	/** Proposals this agent made, by kind label, superseded ones left out. */
	byKind: { label: string; count: number }[];
	made: number;
	approved: number;
	waitingCfo: number;
	/** Distinct tools behind the items, most used first. */
	toolsUsed: { name: string; count: number }[];
}

export interface ActivityInput {
	proposals: Proposal[];
	messages: AgentMessage[];
	creditChecks: CreditCheck[];
	/** Display name of a customer or vendor by id. */
	nameOf?: (kind: 'customer' | 'vendor', id: string) => string | undefined;
	/** Kind labels (#lib/labels.js KIND). */
	kindLabel: (k: ProposalKind) => string;
}

/** The harness tools behind each kind of Proposal, in the order the agent uses them. */
export function toolsForProposal(p: Pick<Proposal, 'kind' | 'proposerRole'>): string[] {
	switch (p.kind) {
		case 'bank_match':
			return ['score_bank_matches', 'propose_bank_match'];
		case 'accrual':
			return ['detect_missing_accruals', 'propose_accrual'];
		case 'journal_entry':
			return p.proposerRole === 'credit' ? ['allowance_target', 'propose_journal_entry'] : ['propose_journal_entry'];
		case 'revenue_schedule':
			return ['build_revenue_schedule', 'propose_revenue_schedule'];
		case 'credit_decision':
			return ['run_credit_cascade', 'record_credit_check', 'propose_credit_decision'];
		case 'vendor_block':
			return ['run_credit_cascade', 'propose_vendor_block'];
		case 'vendor_verify':
			return ['run_credit_cascade', 'propose_vendor_verify'];
		case 'fx_revaluation':
			return ['revaluation_candidates', 'propose_fx_revaluation'];
		case 'ic_elimination':
			return ['elimination_candidates', 'propose_ic_elimination'];
		default:
			return [];
	}
}

function toolForMessage(m: AgentMessage): string {
	if (m.kind === 'critique') return 'submit_critique';
	if (m.kind === 'ruling') {
		if (/^\s*REJECT/i.test(m.body)) return 'reject_proposal';
		if (/^\s*(APPROVE|AMEND)/i.test(m.body)) return 'approve_proposal';
		return 'post_ruling';
	}
	return 'post_message';
}

const parse = (json: string): Record<string, unknown> => {
	try {
		const v = JSON.parse(json);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * The finding of a Credit Check in a few words. A live row stores the cascade's facts (packages/crs-mcp
 * creditCheckSummaryJson): a bureau file status other than returned (NO_HIT, FROZEN, DECEASED), a failed identity
 * check or high fraud. A Demo-mode row stores a short summary (credit band, public records).
 */
export function creditFinding(summaryJson: string): string {
	const s = parse(summaryJson);
	const facts = obj(s.facts);
	const parts: string[] = [];
	const identity = obj(facts.identity);
	if (identity.result && identity.result !== 'PASS') parts.push(`identity ${String(identity.result)}`);
	if (identity.deceased) parts.push('DECEASED');
	if (identity.synthetic) parts.push('synthetic identity');
	const fraud = obj(facts.fraud);
	if (fraud.level === 'high') parts.push('fraud risk high');
	const files = Object.values(obj(facts.bureaus)).map((b) => String(obj(b).fileStatus ?? '')).filter((f) => f && f !== 'returned');
	for (const f of new Set(files)) parts.push(f.toUpperCase());
	const records = obj(facts.publicRecords);
	if (Number(obj(records.counts).bankruptcies) > 0) parts.push('bankruptcy on record');
	if (!Object.keys(facts).length) {
		if (typeof s.identity === 'string' && s.identity !== 'pass') parts.push(`identity ${s.identity}`);
		if (typeof s.fraud === 'string' && s.fraud !== 'low') parts.push(`fraud ${s.fraud}`);
		if (typeof s.creditBand === 'string') parts.push(`${s.creditBand} credit`);
		if (typeof s.publicRecords === 'string' && s.publicRecords !== 'none') parts.push(s.publicRecords);
	}
	return [...new Set(parts)].join(', ');
}

export function agentActivity(input: ActivityInput): AgentActivity[] {
	const { proposals, messages, creditChecks, nameOf, kindLabel } = input;
	const byRole = new Map<ActivityRole, ActivityItem[]>(ACTIVITY_ROLES.map((r) => [r, []]));
	const push = (role: AgentRole, item: ActivityItem) => byRole.get(role as ActivityRole)?.push(item);

	for (const p of proposals) {
		if (p.status === 'superseded') continue;
		push(p.proposerRole, { id: `p:${p.id}`, at: p.createdAt, label: kindLabel(p.kind), text: p.summaryPlain, tools: toolsForProposal(p), proposalId: p.id, status: p.status });
	}
	// Messages: a worker's statements on its own Proposal repeat that Proposal, so only its close-thread messages show;
	// the Red Team's critiques and the Advisor's rulings are their work.
	for (const m of messages) {
		const own = m.senderRole === 'redteam' || m.senderRole === 'advisor';
		if (!own && m.proposalId) continue;
		push(m.senderRole, { id: `m:${m.id}`, at: m.createdAt, label: m.kind === 'critique' ? 'Critique' : m.kind === 'ruling' ? 'Ruling' : 'Close thread', text: m.summaryPlain || m.body, tools: [toolForMessage(m)], proposalId: m.proposalId });
	}
	// Credit Checks: a live cascade records one row per product, so one item per subject and persona (the latest row).
	const latest = new Map<string, CreditCheck>();
	for (const c of creditChecks) {
		const key = `${c.subjectKind}:${c.subjectId}:${c.personaId}`;
		const prev = latest.get(key);
		if (!prev || prev.checkedAt < c.checkedAt) latest.set(key, c);
	}
	for (const c of latest.values()) {
		const who = nameOf?.(c.subjectKind, c.subjectId);
		const subject = who ? (c.subjectKind === 'customer' ? `, guarantor of ${who}` : `, owner of ${who}`) : '';
		const finding = creditFinding(c.summaryJson);
		push('credit', {
			id: `c:${c.id}`,
			at: c.checkedAt,
			label: 'Credit Check',
			text: `Ran the CRS cascade on persona ${c.personaId}${subject}: Tier ${c.tier}${finding ? `, ${finding}` : ''}.`,
			tools: ['run_credit_cascade', 'record_credit_check']
		});
	}

	return ACTIVITY_ROLES.map((role) => {
		const items = byRole.get(role)!.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
		const own = proposals.filter((p) => p.proposerRole === role && p.status !== 'superseded');
		const kinds = new Map<string, number>();
		for (const p of own) kinds.set(kindLabel(p.kind), (kinds.get(kindLabel(p.kind)) ?? 0) + 1);
		const tools = new Map<string, number>();
		for (const i of items) for (const t of i.tools) tools.set(t, (tools.get(t) ?? 0) + 1);
		return {
			role,
			items,
			byKind: [...kinds].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
			made: own.length,
			approved: own.filter((p) => p.status === 'approved' || p.status === 'amended').length,
			waitingCfo: own.filter((p) => p.status === 'awaiting_cfo').length,
			toolsUsed: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
		};
	});
}
