/** Gateway routes for exports: the books as CSV, or as a Google Slides deck (exports.ts, slides.ts). */
import { BadRequest, json, readJson, type Route, type RouteContext } from './http';
import { DATASETS, exportTables, isDataset, toCsv, type Dataset } from './exports';
import { exportToSlides, slidesSetup } from './slides';
import type { Cast } from './stdb';

const LABEL: Record<Dataset, string> = { ledger: 'Ledger', 'board-pack': 'Board Pack', 'cfo-queue': 'Waiting for the CFO' };

function parse(dataset: unknown, period: unknown): { dataset: Dataset; period: string } {
  const d = String(dataset ?? '');
  const p = String(period ?? '');
  if (!isDataset(d)) throw new BadRequest(`dataset must be one of ${DATASETS.join(', ')}`);
  if (!/^\d{4}-\d{2}$/.test(p)) throw new BadRequest('period must be YYYY-MM');
  return { dataset: d, period: p };
}

/** Exports read the books, so like the Advisor chat they answer only this machine, or a caller with the gateway key. */
const refuseRemote = (ctx: RouteContext) => {
  if (ctx.mayChangeState) return false;
  json(ctx.res, 403, { error: 'exports read the books; from another machine they need the gateway API key (Authorization: Bearer)' });
  return true;
};

export function exportRoutes(cast: Cast, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/export\/csv$/,
      handle: ctx => {
        if (refuseRemote(ctx)) return;
        const { dataset, period } = parse(ctx.url.searchParams.get('dataset'), ctx.url.searchParams.get('period'));
        let tables;
        try {
          tables = exportTables(cast.advisor, dataset, period);
        } catch (e) {
          return json(ctx.res, 404, { error: (e as Error).message });
        }
        ctx.res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="luyten-${dataset}-${period}.csv"` });
        ctx.res.end(toCsv(tables));
      },
    },
    {
      method: 'POST',
      pattern: /^\/export\/slides$/,
      handle: async ctx => {
        const body = await readJson(ctx.req);
        const { dataset, period } = parse(body.dataset, body.period);
        const setup = slidesSetup(env);
        if ('missing' in setup) return json(ctx.res, 409, { error: 'Google Slides export is not set up on this machine. CSV export works without it.', missing: setup.missing });
        let tables;
        try {
          tables = exportTables(cast.advisor, dataset, period);
        } catch (e) {
          return json(ctx.res, 404, { error: (e as Error).message });
        }
        try {
          const deck = await exportToSlides(setup.config, `Luyten ${LABEL[dataset]}, ${period}`, `Exported ${new Date().toISOString().slice(0, 10)} from the Luyten ledger. Every figure drills down to its journal lines in the app.`, tables, fetcher);
          return json(ctx.res, 200, { ...deck, sharedWith: setup.config.shareWith });
        } catch (e) {
          return json(ctx.res, 502, { error: (e as Error).message });
        }
      },
    },
  ];
}
