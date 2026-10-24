/** Provider detection. Every external dependency has a demo mode that needs no key. */
export type ProviderStatus = { name: string; mode: 'live' | 'demo'; detail: string };

const has = (k: string) => Boolean(process.env[k] && process.env[k]!.trim());
const forcedDemo = () => process.env.DEMO_MODE === '1';

export function providers(): ProviderStatus[] {
  const demo = forcedDemo();
  return [
    { name: 'Claude Agent SDK (Advisor, Bookkeeper, Revenue, Credit & Risk)', mode: !demo && has('ANTHROPIC_API_KEY') ? 'live' : 'demo', detail: !demo && has('ANTHROPIC_API_KEY') ? 'live agents' : 'scripted close over the real accounting engines' },
    { name: 'xAI Grok (Red Team)', mode: !demo && has('XAI_API_KEY') ? 'live' : 'demo', detail: !demo && has('XAI_API_KEY') ? 'grok-4.7 critiques' : 'scripted critiques' },
    { name: 'CRS Credit API', mode: !demo && has('CRS_USERNAME') && process.env.CRS_REPLAY !== '1' ? 'live' : 'demo', detail: 'sandbox persona fixtures' },
    { name: 'Bright Data', mode: !demo && has('API_TOKEN') ? 'live' : 'demo', detail: 'recorded vendor lookups' },
    { name: 'Apify', mode: !demo && has('APIFY_TOKEN') ? 'live' : 'demo', detail: 'crawl skipped' },
    { name: 'Moss', mode: !demo && has('MOSS_PROJECT_ID') ? 'live' : 'demo', detail: 'local keyword search' },
    { name: 'SpacetimeDB', mode: 'live', detail: process.env.SPACETIMEDB_URI ?? 'ws://localhost:3000' },
  ];
}

export const agentsLive = () => providers()[0].mode === 'live';
export const redTeamLive = () => providers()[1].mode === 'live';
export const STDB_URI = process.env.SPACETIMEDB_URI?.replace(/^http/, 'ws') ?? 'ws://localhost:3000';
export const STDB_DB = process.env.SPACETIMEDB_DB_NAME ?? 'cafoo';
export const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 8787);
/** Milliseconds between scripted steps; 0 for tests. */
export const STEP_MS = Number(process.env.DEMO_STEP_MS ?? 1400);
