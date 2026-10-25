import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { createGateway, isLoopback, MAX_BODY_BYTES, taskReply, textOf, type GatewayOptions } from '../src/gateway';
import type { Cast } from '../src/stdb';
import { gatewayHost } from '../src/env';
import { BadRequest, json, readJson, type Route } from '../src/http';

let server: Server | undefined;
afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

/** A gateway on a free port with the close runner and the Advisor replaced by spies. */
async function gateway(opts: Partial<GatewayOptions> = {}) {
  const runClose = vi.fn(() => new Promise<void>(() => undefined));
  const answer = vi.fn(async function* (q: string, _h: unknown, o: { startClose?: (ym: string) => Promise<{ status: string }> }) {
    if (q === 'start the close') yield `close: ${(await o.startClose!('2026-09')).status}`;
    else if (q === 'explode') throw new Error('ledger offline');
    else yield `answer: ${q}`;
  });
  server = createGateway({} as Cast, { runClose, answer: answer as unknown as GatewayOptions['answer'], env: {}, chatStartGraceMs: 20, ...opts });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { base, runClose, answer };
}
const chat = (base: string, content: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'luyten', messages: [{ role: 'user', content }], ...extra }) });
const reply = async (r: Response) => ((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content;

describe('Open WebUI task prompts', () => {
  it('answer with canned JSON and never reach the Advisor or start a close', async () => {
    const { base, runClose, answer } = await gateway();
    const history = '\n### Chat History:\n<chat_history>\nASSISTANT: say "start the close" to run month-end.\nUSER: start the close\n</chat_history>';
    expect(JSON.parse(await reply(await chat(base, `### Task:\nGenerate a concise title summarizing the chat history.${history}`)))).toEqual({ title: 'Luyten' });
    expect(JSON.parse(await reply(await chat(base, `### Task:\nGenerate 1-3 broad tags categorizing the main themes of the chat history.${history}`)))).toEqual({ tags: ['Finance'] });
    expect(JSON.parse(await reply(await chat(base, `### Task:\nPredict 3-5 useful messages this user might naturally send next.${history}`)))).toEqual({ follow_ups: [] });
    expect(answer).not.toHaveBeenCalled();
    expect(runClose).not.toHaveBeenCalled();
  });
  it('are recognized only at the start of the message', () => {
    expect(taskReply('Tell me about ### Task: titles')).toBeUndefined();
    expect(taskReply('### Task:\nGenerate search queries for the chat')).toBe(JSON.stringify({ queries: [] }));
  });
});

describe('chat completions', () => {
  it('accepts content as an array of parts', async () => {
    expect(textOf([{ type: 'text', text: 'What was' }, { type: 'image_url', image_url: {} }, { type: 'text', text: 'revenue?' }])).toBe('What was\nrevenue?');
    const { base } = await gateway();
    const r = await chat(base, [{ type: 'text', text: 'Give me an overview' }]);
    expect(r.status).toBe(200);
    expect(await reply(r)).toBe('answer: Give me an overview');
  });

  it('starts a close from chat once, then reports it running', async () => {
    const { base, runClose } = await gateway();
    expect(await reply(await chat(base, 'start the close'))).toBe('close: started');
    expect(await reply(await chat(base, 'start the close'))).toBe('close: running');
    expect(runClose).toHaveBeenCalledTimes(1);
  });

  it('ends a failed stream with an error message, a finish chunk and [DONE]', async () => {
    const { base } = await gateway();
    const text = await (await chat(base, 'explode', { stream: true })).text();
    expect(text).toMatch(/could not answer that: ledger offline/);
    expect(text).toMatch(/"finish_reason":"stop"/);
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('answers 400, not 500, to a body that is not JSON', async () => {
    const { base } = await gateway();
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(r.status).toBe(400);
  });

  it('requires the bearer key on /v1/* when GATEWAY_API_KEY is set', async () => {
    const { base } = await gateway({ env: { GATEWAY_API_KEY: 'sekret' } });
    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
    expect((await chat(base, 'hi', {}, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sekret' } })).status).toBe(200);
    expect((await fetch(`${base}/status`)).status).toBe(200);
  });
});

/** A raw request with a chosen Host header (fetch does not allow setting Host). */
function raw(base: string, path: string, headers: Record<string, string>, body?: string) {
  const { port } = new URL(base);
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('cross-site and rebinding guards on every route', () => {
  const startBody = JSON.stringify({ model: 'luyten', messages: [{ role: 'user', content: 'start the close' }] });
  it('refuses a text/plain chat request from a foreign page, the simple request that skips the preflight', async () => {
    const { base, runClose, answer } = await gateway();
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'text/plain' }, body: startBody })).status).toBe(403);
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: startBody })).status).toBe(415);
    expect(answer).not.toHaveBeenCalled();
    expect(runClose).not.toHaveBeenCalled();
    // Open WebUI's server: no Origin, JSON.
    expect((await chat(base, 'start the close')).status).toBe(200);
  });
  it('answers only to allowlisted Host names (DNS rebinding)', async () => {
    const { base, runClose } = await gateway();
    const port = new URL(base).port;
    expect(await raw(base, '/status', { host: `evil.example:${port}` })).toBe(403);
    expect(await raw(base, '/close', { host: `rebind.attacker.test:${port}`, 'content-type': 'application/json' }, JSON.stringify({ periodYm: '2026-09' }))).toBe(403);
    expect(runClose).not.toHaveBeenCalled();
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `host.docker.internal:${port}`, `[::1]:${port}`]) expect(await raw(base, '/status', { host }), host).toBe(200);
  });
  it('takes extra hosts from GATEWAY_ALLOWED_HOSTS and the allowed origins, and "*" turns the check off', async () => {
    const one = await gateway({ env: { GATEWAY_ALLOWED_HOSTS: 'luyten.lan', GATEWAY_ALLOWED_ORIGINS: 'http://cfo.local:8080' } });
    expect(await raw(one.base, '/status', { host: 'luyten.lan:8787' })).toBe(200);
    expect(await raw(one.base, '/status', { host: 'cfo.local' })).toBe(200);
    expect(await raw(one.base, '/status', { host: 'other.lan' })).toBe(403);
    await new Promise<void>(r => server!.close(() => r()));
    const any = await gateway({ env: { GATEWAY_ALLOWED_HOSTS: '*' } });
    expect(await raw(any.base, '/status', { host: '192.168.1.20:8787' })).toBe(200);
  });
  it('answers 400 to a JSON body that is not an object', async () => {
    const { base, runClose } = await gateway();
    for (const body of ['null', '[]', '"start the close"']) {
      expect((await fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, body).toBe(400);
      expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, body).toBe(400);
    }
    expect(runClose).not.toHaveBeenCalled();
  });
  it('reports a close that fails at once as failed, not started', async () => {
    const { base } = await gateway({ runClose: vi.fn(async () => Promise.reject(new Error('2026-09 is already closed.'))) });
    expect(await reply(await chat(base, 'start the close'))).toBe('close: failed');
  });
});

