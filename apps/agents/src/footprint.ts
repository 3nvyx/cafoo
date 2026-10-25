/**
 * Public footprint: what a logged-out visitor can see about a customer or vendor, collected on request and stored per
 * run so a person sees change over time. Sources: a Yelp business page (Web Unlocker), a public job board (plain
 * fetch), a LinkedIn company record (Web Scraper API). Signals for a person, never a decision. Demo mode answers from
 * fixtures/brightdata/footprint/. Public, logged-out data only; no people are stored.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brightDataLive, scrapeDataset, unlockerPage, unlockerZone } from './brightdata';
import { repoRoot, type Cast } from './stdb';

export type SubjectKind = 'customer' | 'vendor';
export type Source = 'yelp' | 'jobs' | 'linkedin';

export interface FootprintRow {
  source: Source;
  sourceUrl: string;
  status: 'ok' | 'failed';
  error: string;
  summaryPlain: string;
  facts: Record<string, unknown>;
  ratingTenths: number;
  reviewCount: number;
  isClosed: boolean;
  isClaimed: boolean;
  yearEstablished: number;
  openRoles: number;
  employees: number;
  followers: number;
  live: boolean;
}

const LINKEDIN_COMPANY_DATASET = 'gd_l1vikfnt1wgvvqz95w';
const fixturesDir = join(repoRoot, 'fixtures', 'brightdata', 'footprint');

const blank = (source: Source, sourceUrl: string, live: boolean): FootprintRow => ({
  source,
  sourceUrl,
  status: 'ok',
  error: '',
  summaryPlain: '',
  facts: {},
  ratingTenths: 0,
  reviewCount: 0,
  isClosed: false,
  isClaimed: false,
  yearEstablished: 0,
  openRoles: 0,
  employees: 0,
  followers: 0,
  live,
});

const failed = (source: Source, sourceUrl: string, live: boolean, error: string): FootprintRow => ({
  ...blank(source, sourceUrl, live),
  status: 'failed',
  error,
  summaryPlain: `Could not read the ${source === 'jobs' ? 'job board' : source === 'linkedin' ? 'LinkedIn page' : 'Yelp listing'} this time.`,
});

export function listingsOf(cast: Cast, subjectKind: SubjectKind, subjectId: bigint) {
  const row = subjectKind === 'customer' ? cast.advisor.db.customer.id.find(subjectId) : cast.advisor.db.vendor.id.find(subjectId);
  if (!row) return null;
  return { name: row.name, yelpUrl: row.yelpUrl, jobBoard: row.jobBoard, linkedinUrl: row.linkedinUrl };
}

// ---------- fixtures ----------

function fixtureFor(source: Source, key: string): FootprintRow | null {
  const p = join(fixturesDir, `${source}.${key}.json`);
  if (!existsSync(p)) return null;
  const f = JSON.parse(readFileSync(p, 'utf8')) as { source: Source; sourceUrl: string; facts: Record<string, any> };
  return fromFacts(source, f.sourceUrl, f.facts, false);
}

function fromFacts(source: Source, sourceUrl: string, facts: Record<string, any>, live: boolean): FootprintRow {
  const row = { ...blank(source, sourceUrl, live), facts };
  if (source === 'yelp') {
    row.ratingTenths = Math.round(Number(facts.rating ?? 0) * 10);
    row.reviewCount = Number(facts.reviewCount ?? 0);
    row.isClosed = Boolean(facts.isClosed);
    row.isClaimed = Boolean(facts.isClaimed);
    row.yearEstablished = Number(facts.yearEstablished ?? 0) || 0;
    const since = typeof facts.reviewsSinceAtLeast === 'string' ? facts.reviewsSinceAtLeast.slice(0, 4) : '';
    row.summaryPlain = `${facts.name ?? 'The business'} is ${row.isClosed ? 'marked closed' : 'open'} on Yelp with a ${(row.ratingTenths / 10).toFixed(1)} rating from ${row.reviewCount} reviews${row.isClaimed ? ', and the owner has claimed the listing' : ', and nobody has claimed the listing'}${since ? `; reviews go back to at least ${since}` : ''}.`;
  } else if (source === 'jobs') {
    row.openRoles = Number(facts.openRoles ?? 0);
    row.summaryPlain = `${facts.org ?? 'The company'} has ${row.openRoles} open roles on its public job board${facts.board ? ` (${facts.board})` : ''}.`;
  } else {
    row.employees = Number(facts.employees_in_linkedin ?? 0);
    row.followers = Number(facts.followers ?? 0);
    row.yearEstablished = Number(facts.founded ?? 0) || 0;
    row.summaryPlain = `${facts.name ?? 'The company'} shows ${row.employees.toLocaleString('en-US')} people on LinkedIn and ${row.followers.toLocaleString('en-US')} followers${facts.company_size ? `, listed as ${facts.company_size}` : ''}${row.yearEstablished ? `, founded ${row.yearEstablished}` : ''}.`;
  }
  return row;
}

// ---------- live sources ----------

function unescapeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
}

/** The JSON text of every <script> whose attributes satisfy `attr`. */
function scriptBodies(html: string, attr: (attrs: string) => boolean): string[] {
  const out: string[] = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) if (attr(m[1])) out.push(m[2]);
  return out;
}

