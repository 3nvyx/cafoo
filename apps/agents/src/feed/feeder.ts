/**
 * The live feed, run by the gateway: once the CFO switches it on, bank lines and invoices for the first open month
 * after a locked month (October once September is locked) arrive one by one, as a bank and a billing system would send
 * them. Without Nessie configuration, events come from the deterministic plan in @cafoo/seed/feed. With Nessie,
 * bank lines come from its account transaction IDs while invoices remain on the separate deterministic billing plan.
 * Every event enters the books only through the module's
 * two ingest reducers under the `feed` identity, which may never propose or commit. The continuous Bookkeeper
 * (src/continuous/bookkeeper.ts) reacts to what lands.
 *
 * The feed stops for a month once that month's close has started; the module refuses ingest when the feed is off, the
 * month is not open, or the month before it is not locked.
 */
import { feedPlan, type FeedContext, type FeedEvent } from '@cafoo/seed/feed';
import { closeOpened, lockedByCfo, previousYm } from '../close-state';
import { json, type Route } from '../http';
import { rootSubsidiary } from '../snapshot';
import type { Cast, RoleConn } from '../stdb';
import { tracked } from '../provider-calls';
import { fetchNessieBankEvents, nessieConfig, type NessieConfig } from '../nessie';

export interface FeedStatus {
  enabled: boolean;
  source?: 'simulated' | 'nessie';
  /** The month the feed fills, when there is one. */
  ym?: string;
  planned: number;
  ingested: number;
  /** ISO time of the month's latest ingested event. */
  lastEventAt?: string;
  /** Why nothing is arriving right now, in plain words; absent while the feed runs or once the month is complete. */
  blockedReason?: string;
}

const lower = (tag: string) => tag.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const monthName = (ym: string) => ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(ym.slice(5, 7)) - 1] ?? ym;

export const feedEnabled = (c: RoleConn) => c.db.settings.key.find('feed_enabled')?.valueI64 === 1n;

/**
 * The first open month whose previous month the CFO locked, or undefined. The seed locks the history months itself, so a
 * fresh database has no such month until the CFO locks the close month (October once September is locked).
 */
export function feedCandidateYm(c: RoleConn): string | undefined {
  return [...c.db.period.iter()]
    .filter(p => p.status.tag === 'Open' && lockedByCfo(c, previousYm(p.ym)))
    .sort((a, b) => a.ym.localeCompare(b.ym))[0]?.ym;
}

/** The month the feed fills: the candidate month, unless its own close has been opened. */
export function feedTargetYm(c: RoleConn): string | undefined {
  const ym = feedCandidateYm(c);
  return ym && !closeOpened(c, ym) ? ym : undefined;
}

/** The root company's books as the feed plan reads them. */
export function feedContext(c: RoleConn, ym: string): FeedContext {
  const db = c.db;
  const sub = rootSubsidiary(c);
  const customers = [...db.customer.iter()].filter(x => x.subsidiaryId === sub.id);
  const customerIds = new Set(customers.map(x => x.id));
  const vendors = [...db.vendor.iter()].filter(x => x.subsidiaryId === sub.id);
  const vendorIds = new Set(vendors.map(x => x.id));
  const contracts = [...db.contract.iter()].filter(k => customerIds.has(k.customerId));
  const codeOf = new Map(contracts.map(k => [k.id, k.code]));
  const items = [...db.contractItem.iter()];
  return {
    ym,
    subsidiaryCode: sub.code,
    ccy: sub.functionalCcy,
    customers: customers.map(x => ({ id: x.id, name: x.name })),
    vendors: vendors.map(v => ({ id: v.id, name: v.name, verification: lower(v.verification.tag) })),
    contracts: contracts.map(k => ({ code: k.code, customerId: k.customerId, plan: lower(k.plan.tag), unitPriceMinor: items.find(i => i.contractId === k.id && i.kind.tag === 'Usage')?.priceMinor ?? 0n })),
    invoices: [...db.invoice.iter()]
      .filter(i => customerIds.has(i.customerId))
      .map(i => ({ number: i.number, customerId: i.customerId, contractCode: i.contractId === undefined ? undefined : codeOf.get(i.contractId), ym: i.ym, amountMinor: i.amountMinor, dueAtMicros: i.dueAt.microsSinceUnixEpoch, status: lower(i.status.tag) })),
    bills: [...db.bill.iter()].filter(b => vendorIds.has(b.vendorId)).map(b => ({ externalRef: b.externalRef, vendorId: b.vendorId, ym: b.ym, amountMinor: b.amountMinor, dueAtMicros: b.dueAt.microsSinceUnixEpoch, status: lower(b.status.tag) })),
    bankTransactions: [...db.bankTransaction.iter()].filter(t => t.subsidiaryId === sub.id).map(t => ({ description: t.description, amountMinor: t.amountMinor })),
    materialityMinor: db.settings.key.find('materiality_threshold_minor')?.valueI64 ?? 1_000_000n,
  };
}

