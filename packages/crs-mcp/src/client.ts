import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixtureName, loadDataset, type PersonaRequest } from './csv.js';
import { fixturesDir as defaultFixturesDir, secretsPath as defaultSecretsPath } from './paths.js';

export type CrsMode = 'live' | 'replay';

export interface CrsResponse<T = unknown> {
  status: number;
  headers: { requestId: string | null };
  body: T;
  /** Where the answer came from. */
  source: 'live' | 'fixture';
}

/** Shape of a file under fixtures/crs/<product>/<name>.json. */
export interface CrsFixture {
  status: number;
  requestId: string;
  /** true until the fixture is overwritten by a live recording. */
  synthesized: boolean;
  recordedAt?: string;
  endpoint: string;
  body: unknown;
}

export interface CrsClientOptions {
  /** Force a mode. Default: replay when CRS_USERNAME is empty or CRS_REPLAY=1, else live. */
  mode?: CrsMode;
  username?: string;
  password?: string;
  baseUrl?: string;
  fixturesDir?: string;
  /** Write every live persona response into this fixtures dir (same layout as fixtures/crs). */
  record?: string;
  /** Token cache file. Default <repo>/.secrets/crs.json. */
  secretsPath?: string;
  /** Live mode refuses test-case rows unless this is true (some go to the real vendor). */
  allowTestCases?: boolean;
  /** Max 429 retries per call. Default 3. */
  maxRateLimitRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export class CrsLoginError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CrsLoginError';
  }
}

export class CrsCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'CrsCallError';
  }
}

interface TokenCache {
  token: string;
  /** Epoch ms. */
  expires: number;
  username: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = 'https://api-sandbox.stitchcredit.com/api';
const EXPIRY_SKEW_MS = 60_000;

/**
 * Process-wide login state, keyed by baseUrl + username. One login per process, memoized as a
 * promise (also when it fails: a failed login is never retried). A 401 on a product call may
 * trigger at most one more login per process.
 */
interface LoginState {
  promise?: Promise<TokenCache>;
  reloginUsed: boolean;
}
const loginStates = new Map<string, LoginState>();

/** Test hook: forget process-wide login state. */
export function __resetLoginStateForTests(): void {
  loginStates.clear();
}

/** Resolve the mode from env the same way the client does. */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): CrsMode {
  const user = (env.CRS_USERNAME ?? '').trim();
  if (!user || env.CRS_REPLAY === '1' || env.CRS_REPLAY === 'true') return 'replay';
  return 'live';
}

/** Parse the login `expires` field: epoch ms, epoch seconds, seconds-from-now, or a date string. */
export function parseExpires(raw: unknown, now = Date.now()): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw > 1e12) return raw;
    if (raw > 1e9) return raw * 1000;
    return now + raw * 1000;
  }
  if (typeof raw === 'string' && raw.trim()) {
    if (/^\d+$/.test(raw.trim())) return parseExpires(Number(raw.trim()), now);
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t;
  }
  // Unknown format: assume a conservative 50 minutes.
  return now + 50 * 60_000;
}

/** Seconds to wait from a Retry-After header (delta-seconds or HTTP-date). */
export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 1;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(value);
  return Number.isNaN(t) ? 1 : Math.max(0, (t - now) / 1000);
}

function canonicalBody(body: unknown): string {
  return JSON.stringify(body ?? null);
}

export class CrsClient {
  readonly mode: CrsMode;
  private readonly username: string;
  private readonly password: string;
  readonly baseUrl: string;
  private readonly fixturesDir: string;
  private readonly recordDir?: string;
  private readonly secretsPath: string;
  private readonly allowTestCases: boolean;
  private readonly maxRateLimitRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(opts: CrsClientOptions = {}) {
    const env = process.env;
    this.username = opts.username ?? (env.CRS_USERNAME ?? '').trim();
    this.password = opts.password ?? env.CRS_PASSWORD ?? '';
    this.baseUrl = (opts.baseUrl ?? (env.CRS_BASE_URL || DEFAULT_BASE_URL)).replace(/\/+$/, '');
    this.mode = opts.mode ?? resolveMode({ ...env, CRS_USERNAME: this.username });
    if (this.mode === 'live' && !this.username) throw new Error('CRS live mode needs CRS_USERNAME');
    this.fixturesDir = opts.fixturesDir ?? defaultFixturesDir();
    this.recordDir = opts.record;
    this.secretsPath = opts.secretsPath ?? defaultSecretsPath();
    this.allowTestCases = opts.allowTestCases ?? false;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 3;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
  }

