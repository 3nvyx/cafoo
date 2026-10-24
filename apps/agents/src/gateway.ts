/**
 * HTTP gateway: starts a close, reports provider status, and speaks the OpenAI chat-completions dialect
 * so Open WebUI (or any OpenAI-compatible client) can talk to the Advisor.
 *
 * It listens on every interface (Open WebUI in Docker reaches it through host.docker.internal), so it guards itself:
 * it answers only to allowlisted Host names (DNS rebinding), browsers get CORS only for allowlisted origins, every
 * POST must be JSON (a cross-site page cannot send that without a preflight the allowlist refuses) and is refused
 * outright from a foreign Origin, and /v1/* requires a bearer key when GATEWAY_API_KEY is set. Open WebUI's server
 * sends no Origin and JSON bodies, so it is unaffected. Its background task prompts get canned JSON, never the Advisor.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { GATEWAY_PORT, agentsLive, gatewayAllowedHosts, gatewayAllowedOrigins, providers } from './env';
import { runScriptedClose } from './scripted/close';
import type { Cast } from './stdb';
import { answerQuestion, type AnswerOptions, type CloseStart } from './advisor-chat';

type CloseState = { periodYm: string; status: 'running' | 'done' | 'error'; startedAt: string; steps: string[]; error?: string };
type ChatMessage = { role: string; content: string };
type CloseRunner = (periodYm: string, onStep: (m: string) => void) => Promise<unknown>;

export interface GatewayOptions {
  /** Live-mode close (Claude Agent SDK); the scripted close runs when agents are not live or this is absent. */
  liveClose?: CloseRunner;
  /** Test seams. */
  runClose?: CloseRunner;
  answer?: (question: string, history: ChatMessage[], opts: AnswerOptions) => AsyncGenerator<string>;
  env?: NodeJS.ProcessEnv;
  /** How long a close started from chat may take to fail before the reply says it started (ms). */
  chatStartGraceMs?: number;
  /** Test seam: whether a connection's remote address is this machine. Default: a loopback address. */
  isLocal?: (remoteAddress: string | undefined) => boolean;
}

/** A loopback address: 127.0.0.0/8, ::1, or either written as an IPv4-mapped IPv6 address. */
export const isLoopback = (a: string | undefined) => !!a && (/^(::ffff:)?127\./.test(a) || a === '::1');

class BadRequest extends Error {}
class TooLarge extends Error {}
/** Largest request body the gateway reads; a chat history or a close request is far smaller. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Message content as text: a string, or the text parts of an OpenAI content-part array. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (typeof p === 'string' ? p : p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Open WebUI's background prompts (title, tags, follow-ups, search queries, autocomplete) arrive as a user message
 * starting with "### Task:". They get the minimal JSON each task expects, so a chat history that mentions the close
 * can never reach the Advisor as if the CFO had typed it.
 */
