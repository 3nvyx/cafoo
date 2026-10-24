// The charter routes behind the real gateway guards: the catalog the editor maps lines against, and the eval
// endpoints (one eval at a time, 404 for an unknown version, 409 for a published one, refused from another machine).
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { charterCoverage } from '../src/charter/coverage';
import type { EvalReport } from '../src/charter/evaluate';
import { charterCatalog, charterEvalStatus, charterRoutes, resetCharterEvalStatus, type CharterRouteOptions } from '../src/charter/routes';
import { loadScenarios, scenariosDir } from '@cafoo/eval-harness';
import { createGateway, type GatewayOptions } from '../src/gateway';
import { HARNESSES, type Role } from '../src/harness';
import type { Cast } from '../src/stdb';

let server: Server | undefined;
afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));
beforeEach(() => resetCharterEvalStatus());

const rows = new Map<bigint, { id: bigint; role: string; status: { tag: string } }>([
  [7n, { id: 7n, role: 'bookkeeper', status: { tag: 'Draft' } }],
  [8n, { id: 8n, role: 'bookkeeper', status: { tag: 'Live' } }],
]);
const cast = { advisor: { db: { charterVersion: { id: { find: (id: bigint) => rows.get(id) } } } } } as unknown as Cast;

async function gateway(routeOpts: CharterRouteOptions, opts: Partial<GatewayOptions> = {}) {
  server = createGateway(cast, { env: {}, routes: charterRoutes(cast, routeOpts), status: () => ({ charterEval: charterEvalStatus() }), ...opts });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const post = (base: string, path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise(r => setTimeout(r, 5));
};

describe('GET /charters/catalog', () => {
  it('lists built-in and parameterized templates with their params, the ledger scenarios, and each built-in charter with a covering mapping', async () => {
    const base = await gateway({});
    const r = await fetch(`${base}/charters/catalog`, { headers: { origin: 'http://localhost:5173' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const body = (await r.json()) as ReturnType<typeof charterCatalog>;
    expect(body.templates).toContainEqual({ id: 'builtin:bookkeeper.may.2', role: 'bookkeeper', titlePlain: expect.stringMatching(/seventy-five percent/), params: [] });
    expect(body.templates).toContainEqual({ id: 'batch_min_confidence', role: 'bookkeeper', titlePlain: expect.any(String), params: [{ name: 'minScoreBp', labelPlain: expect.any(String), type: 'bp', default: 7500, min: 7500, max: 10000 }], tightensLine: 'May 2' });
    expect(body.templates.find(t => t.id === 'kinds_allowed')).toMatchObject({ role: '*', tightensLine: 'May 1' });
    expect(body.templates.find(t => t.id === 'ic_difference_tolerance')).toMatchObject({ tightensLine: 'Escalates 1' });
    expect(body.templates.find(t => t.id === 'max_proposal_amount')).not.toHaveProperty('tightensLine');
    expect(body.templates.find(t => t.id === 'max_proposal_amount')?.role).toBe('*');
    expect(body.scenarios).toContainEqual({ id: 'bookkeeper-batch-confidence', agent: 'bookkeeper', charterLine: expect.stringMatching(/^You may propose many matches/) });
    expect(body.scenarios.some(s => s.id.startsWith('personas'))).toBe(false);
    const scenarios = loadScenarios(scenariosDir);
    for (const role of Object.keys(HARNESSES) as Role[]) {
      const b = body.builtin[role]!;
      expect(b.bodyMd, role).toMatch(/charter\n/);
      expect(charterCoverage(role, b.bodyMd, b.mapping, scenarios).problems, role).toEqual([]);
    }
  });
});

describe('charter eval endpoints', () => {
  const report = (passed: boolean, publishable = passed) => ({ passed, publishable }) as EvalReport;

  it('starts one eval, reports its steps, refuses a second while it runs, and merges into /status', async () => {
    let finish!: (r: EvalReport) => void;
    const calls: unknown[] = [];
    const base = await gateway({
      evaluate: (_c, id, o) => {
        calls.push([id, o?.mode]);
        o?.onStep?.('Checking that every line is mapped to a rule or a scenario');
        return new Promise(r => (finish = r));
      },
    });
    const r = await post(base, '/charters/7/eval', { mode: 'snapshot' });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ versionId: '7', status: 'running', mode: 'snapshot' });
    expect(calls).toEqual([[7n, 'snapshot']]);
    expect((await post(base, '/charters/7/eval')).status).toBe(409);
    const status = (await (await fetch(`${base}/charters/7/eval`)).json()) as { status: string; steps: string[] };
    expect(status).toMatchObject({ status: 'running', steps: ['Checking that every line is mapped to a rule or a scenario'] });
    finish(report(true));
    await until(() => charterEvalStatus().status === 'done');
    expect((await (await fetch(`${base}/charters/7/eval`)).json()) as object).toMatchObject({ status: 'done', passed: true, publishable: true, finishedAt: expect.any(String) });
    expect(((await (await fetch(`${base}/status`)).json()) as { charterEval: unknown }).charterEval).toMatchObject({ versionId: '7', status: 'done' });
    expect((await (await fetch(`${base}/charters/9/eval`)).json()) as object).toEqual({ versionId: '9', status: 'idle', steps: [] });
  });

  it('defaults to a dry run, and reports a runner error', async () => {
    const modes: unknown[] = [];
    const base = await gateway({ evaluate: async (_c, _id, o) => { modes.push(o?.mode); throw new Error('spacetime not found'); } });
    expect((await post(base, '/charters/7/eval')).status).toBe(202);
    await until(() => charterEvalStatus().status === 'error');
    expect(modes).toEqual(['dry_run']);
    expect(charterEvalStatus()).toMatchObject({ status: 'error', error: 'spacetime not found' });
  });

  it('answers 404 for an unknown version, 409 for a published one, 400 for a bad mode', async () => {
    const base = await gateway({ evaluate: async () => report(true) });
    expect((await post(base, '/charters/99/eval')).status).toBe(404);
    expect(await (await post(base, '/charters/8/eval')).json()).toEqual({ error: 'charter version 8 is already published' });
    expect((await post(base, '/charters/7/eval', { mode: 'live' })).status).toBe(400);
    expect(charterEvalStatus().status).toBe('idle');
  });

  it('refuses to start an eval from another machine without the gateway key', async () => {
    const base = await gateway({ evaluate: async () => report(true) }, { isLocal: () => false });
    expect((await post(base, '/charters/7/eval')).status).toBe(403);
    expect((await fetch(`${base}/charters/catalog`)).status).toBe(200);
  });
});