export interface FeederOptions {
  /** Milliseconds between events (FEED_INTERVAL_MS); 0 sends the month's events back to back. */
  intervalMs: number;
  /** How often to look again while the feed is off or has nothing to send. Default max(intervalMs, 1000). */
  idleMs?: number;
  /** Start the timer (default true); false leaves stepping to tick(), for tests and the smoke test. */
  autoStart?: boolean;
  onStep?: (m: string) => void;
  /** Plan seed (default the plan's own). */
  seed?: number;
  /** Explicit source for tests; undefined reads local configuration. Null forces the simulated bank source. */
  nessie?: NessieConfig | null;
  fetcher?: typeof fetch;
  /** Nessie only: once every fetched line is sent, fetch the month again after this long (NESSIE_REFRESH_MS, default 5 minutes). */
  nessieRefreshMs?: number;
}

export interface Feeder {
  status(): FeedStatus;
  /** Send the next event if the feed may run; true when one was sent. */
  tick(): Promise<boolean>;
  /** Send every remaining event of the month now; returns how many were sent. */
  drain(): Promise<number>;
  /** The month's plan (built once per month). */
  plan(): FeedEvent[];
  stop(): void;
}

export function startFeeder(cast: Cast, opts: FeederOptions): Feeder {
  const A = cast.advisor;
  const nessie = opts.nessie === undefined ? nessieConfig(process.env) : opts.nessie;
  const log = (m: string) => {
    opts.onStep?.(m);
    console.log(`[feed] ${m}`);
  };
  const idleMs = opts.idleMs ?? Math.max(opts.intervalMs, 1000);
  const plans = new Map<string, FeedEvent[]>();
  /** When each Nessie month was last fetched: transactions that complete later need a fresh fetch. */
  const fetchedAt = new Map<string, number>();
  const refreshMs = opts.nessieRefreshMs ?? Number(process.env.NESSIE_REFRESH_MS?.trim() || 5 * 60_000);
  const loading = new Map<string, Promise<FeedEvent[]>>();
  /** Events the module accepted in this process (an invoice whose number already exists leaves no feed_event row). */
  const sent = new Set<string>();
  let lastError: string | undefined;
  let nessieAuthFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let busy = false;

  const ingestedIds = () => new Set([...A.db.feedEvent.iter()].map(e => e.externalId));
  const assertSourceConsistent = (ym: string) => {
    const priorBank = [...A.db.feedEvent.iter()].filter(e => e.ym === ym && e.kind.tag === 'BankTx');
    const wrong = priorBank.find(e => e.externalId.startsWith('nessie:') !== !!nessie);
    if (wrong) throw new Error(`${ym} already has bank lines from a different feed source. Finish this month without switching sources.`);
  };
  const planFor = (ym: string) => {
    let p = plans.get(ym);
    if (!p) {
      assertSourceConsistent(ym);
      p = feedPlan(feedContext(A, ym), opts.seed === undefined ? {} : { seed: opts.seed });
      plans.set(ym, p);
      log(`planned ${p.length} event(s) for ${ym}`);
    }
    return p;
  };
  /** The month's plan; `refresh` fetches Nessie again and swaps the plan in only once the fetch succeeds. */
  const ensurePlanFor = (ym: string, refresh = false): Promise<FeedEvent[]> => {
    if (!nessie) return Promise.resolve(planFor(ym));
    const existing = plans.get(ym);
    if (existing && !refresh) return Promise.resolve(existing);
    const pending = loading.get(ym);
    if (pending) return pending;
    const next = (async () => {
      assertSourceConsistent(ym);
      const simulatedInvoices = feedPlan(feedContext(A, ym), opts.seed === undefined ? {} : { seed: opts.seed }).filter(e => e.kind === 'invoice');
      const bank = await tracked('nessie', () => fetchNessieBankEvents(nessie, {
        ym,
        subsidiaries: [...A.db.subsidiary.iter()].filter(sub => !sub.isElimination).map(sub => ({ code: sub.code, functionalCcy: sub.functionalCcy })),
        materialityMinor: A.db.settings.key.find('materiality_threshold_minor')?.valueI64 ?? 1_000_000n,
      }, opts.fetcher));
      const p: FeedEvent[] = [...simulatedInvoices, ...bank].sort((a, b) => a.atMicros < b.atMicros ? -1 : a.atMicros > b.atMicros ? 1 : a.externalId.localeCompare(b.externalId));
      plans.set(ym, p);
      fetchedAt.set(ym, Date.now());
      log(`planned ${bank.length} Nessie bank line(s) and ${simulatedInvoices.length} simulated billing event(s) for ${ym}`);
      return p;
    })();
    loading.set(ym, next);
    void next.finally(() => loading.delete(ym)).catch(() => undefined);
    return next;
  };
  /** Why the feed cannot send right now, or the month and its next event. */
  const state = (): { blocked: string; ym?: string } | { ym: string; next?: FeedEvent; events: FeedEvent[] } => {
    if (!feedEnabled(A)) return { blocked: 'The live feed is switched off; the CFO can switch it on.', ym: feedCandidateYm(A) };
    const ym = feedCandidateYm(A);
    if (!ym) return { blocked: 'No open month follows a month the CFO locked yet; the feed starts once the CFO locks the close month.' };
    if (closeOpened(A, ym)) return { blocked: `The ${monthName(ym)} close has started, so the feed waits for the next month.`, ym };
    const events = nessie ? (plans.get(ym) ?? []) : planFor(ym);
    const done = ingestedIds();
    return { ym, events, next: events.find(e => !done.has(e.externalId) && !sent.has(e.externalId)) };
  };

  const tick = async (): Promise<boolean> => {
    if (busy || nessieAuthFailed) return false;
    busy = true;
    try {
      let st: ReturnType<typeof state>;
      try {
        st = state();
      } catch (err) {
        lastError = `The feed cannot plan this month: ${(err as Error).message}`;
        log(lastError);
        return false;
      }
      if ('blocked' in st) return false;
      try {
        await ensurePlanFor(st.ym);
        assertSourceConsistent(st.ym);
      } catch (err) {
        lastError = `Nessie feed could not load ${st.ym}: ${(err as Error).message}`;
        if (/HTTP (401|403)\b/.test(lastError)) nessieAuthFailed = true;
        log(lastError);
        return false;
      }
      let ready = state();
      if ('blocked' in ready) return false;
      if (!ready.next && nessie && Date.now() - (fetchedAt.get(ready.ym) ?? 0) >= refreshMs) {
        // Everything fetched is in the books, and Nessie may post more this month: fetch again. The old plan stays
        // until the new one arrives, and a failed refresh waits a full interval before the next try (no hammering on a
        // rate limit); lines already ingested are skipped by their external IDs.
        fetchedAt.set(ready.ym, Date.now());
        try {
          await ensurePlanFor(ready.ym, true);
        } catch (err) {
          lastError = `Nessie feed could not refresh ${ready.ym}: ${(err as Error).message}`;
          if (/HTTP (401|403)\b/.test(lastError)) nessieAuthFailed = true;
          log(lastError);
          return false;
        }
        ready = state();
        if ('blocked' in ready) return false;
      }
      if (!ready.next) return false;
      const e = ready.next;
      try {
        if (e.kind === 'bank_tx') await cast.feed.reducers.ingestBankTransactions({ subsidiaryCode: e.subsidiaryCode, txs: [e.tx] });
        else await cast.feed.reducers.ingestInvoices({ invoices: [e.invoice] });
        sent.add(e.externalId);
        lastError = undefined;
        log(`${e.externalId}: ${e.notePlain}`);
        return true;
      } catch (err) {
        lastError = `The books refused ${e.externalId}: ${(err as Error).message}`;
        log(lastError);
        return false;
      }
    } finally {
      busy = false;
    }
  };

  const loop = async () => {
    if (stopped) return;
    const sentOne = await tick().catch(e => {
      log(`feed tick failed: ${(e as Error).message}`);
      return false;
    });
    if (!stopped) timer = setTimeout(() => void loop(), sentOne ? opts.intervalMs : idleMs);
  };
  if (opts.autoStart ?? true) timer = setTimeout(() => void loop(), 0);

  return {
    status(): FeedStatus {
      const enabled = feedEnabled(A);
      let st: ReturnType<typeof state>;
      try {
        st = state();
      } catch (e) {
        return { enabled, source: nessie ? 'nessie' : 'simulated', planned: 0, ingested: 0, blockedReason: `The feed cannot plan this month: ${(e as Error).message}` };
      }
      const ym = st.ym;
      const events = ym ? (plans.get(ym) ?? ('events' in st ? st.events : [])) : [];
      const done = ingestedIds();
      const rows = ym ? [...A.db.feedEvent.iter()].filter(r => r.ym === ym) : [];
      const last = rows.reduce<bigint | undefined>((m, r) => (m === undefined || r.ingestedAt.microsSinceUnixEpoch > m ? r.ingestedAt.microsSinceUnixEpoch : m), undefined);
      const out: FeedStatus = { enabled, source: nessie ? 'nessie' : 'simulated', planned: events.length, ingested: events.filter(e => done.has(e.externalId) || sent.has(e.externalId)).length };
      if (ym) out.ym = ym;
      if (last !== undefined) out.lastEventAt = new Date(Number(last / 1000n)).toISOString();
      const blocked = 'blocked' in st ? st.blocked : lastError ?? (nessie && ym && !plans.has(ym) ? 'Nessie transactions have not been fetched yet.' : undefined);
      if (blocked) out.blockedReason = blocked;
      return out;
    },
    tick,
    async drain() {
      let n = 0;
      while (!stopped && (await tick())) n++;
      return n;
    },
    plan() {
      const ym = feedTargetYm(A);
      return ym ? nessie ? (plans.get(ym) ?? []) : planFor(ym) : [];
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** GET /feed/status: what the live feed is doing (read-only). */
export function feedRoutes(feeder: Pick<Feeder, 'status'>): Route[] {
  return [{ method: 'GET', pattern: /^\/feed\/status$/, handle: ({ res }) => json(res, 200, feeder.status()) }];
}
