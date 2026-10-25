// Demo behaviour for Books: a bank statement, usage invoices, vendor bills and a customer contract. Each sample books
// into Cafoo Inc's October and leads to the owning agent's Proposals; nothing here posts on its own.
import type { Bill, Customer, Invoice, Vendor } from '../../types';
import { formatMoney, toBig } from '../../money';
import { SUBSIDIARY_ID } from '../seed';
import type { ScriptLine } from '../script';
import type { LiveTicker, MockContext, UploadHandler } from './types';

/** The month the samples belong to. */
const MONTH = '2026-10';
const CCY = 'USD';

const money = (minor: string | bigint) => {
	const m = toBig(String(minor));
	return formatMoney(m.toString(), { whole: m % 100n === 0n });
};
const L = (account: string, debitMinor: string, creditMinor: string, extra: Partial<ScriptLine> = {}): ScriptLine => ({ account, debitMinor, creditMinor, ...extra });
/** October if it is still open, otherwise wherever new data goes now. Refuses before any row lands when every month is locked. */
function periodFor(ctx: MockContext): string {
	const id = ctx.t.period.some((p) => p.id === MONTH && p.status !== 'closed') ? MONTH : ctx.openPeriodId();
	if (!id) throw new Error('Every month is locked; unlock one to post.');
	return id;
}
/** "Bluefin Logistics'" and "Bansho Ramen's". */
const owner = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------------------------------------------------------
// Matching bank lines to open invoices and bills (pure, tested)

export interface StatementLine {
	bookedAt: string;
	/** Positive is money in. */
	amountMinor: string;
	description: string;
	counterparty: string;
}

export interface LineMatch {
	targetKind: 'invoice' | 'bill';
	targetId: string;
	number: string;
	/** The customer or vendor. */
	partyId: string;
	partyName: string;
	scoreBp: number;
	bucket: 'exact' | 'strong';
}

