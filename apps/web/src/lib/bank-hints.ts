// Read-only hints for the Close page's unmatched bank lines: the open invoice or bill that most likely pays each line,
// and why the Bookkeeper did not match it on its own. It reuses the ledger's own bank-match scorer, so a hint never
// disagrees with what the agents would score. Nothing here changes the books.
import { MATCH_AUTO_BP, MATCH_REVIEW_BP, scoreBankMatch, ymFromString, type Bill as CoreBill, type Invoice as CoreInvoice } from '@cafoo/ledger-core';
import type { BankTransaction, Bill, Customer, Invoice, Subsidiary, Vendor } from './data/types';
import { toBig } from './data/money';

export interface BankHintBooks {
	subsidiaries: readonly Subsidiary[];
	customers: readonly Customer[];
	vendors: readonly Vendor[];
	invoices: readonly Invoice[];
	bills: readonly Bill[];
}

export interface BankHint {
	kind: 'invoice' | 'bill';
	id: string;
	number: string;
	counterparty: string;
	/** Same amount in the same currency, or only close (a near amount that still scores as reviewable). */
	exact: boolean;
	scoreBp: number;
	/** One plain sentence: why this was not matched automatically. */
	why: string;
}

const DAY_MS = 86_400_000;
const micros = (iso: string) => BigInt(Date.parse(iso)) * 1000n;
const abs = (n: bigint) => (n < 0n ? -n : n);
const percent = (bp: number) => `${Math.round(bp / 100)}%`;

/** The currency a document is in: invoices in their customer's company's currency, bills in the root company's. */
function currencies(books: BankHintBooks) {
	const root = books.subsidiaries.find((s) => !s.parentId) ?? books.subsidiaries[0];
	const baseOf = new Map(books.subsidiaries.map((s) => [s.id, s.baseCurrency]));
	const rootCcy = root?.baseCurrency ?? 'USD';
	const customerCcy = new Map(books.customers.map((c) => [c.id, (c.subsidiaryId && baseOf.get(c.subsidiaryId)) || rootCcy]));
	return { invoice: (i: Invoice) => customerCcy.get(i.customerId) ?? rootCcy, bill: () => rootCcy };
}

/** Why the line was left for the CFO, from what the scorer found and what it did not. */
function whyNotMatched(scoreBp: number, reasons: readonly string[], exact: boolean, bankName: string, otherName: string, daysFromDue: number, docWord: string): string {
	const gaps: string[] = [];
	if (!exact) gaps.push('the amount is close but not identical');
	if (!reasons.some((r) => r.startsWith('counterparty name'))) gaps.push(`the bank names "${bankName || 'no counterparty'}" but the ${docWord} is for ${otherName}`);
	if (daysFromDue > 10) gaps.push(`it landed ${daysFromDue} days from the due date`);
	if (!reasons.some((r) => r.startsWith('reference'))) gaps.push(`the bank text does not carry the ${docWord} number`);
	const score = `It scores ${percent(scoreBp)}; the Bookkeeper matches on its own from ${percent(MATCH_AUTO_BP)}.`;
	if (scoreBp >= MATCH_AUTO_BP) return `It scores ${percent(scoreBp)}, enough to match, but no match has been applied yet.`;
	return gaps.length ? `Not auto-matched: ${gaps.join(', and ')}. ${score}` : `Not auto-matched. ${score}`;
}

/**
 * The most likely open invoice (money in) or bill (money out) for each unmatched line. A candidate must have the same
 * amount in the same currency; failing that, only a close amount the scorer still rates reviewable counts. Lines with
 * no such candidate are left out of the result.
 */
export function bankHints(lines: readonly BankTransaction[], books: BankHintBooks): Map<string, BankHint> {
	const ccyOf = currencies(books);
	const customerName = new Map(books.customers.map((c) => [c.id, c.name]));
	const vendorName = new Map(books.vendors.map((v) => [v.id, v.name]));
	const customerNums = new Map(books.customers.map((c, i) => [c.id, BigInt(i + 1)]));
	const vendorNums = new Map(books.vendors.map((v, i) => [v.id, BigInt(i + 1)]));
	const names = {
		customers: new Map(books.customers.map((c) => [customerNums.get(c.id)!, c.name])),
		vendors: new Map(books.vendors.map((v) => [vendorNums.get(v.id)!, v.name]))
	};

	const out = new Map<string, BankHint>();
	for (const [li, line] of lines.entries()) {
		const amount = toBig(line.amountMinor);
		if (amount === 0n) continue;
		const tx = { id: BigInt(li + 1), bookedAt: micros(line.bookedAt), amountMinor: amount, ccy: line.ccy, description: line.description, counterparty: line.counterparty, matched: false };
		const incoming = amount > 0n;
		let best: BankHint | undefined;
		const consider = (hint: Omit<BankHint, 'why' | 'scoreBp'>, scored: ReturnType<typeof scoreBankMatch>, dueIso: string, other: string, word: string) => {
			if (!hint.exact && scored.scoreBp < MATCH_REVIEW_BP) return;
			const days = Math.round(Math.abs(Date.parse(line.bookedAt) - Date.parse(dueIso)) / DAY_MS);
			const full = { ...hint, scoreBp: scored.scoreBp, why: whyNotMatched(scored.scoreBp, scored.reasons, hint.exact, line.counterparty, other, days, word) };
			if (!best || (full.exact && !best.exact) || (full.exact === best.exact && full.scoreBp > best.scoreBp)) best = full;
		};
		if (incoming) {
			for (const [ii, inv] of books.invoices.entries()) {
				if (inv.status === 'paid' || ccyOf.invoice(inv) !== line.ccy) continue;
				const core: CoreInvoice = { id: BigInt(ii + 1), customerId: customerNums.get(inv.customerId) ?? 0n, ym: ymFromString(inv.issuedAt.slice(0, 7)), amountMinor: toBig(inv.amountMinor), dueAt: micros(inv.dueAt), status: inv.status };
				const scored = scoreBankMatch(tx, core, names);
				const exact = toBig(inv.amountMinor) === abs(amount);
				consider({ kind: 'invoice', id: inv.id, number: inv.number, counterparty: customerName.get(inv.customerId) ?? inv.customerId, exact }, scored, inv.dueAt, customerName.get(inv.customerId) ?? 'another customer', 'invoice');
			}
		} else {
			for (const [bi, bill] of books.bills.entries()) {
				if (bill.status === 'paid' || ccyOf.bill() !== line.ccy) continue;
				const core: CoreBill = { id: BigInt(bi + 1), vendorId: vendorNums.get(bill.vendorId) ?? 0n, ym: ymFromString(bill.issuedAt.slice(0, 7)), amountMinor: toBig(bill.amountMinor), dueAt: micros(bill.dueAt), status: bill.status, externalRef: bill.number };
				const scored = scoreBankMatch(tx, core, names);
				const exact = toBig(bill.amountMinor) === abs(amount);
				consider({ kind: 'bill', id: bill.id, number: bill.number, counterparty: vendorName.get(bill.vendorId) ?? bill.vendorId, exact }, scored, bill.dueAt, vendorName.get(bill.vendorId) ?? 'another vendor', 'bill');
			}
		}
		if (best) out.set(line.id, best);
	}
	return out;
}

/** The lines with an open document for exactly their amount, the ones a "no open invoice" reason would be wrong about. */
export function exactHintCount(hints: ReadonlyMap<string, BankHint>): number {
	let n = 0;
	for (const h of hints.values()) if (h.exact) n++;
	return n;
}
