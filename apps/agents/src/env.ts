/** Provider detection. Every external dependency has a demo mode that needs no key. */
export type ProviderStatus = { name: string; mode: 'live' | 'demo'; detail: string };

/**
 * Which vendor the Claude Agent SDK calls. The SDK always speaks the Anthropic Messages API.
 * `openai` points that API at a local bridge which forwards to OpenAI. `anthropic` calls Anthropic.
 * Unset: OpenAI when only OPENAI_API_KEY is set, otherwise Anthropic (live only if its key is set).
 */
export type AgentProvider = 'openai' | 'anthropic';

/** Model ids the SDK's opus / sonnet / haiku aliases resolve to when AGENT_PROVIDER=openai. */
export const DEFAULT_OPENAI_MODELS = { opus: 'gpt-6.1-sol', sonnet: 'gpt-6-luna', haiku: 'gpt-6-luna' } as const;

const has = (env: NodeJS.ProcessEnv, k: string) => Boolean(env[k] && env[k]!.trim());
const forcedDemo = (env: NodeJS.ProcessEnv) => env.DEMO_MODE === '1';

export function agentProvider(env: NodeJS.ProcessEnv = process.env): AgentProvider {
  const set = env.AGENT_PROVIDER?.trim().toLowerCase();
  if (set === 'openai' || set === 'anthropic') return set;
  if (has(env, 'OPENAI_API_KEY') && !has(env, 'ANTHROPIC_API_KEY')) return 'openai';
  return 'anthropic';
}

/** OpenAI model ids standing in for the Anthropic aliases. A set env var wins; otherwise the default. */
export function aliasModels(env: NodeJS.ProcessEnv = process.env): { opus: string; sonnet: string; haiku: string } {
  const pick = (key: string, fallback: string) => env[key]?.trim() || fallback;
  return {
    opus: pick('ANTHROPIC_DEFAULT_OPUS_MODEL', DEFAULT_OPENAI_MODELS.opus),
    sonnet: pick('ANTHROPIC_DEFAULT_SONNET_MODEL', DEFAULT_OPENAI_MODELS.sonnet),
    haiku: pick('ANTHROPIC_DEFAULT_HAIKU_MODEL', DEFAULT_OPENAI_MODELS.haiku),
  };
}

/**
 * Environment for the Claude Agent SDK subprocess when the vendor is OpenAI.
 * The SDK still sees an Anthropic base URL, an API key, and opus/sonnet/haiku alias targets.
 * The key is a local sentinel: the bridge ignores it and uses OPENAI_API_KEY upstream.
 */
