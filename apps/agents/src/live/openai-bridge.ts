/**
 * Anthropic Messages API on 127.0.0.1, backed by the OpenAI Responses API.
 * The Claude Agent SDK keeps requesting opus / sonnet / haiku. This process translates
 * those calls, including tools, and remembers reasoning items so the next tool result can send them back.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentProvider, anthropicLookingEnv, aliasModels } from '../env';

type Json = Record<string, any>;
type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
type Memory = {
  remember(output: unknown[]): void;
  prior(callId: string): { reasoning: Json[]; call: Json } | undefined;
};

const MAX_BODY = 32 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 128_000;

export function createReasoningMemory(): Memory {
  const saved = new Map<string, { reasoning: Json[]; call: Json }>();
  return {
    remember(output) {
      const items = Array.isArray(output) ? (output as Json[]) : [];
      const reasoning = items.filter(i => i?.type === 'reasoning');
      for (const call of items) {
        if (call?.type !== 'function_call' || !call.call_id) continue;
        saved.set(String(call.call_id), { reasoning, call });
      }
    },
    prior: id => saved.get(id),
  };
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter(b => b?.type === 'text' || b?.type === 'output_text')
    .map(b => String(b.text ?? ''))
    .filter(Boolean)
    .join('\n');
};

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : typeof content === 'string' ? [{ type: 'text', text: content }] : []);

/** One Anthropic Messages request as an OpenAI Responses request. `model` is the id OpenAI should run. */
export function toResponsesRequest(body: Json, memory: Memory, model: string, effort: string): Json {
  const seenReasoning = new Set<Json>();
  const input: Json[] = [];
  for (const msg of (Array.isArray(body.messages) ? body.messages : []) as Json[]) {
    const blocks = blocksOf(msg.content);
    const texts = blocks.filter(b => b.type === 'text').map(b => String(b.text ?? ''));
    const calls = blocks.filter(b => b.type === 'tool_use');
    const results = blocks.filter(b => b.type === 'tool_result');
    if (msg.role === 'assistant') {
      if (texts.some(t => t.trim())) input.push({ role: 'assistant', content: texts.join('\n') });
      for (const call of calls) {
        const stored = call.id ? memory.prior(call.id) : undefined;
        if (stored) {
          for (const item of stored.reasoning) {
            if (seenReasoning.has(item)) continue;
            seenReasoning.add(item);
            input.push(item);
          }
          input.push(stored.call);
        } else {
          input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}) });
        }
      }
    } else {
      if (texts.some(t => t.trim())) input.push({ role: 'user', content: texts.join('\n') });
      for (const result of results) {
        input.push({ type: 'function_call_output', call_id: result.tool_use_id, output: textOf(result.content) || (typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '')) });
      }
    }
  }
  const instructions = textOf(body.system);
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t: Json) => t?.name)
    .map((t: Json) => ({ type: 'function', name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } }));
  const max = Number(body.max_tokens);
  const req: Json = {
    model,
    input: input.length ? input : [{ role: 'user', content: '' }],
    reasoning: { effort },
    store: false,
    stream: Boolean(body.stream),
  };
  if (instructions) req.instructions = instructions;
  if (tools.length) req.tools = tools;
  if (Number.isFinite(max) && max > 0) req.max_output_tokens = Math.min(Math.floor(max), MAX_OUTPUT_TOKENS);
  const choice = body.tool_choice;
  if (choice?.type === 'any') req.tool_choice = 'required';
  else if (choice?.type === 'none') req.tool_choice = 'none';
  else if (choice?.type === 'tool' && choice.name) req.tool_choice = { type: 'function', name: choice.name };
  return req;
}

const parseArgs = (raw: unknown): unknown => {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
};

