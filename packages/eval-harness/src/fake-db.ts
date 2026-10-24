// In-memory stand-in for the SpacetimeDB SQL endpoint, over decoded rows: the harness's own tests and snapshot-mode
// charter evals (snapshotDb in api.ts) run scenarios on it. Supports exactly the subset the scenarios use:
// SELECT * | SELECT COUNT(*) AS n, one table, WHERE with =, !=, <, <=, >, >= joined by AND / OR.
// Anything else throws, so a scenario that starts using unsupported SQL fails here as it would live.
import type { Db, Row } from './db.js';

export type Tables = Record<string, Row[]>;

type Pred = (r: Row) => boolean;

function literal(s: string): unknown {
  const t = s.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  throw new Error(`fake db: unsupported literal ${t}`);
}

function comparison(expr: string): Pred {
  const m = /^\s*(\w+)\s*(=|!=|<=|>=|<|>)\s*(.+?)\s*$/.exec(expr);
  if (!m) throw new Error(`fake db: unsupported expression ${expr}`);
  const [, col, op, lit] = m as unknown as [string, string, string, string];
  const v = literal(lit);
  return (r) => {
    const x = r[col];
    switch (op) {
      case '=': return x === v;
      case '!=': return x !== v;
      case '<': return (x as number) < (v as number);
      case '<=': return (x as number) <= (v as number);
      case '>': return (x as number) > (v as number);
      default: return (x as number) >= (v as number);
    }
  };
}

function where(clause: string): Pred {
  const ors = clause.split(/\s+OR\s+/i).map((part) => part.split(/\s+AND\s+/i).map(comparison));
  return (r) => ors.some((ands) => ands.every((p) => p(r)));
}

export class FakeDb implements Db {
  constructor(readonly tables: Tables) {}

  query(sql: string): Row[] {
    const m = /^\s*SELECT\s+(\*|COUNT\(\*\)\s+AS\s+(\w+))\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?\s*$/i.exec(sql);
    if (!m) throw new Error(`fake db: unsupported SQL ${sql}`);
    const [, proj, alias, table, clause] = m;
    const rows = this.tables[table!];
    if (!rows) throw new Error(`fake db: unknown table ${table}`);
    const out = clause ? rows.filter(where(clause)) : rows;
    return proj === '*' ? out : [{ [alias!]: out.length }];
  }
}
