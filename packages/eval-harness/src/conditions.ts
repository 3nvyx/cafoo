// Row predicates evaluated in code, because the SpacetimeDB SQL endpoint has no LIKE, IN, GROUP BY,
// enum literals or functions. A condition map is { <path>: <condition>, any_of?, all_of?, not? }; every key must hold.
import type { Row } from './db.js';

export type Scalar = string | number | boolean | null;
export interface Ops {
  eq?: Scalar;
  ne?: Scalar;
  in?: Scalar[];
  not_in?: Scalar[];
  gt?: number | string;
  gte?: number | string;
  lt?: number | string;
  lte?: number | string;
  min_length?: number;
  max_length?: number;
  matches?: string;
  not_matches?: string;
  imatches?: string;
  not_imatches?: string;
  is_null?: boolean;
  min_items?: number;
  max_items?: number;
  length?: number;
  each?: CondMap;
  eq_column?: string;
  ne_column?: string;
}
export type Cond = Scalar | Ops;
export interface CondMap {
  any_of?: CondMap[];
  all_of?: CondMap[];
  not?: CondMap;
  [path: string]: Cond | CondMap[] | CondMap | undefined;
}

const OP_KEYS = new Set<string>([
  'eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'min_length', 'max_length', 'matches', 'not_matches',
  'imatches', 'not_imatches', 'is_null', 'min_items', 'max_items', 'length', 'each', 'eq_column', 'ne_column',
]);

function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Reads a dotted path from a row. The first segment is a column; later segments walk into the value,
 * parsing JSON-text columns (payload_json, summary_json) on the way. Numeric segments index arrays.
 */
export function getPath(row: unknown, path: string): unknown {
  if (row && typeof row === 'object' && path in (row as Row)) return (row as Row)[path];
  let cur: unknown = row;
  for (const seg of path.split('.')) {
    cur = maybeJson(cur);
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === 'object') cur = (cur as Row)[seg];
    else return undefined;
  }
  return cur;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const same = (a: unknown, b: unknown): boolean => a === b || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));

function isOps(c: unknown): c is Ops {
  return !!c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).every((k) => OP_KEYS.has(k));
}

export function testCond(row: Row, path: string, cond: Cond): boolean {
  const raw = getPath(row, path);
  if (!isOps(cond)) return same(raw, cond);
  const v = maybeJson(raw);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case 'eq': if (!same(v, arg)) return false; break;
      case 'ne': if (same(v, arg)) return false; break;
      case 'in': if (!(arg as Scalar[]).some((a) => same(v, a))) return false; break;
      case 'not_in': if ((arg as Scalar[]).some((a) => same(v, a))) return false; break;
      case 'gt': if (!(v !== null && v !== undefined && num(v) > num(arg))) return false; break;
      case 'gte': if (!(v !== null && v !== undefined && num(v) >= num(arg))) return false; break;
      case 'lt': if (!(v !== null && v !== undefined && num(v) < num(arg))) return false; break;
      case 'lte': if (!(v !== null && v !== undefined && num(v) <= num(arg))) return false; break;
      case 'min_length': if (String(raw ?? '').trim().length < num(arg)) return false; break;
      case 'max_length': if (String(raw ?? '').trim().length > num(arg)) return false; break;
      case 'matches': if (!new RegExp(String(arg)).test(String(raw ?? ''))) return false; break;
      case 'not_matches': if (new RegExp(String(arg)).test(String(raw ?? ''))) return false; break;
      case 'imatches': if (!new RegExp(String(arg), 'i').test(String(raw ?? ''))) return false; break;
      case 'not_imatches': if (new RegExp(String(arg), 'i').test(String(raw ?? ''))) return false; break;
      case 'is_null': if ((raw === null || raw === undefined) !== arg) return false; break;
      case 'min_items': if (!Array.isArray(v) || v.length < num(arg)) return false; break;
      case 'max_items': if (Array.isArray(v) && v.length > num(arg)) return false; break;
      case 'length': if (!Array.isArray(v) || v.length !== num(arg)) return false; break;
      case 'each': if (!Array.isArray(v) || !v.every((el) => matchRow(el as Row, arg as CondMap))) return false; break;
      case 'eq_column': if (!same(raw, getPath(row, String(arg)))) return false; break;
      case 'ne_column': if (same(raw, getPath(row, String(arg)))) return false; break;
      default: throw new Error(`unknown condition operator ${op}`);
    }
  }
  return true;
}

export function matchRow(row: Row, map: CondMap | undefined): boolean {
  if (!map) return true;
  for (const [key, cond] of Object.entries(map)) {
    if (cond === undefined) continue;
    if (key === 'any_of') {
      if (!(cond as CondMap[]).some((m) => matchRow(row, m))) return false;
    } else if (key === 'all_of') {
      if (!(cond as CondMap[]).every((m) => matchRow(row, m))) return false;
    } else if (key === 'not') {
      if (matchRow(row, cond as CondMap)) return false;
    } else if (!testCond(row, key, cond as Cond)) return false;
  }
  return true;
}

/** Top-level paths a condition map reads, for choosing which columns to show in a failure. */
export function pathsOf(map: CondMap | undefined, out: string[] = []): string[] {
  if (!map) return out;
  for (const [key, cond] of Object.entries(map)) {
    if (key === 'any_of' || key === 'all_of') for (const m of cond as CondMap[]) pathsOf(m, out);
    else if (key === 'not') pathsOf(cond as CondMap, out);
    else if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Replaces ${name} in every string of a YAML value; a string that is exactly ${name} becomes the raw value. */
export function substitute<T>(value: T, vars: Record<string, Scalar>): T {
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = /^\$\{(\w+)\}$/.exec(v);
      if (whole) {
        if (!(whole[1]! in vars)) throw new Error(`unknown variable \${${whole[1]}}`);
        return vars[whole[1]!];
      }
      return v.replace(/\$\{(\w+)\}/g, (_, k: string) => {
        if (!(k in vars)) throw new Error(`unknown variable \${${k}}`);
        return String(vars[k]);
      });
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(value) as T;
}