/** An OpenAI Responses body as an Anthropic message. Also stores reasoning items for the next turn. */
export function anthropicMessageFromResponses(model: string, response: Json, memory?: Memory): Json {
  const output = Array.isArray(response.output) ? (response.output as Json[]) : [];
  memory?.remember(output);
  const content: Json[] = [];
  let sawTool = false;
  for (const item of output) {
    if (item?.type === 'message') {
      const text = textOf(item.content);
      if (text) content.push({ type: 'text', text });
    } else if (item?.type === 'function_call') {
      sawTool = true;
      content.push({ type: 'tool_use', id: String(item.call_id ?? item.id ?? ''), name: String(item.name ?? ''), input: parseArgs(item.arguments) });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const usage = response.usage ?? {};
  return {
    id: String(response.id ?? `msg_${Date.now().toString(36)}`),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: sawTool ? 'tool_use' : response.status === 'incomplete' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    },
  };
}

type StreamState = { started: boolean; index: number; open: 'text' | 'tool' | false; sawTool: boolean; emitted: boolean; argsSent: boolean; finished: boolean; model: string; id: string };

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function ensureStart(s: StreamState): string {
  if (s.started) return '';
  s.started = true;
  return sse('message_start', {
    type: 'message_start',
    message: { id: s.id, type: 'message', role: 'assistant', content: [], model: s.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
}

function closeBlock(s: StreamState): string {
  if (!s.open) return '';
  s.open = false;
  const out = sse('content_block_stop', { type: 'content_block_stop', index: s.index });
  s.index += 1;
  return out;
}

function openBlock(s: StreamState, kind: 'text' | 'tool', block: Json): string {
  const closed = closeBlock(s);
  s.open = kind;
  return closed + sse('content_block_start', { type: 'content_block_start', index: s.index, content_block: block });
}

/** One Responses SSE payload as zero or more Anthropic SSE frames. `done` flushes a message that arrived only as a final body. */
export function anthropicFrames(state: StreamState, event: Json): string {
  const type = String(event.type ?? '');
  if (type === 'response.output_text.delta') {
    state.emitted = true;
    const head = ensureStart(state) + (state.open === 'text' ? '' : openBlock(state, 'text', { type: 'text', text: '' }));
    return head + sse('content_block_delta', { type: 'content_block_delta', index: state.index, delta: { type: 'text_delta', text: String(event.delta ?? '') } });
  }
  if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
    state.emitted = true;
    state.sawTool = true;
    state.argsSent = false;
    const item = event.item;
    return ensureStart(state) + openBlock(state, 'tool', { type: 'tool_use', id: String(item.call_id ?? ''), name: String(item.name ?? ''), input: {} });
  }
  if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
    const partial = type.endsWith('delta') ? String(event.delta ?? '') : state.argsSent ? '' : String(event.arguments ?? '');
    if (!partial) return '';
    state.argsSent = true;
    state.emitted = true;
    return ensureStart(state) + sse('content_block_delta', { type: 'content_block_delta', index: state.index, delta: { type: 'input_json_delta', partial_json: partial } });
  }
  if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
    const extra = !state.argsSent && event.item.arguments ? sse('content_block_delta', { type: 'content_block_delta', index: state.index, delta: { type: 'input_json_delta', partial_json: String(event.item.arguments) } }) : '';
    state.argsSent = true;
    return extra + closeBlock(state);
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = event.response ?? {};
    let prelude = '';
    if (!state.emitted) {
      const message = anthropicMessageFromResponses(state.model, response);
      prelude = ensureStart(state);
      for (const block of message.content as Json[]) {
        if (block.type === 'text' && !block.text) continue;
        prelude += openBlock(state, block.type === 'text' ? 'text' : 'tool', block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} });
        if (block.type === 'text') prelude += sse('content_block_delta', { type: 'content_block_delta', index: state.index, delta: { type: 'text_delta', text: block.text } });
        else prelude += sse('content_block_delta', { type: 'content_block_delta', index: state.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
        prelude += closeBlock(state);
        if (block.type === 'tool_use') state.sawTool = true;
      }
    }
    const usage = response.usage ?? {};
    const stop = state.sawTool ? 'tool_use' : response.status === 'incomplete' || type === 'response.incomplete' ? 'max_tokens' : 'end_turn';
    state.finished = true;
    return prelude + closeBlock(state) + ensureStart(state) + sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0 } }) + sse('message_stop', { type: 'message_stop' });
  }
  if (type === 'response.failed' || type === 'error') {
    const message = String(event.response?.error?.message ?? event.error?.message ?? event.message ?? 'OpenAI request failed');
    state.finished = true;
    return ensureStart(state) + sse('error', { type: 'error', error: { type: 'api_error', message } });
  }
  return '';
}

