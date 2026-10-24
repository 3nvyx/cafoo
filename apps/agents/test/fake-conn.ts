import type { RoleConn } from '../src/stdb';

/**
 * A role connection whose cache holds just these rows (camelCase table names, as the bindings name them); every other
 * table is empty. `id.find` looks rows up by id, `key.find` by key (settings).
 */
export function fakeConn(rows: Record<string, unknown[]>, role = 'advisor'): RoleConn {
  const db = new Proxy({} as Record<string, unknown>, {
    get: (_t, table: string) => ({
      iter: () => (rows[table] ?? [])[Symbol.iterator](),
      key: { find: (k: string) => (rows[table] as { key: string }[] | undefined)?.find(r => r.key === k) },
      id: { find: (id: bigint) => (rows[table] as { id: bigint }[] | undefined)?.find(r => r.id === id) },
    }),
  });
  return { role, db } as unknown as RoleConn;
}

export const ts = (iso: string) => ({ microsSinceUnixEpoch: BigInt(Date.parse(iso)) * 1000n });
