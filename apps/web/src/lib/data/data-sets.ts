// Naming and ordering for the Dash bar's table list, shared by both data sources.
import type { DataSet } from './source';

/** "journalLine", "journal_line" and "JournalLine" all become "Journal line"; "fxRate" becomes "FX rate";
 * the books' short forms are spelled out ("jeId" is "Journal entry ID", "ccy" is "Currency"). */
export function tableLabel(name: string): string {
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => SPELLED[w] ?? (ACRONYMS.has(w) ? w.toUpperCase() : w));
	const text = words.join(' ');
	return text.charAt(0).toUpperCase() + text.slice(1);
}

const ACRONYMS = new Set(['fx', 'cfo', 'ar', 'ap', 'id', 'url', 'gl', 'arr', 'nrr', 'crs', 'ic']);
const SPELLED: Record<string, string> = { je: 'journal entry', ccy: 'currency', bp: 'basis points', ym: 'month' };

export function byLabel(a: DataSet, b: DataSet): number {
	return a.label.localeCompare(b.label);
}
