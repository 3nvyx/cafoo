// The scripted September close the mock source replays when the CFO clicks
// "Close September". About 22 seconds end to end. Times are ms after start.
import type { AgentRole, CloseTaskStatus, MessageKind, Minor, ProposalKind, ProposalStatus, VendorVerification } from '../types';

export interface ScriptLine {
	account: string;
	debitMinor: Minor;
	creditMinor: Minor;
	customerId?: string;
	vendorId?: string;
}

export interface ScriptProposal {
	id: string;
	kind: ProposalKind;
	proposerRole: AgentRole;
	amountMinor: Minor;
	summaryPlain: string;
	rationale: string;
	payload: Record<string, unknown> & { memo?: string; lines?: ScriptLine[] };
	taskId: string;
}

export type Step =
	| { at: number; type: 'activity'; role: AgentRole; label: string; proposalId?: string }
	| { at: number; type: 'idle' }
	| { at: number; type: 'message'; role: AgentRole; kind: MessageKind; body: string; summary: string; proposalId?: string }
	| { at: number; type: 'propose'; proposal: ScriptProposal; body: string; summary: string }
	| { at: number; type: 'rule'; proposalId: string; body: string; summary: string; rationale: string }
	| { at: number; type: 'task'; taskId: string; status: CloseTaskStatus }
	| { at: number; type: 'status'; proposalId: string; status: ProposalStatus }
	| { at: number; type: 'vendor'; vendorId: string; verification: VendorVerification; note: string }
	| { at: number; type: 'wrapup' };

const L = (account: string, debitMinor: Minor, creditMinor: Minor, extra: Partial<ScriptLine> = {}): ScriptLine => ({
	account,
	debitMinor,
	creditMinor,
	...extra
});

