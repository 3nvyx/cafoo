/**
 * What external providers actually did in this process, as opposed to what env.ts says is configured.
 *
 * Every live call site records its outcome here: `ok` when the provider answered, `fallback` when the caller used its
 * demo stand-in instead (outage, timeout, bad key). The gateway's /status merges this into each provider row, so a
 * provider reads "verified" only after a real answer, and a fallback is never hidden behind a "live" label.
 */
import type { ProviderStatus } from './env';

export type ProviderId = 'agents' | 'grok' | 'gemini' | 'crs' | 'brightdata' | 'nessie' | 'apify' | 'moss' | 'spacetimedb';

export type ProviderEvidence = {
  okCount: number;
  fallbackCount: number;
  lastOkAt?: string;
  lastFallbackAt?: string;
  lastFallbackReason?: string;
};

/** demo: no live configuration. configured: live keys, no call yet. verified: the last call answered. fell_back: the last call used the stand-in. */
export type ProviderState = 'demo' | 'configured' | 'verified' | 'fell_back';

const log = new Map<ProviderId, ProviderEvidence>();
const entry = (id: ProviderId) => {
  let e = log.get(id);
  if (!e) log.set(id, (e = { okCount: 0, fallbackCount: 0 }));
  return e;
};

export function recordOk(id: ProviderId, at = new Date()): void {
  const e = entry(id);
  e.okCount++;
  e.lastOkAt = at.toISOString();
}

export function recordFallback(id: ProviderId, reason: unknown, at = new Date()): void {
  const e = entry(id);
  e.fallbackCount++;
  e.lastFallbackAt = at.toISOString();
  // Messages from provider SDKs can echo request URLs; keep the first line and never a query string (Nessie's key rides in one).
  const text = reason instanceof Error ? reason.message : String(reason);
  e.lastFallbackReason = text.split('\n')[0]!.replace(/\?\S*/g, '?…').slice(0, 200);
}

/** Await a live call, recording its outcome; rethrows so the caller's own fallback still runs. */
export async function tracked<T>(id: ProviderId, call: () => Promise<T>): Promise<T> {
  try {
    const v = await call();
    recordOk(id);
    return v;
  } catch (e) {
    recordFallback(id, e);
    throw e;
  }
}

export function evidence(id: ProviderId): ProviderEvidence {
  return { ...entry(id) };
}

export function stateOf(mode: ProviderStatus['mode'], e: ProviderEvidence): ProviderState {
  if (mode === 'demo') return 'demo';
  if (!e.lastOkAt && !e.lastFallbackAt) return 'configured';
  if (!e.lastFallbackAt) return 'verified';
  if (!e.lastOkAt) return 'fell_back';
  return e.lastOkAt >= e.lastFallbackAt ? 'verified' : 'fell_back';
}

/** Provider rows with this process's evidence: `state`, the counts, and a detail line that says what happened. */
export function withEvidence(rows: ProviderStatus[]): (ProviderStatus & { state: ProviderState; evidence: ProviderEvidence })[] {
  return rows.map(r => {
    const e = evidence(r.id);
    const state = stateOf(r.mode, e);
    const suffix =
      state === 'verified' ? `; verified ${e.okCount} call(s), last at ${e.lastOkAt}`
      : state === 'fell_back' ? `; fell back at ${e.lastFallbackAt}: ${e.lastFallbackReason}`
      : '';
    return { ...r, state, evidence: e, detail: r.detail + suffix };
  });
}

/** Tests only. */
export function resetProviderCalls(): void {
  log.clear();
}
