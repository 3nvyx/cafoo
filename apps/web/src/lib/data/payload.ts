// Reading a Proposal's payload: the shapes differ by kind and between the live module and Demo mode, so every reader
// (screens and the Demo source alike) goes through these pure helpers instead of matching substrings in payloadJson.
import type { Minor } from './types';

export type Raw = Record<string, unknown>;

export function parsePayload(json: string): Raw | null {
	try {
		const v = JSON.parse(json) as unknown;
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
	} catch {
		return null;
	}
}

/** The objects in a JSON array (anything else is dropped). */
export const list = (x: unknown): Raw[] => (Array.isArray(x) ? x.filter((v): v is Raw => !!v && typeof v === 'object') : []);
const minor = (x: unknown): Minor => (typeof x === 'string' || typeof x === 'number' || typeof x === 'bigint' ? String(x) : '0');

/** Ids as the UI rows carry them: live ids are whole numbers ("05" is 5), Demo ids are strings like "c05". */
export function normId(x: unknown): string | undefined {
	if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'bigint') return undefined;
	const s = String(x).trim();
	if (!s) return undefined;
	return /^\d+$/.test(s) ? BigInt(s).toString() : s;
}

export interface PayloadJournalLine {
	code: string;
	memo: string;
	debitMinor: Minor;
	creditMinor: Minor;
	/** The line's currency, when the payload says (live payloads do). */
	ccy?: string;
	customerId?: string;
}

/** Journal lines (a debit or credit on an account). Live payloads use accountCode; Demo payloads use account. */
export function journalLinesOf(payload: Raw | null): PayloadJournalLine[] {
	return list(payload?.lines)
		.filter((l) => 'debitMinor' in l || 'creditMinor' in l)
		.map((l) => ({
			code: String(l.accountCode ?? l.account ?? ''),
			memo: typeof l.memo === 'string' ? l.memo : '',
			debitMinor: minor(l.debitMinor ?? '0'),
			creditMinor: minor(l.creditMinor ?? '0'),
			ccy: typeof l.ccy === 'string' && l.ccy ? l.ccy : undefined,
			customerId: normId(l.customerId)
		}));
}

export interface ScheduleLine {
	contractItemId?: string;
	customerId?: string;
	ym: string;
	amountMinor: Minor;
}

/** Revenue Schedule lines: one amount to recognize per month, per contract item. */
export function scheduleLinesOf(payload: Raw | null): ScheduleLine[] {
	return list(payload?.lines)
		.filter((l) => typeof l.ym === 'string' && 'amountMinor' in l)
		.map((l) => ({ contractItemId: normId(l.contractItemId), customerId: normId(l.customerId), ym: String(l.ym), amountMinor: minor(l.amountMinor) }));
}

export interface MatchLine {
	bankTxId: string;
	targetKind: 'invoice' | 'bill' | 'journal_entry';
	targetId: string;
	scoreBp?: number;
}

/** A Bank Match's links. Live: `matches[]` with targetKind invoice | bill | je. Demo: one bankTransactionId + invoiceId. */
export function matchesOf(payload: Raw | null): MatchLine[] {
	if (!payload) return [];
	const out: MatchLine[] = [];
	for (const m of list(payload.matches)) {
		const bankTxId = normId(m.bankTxId);
		const targetId = normId(m.targetId);
		if (!bankTxId || !targetId) continue;
		const targetKind = m.targetKind === 'bill' ? 'bill' : m.targetKind === 'je' || m.targetKind === 'journal_entry' ? 'journal_entry' : 'invoice';
		out.push({ bankTxId, targetKind, targetId, scoreBp: typeof m.scoreBp === 'number' ? m.scoreBp : undefined });
	}
	const tx = normId(payload.bankTransactionId);
	const inv = normId(payload.invoiceId);
	if (tx && inv) out.push({ bankTxId: tx, targetKind: 'invoice', targetId: inv, scoreBp: typeof payload.scoreBp === 'number' ? payload.scoreBp : undefined });
	return out;
}
