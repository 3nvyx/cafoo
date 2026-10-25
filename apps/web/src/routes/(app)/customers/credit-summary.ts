// Reads a stored Credit Check (the CRS cascade evidence) into labelled facts. Two shapes reach the UI: the demo seed
// stores a flat summary ({ guarantor, identity, fraud, ..., recommendationPlain }), and the live Credit & Risk agent
// stores the evidence row ({ product, requestId, summary, status, facts: { ... } }). Both read the same way here.
import type { CreditCheck } from '#lib/data/types.js';

export interface CheckFact {
	key: string;
	label: string;
	value: string;
}

export interface CheckSummary {
	/** The cascade product that produced this row (live checks), e.g. "fraud_finder". */
	product?: string;
	/** The owner the check is on, when the summary names them. */
	owner?: string;
	/** The one-line recommendation or summary, in plain words. */
	headline?: string;
	/** Reasons the cascade gave, when it lists them. */
	reasons: string[];
	facts: CheckFact[];
}

const KNOWN: Record<string, string> = {
	identity: 'Identity',
	fraud: 'Fraud risk',
	creditBand: 'Credit band',
	scoreRange: 'Score range',
	latePayments90d: 'Late payments, 90 days',
	publicRecords: 'Public records',
	decision: 'Decision',
	allowance: 'Allowance'
};
const ORDER = Object.keys(KNOWN);
const SKIP = new Set(['requestId', 'status', 'product', 'guarantor', 'owner', 'ownerName', 'recommendationPlain', 'summary', 'summaryPlain', 'reasons', 'facts']);

/** "latePayments90d" to "Late payments 90d"; "tu_identity_verification" to "Tu identity verification". */
export function humanKey(key: string): string {
	const words = key
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z])([A-Z0-9])/g, '$1 $2')
		.trim()
		.toLowerCase();
	return words ? words[0].toUpperCase() + words.slice(1) : key;
}

const scalar = (v: unknown): string | undefined =>
	typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;

export function parseCheckSummary(json: string): CheckSummary {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { reasons: [], facts: [] };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reasons: [], facts: [] };
	const top = raw as Record<string, unknown>;
	const nested = top.facts && typeof top.facts === 'object' && !Array.isArray(top.facts) ? (top.facts as Record<string, unknown>) : {};
	const merged: Record<string, unknown> = { ...nested, ...top };
	const facts: CheckFact[] = [];
	for (const [key, v] of Object.entries(merged)) {
		if (SKIP.has(key)) continue;
		const value = scalar(v);
		if (value === undefined || value === '') continue;
		facts.push({ key, label: KNOWN[key] ?? humanKey(key), value });
	}
	const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
	facts.sort((a, b) => rank(a.key) - rank(b.key));
	const reasonsRaw = merged.reasons;
	const reasons = Array.isArray(reasonsRaw) ? reasonsRaw.map(scalar).filter((x): x is string => !!x) : [];
	return {
		product: scalar(top.product),
		owner: scalar(top.guarantor) ?? scalar(top.owner) ?? scalar(top.ownerName),
		headline: scalar(top.recommendationPlain) ?? scalar(top.summaryPlain) ?? scalar(top.summary),
		reasons,
		facts
	};
}

/** A subject's checks, newest first. */
export function checksFor(checks: CreditCheck[], kind: 'customer' | 'vendor', id: string): CreditCheck[] {
	return checks.filter((k) => k.subjectKind === kind && k.subjectId === id).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
}
