// How the Dash bar shows one stored value. Rows come straight from the source: in live mode they are SpacetimeDB
// values (bigint, Timestamp, Identity, tagged enums, optional fields); in Demo mode they are the UI's own rows
// (strings for money and ids, ISO strings for times). Both are read here, never changed.
import { dateTime, roleName } from '../labels';
import { tableLabel } from './data-sets';
import type { PostedByRole } from './types';

export type CellKind = 'empty' | 'number' | 'money' | 'date' | 'bool' | 'id' | 'enum' | 'json' | 'text';

export interface Cell {
	kind: CellKind;
	/** What the grid shows, one line. */
	text: string;
	/** The whole value, for the row sheet and the tooltip ('' when it is the same as text). */
	full: string;
	/** What sorting compares: numbers as bigint, times as ISO strings, everything else as text. */
	sort: bigint | string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** "id", "journalEntryId", "je_id": a key, shown as written. */
const ID_KEY = /(^id$|Id$|_id$)/;
/** Midnight UTC on the dot: a date the books store as a time (bank lines, due dates). Shown as the date alone. */
const MIDNIGHT = /T00:00(:00(\.0+)?)?Z$/;

function when(iso: string): string {
	return MIDNIGHT.test(iso) ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : dateTime(iso);
}
const INT = /^-?\d+$/;

/** JSON that survives bigint and SpacetimeDB's own value types. */
export function stringify(value: unknown, space?: number): string {
	return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : plain(v) ?? v), space) ?? '';
}

/** Timestamps, identities and byte arrays as plain strings; undefined for anything else. */
function plain(v: unknown): string | undefined {
	if (v === null || typeof v !== 'object') return undefined;
	const o = v as { toISOString?: () => string; toHexString?: () => string };
	if (v instanceof Date) return v.toISOString();
	if (typeof o.toISOString === 'function') return o.toISOString();
	if (typeof o.toHexString === 'function') return o.toHexString();
	if (v instanceof Uint8Array) return `${v.length} bytes`;
	return undefined;
}

/** Minor units with grouping and two decimals, and the row's currency code when it names one. */
function money(minor: bigint, ccy: string | undefined): string {
	const neg = minor < 0n;
	const abs = neg ? -minor : minor;
	const body = `${(abs / 100n).toLocaleString('en-US')}.${(abs % 100n).toString().padStart(2, '0')}`;
	return `${neg ? '-' : ''}${body}${ccy ? ` ${ccy}` : ''}`;
}

function currencyOf(row: Record<string, unknown> | undefined): string | undefined {
	for (const key of ['ccy', 'currency', 'baseCurrency', 'functionalCcy']) {
		const v = row?.[key];
		if (typeof v === 'string' && /^[A-Z]{3}$/.test(v)) return v;
	}
	return undefined;
}

const textCell = (text: string): Cell => ({ kind: 'text', text, full: '', sort: text.toLowerCase() });

/** Identity columns and the role column each table records beside them. A CFO confirmation is the CFO by definition. */
const ROLE_COLUMN: Record<string, string> = {
	proposedBy: 'proposerRole',
	postedBy: 'postedByRole',
	sender: 'senderRole',
	actor: 'actorRole',
	ranBy: 'ranByRole',
	authoredBy: 'authoredByRole',
	lockedBy: 'lockedByRole'
};

function identityRole(key: string, row: Record<string, unknown> | undefined): string | undefined {
	if (key === 'cfoConfirmedBy') return roleName('cfo');
	const column = ROLE_COLUMN[key];
	const role = column ? row?.[column] : undefined;
	return typeof role === 'string' && role ? roleName(role.toLowerCase() as PostedByRole) : undefined;
}

