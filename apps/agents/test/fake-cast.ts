import type { Cast, RoleConn } from '../src/stdb';
import { ts } from './fake-conn';

/** Table rows by camelCase table name, as the bindings name them. Shared by every role of a fake cast, like one database. */
export type Rows = Record<string, any[]>;
export type ReducerCall = { role: string; reducer: string; args: any };
type Listener = (ctx: unknown, row: any) => void;

const ROLES = ['advisor', 'bookkeeper', 'revenue', 'credit', 'redteam', 'consolidation', 'feed'] as const;
const pascal = (kind: string) => kind.replace(/(^|_)([a-z])/g, (_m, _u, c: string) => c.toUpperCase());

/**
 * A whole cast over one in-memory database. Every reducer call is recorded (role, reducer, args) and resolves, except:
 * - `propose` inserts an Open Proposal row the way the module would (proposedBy the caller's identity), so stdb's
 *   propose() finds it;
 * - a reducer named in `failing` (as "role.reducer" or "*.reducer") rejects with that message, like a module refusal.
 * Inserted rows reach `onInsert` listeners, as the SpacetimeDB client cache does.
 */
export function fakeCast(rows: Rows) {
  const calls: ReducerCall[] = [];
  const failing = new Map<string, string>();
  const listeners = new Map<string, Set<Listener>>();
  let nextProposalId = 1000n;
  const insert = (table: string, row: any) => {
    (rows[table] ??= []).push(row);
    for (const cb of [...(listeners.get(table) ?? [])]) cb({}, row);
    return row;
  };
  const db = new Proxy({} as Record<string, unknown>, {
    get: (_t, table: string) => ({
      iter: () => (rows[table] ?? [])[Symbol.iterator](),
      key: { find: (k: string) => rows[table]?.find(r => r.key === k) },
      id: { find: (id: bigint) => rows[table]?.find(r => r.id === id) },
      onInsert: (cb: Listener) => void (listeners.get(table) ?? listeners.set(table, new Set()).get(table)!).add(cb),
      removeOnInsert: (cb: Listener) => void listeners.get(table)?.delete(cb),
    }),
  });
  const conn = (role: string) => {
    const identity = { role, isEqual: (o: unknown) => o === identity, toHexString: () => `${role}-identity` };
    const reducers = new Proxy({} as Record<string, unknown>, {
      get: (_t, reducer: string) => async (args: any) => {
        calls.push({ role, reducer, args });
        const why = failing.get(`${role}.${reducer}`) ?? failing.get(`*.${reducer}`);
        if (why) throw new Error(why);
        if (reducer === 'propose') {
          const period = rows.period?.find(p => p.ym === args.periodYm);
          insert('proposal', {
            id: nextProposalId++,
            kind: { tag: pascal(args.kind) },
            status: { tag: 'Open' },
            periodId: period?.id,
            payloadJson: args.payloadJson,
            rationale: args.rationale,
            summaryPlain: args.summaryPlain,
            amountMinor: args.amountMinor,
            closeTaskId: args.closeTaskId,
            proposedBy: identity,
            proposerRole: role,
            createdAt: ts('2026-10-02T00:00:00Z'),
          });
        }
      },
    });
    return { role, db, reducers, identity, hex: role } as unknown as RoleConn;
  };
  const conns = Object.fromEntries(ROLES.map(r => [r, conn(r)])) as Record<(typeof ROLES)[number], RoleConn>;
  const cast = { ...conns, byRole: (r: (typeof ROLES)[number]) => conns[r] } as unknown as Cast;
  return {
    cast,
    rows,
    calls,
    insert,
    /** The recorded calls of one reducer, optionally only one role's. */
    callsTo: (reducer: string, role?: string) => calls.filter(c => c.reducer === reducer && (!role || c.role === role)),
    fail: (key: string, message: string) => void failing.set(key, message),
  };
}

const acct = (id: bigint, subsidiaryId: bigint, code: string, tag: string) => ({ id, subsidiaryId, code, name: `Account ${code}`, accountType: { tag }, isIntercompany: false });

/**
 * The root company's books for the 2026-09 close: one customer with an open invoice and its exact receipt, one with a
 * contract missing its schedule, a vendor bill for September billed in October (a missing accrual), a vendor not yet
 * verified, close tasks and the materiality threshold. `group` adds Cafoo Ltd and the elimination subsidiary.
 */