export function anthropicLookingEnv(base: NodeJS.ProcessEnv, shimUrl: string): NodeJS.ProcessEnv {
  const aliases = aliasModels(base);
  const next: NodeJS.ProcessEnv = {
    ...base,
    ANTHROPIC_BASE_URL: shimUrl,
    ANTHROPIC_API_KEY: 'cafoo-local',
    ANTHROPIC_DEFAULT_OPUS_MODEL: aliases.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: aliases.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: aliases.haiku,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_THINKING: '1',
    MAX_THINKING_TOKENS: '0',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  delete next.ANTHROPIC_AUTH_TOKEN;
  // The bridge reads these from this process. The SDK subprocess only needs the Anthropic-shaped vars.
  delete next.OPENAI_API_KEY;
  delete next.OPENAI_BASE_URL;
  delete next.OPENAI_REASONING_EFFORT;
  return next;
}

/** Gemini, the Red Team's second critic. GEMINI_API_KEY, or the Google provider's own GOOGLE_GENERATIVE_AI_API_KEY. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const geminiKey = (env: NodeJS.ProcessEnv = process.env) => (env.GEMINI_API_KEY?.trim() || env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || undefined);
export const geminiModel = (env: NodeJS.ProcessEnv = process.env) => env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

export function providers(env: NodeJS.ProcessEnv = process.env): ProviderStatus[] {
  const demo = forcedDemo(env);
  const provider = agentProvider(env);
  const agentsOn = !demo && (provider === 'openai' ? has(env, 'OPENAI_API_KEY') : has(env, 'ANTHROPIC_API_KEY'));
  const aliases = aliasModels(env);
  const agentDetail = agentsOn
    ? provider === 'openai'
      ? `OpenAI ${aliases.opus} (Advisor) and ${aliases.sonnet} (workers) via the Anthropic Messages API`
      : 'live agents'
    : 'scripted close over the real accounting engines';
  return [
    { name: 'Claude Agent SDK (Advisor, Bookkeeper, Revenue, Credit & Risk)', mode: agentsOn ? 'live' : 'demo', detail: agentDetail },
    { name: 'xAI Grok (Red Team)', mode: !demo && has(env, 'XAI_API_KEY') ? 'live' : 'demo', detail: !demo && has(env, 'XAI_API_KEY') ? 'grok-4.7 critiques' : 'scripted critiques' },
    { name: 'Google Gemini (Red Team, second critic)', mode: !demo && geminiKey(env) ? 'live' : 'demo', detail: !demo && geminiKey(env) ? `${geminiModel(env)} critiques` : 'scripted critiques' },
    { name: 'CRS Credit API', mode: !demo && has(env, 'CRS_USERNAME') && env.CRS_REPLAY !== '1' ? 'live' : 'demo', detail: 'sandbox persona fixtures' },
    { name: 'Bright Data', mode: !demo && (has(env, 'API_TOKEN') || has(env, 'BRIGHTDATA_API_TOKEN') || has(env, 'BRIGHTDATA_API_KEY')) ? 'live' : 'demo', detail: !demo && (has(env, 'API_TOKEN') || has(env, 'BRIGHTDATA_API_TOKEN') || has(env, 'BRIGHTDATA_API_KEY')) ? 'Web Unlocker lookups' : 'recorded vendor lookups' },
    { name: 'Apify', mode: !demo && has(env, 'APIFY_TOKEN') ? 'live' : 'demo', detail: 'crawl skipped' },
    { name: 'Moss', mode: !demo && has(env, 'MOSS_PROJECT_ID') ? 'live' : 'demo', detail: 'local keyword search' },
    { name: 'SpacetimeDB', mode: 'live', detail: env.SPACETIMEDB_URI ?? 'ws://localhost:3000' },
  ];
}

export const agentsLive = () => providers()[0].mode === 'live';
export const redTeamLive = () => providers()[1].mode === 'live';
export const geminiLive = () => providers()[2].mode === 'live';
export const STDB_URI = process.env.SPACETIMEDB_URI?.replace(/^http/, 'ws') ?? 'ws://localhost:3000';
export const STDB_DB = process.env.SPACETIMEDB_DB_NAME ?? 'cafoo';
export const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 8787);
/**
 * Gateway address and guards:
 * - GATEWAY_HOST: the address the gateway listens on. Default 127.0.0.1, this machine only. Set "0.0.0.0" (every
 *   interface) only when something outside this machine's loopback must reach it, such as Open WebUI in Docker on
 *   Linux, and set GATEWAY_API_KEY with it: without a key the gateway refuses /v1/* to any other address.
 * - GATEWAY_ALLOWED_ORIGINS: comma-separated browser origins that get CORS and may POST /close. Default: the web
 *   app's dev and preview origins, http://localhost:5173, http://127.0.0.1:5173, http://localhost:4173,
 *   http://127.0.0.1:4173. Server-to-server callers (Open WebUI's backend, curl) send no Origin and are not affected.
 * - GATEWAY_API_KEY: when set, /v1/* (the OpenAI-compatible endpoint) requires `Authorization: Bearer <key>` from
 *   every caller; give Open WebUI the same value as OPENAI_API_KEY. Unset: /v1/* answers only this machine (a loopback
 *   TCP address), because the Advisor reads the books and, in live mode, spends API budget. Starting a close (POST
 *   /close, or "start the close" in chat) likewise needs no key only from this machine (as the web app's browser and
 *   curl on the host connect); from any other address it needs the bearer key, and is refused when no key is set. A
 *   forged Host header does not help: the check is on the connection's address. Docker Open WebUI connects from the
 *   bridge network, so it needs the key both to chat and to start a close.
 * - GATEWAY_ALLOWED_HOSTS: comma-separated extra Host names the gateway answers to (against DNS rebinding). Always
 *   allowed: localhost, 127.0.0.1, ::1, host.docker.internal, and the host of every allowed origin. "*" turns the
 *   check off (for example to reach the gateway by a LAN address).
 */
/** The address the gateway listens on: GATEWAY_HOST, else 127.0.0.1. */
export function gatewayHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.GATEWAY_HOST?.trim() || '127.0.0.1';
}
export const DEFAULT_GATEWAY_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];
export function gatewayAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.GATEWAY_ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return list.length ? list : DEFAULT_GATEWAY_ORIGINS;
}
export const DEFAULT_GATEWAY_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'];
/** Host names (no port, lower case) the gateway answers to; ['*'] when the check is off. */
export function gatewayAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.GATEWAY_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (extra.includes('*')) return ['*'];
  const fromOrigins = gatewayAllowedOrigins(env).flatMap(o => {
    try {
      return [new URL(o).hostname.toLowerCase()];
    } catch {
      return [];
    }
  });
  return [...new Set([...DEFAULT_GATEWAY_HOSTS, ...fromOrigins, ...extra])];
}
/** Milliseconds between scripted steps; 0 for tests. */
export const STEP_MS = Number(process.env.DEMO_STEP_MS ?? 1400);
/** Milliseconds between live-feed events once the CFO switches the feed on ("0" sends a month's events back to back; empty means the default). */
export const FEED_INTERVAL_MS = Number(process.env.FEED_INTERVAL_MS?.trim() || 8000);
/** Quiet time after the last bank line lands before the continuous Bookkeeper acts on the batch. */
export const FEED_DEBOUNCE_MS = Number(process.env.FEED_DEBOUNCE_MS?.trim() || 2000);