export function taskReply(text: string): string | undefined {
  if (!/^\s*###\s*Task:/i.test(text)) return undefined;
  const task = text.replace(/^\s*###\s*Task:\s*/i, '').split(/\n/)[0]!.toLowerCase();
  if (/title/.test(task)) return JSON.stringify({ title: 'Cafoo Advisor' });
  if (/tags?\b/.test(task)) return JSON.stringify({ tags: ['Finance'] });
  if (/follow.?ups?|messages this user might|next/.test(task)) return JSON.stringify({ follow_ups: [] });
  if (/quer(y|ies)|search/.test(task)) return JSON.stringify({ queries: [] });
  if (/autocomplete|continue|complete/.test(task)) return JSON.stringify({ text: '' });
  return '{}';
}

function corsHeaders(req: IncomingMessage, allowed: readonly string[]): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !allowed.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
}

async function readJson(req: IncomingMessage): Promise<any> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new TooLarge(`request body over ${MAX_BODY_BYTES} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // Keep draining so the response can still be written, but stop keeping the bytes.
    if (size <= MAX_BODY_BYTES) chunks.push(c as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new TooLarge(`request body over ${MAX_BODY_BYTES} bytes`);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest('request body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('request body must be a JSON object');
  return body;
}

/** The Host header's name without its port, lower case; undefined when absent. */
function hostName(req: IncomingMessage): string | undefined {
  const h = req.headers.host?.trim().toLowerCase();
  if (!h) return undefined;
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '');
}

const bearerMatches = (header: string | undefined, key: string) => {
  const got = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? '');
  const want = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
};

/** The gateway server, not yet listening. */
export function createGateway(cast: Cast, opts: GatewayOptions = {}): Server {
  const env = opts.env ?? process.env;
  const allowed = gatewayAllowedOrigins(env);
  const hosts = gatewayAllowedHosts(env);
  const grace = opts.chatStartGraceMs ?? 1500;
  const apiKey = env.GATEWAY_API_KEY?.trim();
  const closes = new Map<string, CloseState>();
  const runClose: CloseRunner = opts.runClose ?? ((ym, onStep) => (agentsLive() && opts.liveClose ? opts.liveClose(ym, onStep) : runScriptedClose(cast, ym, { onStep })));

  /** Start a close unless one is running for that month. `settled` resolves when the run ends, either way. */
  const startClose = (periodYm: string): { started: boolean; state: CloseState; settled: Promise<void> } => {
    const existing = closes.get(periodYm);
    if (existing?.status === 'running') return { started: false, state: existing, settled: Promise.resolve() };
    const state: CloseState = { periodYm, status: 'running', startedAt: new Date().toISOString(), steps: [] };
    closes.set(periodYm, state);
    const settled = Promise.resolve()
      .then(() => runClose(periodYm, m => state.steps.push(m)))
      .then(() => {
        state.status = 'done';
      })
      .catch(e => {
        state.status = 'error';
        state.error = e?.message ?? String(e);
        console.error('close failed:', e);
      });
    return { started: true, state, settled };
  };
  /** From chat: start, then give a fast failure (already closed, not seeded, books refused) a moment to show. */
  const chatStartClose = async (periodYm: string): Promise<CloseStart> => {
    const { started, state, settled } = startClose(periodYm);
    if (!started) return { status: 'running' };
    await Promise.race([settled, new Promise(r => setTimeout(r, grace))]);
    return state.status === 'error' ? { status: 'failed', error: state.error } : { status: 'started' };
  };
  const answer = opts.answer ?? ((q: string, history: ChatMessage[], o: AnswerOptions) => answerQuestion(cast, q, history, o));
  const isLocal = opts.isLocal ?? isLoopback;
  /** May this request change state (start a close)? From this machine always; from elsewhere only with the key. */
  const mayChangeState = (req: IncomingMessage) => isLocal(req.socket.remoteAddress) || (!!apiKey && bearerMatches(req.headers.authorization, apiKey));
  const notFromHere = apiKey ? 'starting a close from another machine needs the gateway API key (Authorization: Bearer)' : 'starting a close is allowed only from this machine; set GATEWAY_API_KEY to allow it from elsewhere';

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = corsHeaders(req, allowed);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors });
      res.end(status === 204 ? undefined : JSON.stringify(body));
    };
    const host = hostName(req);
    if (host !== undefined && hosts[0] !== '*' && !hosts.includes(host)) return json(403, { error: 'host not allowed' });
    const foreignOrigin = Boolean(req.headers.origin) && !cors['access-control-allow-origin'];
    if (req.method === 'OPTIONS') return foreignOrigin ? json(403, { error: 'origin not allowed' }) : json(204, {});
    // Every POST: never from a foreign page, and always JSON, so a cross-site "simple" request (text/plain, no
    // preflight) can neither start a close nor talk to the Advisor.
    if (req.method === 'POST') {
      if (foreignOrigin) return json(403, { error: 'origin not allowed' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(415, { error: 'POST takes content-type: application/json' });
    }
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(200, { providers: providers(), closes: [...closes.values()] });
      }
      if (req.method === 'POST' && url.pathname === '/close') {
        if (!mayChangeState(req)) return json(apiKey ? 401 : 403, { error: notFromHere });
        const body = await readJson(req);
        const periodYm = String(body.periodYm ?? '');
        if (!/^\d{4}-\d{2}$/.test(periodYm)) return json(400, { error: 'periodYm must be YYYY-MM' });
        const { started, state } = startClose(periodYm);
        return json(202, { ...state, started });
      }
      if (url.pathname.startsWith('/v1/') && apiKey && !bearerMatches(req.headers.authorization, apiKey)) {
        return json(401, { error: { message: 'missing or wrong API key', type: 'invalid_request_error' } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return json(200, { object: 'list', data: [{ id: 'cafoo-advisor', object: 'model', owned_by: 'cafoo' }] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(req);
        const messages: ChatMessage[] = (Array.isArray(body.messages) ? body.messages : []).map((m: { role?: unknown; content?: unknown }) => ({ role: String(m?.role ?? ''), content: textOf(m?.content) }));
        const last = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const task = taskReply(last);
        const chunks = (): AsyncGenerator<string> =>
          task !== undefined
            ? (async function* () {
                yield task;
              })()
            : answer(last, messages, { startClose: mayChangeState(req) ? chatStartClose : async () => ({ status: 'failed', error: notFromHere }) });
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors });
          const send = (delta: Record<string, unknown>, finish: string | null = null) =>
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'cafoo-advisor', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
          send({ role: 'assistant' });
          try {
            for await (const chunk of chunks()) send({ content: chunk });
          } catch (e) {
            console.error('chat failed:', e);
            send({ content: `\n\nSorry, I could not answer that: ${(e as Error).message}` });
          }
          send({}, 'stop');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        let text = '';
        for await (const chunk of chunks()) text += chunk;
        return json(200, { id, object: 'chat.completion', created, model: 'cafoo-advisor', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      json(404, { error: 'not found' });
    } catch (e) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      } else if (e instanceof BadRequest) json(400, { error: e.message });
      else if (e instanceof TooLarge) {
        res.setHeader('connection', 'close');
        json(413, { error: e.message });
      }
      else json(500, { error: (e as Error).message });
    }
  });
}

export function startGateway(cast: Cast, liveClose?: CloseRunner) {
  const server = createGateway(cast, { liveClose });
  server.listen(GATEWAY_PORT, () => console.log(`gateway listening on http://localhost:${GATEWAY_PORT} (${agentsLive() ? 'live agents' : 'demo mode'})`));
  return server;
}
