import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CrsClient, CrsLoginError, __resetLoginStateForTests, parseExpires, parseRetryAfter, resolveMode } from '../src/client.js';
import { requestsFor, testCases } from '../src/csv.js';

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {}, calls.length);
  }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const tmp = () => mkdtempSync(join(tmpdir(), 'crs-'));
const req = requestsFor('P01', 'fraud_finder')[0]!;

beforeEach(() => __resetLoginStateForTests());

describe('mode', () => {
  it('replays when there is no username or CRS_REPLAY=1', () => {
    expect(resolveMode({})).toBe('replay');
    expect(resolveMode({ CRS_USERNAME: 'u', CRS_REPLAY: '1' })).toBe('replay');
    expect(resolveMode({ CRS_USERNAME: 'u', CRS_REPLAY: '' })).toBe('live');
  });

  it('replays whenever DEMO_MODE=1 forces demo, even with credentials and CRS_REPLAY unset', () => {
    // The gateway reports CRS as demo under DEMO_MODE=1, so the client must never log in to the sandbox then.
    expect(resolveMode({ CRS_USERNAME: 'u', CRS_REPLAY: '', DEMO_MODE: '1' })).toBe('replay');
    expect(resolveMode({ CRS_USERNAME: 'u', DEMO_MODE: '0' })).toBe('live');
  });

  it('a client built under DEMO_MODE=1 never touches the network', async () => {
    const { f, calls } = fakeFetch(() => json(500, {}));
    const c = new CrsClient({ username: 'u', password: 'p', fetch: f, env: { DEMO_MODE: '1', CRS_REPLAY: '' } });
    expect(c.mode).toBe('replay');
    await c.call(req);
    expect(calls.length).toBe(0);
  });

  it('replay never touches the network', async () => {
    const { f, calls } = fakeFetch(() => json(500, {}));
    const c = new CrsClient({ mode: 'replay', fetch: f });
    const r = await c.call(req);
    expect(r.source).toBe('fixture');
    expect(r.headers.requestId).toBe('fx-P01-fraud_finder');
    expect(calls).toHaveLength(0);
  });
});

describe('live mode', () => {
  const live = (f: typeof fetch, dir = tmp(), extra = {}) =>
    new CrsClient({ mode: 'live', username: 'u', password: 'p', baseUrl: 'https://crs.test/api', secretsPath: join(dir, 'crs.json'), fetch: f, sleep: async () => {}, ...extra });

  it('logs in once per process, caches the token, and sends the CSV body verbatim', async () => {
    const dir = tmp();
    const { f, calls } = fakeFetch((url) =>
      url.endsWith('/users/login') ? json(200, { token: 'T1', expires: Date.now() + 3600_000, refreshToken: 'R' }) : json(200, { risk: { score: 11 } }, { RequestID: 'rid-1' }),
    );
    const c1 = live(f, dir);
    const c2 = live(f, dir);
    const [a, b] = await Promise.all([c1.call(req), c2.call(req)]);
    expect(a.headers.requestId).toBe('rid-1');
    expect(b.status).toBe(200);
    expect(calls.filter((c) => c.url.endsWith('/users/login'))).toHaveLength(1);
    const product = calls.find((c) => c.url.endsWith('/fraud-finder/fraud-finder'))!;
    expect(product.init.body).toBe(JSON.stringify(req.body));
    expect((product.init.headers as Record<string, string>).Authorization).toBe('Bearer T1');
    const cache = JSON.parse(readFileSync(join(dir, 'crs.json'), 'utf8'));
    expect(cache.token).toBe('T1');
  });

  it('reuses a valid cached token without logging in', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'crs.json'), JSON.stringify({ token: 'C', expires: Date.now() + 3600_000, username: 'u', baseUrl: 'https://crs.test/api' }));
    const { f, calls } = fakeFetch(() => json(200, {}));
    await live(f, dir).call(req);
    expect(calls.map((c) => c.url)).toEqual(['https://crs.test/api/fraud-finder/fraud-finder']);
  });

  it('never retries a failed login, and leaves a marker that blocks later processes', async () => {
    const dir = tmp();
    const { f, calls } = fakeFetch(() => json(401, { codes: ['CRS112'] }));
    const c = live(f, dir);
    await expect(c.call(req)).rejects.toBeInstanceOf(CrsLoginError);
    await expect(c.call(req)).rejects.toBeInstanceOf(CrsLoginError);
    expect(calls).toHaveLength(1);
    expect(existsSync(join(dir, 'crs.login-failed.json'))).toBe(true);
    __resetLoginStateForTests();
    await expect(live(f, dir).call(req)).rejects.toThrow(/Refusing to try again/);
    expect(calls).toHaveLength(1);
  });

  it('logs in again at most once after a 401 on a product call', async () => {
    let logins = 0;
    const { f, calls } = fakeFetch((url) => {
      if (url.endsWith('/users/login')) return json(200, { token: `T${++logins}`, expires: Date.now() + 3600_000 });
      return json(401, { codes: ['CRS111'] });
    });
    const c = live(f);
    await expect(c.call(req)).rejects.toThrow(/401/);
    await expect(c.call(req)).rejects.toThrow(/re-login is already spent/);
    expect(logins).toBe(2);
    expect(calls.filter((x) => !x.url.endsWith('/users/login'))).toHaveLength(3);
  });

  it('honors Retry-After on 429', async () => {
    const waits: number[] = [];
    let n = 0;
    const { f } = fakeFetch((url) => {
      if (url.endsWith('/users/login')) return json(200, { token: 'T', expires: Date.now() + 3600_000 });
      return ++n === 1 ? json(429, { codes: ['CRS962'] }, { 'Retry-After': '2' }) : json(200, { ok: true });
    });
    const c = live(f, tmp(), { sleep: async (ms: number) => void waits.push(ms) });
    const r = await c.call(req);
    expect(r.status).toBe(200);
    expect(waits).toEqual([2000]);
  });

  it('refuses requests that are not dataset rows, and test cases unless allowed', async () => {
    const { f, calls } = fakeFetch(() => json(200, { token: 'T', expires: Date.now() + 3600_000 }));
    const c = live(f);
    await expect(c.call({ ...req, body: { ...(req.body as object), email: 'someone@else.com' } })).rejects.toThrow(/not a row/);
    await expect(c.call(testCases('fraud_finder')[0]!)).rejects.toThrow(/test-case/);
    expect(calls).toHaveLength(0);
  });

  it('records live responses as fixtures', async () => {
    const rec = tmp();
    const { f } = fakeFetch((url) => (url.endsWith('/users/login') ? json(200, { token: 'T', expires: 9_999_999_999 }) : json(200, { risk: { score: 11 } }, { RequestID: 'live-rid' })));
    await live(f, tmp(), { record: rec }).call(req);
    const fx = JSON.parse(readFileSync(join(rec, 'fraud_finder', 'P01.json'), 'utf8'));
    expect(fx).toMatchObject({ status: 200, requestId: 'live-rid', synthesized: false, body: { risk: { score: 11 } } });
  });
});

describe('header parsing', () => {
  it('parses expires in several formats', () => {
    const now = 1_700_000_000_000;
    expect(parseExpires(1_800_000_000_000, now)).toBe(1_800_000_000_000);
    expect(parseExpires(1_800_000_000, now)).toBe(1_800_000_000_000);
    expect(parseExpires(3600, now)).toBe(now + 3_600_000);
    expect(parseExpires('2030-01-01T00:00:00Z', now)).toBe(Date.parse('2030-01-01T00:00:00Z'));
  });
  it('parses Retry-After', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(null)).toBe(1);
  });
});
