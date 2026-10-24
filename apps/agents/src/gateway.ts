/**
 * HTTP gateway: starts a close, reports provider status, and speaks the OpenAI chat-completions dialect
 * so Open WebUI (or any OpenAI-compatible client) can talk to the Advisor.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GATEWAY_PORT, agentsLive, providers } from './env';
import { runScriptedClose } from './scripted/close';
import type { Cast } from './stdb';
import { answerQuestion } from './advisor-chat';

type CloseState = { periodYm: string; status: 'running' | 'done' | 'error'; startedAt: string; steps: string[]; error?: string };
const closes = new Map<string, CloseState>();

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export function startGateway(cast: Cast, liveClose?: (periodYm: string, onStep: (m: string) => void) => Promise<unknown>) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') return json(res, 204, {});
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, { providers: providers(), closes: [...closes.values()] });
      }
      if (req.method === 'POST' && url.pathname === '/close') {
        const body = await readJson(req);
        const periodYm = String(body.periodYm ?? '');
        if (!/^\d{4}-\d{2}$/.test(periodYm)) return json(res, 400, { error: 'periodYm must be YYYY-MM' });
        const existing = closes.get(periodYm);
        if (existing?.status === 'running') return json(res, 202, existing);
        const state: CloseState = { periodYm, status: 'running', startedAt: new Date().toISOString(), steps: [] };
        closes.set(periodYm, state);
        const onStep = (m: string) => state.steps.push(m);
        const run = agentsLive() && liveClose ? liveClose(periodYm, onStep) : runScriptedClose(cast, periodYm, { onStep });
        run.then(() => (state.status = 'done')).catch(e => {
          state.status = 'error';
          state.error = e?.message ?? String(e);
          console.error('close failed:', e);
        });
        return json(res, 202, state);
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return json(res, 200, { object: 'list', data: [{ id: 'cafoo-advisor', object: 'model', owned_by: 'cafoo' }] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(req);
        const messages: { role: string; content: string }[] = body.messages ?? [];
        const last = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
        const id = `chatcmpl-${Date.now()}`;
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
          const send = (delta: Record<string, unknown>, finish: string | null = null) =>
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'cafoo-advisor', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
          send({ role: 'assistant' });
          for await (const chunk of answerQuestion(cast, last, messages)) send({ content: chunk });
          send({}, 'stop');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        let text = '';
        for await (const chunk of answerQuestion(cast, last, messages)) text += chunk;
        return json(res, 200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'cafoo-advisor', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
      } else json(res, 500, { error: (e as Error).message });
    }
  });
  server.listen(GATEWAY_PORT, () => console.log(`gateway listening on http://localhost:${GATEWAY_PORT} (${agentsLive() ? 'live agents' : 'demo mode'})`));
  return server;
}