/** Parse the Yelp business page: facts from the data-apollo-state script, review dates from the JSON-LD photo list. */
export function parseYelpBiz(html: string, slug: string): Record<string, unknown> {
  let apollo: Record<string, any> | null = null;
  for (const body of scriptBodies(html, a => a.includes('data-apollo-state'))) {
    const text = unescapeHtml(body.trim().replace(/^<!--/, '').replace(/-->$/, '').trim());
    try {
      apollo = JSON.parse(text);
      break;
    } catch {
      /* try the next script */
    }
  }
  if (!apollo) throw new Error('No readable business data on the page (blocked or changed layout).');
  const entries = Object.entries(apollo).filter(([k]) => k.startsWith('Business:'));
  const [key, biz] = entries.find(([, v]) => v && v.alias === slug) ?? entries.find(([, v]) => v && typeof v.rating === 'number') ?? [];
  if (!biz) throw new Error('No business record on the page.');
  const encid = String(key).slice('Business:'.length);
  const loc = apollo[`BusinessLocation:${encid}`]?.address ?? {};
  const claim = biz['claimability({"useConsumerClaimability":true})'] ?? {};
  const hours = biz.operationHours?.regularHoursMergedWithSpecialHoursForCurrentWeek ?? [];
  const dates = new Set<string>();
  for (const body of scriptBodies(html, a => /application\/ld\+json/.test(a))) {
    try {
      const ld = JSON.parse(body);
      const items = Array.isArray(ld?.itemListElement) ? ld.itemListElement : [];
      for (const it of items) {
        const d = it?.review?.datePublished ?? it?.item?.review?.datePublished;
        if (typeof d === 'string') dates.add(d.slice(0, 10));
      }
    } catch {
      /* ignore non-JSON */
    }
  }
  const sorted = [...dates].sort();
  return {
    name: biz.name,
    rating: biz.rating,
    reviewCount: biz.reviewCount,
    priceRange: biz.priceRange?.display ?? null,
    isClosed: Boolean(biz.isClosed),
    isClaimed: Boolean(claim.isClaimed),
    isYelpAdvertiser: Boolean(biz.isYelpAdvertiser),
    yearEstablished: biz.history?.yearEstablished ?? null,
    hours,
    hoursLastUpdated: biz.operationHours?.regularHoursLastUpdated ?? null,
    address: { addressLine1: loc.addressLine1, city: loc.city, regionCode: loc.regionCode, postalCode: loc.postalCode },
    reviewsSinceAtLeast: sorted[0] ?? null,
    datedPhotoReviews: sorted.length,
  };
}

