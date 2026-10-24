/**
 * One SpacetimeDB connection per agent role. Each role has its own identity (token file under .secrets/<database>/),
 * so the module's reducers can enforce who may propose, critique, rule, or confirm.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Identity } from 'spacetimedb';
import { DbConnection } from '@cafoo/stdb-bindings';
import { STDB_DB, STDB_URI } from './env';

export type AgentRole = 'advisor' | 'bookkeeper' | 'revenue' | 'credit' | 'redteam';
/** A connection's role: an agent, or the CFO seat (only the demo CFO stand-in in src/demo-cfo.ts connects as it). */
export type ConnRole = AgentRole | 'cfo';
export const ROLE_TAG: Record<AgentRole, 'Advisor' | 'Bookkeeper' | 'Revenue' | 'Credit' | 'Redteam'> = {
  advisor: 'Advisor',
  bookkeeper: 'Bookkeeper',
  revenue: 'Revenue',
  credit: 'Credit',
  redteam: 'Redteam',
};
export const ROLE_DISPLAY: Record<AgentRole, string> = {
  advisor: 'Chief Finance Advisor',
  bookkeeper: 'Bookkeeper',
  revenue: 'Revenue',
  credit: 'Credit & Risk',
  redteam: 'Red Team',
};

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..', '..');
// Identities are kept per database, so reseeding one database never replaces the identities another one granted.
const secretsDir = join(repoRoot, '.secrets', STDB_DB);

function tokenPath(role: ConnRole) {
  return join(secretsDir, `${role}.token`);
}
/** Before tokens were kept per database they lived in .secrets/<role>.token; the default database still reads those. */
function legacyTokenPath(role: ConnRole) {
  return STDB_DB === 'cafoo' ? join(repoRoot, '.secrets', `${role}.token`) : undefined;
}
function loadToken(role: ConnRole) {
  try {
    for (const p of [tokenPath(role), legacyTokenPath(role)]) {
      if (p && existsSync(p)) return readFileSync(p, 'utf8').trim() || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
function saveToken(role: ConnRole, token: string) {
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(tokenPath(role), token, 'utf8');
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 15000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(40);
  }
}

export class RoleConn {
  private constructor(
    readonly role: ConnRole,
    readonly conn: DbConnection,
    readonly identity: Identity
  ) {}

  get db() {
    return this.conn.db;
  }
  get reducers() {
    return this.conn.reducers;
  }

  /** Connect with the role's persisted token (or mint a new identity), subscribe to all tables, wait for the cache. */
  static connect(role: ConnRole): Promise<RoleConn> {
    return new Promise((resolve, reject) => {
      let settled = false;
      DbConnection.builder()
        .withUri(STDB_URI)
        .withDatabaseName(STDB_DB)
        .withToken(loadToken(role))
        .onConnect((conn, identity, token) => {
          saveToken(role, token);
          conn
            .subscriptionBuilder()
            .onApplied(() => {
              if (!settled) {
                settled = true;
                resolve(new RoleConn(role, conn, identity));
              }
            })
            .onError(ctx => {
              if (!settled) {
                settled = true;
                reject((ctx as { event?: unknown }).event ?? new Error('subscription failed'));
              }
            })
            .subscribeToAllTables();
        })
        .onConnectError(((_ctx: unknown, err: Error) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }) as never)
        .build();
    });
  }

  /** Short hex for logs. */
  get hex() {
    return this.identity.toHexString().slice(0, 10);
  }

  disconnect() {
    try {
      this.conn.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/** The whole cast. The advisor registers itself (bootstrap) and grants every other role. */
export class Cast {
  private constructor(
    readonly advisor: RoleConn,
    readonly bookkeeper: RoleConn,
    readonly revenue: RoleConn,
    readonly credit: RoleConn,
    readonly redteam: RoleConn
  ) {}

  byRole(role: AgentRole): RoleConn {
    return this[role];
  }

  static async connectAll(models: Partial<Record<AgentRole, string>> = {}): Promise<Cast> {
    const advisor = await RoleConn.connect('advisor');
    const roster = () => [...advisor.db.agentRoster.iter()];
    if (!roster().some(r => r.role === 'advisor')) {
      await advisor.reducers.registerAgent({ role: { tag: 'Advisor' }, displayName: ROLE_DISPLAY.advisor, model: models.advisor ?? 'claude-opus-5-5' });
    }
    const [bookkeeper, revenue, credit, redteam] = await Promise.all(
      (['bookkeeper', 'revenue', 'credit', 'redteam'] as AgentRole[]).map(r => RoleConn.connect(r))
    );
    for (const w of [bookkeeper, revenue, credit, redteam]) {
      const role = w.role as AgentRole;
      await advisor.reducers.grantRole({
        identity: w.identity,
        role: { tag: ROLE_TAG[role] },
        displayName: ROLE_DISPLAY[role],
        model: models[role] ?? (role === 'redteam' ? 'grok-4.7' : 'claude-sonnet-5-5'),
      });
    }
    await waitFor(() => roster().length >= 5, 'agent roster');
    return new Cast(advisor, bookkeeper, revenue, credit, redteam);
  }

  disconnectAll() {
    for (const c of [this.advisor, this.bookkeeper, this.revenue, this.credit, this.redteam]) c.disconnect();
  }
}

/** Create a proposal through a worker's connection and return the inserted row. */
export async function propose(
  worker: RoleConn,
  reader: RoleConn,
  args: {
    kind: 'journal_entry' | 'bank_match' | 'revenue_schedule' | 'credit_decision' | 'accrual' | 'vendor_block' | 'vendor_verify';
    payload: unknown;
    rationale: string;
    summaryPlain: string;
    amountMinor: bigint;
    periodYm: string;
    closeTaskId?: bigint;
  }
) {
  const before = new Set([...reader.db.proposal.iter()].map(p => p.id));
  await worker.reducers.propose({
    kind: args.kind,
    payloadJson: JSON.stringify(args.payload),
    rationale: args.rationale,
    summaryPlain: args.summaryPlain,
    amountMinor: args.amountMinor,
    periodYm: args.periodYm,
    closeTaskId: args.closeTaskId,
  });
  let found: ReturnType<typeof reader.db.proposal.id.find> = null as any;
  await waitFor(() => {
    found = [...reader.db.proposal.iter()].find(p => !before.has(p.id) && p.summaryPlain === args.summaryPlain && p.proposedBy.isEqual(worker.identity)) ?? null;
    return Boolean(found);
  }, 'proposal row');
  return found!;
}

export async function say(
  who: RoleConn,
  threadId: string,
  body: string,
  summaryPlain: string,
  kind: 'statement' | 'question' | 'ruling' = 'statement',
  proposalId?: bigint
) {
  await who.reducers.postAgentMessage({ threadId, kind, body, summaryPlain, proposalId });
}
