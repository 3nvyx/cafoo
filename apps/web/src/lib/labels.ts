// Display words, straight from the CONTEXT.md glossary.
import type { AgentRole, CloseTaskStatus, DocumentKind, MessageKind, PostedByRole, ProposalKind, ProposalStatus, RiskTier, VendorVerification } from './data/types';

export const ROLE: Record<PostedByRole, { name: string; initials: string }> = {
	advisor: { name: 'Advisor', initials: 'AD' },
	bookkeeper: { name: 'Bookkeeper', initials: 'BK' },
	revenue: { name: 'Revenue', initials: 'RV' },
	credit: { name: 'Credit & Risk', initials: 'CR' },
	consolidation: { name: 'Consolidation', initials: 'CO' },
	funding: { name: 'Funding desk', initials: 'FD' },
	capital: { name: 'Capital accountant', initials: 'CA' },
	feed: { name: 'Bank feed', initials: 'BF' },
	redteam: { name: 'Red Team', initials: 'RT' },
	cfo: { name: 'CFO', initials: 'You' },
	system: { name: 'System', initials: 'SY' },
	seed: { name: 'Opening data', initials: 'OD' }
};

export const roleName = (r: PostedByRole) => ROLE[r]?.name ?? r;

/**
 * Which model wrote a Red Team critique, when the body says so. Gemini, the second critic, starts every critique with
 * "Gemini: " (live) or "Gemini (scripted): " (Demo mode stand-in); the first critic's critiques carry no label.
 */
export function criticOf(body: string): { name: string; scripted: boolean } | undefined {
	const m = /^Gemini( \(scripted\))?: /.exec(body);
	return m ? { name: 'Gemini', scripted: Boolean(m[1]) } : undefined;
}

export const KIND: Record<ProposalKind, string> = {
	journal_entry: 'Journal Entry',
	bank_match: 'Bank Match',
	revenue_schedule: 'Revenue Schedule',
	credit_decision: 'Credit decision',
	accrual: 'Accrual',
	vendor_block: 'Vendor block',
	vendor_verify: 'Vendor check',
	fx_revaluation: 'Revaluation',
	ic_elimination: 'Elimination',
	funding_receipt: 'Funding receipt',
	instrument_record: 'Instrument',
	interest_accrual: 'Interest accrual',
	instrument_conversion: 'Conversion',
	payroll_run: 'Pay run',
	cost_allocation: 'Cost allocation',
	credit_breakage: 'Credit breakage',
	inventory_writeoff: 'Stock write-off'
};

/** Each uploadable file: its name, the format the sample comes in, and what Luyten reads from it. */
export const DOCUMENT: Record<DocumentKind, { label: string; format: string; readsPlain: string }> = {
	bank_statement: { label: 'Bank statement', format: 'CSV', readsPlain: 'Every line, matched to invoices and bills' },
	invoices: { label: 'Invoices', format: 'CSV', readsPlain: 'Customer invoices with due dates' },
	bills: { label: 'Vendor bills', format: 'PDF', readsPlain: 'Bills with amounts, due dates and service periods' },
	contracts: { label: 'Customer contract', format: 'PDF', readsPlain: 'Term, billing and ARR for revenue schedules' },
	safe: { label: 'SAFE', format: 'PDF', readsPlain: 'Amount, valuation cap, discount, MFN and pro rata' },
	convertible_note: { label: 'Convertible note', format: 'PDF', readsPlain: 'Principal, interest, maturity, cap and discount' },
	term_sheet: { label: 'Term sheet', format: 'PDF', readsPlain: 'Price, pre-money, option pool and preferences' },
	side_letter: { label: 'Side letter', format: 'PDF', readsPlain: 'Extra rights an investor was given' },
	wire_confirmation: { label: 'Wire confirmation', format: 'PDF', readsPlain: 'Who sent money, how much, and the fee taken' },
	closing_tracker: { label: 'Closing tracker', format: 'XLSX', readsPlain: 'Who committed to the round and how much' },
	cap_table: { label: 'Cap table export', format: 'CSV', readsPlain: 'Every holder, class and share count' },
	valuation_report: { label: 'Valuation report', format: 'PDF', readsPlain: 'Fair values for SAFEs, warrants and common stock' },
	payroll_register: { label: 'Payroll register', format: 'CSV', readsPlain: 'Gross pay, taxes, deductions and net pay per person' },
	pto_report: { label: 'Time-off report', format: 'CSV', readsPlain: 'Balances, accruals and time taken' },
	cloud_bill: { label: 'Cloud bill', format: 'CSV', readsPlain: 'Spend by service, environment and product tag' },
	model_usage: { label: 'Model usage export', format: 'CSV', readsPlain: 'Tokens and spend by model and product' }
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