export const CLOSE_SCRIPT: Step[] = [
	{ at: 0, type: 'activity', role: 'advisor', label: 'Opening the September close' },
	{
		at: 600,
		type: 'message',
		role: 'advisor',
		kind: 'statement',
		body: 'Opening close for 2026-09. Bookkeeper: bank reconciliation and payables. Revenue: deferred and prepaid review. Credit & Risk: receivables and Allowance. Red Team reviews every proposal before I rule.',
		summary: 'The Advisor opened the September close and asked each agent for its remaining items.'
	},
	{ at: 700, type: 'task', taskId: 'ct-5', status: 'in_progress' },
	{ at: 1400, type: 'activity', role: 'bookkeeper', label: 'Matching the last bank deposits' },
	{
		at: 2400,
		type: 'propose',
		proposal: {
			id: 'pr-09',
			kind: 'bank_match',
			proposerRole: 'bookkeeper',
			amountMinor: '60000',
			summaryPlain: "Match Harbor Yoga Studio's $600 deposit to their September invoice.",
			rationale: 'Amount and payer exact; the bank memo has no invoice reference. Score 9,400 bp, bucket strong.',
			payload: {
				bankTransactionId: 'bt13',
				invoiceId: 'i16',
				scoreBp: 9400,
				bucket: 'strong',
				memo: 'Harbor Yoga Studio deposit matched to INV-1047',
				lines: [L('1000', '60000', '0'), L('1100', '0', '60000', { customerId: 'c05' })]
			},
			taskId: 'ct-1'
		},
		body: "bt13 +600.00 'DEPOSIT HARBOR YOGA STUDIO' vs i16 INV-1047 600.00 open, customer c05. Amount exact, payer exact, no reference. scoreBp 9400, bucket strong. Dr 1000 / Cr 1100 600.00.",
		summary: "Bookkeeper matched Harbor Yoga Studio's $600 deposit to their September invoice."
	},
	{ at: 3000, type: 'activity', role: 'redteam', label: 'Reviewing the Harbor Yoga match', proposalId: 'pr-09' },
	{
		at: 3800,
		type: 'message',
		proposalId: 'pr-09',
		role: 'redteam',
		kind: 'critique',
		body: 'No other open invoice for c05 at 600.00. The missing reference lowers confidence, but amount and payer are unique this month. No objection.',
		summary: 'Red Team checked for look-alike invoices and found none.'
	},
	{ at: 4200, type: 'activity', role: 'advisor', label: 'Ruling on the Harbor Yoga match', proposalId: 'pr-09' },
	{ at: 4800, type: 'rule', proposalId: 'pr-09', body: 'APPROVE pr-09.', summary: 'Advisor approved the match.', rationale: 'Unique amount and payer; Red Team found no conflict.' },
	{ at: 5000, type: 'activity', role: 'credit', label: 'Following up on Copperline Electric', proposalId: 'pr-06' },
	{
		at: 5300,
		type: 'message',
		proposalId: 'pr-06',
		role: 'credit',
		kind: 'statement',
		body: 'Per CFO note on pr-06: called guarantor per-06 (Tom Brennan). Agreed payment plan: 4,500.00 past due settled by 2026-10-15. Withdrawing the credit line cut; pr-06 superseded. Allowance treatment moves to the Allowance review.',
		summary: 'Credit & Risk called the owner as you asked. He agreed to pay by October 15, so the credit cut is withdrawn.'
	},
	{ at: 5350, type: 'status', proposalId: 'pr-06', status: 'superseded' },
	{ at: 5600, type: 'activity', role: 'bookkeeper', label: 'Checking vendor payments for duplicates' },
	{
		at: 6400,
		type: 'propose',
		proposal: {
			id: 'pr-10',
			kind: 'journal_entry',
			proposerRole: 'bookkeeper',
			amountMinor: '1840000',
			summaryPlain: 'Brightline Cloud Hosting was paid $18,400 twice. Record the second payment as money they owe us back.',
			rationale: 'bt07 and bt08 are identical disbursements one day apart for the same two bills. je-0906 over-relieved payables.',
			payload: {
				bankTransactionIds: ['bt07', 'bt08'],
				duplicateOfJeId: 'je-0905',
				memo: 'Duplicate payment to Brightline Cloud Hosting, refund due',
				lines: [L('1250', '1840000', '0', { vendorId: 'v01' }), L('2000', '0', '1840000', { vendorId: 'v01' })]
			},
			taskId: 'ct-2'
		},
		body: 'Duplicate disbursement: bt07 2026-09-10 and bt08 2026-09-11, both -18,400.00 to Brightline Cloud Hosting, both referencing BCH-0731/0820 (9,800.00 + 8,600.00). je-0906 over-relieved 2000 by 18,400.00. Propose Dr 1250 Receivable from Vendors 18,400.00 / Cr 2000 Accounts Payable 18,400.00, vendor v01, and request a refund.',
		summary: 'Bookkeeper found that Brightline Cloud Hosting was paid $18,400 twice and wants to record the refund we are owed.'
	},
	{ at: 7200, type: 'activity', role: 'redteam', label: 'Challenging the duplicate payment claim', proposalId: 'pr-10' },
	{
		at: 8200,
		type: 'message',
		proposalId: 'pr-10',
		role: 'redteam',
		kind: 'critique',
		body: 'Verified: identical amount, payee and memo one day apart; b01 9,800.00 and b02 8,600.00 sum to 18,400.00 and each was billed once. Not a split payment. Do not expense it yet: nothing suggests the vendor will refuse, so a receivable is right. Flag collectability if no refund within 30 days.',
		summary: 'Red Team confirmed it is a true duplicate and agreed to record it as money owed back to us, not a loss.'
	},
	{ at: 8700, type: 'activity', role: 'advisor', label: 'Ruling on the duplicate payment', proposalId: 'pr-10' },
	{ at: 9200, type: 'rule', proposalId: 'pr-10', body: 'APPROVE pr-10 as proposed. Evidence: bt07, bt08, b01, b02.', summary: 'Advisor approved recording the $18,400 as owed back to us.', rationale: 'Bank and bill evidence both confirm a duplicate.' },
	{ at: 9800, type: 'activity', role: 'revenue', label: 'Reviewing annual prepayments' },
	{
		at: 10800,
		type: 'propose',
		proposal: {
			id: 'pr-11',
			kind: 'revenue_schedule',
			proposerRole: 'revenue',
			amountMinor: '2200000',
			summaryPlain: "Move $22,000 of Granite Peak Climbing's yearly payment out of September revenue. Only one month of it has been earned.",
			rationale: 'k19 is an annual plan credited in full to revenue by je-0903. Ratable recognition over 12 months earns 2,000.00 in September.',
			payload: {
				contractId: 'k19',
				schedule: { months: 12, convention: 'full-month', earnedThisPeriodMinor: '200000' },
				memo: 'Defer unearned part of Granite Peak Climbing annual plan',
				lines: [L('4000', '2200000', '0', { customerId: 'c19' }), L('2400', '0', '2200000', { customerId: 'c19' })]
			},
			taskId: 'ct-3'
		},
		body: 'Contract k19 (Granite Peak Climbing, annual, 24,000.00, start 2026-09-05) was credited in full to 4000 via je-0903. The obligation is satisfied ratably over 12 months. Earned for 2026-09 (full-month convention): 2,000.00. Propose Dr 4000 Subscription Revenue 22,000.00 / Cr 2400 Deferred Revenue 22,000.00, customer c19.',
		summary: "Revenue wants to move $22,000 of Granite Peak Climbing's yearly payment out of September revenue."
	},
	{ at: 11600, type: 'activity', role: 'redteam', label: 'Checking the Granite Peak schedule', proposalId: 'pr-11' },
	{
		at: 12600,
		type: 'message',
		proposalId: 'pr-11',
		role: 'redteam',
		kind: 'critique',
		body: 'Agree with the deferral. Challenge: with a daily convention a 2026-09-05 start earns 1,710.00 in September, not 2,000.00. Policy REV-02 sets full-month convention for starts on or before the 15th, so 2,000.00 stands. Checked for a setup fee in the contract: none.',
		summary: 'Red Team agreed after checking the start-date rule; September keeps $2,000 of it.'
	},
	{ at: 13100, type: 'activity', role: 'advisor', label: 'Ruling on the Granite Peak schedule', proposalId: 'pr-11' },
	{ at: 13600, type: 'rule', proposalId: 'pr-11', body: 'APPROVE pr-11. Policy REV-02 applied.', summary: 'Advisor approved moving $22,000 to deferred revenue.', rationale: 'Ratable recognition per REV-02.' },
	{ at: 14200, type: 'activity', role: 'bookkeeper', label: 'Looking for unbilled costs' },
	{
		at: 15000,
		type: 'propose',
		proposal: {
			id: 'pr-12',
			kind: 'accrual',
			proposerRole: 'bookkeeper',
			amountMinor: '295000',
			summaryPlain: 'Record $2,950 of September support hours that Helpdesk Collective has not billed yet.',
			rationale: 'Timesheets show 59 hours beyond the HC-2609 retainer at 50.00/h, billed in arrears.',
			payload: {
				vendorId: 'v02',
				evidence: 'timesheets-2026-09.csv',
				memo: 'Support hours incurred in September, not yet billed',
				lines: [L('5100', '295000', '0'), L('2100', '0', '295000', { vendorId: 'v02' })]
			},
			taskId: 'ct-2'
		},
		body: 'Helpdesk Collective timesheets show 59 contractor hours in 2026-09 beyond the HC-2609 retainer at 50.00/h = 2,950.00, billed in arrears. Dr 5100 Customer Support 2,950.00 / Cr 2100 Accrued Expenses 2,950.00, vendor v02.',
		summary: 'Bookkeeper wants to record $2,950 of September support hours not billed yet.'
	},
	{ at: 15800, type: 'rule', proposalId: 'pr-12', body: 'APPROVE pr-12. Timesheet evidence attached; no Red Team objection in the review window.', summary: 'Advisor approved it.', rationale: 'Timesheet evidence.' },
	{ at: 16400, type: 'activity', role: 'credit', label: 'Re-scoring receivables' },
	{
		at: 17200,
		type: 'propose',
		proposal: {
			id: 'pr-13',
			kind: 'journal_entry',
			proposerRole: 'credit',
			amountMinor: '1127500',
			summaryPlain: 'Set aside $11,275 for invoices that three customers are unlikely to pay.',
			rationale: 'Copperline Electric and Summit Ridge Roofing moved to tier D, Brightwater Pools is BLOCK. Rates: D 75%, BLOCK 100%.',
			payload: {
				tiers: { c06: 'D', c14: 'D', c15: 'BLOCK' },
				ratesBp: { D: 7500, BLOCK: 10000 },
				memo: 'Allowance for credit losses, September',
				lines: [L('6500', '1127500', '0'), L('1150', '0', '337500', { customerId: 'c06' }), L('1150', '0', '690000', { customerId: 'c14' }), L('1150', '0', '100000', { customerId: 'c15' })]
			},
			taskId: 'ct-4'
		},
		body: 'Risk Tier migration: c06 Copperline Electric C->D (cc04), c14 Summit Ridge Roofing C->D (cc07); c15 Brightwater Pools BLOCK (cc08). Allowance rates: D 75%, BLOCK 100%. Open AR: c06 4,500.00, c14 9,200.00, c15 1,000.00. Required: 0.75 x 13,700.00 + 1,000.00 = 11,275.00; current 1150 balance 0.00. Propose Dr 6500 Credit Loss Expense 11,275.00 / Cr 1150 Allowance for Credit Losses 11,275.00.',
		summary: 'Credit & Risk wants to set aside $11,275 for invoices it expects three customers will not pay.'
	},
	{ at: 18000, type: 'activity', role: 'redteam', label: 'Testing the Allowance rates', proposalId: 'pr-13' },
	{
		at: 18800,
		type: 'message',
		proposalId: 'pr-13',
		role: 'redteam',
		kind: 'critique',
		body: 'Rates are aggressive but supportable: c14 has 4 invoices past due including one at 95 days and a civil judgment; c06 paid 3 of its last 5 invoices after 40+ days. Counterpoint: c06 has never defaulted. A 50% rate on c06 gives 10,150.00, still above materiality. No objection to 75%.',
		summary: 'Red Team pushed on the rates but accepted them; even a softer rate would still need your OK.'
	},
	{ at: 19200, type: 'activity', role: 'advisor', label: 'Ruling on the Allowance', proposalId: 'pr-13' },
	{ at: 19600, type: 'rule', proposalId: 'pr-13', body: 'APPROVE pr-13.', summary: 'Advisor approved setting aside $11,275.', rationale: 'Tier evidence from cc04, cc07, cc08.' },
	{
		at: 20200,
		type: 'message',
		proposalId: 'pr-08',
		role: 'credit',
		kind: 'statement',
		body: 'Amending pr-08 scope to payments only. AP inbox confirms the 09-18 change came from the known contact; the 09-27 change did not. Holding HFC-4471 until a call to the number on the original tax form.',
		summary: 'Credit & Risk narrowed the block to payments only, as the Red Team asked.'
	},
	{ at: 20800, type: 'rule', proposalId: 'pr-08', body: 'APPROVE pr-08 as amended (payments only).', summary: 'Advisor approved pausing payments to Halvorsen Freight Co.', rationale: 'Scope narrowed per Red Team.' },
	{ at: 20900, type: 'vendor', vendorId: 'v09', verification: 'blocked', note: 'Payments on hold until the new bank account is confirmed by phone.' },
	{ at: 21600, type: 'wrapup' },
	{ at: 21700, type: 'idle' }
];