export function cell(value: unknown, key = '', row?: Record<string, unknown>): Cell {
	if (value === null || value === undefined || value === '') return { kind: 'empty', text: '', full: '', sort: '' };
	if (typeof value === 'boolean') return { kind: 'bool', text: value ? 'Yes' : 'No', full: '', sort: value ? '1' : '0' };

	// Keys and foreign keys are names, not quantities: no grouping, left-aligned, whatever their type.
	if (ID_KEY.test(key) && (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string')) {
		const s = String(value);
		return { kind: 'id', text: s, full: '', sort: typeof value === 'string' ? s.toLowerCase() : BigInt(value) };
	}

	// Money is stored in minor units, under a name ending in "Minor" (bigint live, a digit string in Demo mode).
	const isMinor = /Minor$/.test(key);
	if (typeof value === 'bigint' || typeof value === 'number' || (typeof value === 'string' && isMinor && INT.test(value))) {
		const n = typeof value === 'number' ? (Number.isInteger(value) ? BigInt(value) : undefined) : BigInt(value);
		if (n === undefined) return { kind: 'number', text: String(value), full: '', sort: String(value) };
		if (isMinor) return { kind: 'money', text: money(n, currencyOf(row)), full: '', sort: n };
		return { kind: 'number', text: n.toLocaleString('en-US'), full: '', sort: n };
	}

	if (typeof value === 'string') {
		if (ISO.test(value) && !Number.isNaN(Date.parse(value))) return { kind: 'date', text: when(value), full: value, sort: value };
		if (/Json$/.test(key)) {
			try {
				return { kind: 'json', text: value, full: JSON.stringify(JSON.parse(value), null, 2), sort: value.toLowerCase() };
			} catch {
				return textCell(value);
			}
		}
		return textCell(value);
	}

	const p = plain(value);
	if (p !== undefined) {
		if (ISO.test(p)) return { kind: 'date', text: when(p), full: p, sort: p };
		// An identity that acted ("proposedBy") reads as the role the row records beside it, with the hash kept in full.
		const role = identityRole(key, row);
		if (role) return { kind: 'text', text: role, full: p, sort: role.toLowerCase() };
		const short = /^(0x)?[0-9a-f]{16,}$/i.test(p) ? `${p.slice(0, 8)}…${p.slice(-4)}` : p;
		return { kind: 'id', text: short, full: p === short ? '' : p, sort: p };
	}

	// SpacetimeDB sum types arrive as { tag, value? }: the tag is the readable part.
	if (typeof value === 'object' && !Array.isArray(value) && typeof (value as { tag?: unknown }).tag === 'string') {
		const { tag, value: inner } = value as { tag: string; value?: unknown };
		// A unit variant ("Asset") carries an empty object or nothing; only a payload adds to the label.
		const unit = inner === undefined || inner === null || (typeof inner === 'object' && !Array.isArray(inner) && plain(inner) === undefined && Object.keys(inner).length === 0);
		const extra = unit ? '' : cell(inner).text;
		const text = extra ? `${tableLabel(tag)} · ${extra}` : tableLabel(tag);
		return { kind: 'enum', text, full: '', sort: text.toLowerCase() };
	}

	const json = stringify(value);
	return { kind: 'json', text: json, full: stringify(value, 2), sort: json.toLowerCase() };
}

/** Every key that appears in any row, in first-seen order. */
export function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
	const seen = new Set<string>();
	for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
	return [...seen];
}

const collator = new Intl.Collator('en', { numeric: true });

/** Numbers numerically, everything else in natural text order. The caller keeps empty cells last. */
export function compareCells(a: Cell, b: Cell): number {
	if (typeof a.sort === 'bigint' && typeof b.sort === 'bigint') return a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0;
	return collator.compare(String(a.sort), String(b.sort));
}

/** "journalEntryId" → "Journal entry id"; the grid's header text. Money columns drop their storage suffix:
 * "debitMinor" reads "Debit", since the cells already show it as money. */
export function columnLabel(key: string): string {
	return tableLabel(key.replace(/(?<=.)(Minor|_minor)$/, ''));
}
