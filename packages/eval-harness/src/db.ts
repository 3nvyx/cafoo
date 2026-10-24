// Read-only access to the live SpacetimeDB ledger through the `spacetime sql` CLI.
// The SQL endpoint supports plain SELECT with WHERE (=, !=, <, <=, >, >=, AND, OR), COUNT(*) without GROUP BY,
// and inner JOINs that project one table (`SELECT a.* FROM a JOIN b ON ...`) on non-optional columns.
// It rejects LIKE, IN, GROUP BY, enum literals (`status = 'approved'`) and joins on option columns,
// so scenarios fetch rows and filter, group and join in code (src/conditions.ts, src/assertions.ts).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Row = Record<string, unknown>;

export interface Db {
  query(sql: string): Row[];
}

/** SATS algebraic type as printed by `spacetime sql --format json` in `schema.elements[].algebraic_type`. */
type AlgebraicType =
  | { Sum: { variants: { name: { some?: string }; algebraic_type: AlgebraicType }[] } }
  | { Product: { elements: { name: { some?: string }; algebraic_type: AlgebraicType }[] } }
  | { Array: AlgebraicType }
  | Record<string, unknown>;

interface SqlResultSet {
  schema: { elements: { name: { some?: string }; algebraic_type: AlgebraicType }[] };
  rows: unknown[][];
}

/** camelCase variant names (as the module declares them) to the snake_case tags the reducers use. */
export const snake = (s: string): string => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

const SPECIAL_PRODUCTS = new Set([
  '__identity__',
  '__connection_id__',
  '__timestamp_micros_since_unix_epoch__',
  '__time_duration_micros__',
]);

/**
 * Decodes one JSON-encoded SATS value.
 * Option (some|none) -> value or null. Plain enums -> snake_case variant name. Enums with payload -> { tag, value }.
 * Identity -> hex string. Timestamp and duration -> number of microseconds. Other products -> objects.
 */
export function decodeValue(type: AlgebraicType, value: unknown): unknown {
  if ('Sum' in type) {
    const variants = (type as { Sum: { variants: { name: { some?: string }; algebraic_type: AlgebraicType }[] } }).Sum.variants;
    const [idx, payload] = value as [number, unknown];
    const v = variants[idx];
    if (!v) throw new Error(`sum value index ${idx} out of range`);
    const names = variants.map((x) => x.name.some);
    if (names.length === 2 && names[0] === 'some' && names[1] === 'none') {
      return idx === 0 ? decodeValue(v.algebraic_type, payload) : null;
    }
    const tag = snake(v.name.some ?? String(idx));
    const inner = v.algebraic_type;
    const isUnit = 'Product' in inner && (inner as { Product: { elements: unknown[] } }).Product.elements.length === 0;
    return isUnit ? tag : { tag, value: decodeValue(inner, payload) };
  }
  if ('Product' in type) {
    const elements = (type as { Product: { elements: { name: { some?: string }; algebraic_type: AlgebraicType }[] } }).Product.elements;
    const arr = value as unknown[];
    const only = elements.length === 1 ? elements[0]!.name.some : undefined;
    if (only && SPECIAL_PRODUCTS.has(only)) return arr[0];
    const out: Row = {};
    elements.forEach((e, i) => {
      out[e.name.some ?? String(i)] = decodeValue(e.algebraic_type, arr[i]);
    });
    return out;
  }
  if ('Array' in type) {
    const inner = (type as { Array: AlgebraicType }).Array;
    return (value as unknown[]).map((x) => decodeValue(inner, x));
  }
  return value;
}

/** Decodes the full `--format json` output (an array of result sets) into rows of the first result set. */
export function decodeSqlJson(text: string): Row[] {
  const sets = JSON.parse(text) as SqlResultSet[];
  const first = sets[0];
  if (!first) return [];
  const cols = first.schema.elements.map((e, i) => ({ name: e.name.some ?? `col${i}`, type: e.algebraic_type }));
  return first.rows.map((r) => {
    const row: Row = {};
    cols.forEach((c, i) => {
      row[c.name] = decodeValue(c.type, r[i]);
    });
    return row;
  });
}

export function findSpacetimeBin(): string {
  const env = process.env.SPACETIME_BIN;
  if (env) return env;
  const local = join(homedir(), '.local', 'bin', 'spacetime');
  return existsSync(local) ? local : 'spacetime';
}

export class SqlError extends Error {}

/**
 * Scenarios only read. A charter draft can carry its own scenario YAML, and the CLI runs as the database owner, so
 * anything but one SELECT statement is refused before it reaches the database.
 */
export function assertReadOnly(sql: string): void {
  if (!/^\s*select\b/i.test(sql) || sql.includes(';')) throw new SqlError(`only a single SELECT statement is allowed [${sql}]`);
}

export class SpacetimeCli implements Db {
  private cache = new Map<string, Row[]>();
  readonly calls: string[] = [];

  constructor(
    readonly opts: { db: string; server: string; bin?: string },
  ) {}

  query(sql: string): Row[] {
    const hit = this.cache.get(sql);
    if (hit) return hit;
    assertReadOnly(sql);
    const bin = this.opts.bin ?? findSpacetimeBin();
    let stdout: string;
    try {
      stdout = execFileSync(bin, ['sql', this.opts.db, '-s', this.opts.server, '--format', 'json', '--no-config', sql], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
        // The gateway's eval runner calls this in-process: a hung CLI must not hold it.
        timeout: 60_000,
      });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      const msg = (err.stderr ?? err.message)
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('WARNING'))
        .slice(0, 2)
        .join(' ');
      const hint = /\/identity\)/.test(msg) ? ` (database "${this.opts.db}" not found on server "${this.opts.server}"?)` : '';
      throw new SqlError(`SQL failed${hint}: ${msg} [${sql}]`);
    }
    const json = stdout.slice(stdout.indexOf('['));
    let rows: Row[];
    try {
      rows = decodeSqlJson(json);
    } catch (e) {
      throw new SqlError(`could not parse SQL output (${(e as Error).message}) [${sql}]`);
    }
    this.calls.push(sql);
    this.cache.set(sql, rows);
    return rows;
  }

  /** Drop cached results (after --rerun mutates the database). */
  clear(): void {
    this.cache.clear();
  }
}