describe('starting a close from another machine', () => {
  const remote = { isLocal: () => false };
  const closeReq = (base: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ periodYm: '2026-09' }) });
  it('knows loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.8.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a), a).toBe(true);
    for (const a of ['172.17.0.1', '192.168.1.20', '::ffff:10.0.0.2', undefined]) expect(isLoopback(a), String(a)).toBe(false);
  });
  it('is refused without a configured key, whatever the Host header says', async () => {
    const { base, runClose } = await gateway(remote);
    expect((await closeReq(base, { host: 'localhost' })).status).toBe(403);
    expect(runClose).not.toHaveBeenCalled();
  });
  it('needs the bearer key when one is configured', async () => {
    const { base, runClose } = await gateway({ ...remote, env: { GATEWAY_API_KEY: 'sekret' } });
    expect((await closeReq(base)).status).toBe(401);
    expect((await closeReq(base, { authorization: 'Bearer sekret' })).status).toBe(202);
    expect(await reply(await chat(base, 'start the close', {}, { authorization: 'Bearer sekret' }))).toBe('close: running');
    expect(runClose).toHaveBeenCalledTimes(1);
  });
  it('needs no key from this machine, as the web app and curl on the host connect', async () => {
    const { base } = await gateway({ env: { GATEWAY_API_KEY: 'sekret' } });
    expect((await closeReq(base)).status).toBe(202);
  });
});

