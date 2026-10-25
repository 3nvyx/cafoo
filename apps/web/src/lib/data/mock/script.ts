// The scripted September close the mock source replays when the CFO clicks
// "Close September". About 31 seconds end to end. Times are ms after start.
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
	| { at: number; type: 'wrapup' }
	/**
	 * The Consolidation agent proposes the month's Revaluation and Eliminations, computed from the books by the ledger
	 * engine. The mock source also files the Red Team's critique of each, from the same figures, 0.4, 0.8 and 1.2 s later.
	 */
	| { at: number; type: 'consolidate'; taskId: string };

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
	{
		at: 4000,
		type: 'message',
		proposalId: 'pr-09',
		role: 'redteam',
		kind: 'critique',
		body: 'Gemini (scripted): Agree there is no look-alike invoice. One addition: ask Harbor Yoga to put the invoice number on future payments, so next month this matches on the reference instead of the amount.',
		summary: 'Gemini agrees and suggests asking the customer to quote the invoice number on future payments.'
	},
	{ at: 4200, type: 'activity', role: 'advisor', label: 'Ruling on the Harbor Yoga match', proposalId: 'pr-09' },
	{ at: 4800, type: 'rule', proposalId: 'pr-09', body: 'APPROVE pr-09.', summary: 'Advisor approved the match.', rationale: 'Unique amount and payer; Red Team found no conflict.' },
	// The deposits that match an open invoice to the cent, the fee and interest the bank booked, and the returned payment.
	{ at: 5000, type: 'activity', role: 'bookkeeper', label: 'Matching the other unmatched deposits' },
	{
		at: 5500,
		type: 'propose',
		proposal: {
			id: 'pr-14',
			kind: 'bank_match',
			proposerRole: 'bookkeeper',
			amountMinor: '250000',
			summaryPlain: "Match Foxglove Catering's $2,500 deposit to their September invoice.",
			rationale: "Amount exact; payer 'FOXGLOVE CAT LLC' is an abbreviation of Foxglove Catering, with no invoice reference. Score 9,100 bp, bucket strong.",
			payload: {
				bankTransactionId: 'bt12',
				invoiceId: 'i26',
				scoreBp: 9100,
				bucket: 'strong',
				memo: 'Foxglove Catering deposit matched to INV-1058',
				lines: [L('1000', '250000', '0'), L('1100', '0', '250000', { customerId: 'c18' })]
			},
			taskId: 'ct-1'
		},
		body: "bt12 +2,500.00 'DEPOSIT FOXGLOVE CAT LLC' vs i26 INV-1058 2,500.00 open, customer c18. Amount exact to the cent, payer an abbreviation of the customer's name, no reference. scoreBp 9100, bucket strong. Dr 1000 / Cr 1100 2,500.00.",
		summary: "Bookkeeper matched Foxglove Catering's $2,500 deposit to their September invoice."
	},
	{
		at: 5750,
		type: 'propose',
		proposal: {
			id: 'pr-15',
			kind: 'bank_match',
			proposerRole: 'bookkeeper',
			amountMinor: '75000',
			summaryPlain: "Match Riverside Tutoring's $750 deposit to their September invoice.",
			rationale: "Amount exact; payer 'RIVERSIDE TUTOR' is a truncation of Riverside Tutoring. Score 9,300 bp, bucket strong.",
			payload: {
				bankTransactionId: 'bt17',
				invoiceId: 'i14',
				scoreBp: 9300,
				bucket: 'strong',
				memo: 'Riverside Tutoring deposit matched to INV-1045',
				lines: [L('1000', '75000', '0'), L('1100', '0', '75000', { customerId: 'c17' })]
			},
			taskId: 'ct-1'
		},
		body: "bt17 +750.00 'DEPOSIT RIVERSIDE TUTOR' vs i14 INV-1045 750.00 open, customer c17. Amount exact, payer truncated by the bank, no reference. scoreBp 9300, bucket strong. Dr 1000 / Cr 1100 750.00.",
		summary: "Bookkeeper matched Riverside Tutoring's $750 deposit to their September invoice."
	},
	{
		at: 6000,
		type: 'propose',
		proposal: {
			id: 'pr-16',
			kind: 'bank_match',
			proposerRole: 'bookkeeper',
			amountMinor: '220000',
			summaryPlain: "Match Tallgrass Fitness's $2,200 deposit to their August invoice.",
			rationale: "Amount exact; payer 'TALLGRASS FIT' is a truncation of Tallgrass Fitness. The invoice was due on September 24, so this is one day late. Score 9,400 bp, bucket strong.",
			payload: {
				bankTransactionId: 'bt22',
				invoiceId: 'i11',
				scoreBp: 9400,
				bucket: 'strong',
				memo: 'Tallgrass Fitness deposit matched to INV-1040',
				lines: [L('1000', '220000', '0'), L('1100', '0', '220000', { customerId: 'c08' })]
			},
			taskId: 'ct-1'
		},
		body: "bt22 +2,200.00 'DEPOSIT TALLGRASS FIT' vs i11 INV-1040 2,200.00 overdue since 2026-09-24, customer c08. Amount exact, payer truncated, no reference. scoreBp 9400, bucket strong. Dr 1000 / Cr 1100 2,200.00.",
		summary: "Bookkeeper matched Tallgrass Fitness's $2,200 deposit to their overdue August invoice."
	},
	{
		at: 6250,
		type: 'propose',
		proposal: {
			id: 'pr-17',
			kind: 'bank_match',
			proposerRole: 'bookkeeper',
			amountMinor: '90000',
			summaryPlain: "Match Ironwood Auto Repair's $900 deposit to their September invoice.",
			rationale: "Amount exact; payer 'IRONWOOD AUTO' is a truncation of Ironwood Auto Repair. The invoice was due on September 20. Score 9,300 bp, bucket strong.",
			payload: {
				bankTransactionId: 'bt30',
				invoiceId: 'i15',
				scoreBp: 9300,
				bucket: 'strong',
				memo: 'Ironwood Auto Repair deposit matched to INV-1046',
				lines: [L('1000', '90000', '0'), L('1100', '0', '90000', { customerId: 'c11' })]
			},
			taskId: 'ct-1'
		},
		body: "bt30 +900.00 'DEPOSIT IRONWOOD AUTO' vs i15 INV-1046 900.00 overdue since 2026-09-20, customer c11. Amount exact, payer truncated, no reference. scoreBp 9300, bucket strong. Dr 1000 / Cr 1100 900.00.",
		summary: "Bookkeeper matched Ironwood Auto Repair's $900 deposit to their overdue September invoice."
	},
	{ at: 6500, type: 'activity', role: 'bookkeeper', label: 'Booking the bank fee, the interest and the returned payment' },
	{
		at: 6900,
		type: 'propose',
		proposal: {
			id: 'pr-18',
			kind: 'journal_entry',
			proposerRole: 'bookkeeper',
			amountMinor: '8400',
			summaryPlain: 'Record the bank\'s $84 monthly service fee.',
			rationale: 'bt15 is the bank charging its monthly service fee. There is no invoice behind it; the bank statement is the evidence.',
			payload: {
				bankTransactionId: 'bt15',
				memo: 'Bank monthly service fee, September',
				lines: [L('6700', '8400', '0'), L('1000', '0', '8400')]
			},
			taskId: 'ct-1'
		},
		body: "bt15 2026-09-18 -84.00 'MONTHLY SERVICE FEE', counterparty Bank. Not a customer or vendor payment. Dr 6700 Bank Fees 84.00 / Cr 1000 Operating Cash 84.00.",
		summary: "Bookkeeper wants to record the bank's $84 service fee as an expense."
	},
	{
		at: 7150,
		type: 'propose',
		proposal: {
			id: 'pr-19',
			kind: 'journal_entry',
			proposerRole: 'bookkeeper',
			amountMinor: '1250',
			summaryPlain: 'Record $12.50 of interest the bank paid us.',
			rationale: 'bt29 is interest credited by the bank on September 30. There is no invoice behind it; the bank statement is the evidence.',
			payload: {
				bankTransactionId: 'bt29',
				memo: 'Bank interest, September',
				lines: [L('1000', '1250', '0'), L('4200', '0', '1250')]
			},
			taskId: 'ct-1'
		},
		body: "bt29 2026-09-30 +12.50 'INTEREST PAID', counterparty Bank. Dr 1000 Operating Cash 12.50 / Cr 4200 Interest Income 12.50.",
		summary: 'Bookkeeper wants to record $12.50 of bank interest as income.'
	},
	{
		at: 7400,
		type: 'propose',
		proposal: {
			id: 'pr-20',
			kind: 'bank_match',
			proposerRole: 'bookkeeper',
			amountMinor: '397500',
			summaryPlain: 'Pair the $3,975 payment to Apex Kinetic Supplies with the bank returning it. No money moved.',
			rationale: 'bt20 (out) and bt21 (back) are the same 3,975.00 on the same day, described as a returned ACH. They net to zero, so nothing is posted. Bill AKS-0902 stays open and the vendor stays blocked.',
			payload: {
				matches: [
					{ bankTxId: 'bt20', targetKind: 'bill', targetId: 'b14', scoreBp: 9900 },
					{ bankTxId: 'bt21', targetKind: 'bill', targetId: 'b14', scoreBp: 9900 }
				],
				bankTransactionIds: ['bt20', 'bt21'],
				returned: true,
				bucket: 'exact',
				memo: 'Returned ACH to Apex Kinetic Supplies, nets to zero'
			},
			taskId: 'ct-1'
		},
		body: "bt20 2026-09-24 -3,975.00 'ACH APEX KINETIC SUPPLIES (RETURNED)' and bt21 2026-09-24 +3,975.00 'ACH RETURN APEX KINETIC': same vendor, same amount, same day. Paired against bill b14 AKS-0902 3,975.00. Net cash effect 0.00, so no entry; the bill stays unpaid. Vendor v11 is blocked (cc09).",
		summary: 'Bookkeeper paired the $3,975 payment to Apex with the bank sending it back. No money moved and the bill is still unpaid.'
	},
	{ at: 7700, type: 'activity', role: 'redteam', label: 'Checking the new bank matches' },
	{
		at: 8100,
		type: 'message',
		proposalId: 'pr-14',
		role: 'redteam',
		kind: 'critique',
		body: 'Looked for look-alikes: INV-1043 (Lantern Bakery) is also 2,500.00 but bt02 already paid it, so INV-1058 is the only open 2,500.00 and c18 has no other invoice. Payer is an abbreviation, not an exact name; the exact amount carries it. No objection.',
		summary: 'Red Team found no other open $2,500 invoice, so the match stands.'
	},
	{
		at: 8300,
		type: 'message',
		proposalId: 'pr-15',
		role: 'redteam',
		kind: 'critique',
		body: 'Sound. INV-1045 is the only open 750.00 and c17 has no other open invoice. The one check I would still make: the bank truncated the name, so confirm it is not a payment for a different tutoring business.',
		summary: 'Red Team found it sound; the only open item for this customer is this invoice.'
	},
	{
		at: 8500,
		type: 'message',
		proposalId: 'pr-16',
		role: 'redteam',
		kind: 'critique',
		body: 'Sound. Amount exact and INV-1040 is c08\'s only open invoice. It arrived one day after the 09-24 due date, so this is a late payment, not a missing one. Nothing to reserve against.',
		summary: 'Red Team found it sound; the payment was one day late, which needs no reserve.'
	},
	{
		at: 8700,
		type: 'message',
		proposalId: 'pr-17',
		role: 'redteam',
		kind: 'critique',
		body: 'Sound on the match: INV-1046 is c11\'s only open invoice at 900.00. The one check I would still make: c11 is tier C and paid 10 days after the due date, so keep it on the watch list for October.',
		summary: 'Red Team found the match sound; the customer paid 10 days late and stays on the watch list.'
	},
	{
		at: 8900,
		type: 'message',
		proposalId: 'pr-18',
		role: 'redteam',
		kind: 'critique',
		body: 'Sound: 84.00 is the same fee the bank charges every month and it has no vendor behind it. The one check I would still make: confirm the account has no fee waiver for balances this size, since a waived fee would be a bank error.',
		summary: 'Red Team found it sound; it is the usual monthly fee.'
	},
	{
		at: 9100,
		type: 'message',
		proposalId: 'pr-19',
		role: 'redteam',
		kind: 'critique',
		body: 'Sound: 12.50 is credited interest with nothing to match it to. The one check I would still make: interest income is taxable, so 4200 should roll into the year-end return, not just the Board Pack.',
		summary: 'Red Team found it sound; the interest is small but belongs in taxable income.'
	},
	{
		at: 9400,
		type: 'message',
		proposalId: 'pr-20',
		role: 'redteam',
		kind: 'critique',
		body: 'The pair is right: same amount, same day, and the descriptions say returned. But the payment should never have gone out: Apex Kinetic Supplies has been blocked since September 2 (cc09, no registered business). The bank returned it, which is luck, not control. Ask who released ACH to a blocked vendor and keep b14 unpaid. Do not match this against a bill as paid.',
		summary: 'Red Team agrees nothing was lost, but a payment went to a blocked vendor and only the bank stopped it. Worth finding out who released it.'
	},
	{ at: 9700, type: 'activity', role: 'advisor', label: 'Ruling on the bank items' },
	{ at: 10000, type: 'rule', proposalId: 'pr-14', body: 'APPROVE pr-14.', summary: "Advisor approved Foxglove Catering's deposit match.", rationale: 'Unique open invoice at the exact amount; Red Team found no look-alike.' },
	{ at: 10200, type: 'rule', proposalId: 'pr-15', body: 'APPROVE pr-15.', summary: "Advisor approved Riverside Tutoring's deposit match.", rationale: 'Only open invoice for the customer, exact amount.' },
	{ at: 10400, type: 'rule', proposalId: 'pr-16', body: 'APPROVE pr-16.', summary: "Advisor approved Tallgrass Fitness's deposit match.", rationale: 'Only open invoice for the customer, exact amount; one day late.' },
	{ at: 10600, type: 'rule', proposalId: 'pr-17', body: 'APPROVE pr-17.', summary: "Advisor approved Ironwood Auto Repair's deposit match.", rationale: 'Only open invoice for the customer, exact amount.' },
	{ at: 10800, type: 'rule', proposalId: 'pr-18', body: 'APPROVE pr-18.', summary: 'Advisor approved the bank fee.', rationale: 'Bank statement evidence; no vendor involved.' },
	{ at: 11000, type: 'rule', proposalId: 'pr-19', body: 'APPROVE pr-19.', summary: 'Advisor approved the bank interest.', rationale: 'Bank statement evidence; no invoice involved.' },
	{ at: 11200, type: 'rule', proposalId: 'pr-20', body: 'APPROVE pr-20. Pairing only; nothing posts, b14 stays open and v11 stays blocked. Red Team\'s question about who released the payment stays with the CFO.', summary: 'Advisor approved pairing the returned payment. Nothing posted.', rationale: 'The two bank lines net to zero; the bill stays unpaid.' },
	{ at: 11500, type: 'activity', role: 'credit', label: 'Following up on Copperline Electric', proposalId: 'pr-06' },
	{
		at: 11800,
		type: 'message',
		proposalId: 'pr-06',
		role: 'credit',
		kind: 'statement',
		body: 'Per CFO note on pr-06: called guarantor per-06 (Tom Brennan). Agreed payment plan: 4,500.00 past due settled by 2026-10-15. Withdrawing the credit line cut; pr-06 superseded. Allowance treatment moves to the Allowance review.',
		summary: 'Credit & Risk called the owner as you asked. He agreed to pay by October 15, so the credit cut is withdrawn.'
	},
	{ at: 11850, type: 'status', proposalId: 'pr-06', status: 'superseded' },
	{ at: 12100, type: 'activity', role: 'bookkeeper', label: 'Checking vendor payments for duplicates' },
	{
		at: 12900,
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
	{ at: 13700, type: 'activity', role: 'redteam', label: 'Challenging the duplicate payment claim', proposalId: 'pr-10' },
	{
		at: 14700,
		type: 'message',
		proposalId: 'pr-10',
		role: 'redteam',
		kind: 'critique',
		body: 'Verified: identical amount, payee and memo one day apart; b01 9,800.00 and b02 8,600.00 sum to 18,400.00 and each was billed once. Not a split payment. Do not expense it yet: nothing suggests the vendor will refuse, so a receivable is right. Flag collectability if no refund within 30 days.',
		summary: 'Red Team confirmed it is a true duplicate and agreed to record it as money owed back to us, not a loss.'
	},
	{ at: 15200, type: 'activity', role: 'advisor', label: 'Ruling on the duplicate payment', proposalId: 'pr-10' },
	{ at: 15700, type: 'rule', proposalId: 'pr-10', body: 'APPROVE pr-10 as proposed. Evidence: bt07, bt08, b01, b02.', summary: 'Advisor approved recording the $18,400 as owed back to us.', rationale: 'Bank and bill evidence both confirm a duplicate.' },
	{ at: 16300, type: 'activity', role: 'revenue', label: 'Reviewing annual prepayments' },
	{
		at: 17300,
		type: 'propose',
		proposal: {
			id: 'pr-11',
			kind: 'revenue_schedule',
			proposerRole: 'revenue',
			amountMinor: '2200000',
			summaryPlain: "Move $22,000 of Bansho Ramen's yearly payment out of September revenue. Only one month of it has been earned.",
			rationale: 'k19 is an annual plan credited in full to revenue by je-0903. Ratable recognition over 12 months earns 2,000.00 in September.',
			payload: {
				contractId: 'k19',
				schedule: { months: 12, convention: 'full-month', earnedThisPeriodMinor: '200000' },
				memo: 'Defer unearned part of Bansho Ramen annual plan',
				lines: [L('4000', '2200000', '0', { customerId: 'c19' }), L('2400', '0', '2200000', { customerId: 'c19' })]
			},
			taskId: 'ct-3'
		},
		body: 'Contract k19 (Bansho Ramen, annual, 24,000.00, start 2026-09-05) was credited in full to 4000 via je-0903. The obligation is satisfied ratably over 12 months. Earned for 2026-09 (full-month convention): 2,000.00. Propose Dr 4000 Subscription Revenue 22,000.00 / Cr 2400 Deferred Revenue 22,000.00, customer c19.',
		summary: "Revenue wants to move $22,000 of Bansho Ramen's yearly payment out of September revenue."
	},
	{ at: 18100, type: 'activity', role: 'redteam', label: 'Checking the Bansho Ramen schedule', proposalId: 'pr-11' },
	{
		at: 19100,
		type: 'message',
		proposalId: 'pr-11',
		role: 'redteam',
		kind: 'critique',
		body: 'Agree with the deferral. Challenge: with a daily convention a 2026-09-05 start earns 1,710.00 in September, not 2,000.00. Policy REV-02 sets full-month convention for starts on or before the 15th, so 2,000.00 stands. Checked for a setup fee in the contract: none.',
		summary: 'Red Team agreed after checking the start-date rule; September keeps $2,000 of it.'
	},
	{ at: 19600, type: 'activity', role: 'advisor', label: 'Ruling on the Bansho Ramen schedule', proposalId: 'pr-11' },
	{ at: 20100, type: 'rule', proposalId: 'pr-11', body: 'APPROVE pr-11. Policy REV-02 applied.', summary: 'Advisor approved moving $22,000 to deferred revenue.', rationale: 'Ratable recognition per REV-02.' },
	{ at: 20700, type: 'activity', role: 'bookkeeper', label: 'Looking for unbilled costs' },
	{
		at: 21500,
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
	{ at: 21900, type: 'activity', role: 'redteam', label: 'Checking the support hours', proposalId: 'pr-12' },
	{
		at: 22400,
		type: 'message',
		proposalId: 'pr-12',
		role: 'redteam',
		kind: 'critique',
		body: 'Sound: 59 hours x 50.00 = 2,950.00 and the retainer is billed in arrears, so September cost belongs in September. The one check I would still make: HC-2609 (3,600.00) is already booked, so confirm the 59 hours are beyond that retainer and not inside it.',
		summary: 'Red Team re-did the sum and found it sound; it checked that the hours are on top of the retainer, not part of it.'
	},
	{ at: 22800, type: 'rule', proposalId: 'pr-12', body: 'APPROVE pr-12. Timesheet evidence attached; Red Team re-did the sum and raised no objection.', summary: 'Advisor approved it.', rationale: 'Timesheet evidence.' },
	{ at: 23400, type: 'activity', role: 'credit', label: 'Re-scoring receivables' },
	{
		at: 24200,
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
	{ at: 25000, type: 'activity', role: 'redteam', label: 'Testing the Allowance rates', proposalId: 'pr-13' },
	{
		at: 25800,
		type: 'message',
		proposalId: 'pr-13',
		role: 'redteam',
		kind: 'critique',
		body: 'Rates are aggressive but supportable: c14 has 4 invoices past due including one at 95 days and a civil judgment; c06 paid 3 of its last 5 invoices after 40+ days. Counterpoint: c06 has never defaulted. A 50% rate on c06 gives 10,150.00, still above materiality. No objection to 75%.',
		summary: 'Red Team pushed on the rates but accepted them; even a softer rate would still need your OK.'
	},
	{ at: 26200, type: 'activity', role: 'advisor', label: 'Ruling on the Allowance', proposalId: 'pr-13' },
	{ at: 26600, type: 'rule', proposalId: 'pr-13', body: 'APPROVE pr-13.', summary: 'Advisor approved setting aside $11,275.', rationale: 'Tier evidence from cc04, cc07, cc08.' },
	{
		at: 27200,
		type: 'message',
		proposalId: 'pr-08',
		role: 'credit',
		kind: 'statement',
		body: 'Amending pr-08 scope to payments only. AP inbox confirms the 09-18 change came from the known contact; the 09-27 change did not. Holding HFC-4471 until a call to the number on the original tax form.',
		summary: 'Credit & Risk narrowed the block to payments only, as the Red Team asked.'
	},
	{ at: 27800, type: 'rule', proposalId: 'pr-08', body: 'APPROVE pr-08 as amended (payments only).', summary: 'Advisor approved pausing payments to Halvorsen Freight Co.', rationale: 'Scope narrowed per Red Team.' },
	{ at: 27900, type: 'vendor', vendorId: 'v09', verification: 'blocked', note: 'Payments on hold until the new bank account is confirmed by phone.' },
	{ at: 28000, type: 'activity', role: 'consolidation', label: "Revaluing Cafoo Ltd's dollar balances" },
	{ at: 28400, type: 'consolidate', taskId: 'ct-7' },
	{ at: 28500, type: 'activity', role: 'redteam', label: 'Checking the revaluation and the eliminations', proposalId: 'pr-c1' },
	{ at: 29900, type: 'activity', role: 'advisor', label: 'Ruling on the consolidation entries', proposalId: 'pr-c1' },
	{ at: 30200, type: 'rule', proposalId: 'pr-c1', body: 'APPROVE pr-c1. Balances and rates recomputed from the books; closing rate recorded for the month.', summary: "Advisor approved restating Cafoo Ltd's dollar balances", rationale: 'Revaluation at the recorded closing rate; recomputed from the posted ledger.' },
	{ at: 30500, type: 'rule', proposalId: 'pr-c2', body: 'APPROVE pr-c2. Both pairs tie to the cent; reverses next month.', summary: 'Advisor approved removing what the group companies owe each other', rationale: 'Balance elimination; pairs agree after revaluation.' },
	{ at: 30800, type: 'rule', proposalId: 'pr-c3', body: 'APPROVE pr-c3. One cent of translation rounding, under the $1 tolerance.', summary: "Advisor approved removing the month's intercompany service fees", rationale: 'Activity elimination; difference within tolerance.' },
	{ at: 31100, type: 'wrapup' },
	{ at: 31200, type: 'idle' }
];