export function newStreamState(model: string): StreamState {
  return { started: false, index: 0, open: false, sawTool: false, emitted: false, argsSent: false, finished: false, model, id: `msg_${Date.now().toString(36)}` };
}

/** Feed a chunk of OpenAI SSE. Returns Anthropic SSE to write, and keeps the unparsed tail. */
export function pushSse(buffer: string, chunk: string, onEvent: (event: Json) => void): string {
  let buf = (buffer + chunk).replace(/\r\n/g, '\n');
  let sep = buf.indexOf('\n\n');
  while (sep >= 0) {
    const block = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    let data = '';
    for (const line of block.split('\n')) if (line.startsWith('data:')) data += line.slice(5).trim();
    if (data && data !== '[DONE]') {
      try {
        onEvent(JSON.parse(data) as Json);
      } catch {
        /* a non-JSON keepalive */
      }
    }
    sep = buf.indexOf('\n\n');
  }
  return buf;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const anthropicError = (status: number, message: string) => ({ status, body: { type: 'error', error: { type: 'api_error', message } } });

export function resolveAlias(model: string, env: NodeJS.ProcessEnv): string {
  const aliases = aliasModels(env);
  if (model === 'opus') return aliases.opus;
  if (model === 'sonnet') return aliases.sonnet;
  if (model === 'haiku') return aliases.haiku;
  return model || aliases.sonnet;
}

export interface BridgeOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  memory?: Memory;
}

/** The bridge HTTP server, not yet listening. Loopback only: it holds the OpenAI key. */
export function createOpenAiBridge(opts: BridgeOptions = {}): Server {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? fetch;
  const memory = opts.memory ?? createReasoningMemory();
  const base = (env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const effort = env.OPENAI_REASONING_EFFORT?.trim() || 'low';

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'POST' || (!url.pathname.endsWith('/v1/messages') && !url.pathname.endsWith('/v1/messages/count_tokens'))) {
        return send(404, anthropicError(404, 'not found').body);
      }
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Json) : {};
      if (url.pathname.endsWith('/count_tokens')) {
        return send(200, { input_tokens: Math.ceil(raw.length / 4) });
      }
      const key = env.OPENAI_API_KEY?.trim();
      if (!key) return send(500, anthropicError(500, 'OPENAI_API_KEY is empty').body);
      const model = resolveAlias(String(body.model ?? ''), env);
      const upstream = toResponsesRequest(body, memory, model, effort);
      const response = await fetchImpl(`${base}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(upstream),
      });
      if (!response.ok) {
        const detail = await response.text();
        return send(response.status, anthropicError(response.status, detail.slice(0, 500) || response.statusText).body);
      }
      if (body.stream && response.body) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const state = newStreamState(model);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let completed: Json | undefined;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending = pushSse(pending, decoder.decode(value, { stream: true }), event => {
            if (event.type === 'response.completed' || event.type === 'response.incomplete') completed = event.response;
            res.write(anthropicFrames(state, event));
          });
        }
        if (completed) memory.remember(Array.isArray(completed.output) ? completed.output : []);
        if (!state.finished) res.write(anthropicFrames(state, { type: 'response.completed', response: completed ?? { output: [] } }));
        return res.end();
      }
      const json = (await response.json()) as Json;
      return send(200, anthropicMessageFromResponses(model, json, memory));
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      send(status, anthropicError(status, (e as Error).message).body);
    }
  });
}

let listening: Promise<string> | undefined;

/** One loopback bridge for this process. Later calls return the same URL. */
export function startOpenAiBridge(opts: BridgeOptions = {}): Promise<string> {
  if (listening) return listening;
  listening = new Promise((resolve, reject) => {
    const server = createOpenAiBridge(opts);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  listening.catch(() => {
    listening = undefined;
  });
  return listening;
}

/** Env for a Claude Agent SDK `query`. OpenAI mode rewrites it so the SDK still looks at an Anthropic endpoint. */
export async function claudeProcessEnv(): Promise<Record<string, string>> {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4',
  };
  const env = agentProvider() === 'openai' ? anthropicLookingEnv(base, await startOpenAiBridge()) : base;
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function _resetBridgeForTests() {
  listening = undefined;
}
