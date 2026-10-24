// Display words, straight from the CONTEXT.md glossary.
import type { AgentRole, CloseTaskStatus, MessageKind, PostedByRole, ProposalKind, ProposalStatus, RiskTier, VendorVerification } from './data/types';

export const ROLE: Record<PostedByRole, { name: string; initials: string }> = {
	advisor: { name: 'Advisor', initials: 'AD' },
	bookkeeper: { name: 'Bookkeeper', initials: 'BK' },
	revenue: { name: 'Revenue', initials: 'RV' },
	credit: { name: 'Credit & Risk', initials: 'CR' },
	redteam: { name: 'Red Team', initials: 'RT' },
	cfo: { name: 'CFO', initials: 'You' },
	system: { name: 'System', initials: 'SY' },
	seed: { name: 'Opening data', initials: 'OD' }
};

export const roleName = (r: PostedByRole) => ROLE[r]?.name ?? r;

export const KIND: Record<ProposalKind, string> = {
	journal_entry: 'Journal Entry',
	bank_match: 'Bank Match',
	revenue_schedule: 'Revenue Schedule',
	credit_decision: 'Credit decision',
	accrual: 'Accrual',
	vendor_block: 'Vendor block',
	vendor_verify: 'Vendor check'
};

export const STATUS: Record<ProposalStatus, { label: string; tone: Tone }> = {
	open: { label: 'In debate', tone: 'neutral' },
	awaiting_cfo: { label: 'Awaiting confirmation', tone: 'accent' },
	approved: { label: 'Approved', tone: 'pos' },
	amended: { label: 'Amended and approved', tone: 'pos' },
	rejected: { label: 'Rejected', tone: 'neg' },
	sent_back: { label: 'Sent back', tone: 'warn' },
	superseded: { label: 'Superseded', tone: 'muted' }
};

export const TASK_STATUS: Record<CloseTaskStatus, { label: string; tone: Tone }> = {
	todo: { label: 'To do', tone: 'muted' },
	in_progress: { label: 'In progress', tone: 'neutral' },
	blocked: { label: 'Waiting', tone: 'warn' },
	done: { label: 'Done', tone: 'pos' }
};

export const MESSAGE_KIND: Record<MessageKind, string> = {
	statement: 'Statement',
	critique: 'Critique',
	question: 'Question',
	ruling: 'Ruling'
};

export const TIER: Record<RiskTier, { label: string; tone: Tone; plain: string }> = {
	A: { label: 'Tier A', tone: 'pos', plain: 'Low risk' },
	B: { label: 'Tier B', tone: 'neutral', plain: 'Some risk' },
	C: { label: 'Tier C', tone: 'warn', plain: 'Watch closely' },
	D: { label: 'Tier D', tone: 'neg', plain: 'High risk' },
	BLOCK: { label: 'BLOCK', tone: 'neg', plain: 'Do not extend credit' }
};

export const VERIFICATION: Record<VendorVerification, { label: string; tone: Tone }> = {
	verified: { label: 'Verified', tone: 'pos' },
	unverified: { label: 'Unverified', tone: 'warn' },
	blocked: { label: 'Blocked', tone: 'neg' }
};

export type Tone = 'neutral' | 'muted' | 'accent' | 'pos' | 'neg' | 'warn';

export function shortDate(iso: string): string {
	return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function dateTime(iso: string): string {
	return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

export function timeOnly(iso: string): string {
	return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
}

/** Ledger drill-down links live in drill.ts; re-exported here because most screens import labels. */
export { drill } from './drill';
