import { describe, expect, it } from 'vitest';
import { providers } from '../src/env';

describe('provider status', () => {
  it('reports Apify as configured, not proven, from its token, and as demo snapshots without one', () => {
    expect(providers({ APIFY_TOKEN: 'configured' }).find(p => p.id === 'apify')).toMatchObject({ mode: 'live', detail: expect.stringContaining('status does not verify a crawl') });
    expect(providers({ APIFY_TOKEN: 'configured', DEMO_MODE: '1' }).find(p => p.id === 'apify')).toMatchObject({ mode: 'demo', detail: 'demo website snapshots' });
  });

  it('requires both Moss credentials and describes configuration separately from proof', () => {
    expect(providers({ MOSS_PROJECT_ID: 'project' }).find(p => p.name === 'Moss')?.mode).toBe('demo');
    expect(providers({ MOSS_PROJECT_ID: 'project', MOSS_PROJECT_KEY: 'configured' }).find(p => p.name === 'Moss')).toMatchObject({
      mode: 'live',
      detail: expect.stringContaining('configured'),
    });
  });

  it('reports Nessie as configured only when a key and account mapping are present', () => {
    expect(providers({ NESSIE_API_KEY: 'configured' }).find(p => p.name === 'Capital One Nessie')?.mode).toBe('demo');
    expect(providers({ NESSIE_API_KEY: 'configured', NESSIE_ACCOUNT_IDS: 'US:account-1' }).find(p => p.name === 'Capital One Nessie')).toMatchObject({
      mode: 'live',
      detail: expect.stringContaining('configured'),
    });
  });
});
