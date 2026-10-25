/**
 * Capital One Nessie bank transactions, read into the existing ingest-only feed identity.
 * Endpoints and query authentication follow the first-party Nessie JavaScript SDK:
 * https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/deposit.js
 * https://github.com/nessieisreal/nessie-javascript-sdk/blob/master/lib/withdrawal.js
 */
import { z } from 'zod';
import type { FeedBankTxEvent } from '@cafoo/seed/feed';

export interface NessieConfig {
  apiKey: string;
  baseUrl: string;
  /** Subsidiary code to Nessie account ID. Nessie's documented amounts are dollars without a currency field. */
  accounts: ReadonlyMap<string, string>;
}

const DEFAULT_BASE = 'https://prod-api.nessieisreal.com';
const accountId = /^[a-zA-Z0-9_-]{1,100}$/;
const subsidiaryCode = /^[A-Z0-9_-]{1,30}$/;

/** Missing both settings keeps the deterministic feed. A partial or unsafe setup fails at startup. */
export function nessieConfig(env: NodeJS.ProcessEnv): NessieConfig | null {
  if (env.DEMO_MODE === '1') return null;
  const apiKey = env.NESSIE_API_KEY?.trim();
  const pairs = env.NESSIE_ACCOUNT_IDS?.trim();
  if (!apiKey && !pairs) return null;
  if (!apiKey) throw new Error('NESSIE_API_KEY is required when NESSIE_ACCOUNT_IDS is set.');
  if (!pairs) throw new Error('NESSIE_ACCOUNT_IDS is required when NESSIE_API_KEY is set.');
  const accounts = new Map<string, string>();
  for (const pair of pairs.split(',')) {
    const [code, id, extra] = pair.trim().split(':');
    if (extra !== undefined || !code || !id || !subsidiaryCode.test(code) || !accountId.test(id)) {
      throw new Error('NESSIE_ACCOUNT_IDS must be comma-separated SUBSIDIARY_CODE:accountId pairs.');
    }
    if (accounts.has(code)) throw new Error(`NESSIE_ACCOUNT_IDS repeats subsidiary ${code}.`);
    accounts.set(code, id);
  }
  const rawBase = env.NESSIE_BASE_URL?.trim() || DEFAULT_BASE;
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new Error('NESSIE_BASE_URL must be an HTTPS origin.');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('NESSIE_BASE_URL must be an HTTPS origin.');
  }
  return { apiKey, accounts, baseUrl: base.origin };
}

/** Parse a JSON dollar amount without passing it through floating-point multiplication. */
export function parseNessieDollars(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Nessie transaction amount must be positive.');
  const text = String(amount);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error('Nessie transaction amount must have whole cents.');
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (cents > 9_223_372_036_854_775_807n) throw new Error('Nessie transaction amount exceeds the ledger range.');
  return cents;
}

const rawTransaction = z.object({
  _id: z.string().min(1).max(100),
  amount: z.number().finite().positive(),
  transaction_date: z.string().min(10),
  status: z.string(),
  description: z.string().optional(),
});

function bookedAtMicros(rawDate: string): bigint {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(rawDate)) {
    throw new Error('Nessie transaction_date must be an ISO date or timestamp with an offset.');
  }
  const year = Number(rawDate.slice(0, 4));
  const month = Number(rawDate.slice(5, 7));
  const day = Number(rawDate.slice(8, 10));
  const calendarDate = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  const ms = Date.parse(rawDate);
  if (!Number.isFinite(ms) || calendarDate !== rawDate.slice(0, 10)) {
    throw new Error('Nessie transaction_date is invalid.');
  }
  return BigInt(ms) * 1000n;
}

async function listTransactions(
  config: NessieConfig,
  account: string,
  kind: 'deposit' | 'withdrawal',
  fetcher: typeof fetch,
) {
  const url = new URL(`/accounts/${encodeURIComponent(account)}/${kind}s`, config.baseUrl);
  url.searchParams.set('key', config.apiKey);
  let response: Response;
  try {
    response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(`Nessie ${kind} request failed before a response.`);
  }
  if (!response.ok) throw new Error(`Nessie ${kind} request failed (HTTP ${response.status}).`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Nessie ${kind} response was not JSON.`);
  }
  // Only completed rows post; a pending or cancelled row (often a zero amount) must not fail the whole month.
  const rows = z.array(z.object({ status: z.string() }).passthrough()).safeParse(body);
  if (!rows.success) throw new Error(`Nessie ${kind} response did not match the documented transaction fields.`);
  const result = z.array(rawTransaction).safeParse(rows.data.filter(row => row.status.toLowerCase() === 'completed'));
  if (!result.success) throw new Error(`Nessie ${kind} response did not match the documented transaction fields.`);
  return result.data;
}

export interface NessieScope {
  ym: string;
  subsidiaries: readonly { code: string; functionalCcy: string }[];
  materialityMinor: bigint;
}

/** One month of posted bank lines. The module deduplicates these stable provider IDs across restarts. */
export async function fetchNessieBankEvents(config: NessieConfig, scope: NessieScope, fetcher: typeof fetch = fetch): Promise<FeedBankTxEvent[]> {
  for (const code of config.accounts.keys()) {
    const sub = scope.subsidiaries.find(row => row.code === code);
    if (!sub) throw new Error(`Nessie mapping names unknown subsidiary ${code}.`);
    if (sub.functionalCcy !== 'USD') throw new Error(`Nessie account for ${code} cannot be ingested as ${sub.functionalCcy}: Nessie transaction amounts are USD.`);
  }
  const events: FeedBankTxEvent[] = [];
  const seen = new Set<string>();
  for (const [code, account] of config.accounts) {
    for (const kind of ['deposit', 'withdrawal'] as const) {
      const rows = await listTransactions(config, account, kind, fetcher);
      for (const row of rows) {
        if (row.status.toLowerCase() !== 'completed') continue;
        const atMicros = bookedAtMicros(row.transaction_date);
        if (new Date(Number(atMicros / 1000n)).toISOString().slice(0, 7) !== scope.ym) continue;
        const externalId = `nessie:${account}:${kind}:${row._id}`;
        if (externalId.length > 200) throw new Error(`Nessie ${kind} ID is too long for the feed.`);
        if (seen.has(externalId)) throw new Error(`Nessie returned duplicate ${kind} ID ${row._id}.`);
        seen.add(externalId);
        const amount = parseNessieDollars(row.amount) * (kind === 'deposit' ? 1n : -1n);
        const description = row.description?.trim() || `Nessie ${kind} ${row._id}`;
        events.push({
          kind: 'bank_tx', externalId, ym: scope.ym, atMicros, subsidiaryCode: code,
          tx: { externalId, bookedAtMicros: atMicros, amountMinor: amount, ccy: 'USD', description, counterparty: '' },
          expect: 'classify', material: (amount < 0n ? -amount : amount) >= scope.materialityMinor,
          notePlain: `${kind === 'deposit' ? 'Deposit' : 'Withdrawal'} from Nessie account ${code}: ${description}.`,
        });
      }
    }
  }
  events.sort((a, b) => a.atMicros < b.atMicros ? -1 : a.atMicros > b.atMicros ? 1 : a.externalId.localeCompare(b.externalId));
  return events;
}