async function liveYelp(url: string): Promise<FootprintRow> {
  const slug = url.replace(/[?#].*$/, '').split('/biz/')[1]?.replace(/\/$/, '') ?? '';
  try {
    const html = await unlockerPage(url);
    return fromFacts('yelp', url, parseYelpBiz(html, slug), true);
  } catch (e) {
    return failed('yelp', url, true, (e as Error).message);
  }
}

/** Public job boards need no Bright Data: Greenhouse and Ashby publish JSON. */
async function liveJobs(board: string): Promise<FootprintRow> {
  const [kind, org] = board.split(':');
  const url = kind === 'ashby' ? `https://api.ashbyhq.com/posting-api/job-board/${org}` : `https://boards-api.greenhouse.io/v1/boards/${org}/jobs?content=true`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return failed('jobs', url, true, `The job board answered HTTP ${res.status}.`);
    const data: any = await res.json();
    const jobs: any[] = Array.isArray(data?.jobs) ? data.jobs : [];
    const sample = jobs.slice(0, 5).map(j => ({ title: j.title, department: kind === 'ashby' ? j.department : j.departments?.[0]?.name, location: kind === 'ashby' ? j.location : j.location?.name, firstPublished: j.first_published ?? j.publishedAt }));
    return fromFacts('jobs', url, { org, board: kind, openRoles: jobs.length, sample }, true);
  } catch (e) {
    return failed('jobs', url, true, (e as Error).message);
  }
}

async function liveLinkedin(url: string): Promise<FootprintRow> {
  try {
    const records = await scrapeDataset(LINKEDIN_COMPANY_DATASET, [{ url }]);
    const r: any = records.find(x => !x.error && !x.error_code) ?? null;
    if (!r) return failed('linkedin', url, true, String(records[0]?.error ?? 'No record came back.'));
    const facts = {
      name: r.name,
      industries: r.industries,
      company_size: r.company_size,
      employees_in_linkedin: r.employees_in_linkedin,
      followers: r.followers,
      headquarters: r.headquarters,
      website: r.website,
      founded: r.founded,
      organization_type: r.organization_type,
      locations: Array.isArray(r.locations) ? r.locations.slice(0, 2) : [],
      // Dates and likes only: no update text, no poster names.
      recentUpdates: (Array.isArray(r.updates) ? r.updates : []).slice(0, 3).map((u: any) => ({ date: u.date, likes: u.likes_count })),
    };
    return fromFacts('linkedin', url, facts, true);
  } catch (e) {
    return failed('linkedin', url, true, (e as Error).message);
  }
}

// ---------- collection ----------

const keyOf = (source: Source, listing: string) =>
  source === 'yelp' ? (listing.replace(/[?#].*$/, '').split('/biz/')[1]?.replace(/\/$/, '') ?? listing)
  : source === 'jobs' ? listing.replace(':', '-')
  : (listing.replace(/[?#].*$/, '').split('/company/')[1]?.replace(/\/$/, '') ?? listing);

/** Collect every source the subject has a listing for. Live when Bright Data is configured, otherwise fixtures. */
export async function collectFootprint(cast: Cast, subjectKind: SubjectKind, subjectId: bigint, onStep: (m: string) => void = () => undefined): Promise<FootprintRow[]> {
  const listings = listingsOf(cast, subjectKind, subjectId);
  if (!listings) throw new Error(`Unknown ${subjectKind} ${subjectId}`);
  // The Web Scraper API needs only the key; Web Unlocker pages also need a zone on the account. Anything not
  // available live comes from recorded data, marked as such.
  const liveScraper = brightDataLive();
  let liveUnlocker = liveScraper;
  if (liveUnlocker) {
    try {
      await unlockerZone();
    } catch (e) {
      onStep(`Web Unlocker not usable yet (${(e as Error).message}); using recorded page data`);
      liveUnlocker = false;
    }
  }
  const liveJobsOk = process.env.DEMO_MODE !== '1';
  const jobs: Promise<FootprintRow | null>[] = [];
  if (listings.yelpUrl) jobs.push(liveUnlocker ? liveYelp(listings.yelpUrl) : Promise.resolve(fixtureFor('yelp', keyOf('yelp', listings.yelpUrl))));
  if (listings.jobBoard) jobs.push(liveJobsOk ? liveJobs(listings.jobBoard) : Promise.resolve(fixtureFor('jobs', keyOf('jobs', listings.jobBoard))));
  if (listings.linkedinUrl) jobs.push(liveScraper ? liveLinkedin(listings.linkedinUrl) : Promise.resolve(fixtureFor('linkedin', keyOf('linkedin', listings.linkedinUrl))));
  if (!jobs.length) {
    onStep(`${listings.name}: no public listing on file`);
    return [];
  }
  const rows = (await Promise.all(jobs)).filter((r): r is FootprintRow => r !== null);
  for (const r of rows) {
    await cast.credit.reducers.recordFootprint({
      subjectKind,
      subjectId,
      source: r.source,
      sourceUrl: r.sourceUrl,
      status: r.status,
      error: r.error,
      summaryPlain: r.summaryPlain,
      factsJson: JSON.stringify(r.facts),
      ratingTenths: r.ratingTenths,
      reviewCount: r.reviewCount,
      isClosed: r.isClosed,
      isClaimed: r.isClaimed,
      yearEstablished: r.yearEstablished,
      openRoles: r.openRoles,
      employees: r.employees,
      followers: r.followers,
      live: r.live,
    });
    onStep(`${listings.name} ${r.source}: ${r.status === 'ok' ? r.summaryPlain : r.error}`);
  }
  return rows;
}

/** Subjects with at least one listing on file. */
export function subjectsWithListings(cast: Cast): { subjectKind: SubjectKind; subjectId: bigint; name: string }[] {
  const out: { subjectKind: SubjectKind; subjectId: bigint; name: string }[] = [];
  for (const c of cast.advisor.db.customer.iter()) if (c.yelpUrl || c.jobBoard || c.linkedinUrl) out.push({ subjectKind: 'customer', subjectId: c.id, name: c.name });
  for (const v of cast.advisor.db.vendor.iter()) if (v.yelpUrl || v.jobBoard || v.linkedinUrl) out.push({ subjectKind: 'vendor', subjectId: v.id, name: v.name });
  return out;
}
