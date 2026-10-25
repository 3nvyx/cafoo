/** Gateway routes for the public footprint: start a collection job, read job status. */
import { json, type Route } from './http';
import { collectFootprint, listingsOf, type SubjectKind } from './footprint';
import { customerSite, siteSignals, sitePlain } from './apify';
import type { Cast } from './stdb';

type Job = { subjectKind: SubjectKind; subjectId: string; status: 'running' | 'done' | 'error'; startedAt: string; steps: string[]; error?: string };

export function footprintRoutes(cast: Cast): Route[] {
  const jobs = new Map<string, Job>();
  return [
    {
      method: 'POST',
      pattern: /^\/footprint$/,
      handle: async ({ req, res }) => {
        const { readJson } = await import('./http');
        const body = await readJson(req);
        const subjectKind = String(body.subjectKind ?? '') as SubjectKind;
        const subjectId = String(body.subjectId ?? '');
        if (subjectKind !== 'customer' && subjectKind !== 'vendor') return json(res, 400, { error: 'subjectKind must be customer or vendor' });
        if (!/^\d+$/.test(subjectId)) return json(res, 400, { error: 'subjectId must be a numeric id' });
        const listings = listingsOf(cast, subjectKind, BigInt(subjectId));
        if (!listings) return json(res, 404, { error: `Unknown ${subjectKind} ${subjectId}` });
        if (!listings.yelpUrl && !listings.jobBoard && !listings.linkedinUrl) return json(res, 409, { error: `${listings.name} has no public listing on file. Add a Yelp, job board, or LinkedIn listing first.` });
        const key = `${subjectKind}:${subjectId}`;
        const existing = jobs.get(key);
        if (existing?.status === 'running') return json(res, 202, { started: false, job: existing });
        const job: Job = { subjectKind, subjectId, status: 'running', startedAt: new Date().toISOString(), steps: [] };
        jobs.set(key, job);
        collectFootprint(cast, subjectKind, BigInt(subjectId), m => job.steps.push(m))
          .then(() => (job.status = 'done'))
          .catch(e => {
            job.status = 'error';
            job.error = e instanceof Error ? e.message : String(e);
          });
        return json(res, 202, { started: true, job });
      },
    },
    { method: 'GET', pattern: /^\/footprint\/status$/, handle: ({ res }) => json(res, 200, { jobs: [...jobs.values()] }) },
    {
      // A customer's website, read-only: what it says about closing, insolvency or a new owner. Crawls once per process.
      method: 'GET',
      pattern: /^\/customers\/(\d+)\/site$/,
      handle: async ({ res, params }) => {
        const c = cast.advisor.db.customer.id.find(BigInt(params[0]!));
        if (!c) return json(res, 404, { error: `Unknown customer ${params[0]}` });
        const site = await customerSite(c.domain);
        if (!site) return json(res, 200, { customerId: params[0], domain: c.domain, site: null, summaryPlain: `No website snapshot for ${c.name}.` });
        const signals = siteSignals(site);
        return json(res, 200, { customerId: params[0], domain: c.domain, source: site.source, crawledAt: site.crawledAt, pages: site.pages.map(p => ({ url: p.url, title: p.title })), signals, summaryPlain: sitePlain(c.name, site, signals) });
      },
    },
  ];
}