export function books(opts: { group?: boolean } = {}): Rows {
  return {
    subsidiary: [
      { id: 1n, code: 'US', name: 'Cafoo Inc', functionalCcy: 'USD', parentId: undefined, isElimination: false },
      ...(opts.group
        ? [
            { id: 2n, code: 'UK', name: 'Cafoo Ltd', functionalCcy: 'GBP', parentId: 1n, isElimination: false },
            { id: 3n, code: 'ELIM', name: 'Group eliminations', functionalCcy: 'USD', parentId: 1n, isElimination: true },
          ]
        : []),
    ],
    period: [
      { id: 8n, ym: '2026-08', status: { tag: 'Closed' } },
      { id: 9n, ym: '2026-09', status: { tag: 'Open' } },
      { id: 10n, ym: '2026-10', status: { tag: 'Open' } },
    ],
    account: [
      acct(100n, 1n, '1000', 'Asset'),
      acct(101n, 1n, '1100', 'Asset'),
      acct(102n, 1n, '1150', 'Asset'),
      acct(103n, 1n, '2000', 'Liability'),
      acct(104n, 1n, '2100', 'Liability'),
      acct(105n, 1n, '2400', 'Liability'),
      acct(106n, 1n, '4000', 'Revenue'),
      acct(107n, 1n, '5600', 'Expense'),
      acct(108n, 1n, '5700', 'Expense'),
      acct(109n, 1n, '6100', 'Expense'),
    ],
    customer: [
      { id: 20n, subsidiaryId: 1n, name: 'Acme Analytics', guarantorPersonaId: 'P01', guarantorName: 'Guarantor One', creditTier: undefined, allowanceMinor: 0n, paymentTermsDays: 30 },
      { id: 21n, subsidiaryId: 1n, name: 'Beta Corp', guarantorPersonaId: 'P07', guarantorName: 'Guarantor Seven', creditTier: 'B', allowanceMinor: 5000n, paymentTermsDays: 30 },
    ],
    vendor: [
      { id: 30n, subsidiaryId: 1n, name: 'Northwind Traders', category: 'hosting', verification: { tag: 'Verified' }, ownerPersonaId: undefined },
      { id: 31n, subsidiaryId: 1n, name: 'Shady Supplies', category: 'supplies', verification: { tag: 'Unverified' }, ownerPersonaId: 'P07' },
    ],
    invoice: [
      { id: 40n, number: 'INV-40', customerId: 20n, ym: '2026-09', amountMinor: 420000n, dueAt: ts('2026-10-15'), status: { tag: 'Open' } },
      { id: 41n, number: 'INV-41', customerId: 21n, ym: '2026-09', amountMinor: 100000n, dueAt: ts('2026-10-15'), status: { tag: 'Open' } },
      { id: 42n, number: 'INV-42', customerId: 21n, ym: '2026-08', amountMinor: 70000n, dueAt: ts('2026-09-15'), status: { tag: 'Paid' } },
    ],
    bill: [
      { id: 50n, vendorId: 30n, ym: '2026-09', amountMinor: 120000n, dueAt: ts('2026-10-30'), billedAt: ts('2026-10-03'), status: { tag: 'Open' }, externalRef: 'NW-311', expenseAccountCode: '6100' },
      { id: 51n, vendorId: 31n, ym: '2026-09', amountMinor: 50000n, dueAt: ts('2026-10-10'), billedAt: ts('2026-09-10'), status: { tag: 'Open' }, externalRef: 'SH-9', expenseAccountCode: '5600' },
    ],
    bankTransaction: [
      { id: 60n, subsidiaryId: 1n, ym: '2026-09', bookedAt: ts('2026-09-20'), amountMinor: 420000n, ccy: 'USD', description: 'ACME ANALYTICS PAYMENT INV-40', counterparty: 'Acme Analytics', matched: false },
      { id: 61n, subsidiaryId: 1n, ym: '2026-09', bookedAt: ts('2026-09-21'), amountMinor: 99000n, ccy: 'USD', description: 'BETA CORP INV-41', counterparty: 'Beta Corp', matched: false },
      { id: 62n, subsidiaryId: 1n, ym: '2026-09', bookedAt: ts('2026-09-02'), amountMinor: -4500n, ccy: 'USD', description: 'MONTHLY SERVICE FEE', counterparty: 'First Bank', matched: false },
      { id: 63n, subsidiaryId: 1n, ym: '2026-08', bookedAt: ts('2026-08-02'), amountMinor: 70000n, ccy: 'USD', description: 'BETA CORP INV-42', counterparty: 'Beta Corp', matched: true },
    ],
    contract: [
      { id: 70n, customerId: 20n, code: 'K-ACME', startYm: '2026-09', endYm: '2027-08', totalMinor: 1_200_000n, plan: { tag: 'Annual' } },
      { id: 71n, customerId: 21n, code: 'K-BETA', startYm: '2026-01', endYm: '2026-12', totalMinor: 120_000n, plan: { tag: 'Annual' } },
    ],
    contractItem: [
      { id: 80n, contractId: 70n, kind: { tag: 'Subscription' }, priceMinor: 100_000n, qty: 1n, sspMinor: 1_200_000n },
      { id: 81n, contractId: 71n, kind: { tag: 'Subscription' }, priceMinor: 10_000n, qty: 1n, sspMinor: 120_000n },
    ],
    revenueScheduleLine: [{ id: 90n, contractItemId: 81n, customerId: 21n, ym: '2026-09', amountMinor: 10_000n, recognized: false }],
    journalEntry: [{ id: 200n, periodId: 8n, postedAt: ts('2026-08-31'), source: { tag: 'Agent' } }],
    journalLine: [
      { id: 300n, jeId: 200n, accountId: 108n, debitMinor: 5000n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1_000_000n, customerId: 21n },
      { id: 301n, jeId: 200n, accountId: 102n, debitMinor: 0n, creditMinor: 5000n, ccy: 'USD', fxRateE6: 1_000_000n, customerId: 21n },
    ],
    closeTask: [
      { id: 5n, periodId: 9n, title: 'Bank reconciliation', ownerRole: 'bookkeeper', status: { tag: 'Todo' }, sortOrder: 1 },
      { id: 6n, periodId: 9n, title: 'Revenue recognition', ownerRole: 'revenue', status: { tag: 'InProgress' }, sortOrder: 2 },
    ],
    settings: [{ key: 'materiality_threshold_minor', valueI64: 1_000_000n, valueText: '' }],
  };
}