  private get stateKey(): string {
    return `${this.baseUrl}|${this.username}`;
  }

  private state(): LoginState {
    let s = loginStates.get(this.stateKey);
    if (!s) {
      s = { reloginUsed: false };
      loginStates.set(this.stateKey, s);
    }
    return s;
  }

  /**
   * Returns a bearer token. Uses the cached token in .secrets/crs.json when it is still valid,
   * otherwise logs in once. The promise is memoized for the whole process, including failures.
   */
  login(): Promise<string> {
    if (this.mode === 'replay') return Promise.resolve('replay');
    const s = this.state();
    s.promise ??= this.obtainToken(true);
    return s.promise.then((t) => t.token);
  }

  private async obtainToken(allowCache: boolean): Promise<TokenCache> {
    if (allowCache) {
      const cached = this.readTokenCache();
      if (cached) return cached;
    }
    return this.doLogin();
  }

  private readTokenCache(): TokenCache | undefined {
    try {
      if (!existsSync(this.secretsPath)) return undefined;
      const c = JSON.parse(readFileSync(this.secretsPath, 'utf8')) as Partial<TokenCache>;
      if (
        typeof c.token === 'string' &&
        typeof c.expires === 'number' &&
        c.username === this.username &&
        c.baseUrl === this.baseUrl &&
        c.expires - EXPIRY_SKEW_MS > Date.now()
      ) {
        return c as TokenCache;
      }
    } catch {
      // unreadable cache: ignore and log in
    }
    return undefined;
  }

  private writeTokenCache(t: TokenCache): void {
    mkdirSync(dirname(this.secretsPath), { recursive: true });
    writeFileSync(this.secretsPath, JSON.stringify(t, null, 2), { mode: 0o600 });
  }