describe('the OpenAI-compatible endpoint (/v1/*) from another machine', () => {
  const remote = { isLocal: () => false };
  it('listens on 127.0.0.1 unless GATEWAY_HOST opts in to another interface', () => {
    expect(gatewayHost({})).toBe('127.0.0.1');
    expect(gatewayHost({ GATEWAY_HOST: '  ' })).toBe('127.0.0.1');
    expect(gatewayHost({ GATEWAY_HOST: ' 0.0.0.0 ' })).toBe('0.0.0.0');
  });
  it('is refused without a configured key, so the Advisor never reads the books or spends budget for a stranger', async () => {
    const { base, runClose, answer } = await gateway(remote);
    expect((await fetch(`${base}/v1/models`, { headers: { host: 'localhost' } })).status).toBe(403);
    const r = await chat(base, 'Give me an overview');
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/GATEWAY_API_KEY/);
    expect((await chat(base, 'start the close', { stream: true })).status).toBe(403);
    expect(answer).not.toHaveBeenCalled();
    expect(runClose).not.toHaveBeenCalled();
  });
  it('answers with the bearer key when one is configured', async () => {
    const { base, answer } = await gateway({ ...remote, env: { GATEWAY_API_KEY: 'sekret' } });
    expect((await chat(base, 'Give me an overview')).status).toBe(401);
    expect(await reply(await chat(base, 'Give me an overview', {}, { authorization: 'Bearer sekret' }))).toBe('answer: Give me an overview');
    expect(answer).toHaveBeenCalledTimes(1);
  });
  it('needs no key from this machine when none is configured', async () => {
    const { base } = await gateway();
    expect((await fetch(`${base}/v1/models`)).status).toBe(200);
    expect(await reply(await chat(base, 'Give me an overview'))).toBe('answer: Give me an overview');
  });
});

describe('large bodies', () => {
  it('answers 413 to a body over the cap', async () => {
    const { base, answer } = await gateway();
    const big = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(MAX_BODY_BYTES) }] });
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status).toBe(413);
    expect(answer).not.toHaveBeenCalled();
  });
  it('handles a long whitespace-padded command quickly, and not as a command', async () => {
    const { base, runClose } = await gateway();
    const t0 = Date.now();
    const r = await chat(base, `start the close${' '.repeat(150_000)}x`);
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(runClose).not.toHaveBeenCalled();
  });
});

