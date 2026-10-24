import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { agentProvider, aliasModels, anthropicLookingEnv, providers } from '../src/env';
import { anthropicFrames, anthropicMessageFromResponses, createOpenAiBridge, createReasoningMemory, newStreamState, toResponsesRequest } from '../src/live/openai-bridge';

let server: Server | undefined;
afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

const listen = (opts: Parameters<typeof createOpenAiBridge>[0]) =>
  new Promise<string>(resolve => {
    server = createOpenAiBridge(opts);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });

describe('agent provider mode', () => {
  it('uses OpenAI when the mode says so, and stays on scripted close without a key or in demo mode', () => {
    expect(agentProvider({ AGENT_PROVIDER: 'openai' })).toBe('openai');
    expect(agentProvider({ OPENAI_API_KEY: 'sk-live' })).toBe('openai');
    expect(agentProvider({ ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-live' })).toBe('anthropic');
    expect(agentProvider({})).toBe('anthropic');

    const live = providers({ AGENT_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-live' })[0]!;
    expect(live.mode).toBe('live');
    expect(live.detail).toContain('OpenAI gpt-6.1-sol');
    expect(live.detail).toContain('Anthropic Messages API');
    expect(providers({ AGENT_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-live', DEMO_MODE: '1' })[0]!.mode).toBe('demo');
    expect(providers({ AGENT_PROVIDER: 'openai' })[0]!.mode).toBe('demo');
    expect(providers({ ANTHROPIC_API_KEY: 'sk-ant' })[0]).toMatchObject({ mode: 'live', detail: 'live agents' });
    expect(providers({})[0]!.mode).toBe('demo');
  });

  it('keeps opus, sonnet, and haiku as the names the SDK sees, pointed at OpenAI models', () => {
    expect(aliasModels({})).toEqual({ opus: 'gpt-6.1-sol', sonnet: 'gpt-6-luna', haiku: 'gpt-6-luna' });
    const env = anthropicLookingEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-live', OPENAI_BASE_URL: 'https://example.test/v1', ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_AUTH_TOKEN: 'bearer', ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-6-astra' }, 'http://127.0.0.1:9');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9');
    expect(env.ANTHROPIC_API_KEY).toBe('cafoo-local');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-6-astra');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-6-luna');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-6-luna');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.CLAUDE_CODE_DISABLE_THINKING).toBe('1');
  });
});

describe('Anthropic messages to OpenAI responses', () => {
  it('sends the alias the SDK asked for as the OpenAI model, with tools and the system prompt', () => {
    const memory = createReasoningMemory();
    const req = toResponsesRequest(
      {
        model: 'opus',
        max_tokens: 1000,
        system: [{ type: 'text', text: 'You are the Advisor.' }],
        messages: [{ role: 'user', content: 'List the proposals.' }],
        tools: [{ name: 'list_proposals', description: 'List open proposals', input_schema: { type: 'object', properties: {} } }],
      },
      memory,
      'gpt-6.1-sol',
      'low'
    );
    expect(req.model).toBe('gpt-6.1-sol');
    expect(req.instructions).toBe('You are the Advisor.');
    expect(req.tools[0]).toMatchObject({ type: 'function', name: 'list_proposals' });
    expect(req.input).toEqual([{ role: 'user', content: 'List the proposals.' }]);
    expect(req.reasoning).toEqual({ effort: 'low' });
    expect(req.store).toBe(false);
  });

  it('turns a tool result back into a function call and replays the reasoning item OpenAI requires', () => {
    const memory = createReasoningMemory();
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list_proposals', arguments: '{}' };
    memory.remember([reasoning, call]);
    const req = toResponsesRequest(
      {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'list_proposals', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'none open' }] },
        ],
      },
      memory,
      'gpt-6-luna',
      'low'
    );
    expect(req.input).toEqual([reasoning, call, { type: 'function_call_output', call_id: 'call_1', output: 'none open' }]);
  });

  it('reads a Responses body as an Anthropic message with a tool call', () => {
    const message = anthropicMessageFromResponses('gpt-6.1-sol', {
      id: 'resp_1',
      output: [
        { type: 'reasoning', id: 'rs_1' },
        { type: 'function_call', call_id: 'call_9', name: 'list_proposals', arguments: '{"period":"2026-09"}' },
      ],
      usage: { input_tokens: 4, output_tokens: 6 },
    });
    expect(message.role).toBe('assistant');
    expect(message.stop_reason).toBe('tool_use');
    expect(message.content).toEqual([{ type: 'tool_use', id: 'call_9', name: 'list_proposals', input: { period: '2026-09' } }]);
    expect(message.usage).toEqual({ input_tokens: 4, output_tokens: 6 });
  });

  it('streams text deltas as Anthropic content blocks and stops on end_turn', () => {
    const state = newStreamState('gpt-6-luna');
    const frames = [
      anthropicFrames(state, { type: 'response.output_text.delta', delta: 'Hello' }),
      anthropicFrames(state, { type: 'response.completed', response: { usage: { output_tokens: 1 }, output: [] } }),
    ].join('');
    expect(frames).toContain('"text_delta"');
    expect(frames).toContain('Hello');
    expect(frames).toContain('"stop_reason":"end_turn"');
    expect(frames).toContain('message_stop');
  });
});

describe('bridge HTTP', () => {
  it('answers POST /v1/messages in the Anthropic shape and calls the OpenAI Responses API', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body));
      expect(sent.model).toBe('gpt-6.1-sol');
      expect(sent.instructions).toBe('Advisor');
      return new Response(JSON.stringify({ id: 'resp_2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Two proposals are open.' }] }], usage: { input_tokens: 3, output_tokens: 5 } }), { status: 200 });
    });
    const base = await listen({ env: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://example.test/v1' }, fetch: fetchImpl as unknown as typeof fetch });
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'cafoo-local' },
      body: JSON.stringify({ model: 'opus', max_tokens: 20, system: 'Advisor', messages: [{ role: 'user', content: 'Status?' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('message');
    expect(body.model).toBe('gpt-6.1-sol');
    expect(body.content).toEqual([{ type: 'text', text: 'Two proposals are open.' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/v1/responses', expect.objectContaining({ method: 'POST' }));
  });

  it('estimates /v1/messages/count_tokens without calling OpenAI', async () => {
    const fetchImpl = vi.fn();
    const base = await listen({ env: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl as unknown as typeof fetch });
    const res = await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect((await res.json()).input_tokens).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
