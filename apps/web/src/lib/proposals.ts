// What a Proposal means for the CFO: which customers it is about and what confirming it does. The payload readers
// themselves are pure and live in data/payload.ts.
import type { DataSource } from './data/source';
import type { Proposal } from './data/types';
import { monthName } from './data/derive';
import { journalLinesOf, list, matchesOf, normId, parsePayload } from './data/payload';

export { journalLinesOf, matchesOf, normId, parsePayload, scheduleLinesOf } from './data/payload';
export type { MatchLine, PayloadJournalLine, ScheduleLine } from './data/payload';

/**
 * The customers a Proposal is about: a top-level customerId (credit decisions), customerId on any line (journal and
 * schedule lines), and the customer of every invoice a Bank Match settles. Nothing else counts, so a subsidiary,
 * vendor or bank transaction that happens to share a customer's id does not.
 */
export function customerIdsOf(p: Proposal, db: DataSource): Set<string> {
	const payload = parsePayload(p.payloadJson);
	const ids = new Set<string>();
	const add = (x: unknown) => {
		const id = normId(x);
		if (id) ids.add(id);
	};
	if (!payload) return ids;
	add(payload.customerId);
	for (const l of list(payload.lines)) add(l.customerId);
	for (const m of matchesOf(payload)) {
		if (m.targetKind === 'invoice') add(db.invoices().find((i) => i.id === m.targetId)?.customerId);
	}
	return ids;
}

export interface ConfirmEffect {
	/** Confirming posts at least one Journal Entry. */
	posts: boolean;
	/** What to tell the CFO once the confirmation went through. */
	message: string;
}

/**
 * What confirming this Proposal does to the books, mirroring the module's applyProposal: journal entries and accruals
 * post; a Bank Match posts a payment entry per invoice or bill it settles (a match to an existing entry posts nothing);
 * a Revenue Schedule is saved and recognized at later closes; credit decisions and vendor rulings change a customer or
 * vendor. Demo-mode payloads that carry journal lines post them, whatever their kind.
 */
export function confirmEffect(p: Proposal, db: DataSource): ConfirmEffect {
	const payload = parsePayload(p.payloadJson);
	const vendor = () => db.vendors().find((v) => v.id === normId(payload?.vendorId))?.name;
	const customer = () => db.customers().find((c) => c.id === normId(payload?.customerId))?.name;
	if (journalLinesOf(payload).length) {
		const back = p.kind === 'accrual' && typeof payload?.reversesInYm === 'string' ? ` It reverses itself in ${monthName(Number(payload.reversesInYm.slice(5, 7)))}.` : '';
		return { posts: true, message: `Confirmed. The entry is posted.${back}` };
	}
	switch (p.kind) {
		case 'bank_match': {
			const ms = matchesOf(payload);
			const pays = ms.filter((m) => m.targetKind !== 'journal_entry').length;
			if (pays) return { posts: true, message: pays === 1 ? 'Confirmed. The payment entry is posted.' : `Confirmed. ${pays} payment entries are posted.` };
			return { posts: false, message: ms.length === 1 ? 'Confirmed. The bank line is matched to its entry. Nothing new is posted.' : 'Confirmed. The bank lines are matched to their entries. Nothing new is posted.' };
		}
		case 'revenue_schedule':
			return { posts: false, message: 'Confirmed. The Revenue Schedule is saved. Its revenue is recognized month by month at each close.' };
		case 'credit_decision': {
			const name = customer();
			return { posts: false, message: `Confirmed. ${name ? `${name}'s` : "The customer's"} Risk Tier and payment terms are updated.` };
		}
		case 'vendor_block': {
			const name = vendor();
			return { posts: false, message: `Confirmed. Payments to ${name ?? 'this vendor'} are stopped.` };
		}
		case 'vendor_verify': {
			const name = vendor();
			return { posts: false, message: `Confirmed. ${name ?? 'The vendor'} is verified, so their bills can be paid.` };
		}
		default:
			return { posts: false, message: 'Confirmed.' };
	}
}