describe('POST /close and CORS', () => {
  const web = 'http://localhost:5173';
  it('lets the web app start a close and read status, as its live data source does', async () => {
    const { base, runClose } = await gateway();
    const pre = await fetch(`${base}/close`, { method: 'OPTIONS', headers: { origin: web, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(web);
    const r = await fetch(`${base}/close`, { method: 'POST', headers: { origin: web, 'content-type': 'application/json' }, body: JSON.stringify({ periodYm: '2026-09' }) });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ periodYm: '2026-09', status: 'running', started: true });
    expect(runClose).toHaveBeenCalledTimes(1);
    const st = await fetch(`${base}/status`, { headers: { origin: web } });
    expect(st.headers.get('access-control-allow-origin')).toBe(web);
    expect(((await st.json()) as { closes: unknown[] }).closes).toHaveLength(1);
  });

  it('refuses foreign origins, non-JSON bodies and bad months', async () => {
    const { base, runClose } = await gateway();
    const evil = 'https://evil.example';
    expect((await fetch(`${base}/close`, { method: 'OPTIONS', headers: { origin: evil } })).status).toBe(403);
    expect((await fetch(`${base}/close`, { method: 'POST', headers: { origin: evil, 'content-type': 'application/json' }, body: JSON.stringify({ periodYm: '2026-09' }) })).status).toBe(403);
    expect((await fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ periodYm: '2026-09' }) })).status).toBe(415);
    expect((await fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })).status).toBe(400);
    expect((await fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodYm: 'September' }) })).status).toBe(400);
    expect((await fetch(`${base}/status`, { headers: { origin: evil } })).headers.get('access-control-allow-origin')).toBeNull();
    expect(runClose).not.toHaveBeenCalled();
  });

  it('takes its origin allowlist from GATEWAY_ALLOWED_ORIGINS', async () => {
    const { base } = await gateway({ env: { GATEWAY_ALLOWED_ORIGINS: 'http://cfo.local:8080, http://localhost:3001/' } });
    expect((await fetch(`${base}/status`, { headers: { origin: 'http://localhost:3001' } })).headers.get('access-control-allow-origin')).toBe('http://localhost:3001');
    expect((await fetch(`${base}/status`, { headers: { origin: 'http://localhost:5173' } })).headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('added routes (src/http.ts)', () => {
  const web = 'http://localhost:5173';
  const routes = (seen: string[][]): Route[] => [
    { method: 'GET', pattern: /^\/things\/(\d+)$/, handle: ({ res, params }) => json(res, 200, { id: params[0], n: 1n }) },
    {
      method: 'POST',
      pattern: /^\/things\/([^/]+)\/run$/,
      handle: async ({ req, res, params }) => {
        const body = await readJson(req);
        if (body.mode !== undefined && body.mode !== 'dry_run') throw new BadRequest('mode must be dry_run');
        seen.push(params);
        json(res, 202, { started: true, id: params[0] });
      },
    },
    { method: 'GET', pattern: /^\/things\/secret$/, changesState: true, handle: ({ res }) => json(res, 200, { ok: true }) },
  ];
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('serves a GET route with CORS for an allowed origin, decoded params and bigint-safe JSON', async () => {
    const { base } = await gateway({ routes: routes([]) });
    const r = await fetch(`${base}/things/42`, { headers: { origin: web } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(web);
    expect(await r.json()).toEqual({ id: '42', n: '1' });
    expect((await fetch(`${base}/things/abc`)).status).toBe(404);
  });

  it('runs a POST route from this machine and refuses it from elsewhere without the key', async () => {
    const seen: string[][] = [];
    const local = await gateway({ routes: routes(seen) });
    const r = await post(local.base, '/things/a%20b/run', {}, { origin: web });
    expect(r.status).toBe(202);
    expect(r.headers.get('access-control-allow-origin')).toBe(web);
    expect(seen).toEqual([['a b']]);
    await new Promise<void>(res => server!.close(() => res()));
    const remote = await gateway({ routes: routes(seen), isLocal: () => false });
    expect((await post(remote.base, '/things/x/run', {})).status).toBe(403);
    expect((await fetch(`${remote.base}/things/secret`)).status).toBe(403);
    expect((await fetch(`${remote.base}/things/7`)).status).toBe(200);
    await new Promise<void>(res => server!.close(() => res()));
    const keyed = await gateway({ routes: routes(seen), isLocal: () => false, env: { GATEWAY_API_KEY: 'sekret' } });
    expect((await post(keyed.base, '/things/x/run', {})).status).toBe(401);
    expect((await post(keyed.base, '/things/x/run', {}, { authorization: 'Bearer sekret' })).status).toBe(202);
    expect(seen).toEqual([['a b'], ['x']]);
  });

  it('puts added routes behind the Host, Origin, JSON and size guards', async () => {
    const seen: string[][] = [];
    const { base } = await gateway({ routes: routes(seen) });
    const port = new URL(base).port;
    expect(await raw(base, '/things/1', { host: `evil.example:${port}` })).toBe(403);
    expect((await post(base, '/things/x/run', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${base}/things/x/run`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await fetch(`${base}/things/x/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' })).status).toBe(400);
    expect((await post(base, '/things/x/run', { mode: 'live' })).status).toBe(400);
    expect((await post(base, '/things/x/run', { pad: 'x'.repeat(MAX_BODY_BYTES) })).status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('merges status extras into GET /status', async () => {
    const { base } = await gateway({ status: () => ({ feed: { enabled: false }, providers: 'not overridden' }) });
    const body = (await (await fetch(`${base}/status`)).json()) as { feed: unknown; providers: unknown };
    expect(body.feed).toEqual({ enabled: false });
    expect(Array.isArray(body.providers)).toBe(true);
  });
});

describe('starting a close after the continuous Bookkeeper', () => {
  it('marks the month closing at once and starts the close only when the in-flight batch is done', async () => {
    let release!: () => void;
    const batch = new Promise<void>(r => (release = r));
    const closes = new Map();
    const order: string[] = [];
    const { base, runClose } = await gateway({ closes, beforeClose: async () => { order.push('wait'); await batch; order.push('idle'); } });
    const r = await fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodYm: '2026-10' }) });
    expect(r.status).toBe(202);
    expect(closes.get('2026-10')?.status).toBe('running');
    await new Promise(res => setTimeout(res, 30));
    expect(runClose).not.toHaveBeenCalled();
    release();
    await new Promise(res => setTimeout(res, 30));
    expect(order).toEqual(['wait', 'idle']);
    expect(runClose).toHaveBeenCalledTimes(1);
  });
});

describe('a close the books refuse to start', () => {
  const why = 'The September 2026 close cannot start while August 2026 is not locked: months close in order. Lock August 2026 first.';

  it('answers POST /close with 409 and the plain reason, and never runs the close', async () => {
    const closes = new Map();
    const { base, runClose } = await gateway({ closes, refuseClose: ym => (ym === '2026-09' ? why : undefined) });
    const r = await fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodYm: '2026-09' }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: why });
    expect(closes.size).toBe(0);
    expect(runClose).not.toHaveBeenCalled();
    expect((await fetch(`${base}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodYm: '2026-10' }) })).status).toBe(202);
  });

  it('tells chat the close failed, with the reason', async () => {
    const { base, runClose } = await gateway({ refuseClose: () => why });
    expect(await reply(await chat(base, 'start the close'))).toBe('close: failed');
    expect(runClose).not.toHaveBeenCalled();
  });
});