export interface OpenBooks {
	invoices: Pick<Invoice, 'id' | 'number' | 'customerId' | 'amountMinor' | 'status' | 'dueAt'>[];
	bills: Pick<Bill, 'id' | 'number' | 'vendorId' | 'amountMinor' | 'status' | 'dueAt'>[];
	customers: Pick<Customer, 'id' | 'name'>[];
	vendors: Pick<Vendor, 'id' | 'name'>[];
	/** Invoice and bill ids already matched to a bank line (or claimed by an earlier line of the same statement). */
	taken: Set<string>;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** "Cedar & Pine Dental" and "CEDAR PINE DENTAL" are the same payer. */
export const samePayer = (a: string, b: string) => {
	const x = squash(a);
	const y = squash(b);
	return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/**
 * The open invoice (money in) or bill (money out) a bank line pays: same amount, same payer, not already matched.
 * A document whose number is in the bank memo wins and scores exact; otherwise the one due first, scored strong.
 */
export function matchStatementLine(line: StatementLine, books: OpenBooks): LineMatch | null {
	const amount = toBig(line.amountMinor);
	if (amount === 0n) return null;
	const memo = squash(line.description);
	const candidates: LineMatch[] = [];
	const dueAt = new Map<string, string>();
	if (amount > 0n) {
		for (const inv of books.invoices) {
			const c = books.customers.find((x) => x.id === inv.customerId);
			if (!c || inv.status === 'paid' || books.taken.has(inv.id) || toBig(inv.amountMinor) !== amount || !samePayer(c.name, line.counterparty)) continue;
			const named = memo.includes(squash(inv.number));
			candidates.push({ targetKind: 'invoice', targetId: inv.id, number: inv.number, partyId: c.id, partyName: c.name, scoreBp: named ? 9900 : 9400, bucket: named ? 'exact' : 'strong' });
			dueAt.set(inv.id, inv.dueAt);
		}
	} else {
		for (const bill of books.bills) {
			const v = books.vendors.find((x) => x.id === bill.vendorId);
			if (!v || bill.status === 'paid' || books.taken.has(bill.id) || toBig(bill.amountMinor) !== -amount || !samePayer(v.name, line.counterparty)) continue;
			const named = memo.includes(squash(bill.number));
			candidates.push({ targetKind: 'bill', targetId: bill.id, number: bill.number, partyId: v.id, partyName: v.name, scoreBp: named ? 9900 : 9400, bucket: named ? 'exact' : 'strong' });
			dueAt.set(bill.id, bill.dueAt);
		}
	}
	candidates.sort((a, b) => b.scoreBp - a.scoreBp || (dueAt.get(a.targetId) ?? '').localeCompare(dueAt.get(b.targetId) ?? ''));
	return candidates[0] ?? null;
}

/** `total` spread over `months` consecutive months from `startYm`, the leftover cents in the last month. */
export function spreadEvenly(totalMinor: string, months: number, startYm: string): { ym: string; amountMinor: string }[] {
	const total = toBig(totalMinor);
	const n = BigInt(Math.max(1, months));
	const each = total / n;
	const [y, m] = startYm.split('-').map(Number);
	return Array.from({ length: Number(n) }, (_, i) => {
		const d = new Date(Date.UTC(y, m - 1 + i, 1));
		const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
		return { ym, amountMinor: (i === Number(n) - 1 ? total - each * (n - 1n) : each).toString() };
	});
}

function openBooks(ctx: MockContext): OpenBooks {
	const t = ctx.t;
	return {
		invoices: t.invoice,
		bills: t.bill,
		customers: t.customer,
		vendors: t.vendor,
		taken: new Set(t.bank_match.filter((m) => m.targetKind !== 'journal_entry').map((m) => m.targetId))
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Bank statement: five October lines on Cafoo Inc's operating account. Four pay an open invoice or bill; a card
// charge has nothing behind it and is left for the CFO.

export const STATEMENT: StatementLine[] = [
	{ bookedAt: '2026-10-01T00:00:00Z', amountMinor: '600000', description: 'ACH IN BLUEFIN LOGISTICS INV-1060', counterparty: 'Bluefin Logistics' },
	{ bookedAt: '2026-10-01T00:00:00Z', amountMinor: '80000', description: 'DEPOSIT CEDAR PINE DENTAL', counterparty: 'Cedar & Pine Dental' },
	{ bookedAt: '2026-10-01T00:00:00Z', amountMinor: '-21840', description: 'CARD 4471 HOTEL', counterparty: 'Unknown' },
	{ bookedAt: '2026-10-02T00:00:00Z', amountMinor: '-360000', description: 'ACH HELPDESK COLLECTIVE HC-2609', counterparty: 'Helpdesk Collective' },
	{ bookedAt: '2026-10-02T00:00:00Z', amountMinor: '2400000', description: 'WIRE IN BANSHO RAMEN INV-1061', counterparty: 'Bansho Ramen' }
];

const alreadyImported = (ctx: MockContext, l: StatementLine) =>
	ctx.t.bank_transaction.some((b) => b.subsidiaryId === SUBSIDIARY_ID && b.bookedAt === l.bookedAt && b.description === l.description && b.amountMinor === l.amountMinor);

/** Each new line with what it pays, matched in statement order so two lines never claim the same document. */
function plan(ctx: MockContext): { line: StatementLine; match: LineMatch | null }[] {
	const books = openBooks(ctx);
	return STATEMENT.filter((l) => !alreadyImported(ctx, l)).map((line) => {
		const match = matchStatementLine(line, books);
		if (match) books.taken.add(match.targetId);
		return { line, match };
	});
}

const bankStatement: UploadHandler = {
	kind: 'bank_statement',
	fileName: 'cafoo-inc-operating-2026-10-02.csv',
	sizeBytes: 1_284,
	readByRole: 'bookkeeper',
	read(ctx) {
		const rows = plan(ctx);
		const extracted = { account: 'Cafoo Inc operating account', currency: CCY, from: '2026-10-01', to: '2026-10-02', lines: STATEMENT };
		if (!rows.length) return { extracted, summaryPlain: 'Every line on this statement was already imported, so there is nothing new to match.' };
		const matched = rows.filter((r) => r.match).length;
		const unmatched = rows.filter((r) => !r.match);
		return {
			extracted,
			summaryPlain: `${rows.length} October bank lines from Cafoo Inc's operating account; the Bookkeeper is matching ${matched} of them to open invoices and bills.`,
			flagsPlain: unmatched.map(({ line }) =>
				toBig(line.amountMinor) < 0n
					? `A ${money(-toBig(line.amountMinor))} payment on ${day(line.bookedAt)} ("${line.description}") has no bill or receipt behind it. Tell the Bookkeeper what it was for.`
					: `A ${money(line.amountMinor)} deposit on ${day(line.bookedAt)} ("${line.description}") matches no open invoice. Tell the Bookkeeper who sent it.`
			)
		};
	},
	apply(ctx) {
		const ids: string[] = [];
		const periodId = periodFor(ctx);
		for (const { line, match } of plan(ctx)) {
			const tx = ctx.insert('bank_transaction', {
				id: ctx.id('bt'),
				subsidiaryId: SUBSIDIARY_ID,
				bookedAt: line.bookedAt,
				ym: line.bookedAt.slice(0, 7),
				amountMinor: line.amountMinor,
				ccy: CCY,
				description: line.description,
				counterparty: line.counterparty,
				matched: false
			});
			if (!match) continue;
			const amount = toBig(line.amountMinor);
			const abs = (amount < 0n ? -amount : amount).toString();
			const named = match.bucket === 'exact';
			const why = `Amount and payer exact${named ? `; the bank memo names ${match.number}` : '; the bank memo has no reference'}. Score ${match.scoreBp.toLocaleString('en-US')} bp, bucket ${match.bucket}.`;
			if (match.targetKind === 'invoice') {
				const older = ctx.t.invoice.filter((i) => i.customerId === match.partyId && i.id !== match.targetId && i.status !== 'paid' && i.amountMinor === line.amountMinor);
				ids.push(
					ctx.propose({
						kind: 'bank_match',
						proposerRole: 'bookkeeper',
						amountMinor: abs,
						periodId,
						summaryPlain: `Match ${owner(match.partyName)} ${money(abs)} payment to their invoice ${match.number}.`,
						rationale: why,
						payload: {
							bankTransactionId: tx.id,
							invoiceId: match.targetId,
							scoreBp: match.scoreBp,
							bucket: match.bucket,
							memo: `${match.partyName} payment matched to ${match.number}`,
							lines: [L('1000', abs, '0'), L('1100', '0', abs, { customerId: match.partyId })]
						},
						body: `${tx.id} +${money(abs).slice(1)} '${line.description}' vs ${match.targetId} ${match.number} ${money(abs).slice(1)} open, customer ${match.partyId}. ${why} Dr 1000 / Cr 1100 ${money(abs).slice(1)}.`,
						critique: older.length
							? {
									body: `${match.partyName} has ${older.length + 1} unpaid invoices of ${money(abs).slice(1)} (${[match.number, ...older.map((i) => i.number)].join(', ')}). No reference in the memo, so applying to the one due first is the right default; confirm with the customer if they meant another.`,
									summary: `Red Team noted ${match.partyName} owes more than one invoice of this amount and agreed to apply it to the oldest.`
								}
							: undefined
					})
				);
			} else {
				ids.push(
					ctx.propose({
						kind: 'bank_match',
						proposerRole: 'bookkeeper',
						amountMinor: abs,
						periodId,
						summaryPlain: `Match the ${money(abs)} paid to ${match.partyName} to their bill ${match.number}.`,
						rationale: why,
						payload: {
							bankTransactionId: tx.id,
							billId: match.targetId,
							matches: [{ bankTxId: tx.id, targetKind: 'bill', targetId: match.targetId, scoreBp: match.scoreBp }],
							scoreBp: match.scoreBp,
							bucket: match.bucket,
							memo: `Payment to ${match.partyName} matched to ${match.number}`,
							lines: [L('2000', abs, '0', { vendorId: match.partyId }), L('1000', '0', abs)]
						},
						body: `${tx.id} -${money(abs).slice(1)} '${line.description}' vs ${match.targetId} ${match.number} ${money(abs).slice(1)} open, vendor ${match.partyId}. ${why} Dr 2000 / Cr 1000 ${money(abs).slice(1)}.`
					})
				);
			}
		}
		return ids;
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Invoices: usage above plan billed to three existing customers on October 1.

const USAGE_INVOICES: Invoice[] = [
	{ id: 'i31', number: 'INV-1062', customerId: 'c04', issuedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-31T00:00:00Z', amountMinor: '184000', status: 'open' },
	{ id: 'i32', number: 'INV-1063', customerId: 'c10', issuedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-31T00:00:00Z', amountMinor: '61250', status: 'open' },
	{ id: 'i33', number: 'INV-1064', customerId: 'c02', issuedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-31T00:00:00Z', amountMinor: '297500', status: 'open' }
];
const USAGE_NOTE: Record<string, string> = { i31: '1.84M routing calls over plan', i32: '245 extra design renders', i33: '11.9M analytics events over plan' };

const invoices: UploadHandler = {
	kind: 'invoices',
	fileName: 'usage-invoices-2026-10-01.csv',
	sizeBytes: 642,
	readByRole: 'revenue',
	read(ctx) {
		const fresh = USAGE_INVOICES.filter((i) => !ctx.t.invoice.some((x) => x.id === i.id));
		const name = (id: string) => ctx.t.customer.find((c) => c.id === id)?.name ?? id;
		const extracted = { invoices: USAGE_INVOICES.map((i) => ({ ...i, customer: name(i.customerId), usage: USAGE_NOTE[i.id] })) };
		if (!fresh.length) return { extracted, summaryPlain: 'These usage invoices were already imported, so nothing new was booked.' };
		const total = fresh.reduce((s, i) => s + toBig(i.amountMinor), 0n);
		return { extracted, summaryPlain: `${fresh.length} usage invoices worth ${money(total)}, billed on October 1 to ${fresh.map((i) => name(i.customerId)).join(', ')}.` };
	},
	apply(ctx) {
		const fresh = USAGE_INVOICES.filter((i) => !ctx.t.invoice.some((x) => x.id === i.id));
		if (!fresh.length) return [];
		const periodId = periodFor(ctx);
		for (const inv of fresh) ctx.insert('invoice', { ...inv });
		const total = fresh.reduce((s, i) => s + toBig(i.amountMinor), 0n).toString();
		const name = (id: string) => ctx.t.customer.find((c) => c.id === id)?.name ?? id;
		return [
			ctx.propose({
				kind: 'journal_entry',
				proposerRole: 'revenue',
				amountMinor: total,
				periodId,
				summaryPlain: `Book ${money(total)} of usage that three customers were billed for on October 1 as revenue they owe us.`,
				rationale: `Usage above plan, billed in arrears per contract; invoices ${fresh.map((i) => i.number).join(', ')}.`,
				payload: {
					invoiceIds: fresh.map((i) => i.id),
					memo: 'Usage invoices billed October 1',
					lines: [...fresh.map((i) => L('1100', i.amountMinor, '0', { customerId: i.customerId })), L('4000', '0', total)]
				},
				body: `Usage invoices ${fresh.map((i) => `${i.number} ${name(i.customerId)} ${money(i.amountMinor).slice(1)}`).join('; ')}. Dr 1100 per customer / Cr 4000 Subscription Revenue ${money(total).slice(1)}.`
			})
		];
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Vendor bills: October software, and a quarter of coworking rent billed upfront (spread over the three months).

const SOFTWARE_BILL: Bill = { id: 'b19', number: 'GAT-2610', vendorId: 'v12', issuedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-31T00:00:00Z', amountMinor: '310000', status: 'open' };
const RENT_BILL: Bill = { id: 'b20', number: 'LC-2026Q4', vendorId: 'v06', issuedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-15T00:00:00Z', amountMinor: '1950000', status: 'open' };
const RENT_MONTHS = 3;

const bills: UploadHandler = {
	kind: 'bills',
	fileName: 'vendor-bills-2026-10.pdf',
	sizeBytes: 218_406,
	readByRole: 'bookkeeper',
	read(ctx) {
		const fresh = [SOFTWARE_BILL, RENT_BILL].filter((b) => !ctx.t.bill.some((x) => x.id === b.id));
		const extracted = {
			bills: [
				{ ...SOFTWARE_BILL, vendor: 'Glasshouse Analytics Tools', servicePeriod: { from: '2026-10-01', to: '2026-10-31' } },
				{ ...RENT_BILL, vendor: 'Larkspur Coworking', servicePeriod: { from: '2026-10-01', to: '2026-12-31' } }
			]
		};
		if (!fresh.length) return { extracted, summaryPlain: 'Both bills were already imported, so nothing new was booked.' };
		return { extracted, summaryPlain: `Two vendor bills: ${money(SOFTWARE_BILL.amountMinor)} of October software and ${money(RENT_BILL.amountMinor)} of rent for October to December, which the Bookkeeper spreads over those three months.` };
	},
	apply(ctx) {
		const ids: string[] = [];
		const periodId = periodFor(ctx);
		if (!ctx.t.bill.some((b) => b.id === SOFTWARE_BILL.id)) {
			ctx.insert('bill', { ...SOFTWARE_BILL });
			const a = SOFTWARE_BILL.amountMinor;
			ids.push(
				ctx.propose({
					kind: 'journal_entry',
					proposerRole: 'bookkeeper',
					amountMinor: a,
					periodId,
					summaryPlain: `Record ${owner('Glasshouse Analytics Tools')} ${money(a)} October software bill as owed.`,
					rationale: `Bill ${SOFTWARE_BILL.number}, service October 2026 only, same amount as September's GAT-2609.`,
					payload: { billId: SOFTWARE_BILL.id, memo: `Software subscription for October, bill ${SOFTWARE_BILL.number}`, lines: [L('6100', a, '0'), L('2000', '0', a, { vendorId: SOFTWARE_BILL.vendorId })] },
					body: `${SOFTWARE_BILL.number} Glasshouse Analytics Tools ${money(a).slice(1)}, service 2026-10. Dr 6100 Software and Tools / Cr 2000 Accounts Payable ${money(a).slice(1)}, vendor ${SOFTWARE_BILL.vendorId}.`
				})
			);
		}
		if (!ctx.t.bill.some((b) => b.id === RENT_BILL.id)) {
			ctx.insert('bill', { ...RENT_BILL });
			const total = RENT_BILL.amountMinor;
			const months = spreadEvenly(total, RENT_MONTHS, MONTH);
			const now = months[0].amountMinor;
			ids.push(
				ctx.propose({
					kind: 'accrual',
					proposerRole: 'bookkeeper',
					amountMinor: total,
					periodId,
					summaryPlain: `Larkspur Coworking billed ${money(total)} for October to December, so book ${money(now)} of rent this month and hold the rest as prepaid.`,
					rationale: `Bill ${RENT_BILL.number} covers 2026-10-01 to 2026-12-31; expense it ratably, ${money(now)} a month.`,
					payload: {
						billId: RENT_BILL.id,
						vendorId: RENT_BILL.vendorId,
						servicePeriod: { from: '2026-10-01', to: '2026-12-31' },
						schedule: months,
						memo: `Quarterly rent, bill ${RENT_BILL.number}: October's share expensed, the rest prepaid`,
						lines: [L('1200', total, '0'), L('2000', '0', total, { vendorId: RENT_BILL.vendorId }), L('6200', now, '0'), L('1200', '0', now)]
					},
					body: `${RENT_BILL.number} Larkspur Coworking ${money(total).slice(1)}, service 2026-10-01..2026-12-31. Dr 1200 Prepaid / Cr 2000 AP ${money(total).slice(1)}; release ${money(now).slice(1)} to 6200 Rent for 2026-10, then ${months
						.slice(1)
						.map((m) => `${money(m.amountMinor).slice(1)} in ${m.ym}`)
						.join(' and ')}.`,
					critique: {
						body: `Agree with prepaid treatment. Checked for double counting: September rent went out by ACH (bt01) with no bill, and no October rent ACH is on the bank feed yet. If one arrives, it is payment of this bill, not more rent.`,
						summary: 'Red Team agreed and checked that October rent is not being counted twice.'
					}
				})
			);
		}
		return ids;
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Customer contract: a new customer signs a yearly plan, billed upfront. The Revenue agent schedules it over 12 months.

const NEW_CUSTOMER: Customer = {
	id: 'c21',
	name: 'Kestrel Climbing Gym',
	domain: 'kestrelclimbing.example',
	guarantorPersonaId: 'per-21',
	guarantorName: 'Maya Okafor',
	paymentTermsDays: 30
};
const CONTRACT = { id: 'k21', customerId: 'c21', startAt: '2026-10-01T00:00:00Z', endAt: '2027-09-30T00:00:00Z', billing: 'annual' as const, arrMinor: '1800000' };
const CONTRACT_INVOICE: Invoice = { id: 'i34', number: 'INV-1065', customerId: 'c21', issuedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-31T00:00:00Z', amountMinor: '1800000', status: 'open' };

const contracts: UploadHandler = {
	kind: 'contracts',
	fileName: 'kestrel-climbing-order-form.pdf',
	sizeBytes: 164_920,
	readByRole: 'revenue',
	read(ctx) {
		const extracted = { customer: NEW_CUSTOMER.name, owner: NEW_CUSTOMER.guarantorName, term: { from: '2026-10-01', to: '2027-09-30' }, billing: 'annual, upfront', feeMinor: CONTRACT.arrMinor, currency: CCY, paymentTermsDays: 30, invoice: CONTRACT_INVOICE.number };
		if (ctx.t.contract.some((k) => k.id === CONTRACT.id)) return { extracted, summaryPlain: 'This contract was already imported, so nothing new was booked.' };
		return {
			extracted,
			summaryPlain: `${NEW_CUSTOMER.name} signed a yearly plan worth ${money(CONTRACT.arrMinor)}, paid upfront; the Revenue agent spreads it over the 12 months it covers.`,
			flagsPlain: [`${NEW_CUSTOMER.name} is a new customer with no credit check yet. Ask Credit & Risk to check the owner, ${NEW_CUSTOMER.guarantorName}, before the invoice is due on October 31.`]
		};
	},
	apply(ctx) {
		if (ctx.t.contract.some((k) => k.id === CONTRACT.id)) return [];
		const periodId = periodFor(ctx);
		if (!ctx.t.customer.some((c) => c.id === NEW_CUSTOMER.id)) ctx.insert('customer', { ...NEW_CUSTOMER });
		ctx.insert('contract', { ...CONTRACT });
		if (!ctx.t.invoice.some((i) => i.id === CONTRACT_INVOICE.id)) ctx.insert('invoice', { ...CONTRACT_INVOICE });
		const fee = CONTRACT.arrMinor;
		const months = spreadEvenly(fee, 12, MONTH);
		const earned = months[0].amountMinor;
		return [
			ctx.propose({
				kind: 'revenue_schedule',
				proposerRole: 'revenue',
				amountMinor: fee,
				periodId,
				summaryPlain: `${NEW_CUSTOMER.name} prepaid ${money(fee)} for a year: count ${money(earned)} as October revenue and the rest as revenue still to be earned.`,
				rationale: `Contract ${CONTRACT.id}, 12 months from 2026-10-01, satisfied ratably; invoice ${CONTRACT_INVOICE.number} billed upfront. Full-month convention (start on the 1st).`,
				payload: {
					contractId: CONTRACT.id,
					customerId: NEW_CUSTOMER.id,
					invoiceId: CONTRACT_INVOICE.id,
					schedule: { months: 12, convention: 'full-month', monthly: months },
					memo: `${NEW_CUSTOMER.name} annual plan: invoice deferred, October earned`,
					lines: [
						L('1100', fee, '0', { customerId: NEW_CUSTOMER.id }),
						L('2400', '0', fee, { customerId: NEW_CUSTOMER.id }),
						L('2400', earned, '0', { customerId: NEW_CUSTOMER.id }),
						L('4000', '0', earned, { customerId: NEW_CUSTOMER.id })
					]
				},
				body: `New contract ${CONTRACT.id} (${NEW_CUSTOMER.name}, annual, ${money(fee).slice(1)}, 2026-10-01..2027-09-30), invoice ${CONTRACT_INVOICE.number}. Dr 1100 / Cr 2400 Deferred Revenue ${money(fee).slice(1)}; recognize ${money(earned).slice(1)} for 2026-10: Dr 2400 / Cr 4000.`,
				critique: {
					body: `Schedule ties: 12 x ${money(earned).slice(1)} = ${money(fee).slice(1)}. No setup fee or free months in the order form. The customer has no credit check on file; the receivable is fine to book, but the Allowance review should pick it up next close.`,
					summary: 'Red Team checked the 12 monthly amounts add up and noted the new customer still needs a credit check.'
				}
			})
		];
	}
};

export const handlers: UploadHandler[] = [bankStatement, invoices, bills, contracts];
export const tickers: LiveTicker[] = [];