  /** Exactly one POST /users/login. Never retried, never looped. */
  private async doLogin(): Promise<TokenCache> {
    const markerPath = join(dirname(this.secretsPath), 'crs.login-failed.json');
    if (existsSync(markerPath)) {
      throw new CrsLoginError(
        `A previous CRS login failed (see ${markerPath}). Refusing to try again: repeated failed logins ` +
          'disable the sandbox account. Fix CRS_USERNAME/CRS_PASSWORD, then delete that file.',
      );
    }
    if (!this.password) throw new CrsLoginError('CRS_PASSWORD is empty; not attempting a login');
    this.log('crs: POST /users/login');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password }),
      });
    } catch (e) {
      throw new CrsLoginError(`CRS login request failed before reaching the server: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(
        markerPath,
        JSON.stringify({ at: new Date().toISOString(), status: res.status, username: this.username, body: text.slice(0, 500) }, null, 2),
        { mode: 0o600 },
      );
      throw new CrsLoginError(`CRS login failed with HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    let json: { token?: string; expires?: unknown };
    try {
      json = JSON.parse(text) as { token?: string; expires?: unknown };
    } catch {
      throw new CrsLoginError('CRS login returned a non-JSON body', res.status);
    }
    if (!json.token) throw new CrsLoginError('CRS login response has no token', res.status);
    const t: TokenCache = {
      token: json.token,
      expires: parseExpires(json.expires),
      username: this.username,
      baseUrl: this.baseUrl,
    };
    this.writeTokenCache(t);
    return t;
  }

  /** Throws unless `req` is byte-for-byte a dataset row (same endpoint, method and body). */
  private assertFromDataset(req: PersonaRequest): void {
    const match = loadDataset().some(
      (r) =>
        r.endpoint === req.endpoint &&
        r.method === req.method &&
        r.source === req.source &&
        r.personaId === req.personaId &&
        canonicalBody(r.body) === canonicalBody(req.body),
    );
    if (!match) throw new Error('CRS: refusing to send a request that is not a row of crs-sandbox-dataset.csv');
    if (req.source !== 'persona' && !this.allowTestCases) {
      throw new Error('CRS: test-case rows are not sent live unless allowTestCases is set');
    }
  }

  fixturePath(req: PersonaRequest, dir = this.fixturesDir): string {
    return join(dir, req.product, `${fixtureName(req)}.json`);
  }

  /** Send one dataset request (live) or answer it from fixtures (replay). */
  async call<T = unknown>(req: PersonaRequest): Promise<CrsResponse<T>> {
    if (this.mode === 'replay') return this.replay<T>(req);
    this.assertFromDataset(req);
    const res = await this.live<T>(req);
    if (this.recordDir && req.source === 'persona') this.recordFixture(req, res);
    return res;
  }

  private replay<T>(req: PersonaRequest): CrsResponse<T> {
    const path = this.fixturePath(req);
    if (!existsSync(path)) throw new Error(`CRS replay: no fixture at ${path}`);
    const fx = JSON.parse(readFileSync(path, 'utf8')) as CrsFixture;
    return { status: fx.status, headers: { requestId: fx.requestId }, body: fx.body as T, source: 'fixture' };
  }

  private async live<T>(req: PersonaRequest): Promise<CrsResponse<T>> {
    const payload = JSON.stringify(req.body);
    let token = await this.login();
    let rateLimitRetries = 0;
    let relogged = false;
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl}${req.endpoint}`, {
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: req.method === 'GET' ? undefined : payload,
      });
      const requestId = res.headers.get('RequestID');
      if (res.status === 429 && rateLimitRetries < this.maxRateLimitRetries) {
        rateLimitRetries++;
        const wait = Math.min(parseRetryAfter(res.headers.get('Retry-After')), 120);
        this.log(`crs: 429 on ${req.endpoint}; waiting ${wait}s`);
        await res.text().catch(() => '');
        await this.sleep(wait * 1000);
        continue;
      }
      if (res.status === 401 && !relogged) {
        const s = this.state();
        await res.text().catch(() => '');
        if (s.reloginUsed) {
          throw new CrsCallError(`CRS 401 on ${req.endpoint} and the one re-login is already spent`, 401, requestId, null);
        }
        s.reloginUsed = true;
        relogged = true;
        this.log('crs: 401 on product call; logging in again (once per process)');
        s.promise = this.obtainToken(false);
        token = (await s.promise).token;
        continue;
      }
      const ct = res.headers.get('content-type') ?? '';
      const text = await res.text();
      let body: unknown = text;
      if (ct.includes('json') || /^\s*[{[]/.test(text)) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (res.status === 401) throw new CrsCallError(`CRS 401 on ${req.endpoint} after re-login`, 401, requestId, body);
      return { status: res.status, headers: { requestId }, body: body as T, source: 'live' };
    }
  }

  private recordFixture(req: PersonaRequest, res: CrsResponse): void {
    const dir = this.recordDir!;
    const path = this.fixturePath(req, dir);
    mkdirSync(dirname(path), { recursive: true });
    const fx: CrsFixture = {
      status: res.status,
      requestId: res.headers.requestId ?? `live-${fixtureName(req)}-${req.product}`,
      synthesized: false,
      recordedAt: new Date().toISOString(),
      endpoint: req.endpoint,
      body: res.body,
    };
    writeFileSync(path, JSON.stringify(fx, null, 2) + '\n');
  }
}

/** A client configured from process.env (the caller loads .env). */
export function createCrsClient(opts: CrsClientOptions = {}): CrsClient {
  return new CrsClient(opts);
}
