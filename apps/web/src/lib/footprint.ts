// Public footprint: derivations shared by the detail panel and the list chips.
// Read-only signals about a Customer or Vendor; nothing here touches the books.
import type { FootprintSource, FootprintSubject, Listings, PublicFootprint } from './data/types';

export const SOURCE_ORDER: FootprintSource[] = ['yelp', 'jobs', 'linkedin', 'search'];

export const SOURCE_LABEL: Record<FootprintSource, string> = {
	yelp: 'Yelp',
	jobs: 'Job board',
	linkedin: 'LinkedIn',
	search: 'Web search'
};

/** One source's history for one subject: the newest attempt, the newest good fetch, and the good fetch before it. */
export interface SourceView {
	source: FootprintSource;
	latest: PublicFootprint;
	good?: PublicFootprint;
	previous?: PublicFootprint;
	runs: number;
}

export function rowsFor(all: PublicFootprint[], kind: FootprintSubject, id: string): PublicFootprint[] {
	return all.filter((r) => r.subjectKind === kind && r.subjectId === id).sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id));
}

export function bySource(rows: PublicFootprint[]): SourceView[] {
	const out: SourceView[] = [];
	for (const source of SOURCE_ORDER) {
		const mine = rows.filter((r) => r.source === source);
		if (!mine.length) continue;
		const ok = mine.filter((r) => r.status === 'ok');
		out.push({ source, latest: mine[mine.length - 1], good: ok[ok.length - 1], previous: ok[ok.length - 2], runs: mine.length });
	}
	return out;
}

export const hasListing = (l: Listings) => !!(l.yelpUrl || l.jobBoard || l.linkedinUrl);
export const listingCount = (l: Listings) => [l.yelpUrl, l.jobBoard, l.linkedinUrl].filter(Boolean).length;

const int = new Intl.NumberFormat('en-US');
export const fmtInt = (n: number) => int.format(n);
export const fmtRating = (tenths: number) => (tenths / 10).toFixed(1);

/** A change between two good fetches of the same source, in plain words. */
export interface Delta {
	label: string;
	dir: 'up' | 'down';
}

function diff(now: number, then: number, unit: string, unitOne = unit, fmt: (n: number) => string = fmtInt): Delta | null {
	const d = now - then;
	if (!d) return null;
	const abs = Math.abs(d);
	return { label: `${d > 0 ? '+' : '−'}${fmt(abs)} ${abs === 1 ? unitOne : unit}`, dir: d > 0 ? 'up' : 'down' };
}

export function deltas(now: PublicFootprint, then: PublicFootprint): Delta[] {
	const out: (Delta | null)[] = [];
	switch (now.source) {
		case 'yelp':
			out.push(diff(now.reviewCount, then.reviewCount, 'reviews', 'review'));
			out.push(diff(now.ratingTenths, then.ratingTenths, 'stars', 'stars', fmtRating));
			if (now.isClosed !== then.isClosed) out.push({ label: now.isClosed ? 'Now listed as closed' : 'Reopened', dir: now.isClosed ? 'down' : 'up' });
			break;
		case 'jobs':
			out.push(diff(now.openRoles, then.openRoles, 'open roles', 'open role'));
			break;
		case 'linkedin':
			out.push(diff(now.employees, then.employees, 'employees', 'employee'));
			out.push(diff(now.followers, then.followers, 'followers', 'follower'));
			break;
		case 'search':
			break;
	}
	return out.filter((d): d is Delta => !!d);
}

export function parseFacts(json: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(json);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The earliest year reviews go back to: the recorded "reviews since at least" date, else the year established. */
export function reviewsSinceYear(r: PublicFootprint): number | undefined {
	const since = parseFacts(r.factsJson)?.reviewsSinceAtLeast;
	if (typeof since === 'string' && /^\d{4}/.test(since)) return Number(since.slice(0, 4));
	return r.yearEstablished || undefined;
}

export function factString(r: PublicFootprint, key: string): string | undefined {
	const v = parseFacts(r.factsJson)?.[key];
	return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;
}

/** "greenhouse:stripe" to "Greenhouse". */
export function boardName(jobBoard: string | undefined, r?: PublicFootprint): string | undefined {
	const raw = (r && factString(r, 'board')) || jobBoard?.split(':')[0];
	return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : undefined;
}

/** The list chip: the most telling good fetch for a subject, or null when nothing has been collected. */
export function chipFor(rows: PublicFootprint[]): { text: string; tone: 'pos' | 'neg' | 'neutral'; title: string } | null {
	const views = bySource(rows);
	for (const source of ['yelp', 'jobs', 'linkedin'] as const) {
		const g = views.find((v) => v.source === source)?.good;
		if (!g) continue;
		if (source === 'yelp') {
			const parts = [g.ratingTenths ? fmtRating(g.ratingTenths) : '', g.reviewCount ? fmtInt(g.reviewCount) : ''].filter(Boolean);
			return {
				text: `Yelp ${parts.join(' · ') || (g.isClosed ? 'closed' : 'listed')}`,
				tone: g.isClosed ? 'neg' : 'pos',
				title: `Yelp: ${g.ratingTenths ? `${fmtRating(g.ratingTenths)} stars, ` : ''}${fmtInt(g.reviewCount)} reviews${g.isClosed ? ', listed as closed' : ''}`
			};
		}
		if (source === 'jobs') return { text: `Open roles ${fmtInt(g.openRoles)}`, tone: 'pos', title: `${fmtInt(g.openRoles)} open roles on the public job board` };
		return { text: `LinkedIn ${fmtInt(g.employees)}`, tone: 'pos', title: `${fmtInt(g.employees)} employees on LinkedIn` };
	}
	return null;
}

const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
	['second', 60],
	['minute', 60],
	['hour', 24],
	['day', 7],
	['week', 4.345],
	['month', 12],
	['year', Infinity]
];

/** "5 minutes ago", "yesterday", "3 weeks ago". `now` is the data source's clock. */
export function relTime(iso: string, now: string): string {
	let v = (Date.parse(iso) - Date.parse(now)) / 1000;
	if (Math.abs(v) < 10) return 'just now';
	for (const [unit, size] of STEPS) {
		if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
		v /= size;
	}
	return rtf.format(Math.round(v), 'year');
}
