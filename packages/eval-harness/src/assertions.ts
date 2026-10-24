import { cascade } from './cascade.js';
import { getPath, matchRow, pathsOf } from './conditions.js';
import type { Db, Row } from './db.js';
import type { Assertion, Side } from './scenarios.js';
import { CHECKS, type CheckContext } from './checks.js';

export interface AssertionResult {
  type: string;
  label: string;
  pass: boolean;
  /** One line for the table. */
  detail: string;
  /** Rows that break the rule, trimmed for the report. */
  offenders?: Row[];
  offenderCount?: number;
}

export interface EvalContext extends CheckContext {
  db: Db | null;
}

const MAX_OFFENDERS = 10;

function trimValue(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 90 ? `${v.slice(0, 87)}...` : v;
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 90 ? `${s.slice(0, 87)}...` : v;
  }
  return v;
}

export function pickColumns(rows: Row[], wanted: string[]): Row[] {
  return rows.slice(0, MAX_OFFENDERS).map((r) => {
    const cols = ['id', ...wanted.filter((w) => w !== 'id')].filter((c) => getPath(r, c) !== undefined).slice(0, 7);
    const useCols = cols.length > 1 ? cols : Object.keys(r).slice(0, 6);
    return Object.fromEntries(useCols.map((c) => [c, trimValue(getPath(r, c))]));
  });
}

function requireDb(ctx: EvalContext): Db {
  if (!ctx.db) throw new Error('this assertion needs the database (run with the charters suite and a reachable SpacetimeDB)');
  return ctx.db;
}

const keyOf = (row: Row, key: string | string[]): string =>
  (Array.isArray(key) ? key : [key]).map((k) => String(getPath(row, k) ?? '\u0000null')).join('\u0001');

function sideRows(db: Db, side: Side): Row[] {
  return db.query(side.sql).filter((r) => matchRow(r, side.where));
}

const describeBound = (a: { expect?: number; min?: number; max?: number }): string =>
  a.expect !== undefined ? `= ${a.expect}` : [a.min !== undefined ? `>= ${a.min}` : '', a.max !== undefined ? `<= ${a.max}` : ''].filter(Boolean).join(' and ');

export async function evaluate(a: Assertion, ctx: EvalContext): Promise<AssertionResult> {
  const label = a.label ?? a.type;
  switch (a.type) {
    case 'sql_count': {
      const rows = requireDb(ctx).query(a.sql);
      const only = rows.length === 1 && Object.keys(rows[0]!).length === 1 && !a.where ? Object.values(rows[0]!)[0] : undefined;
      const n = typeof only === 'number' && /count\s*\(/i.test(a.sql) ? only : rows.filter((r) => matchRow(r, a.where)).length;
      const ok = (a.expect === undefined || n === a.expect) && (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max);
      return { type: a.type, label, pass: ok, detail: `count ${n}, expected ${describeBound(a)}` };
    }
    case 'sql_all': {
      const rows = requireDb(ctx).query(a.sql).filter((r) => matchRow(r, a.where));
      const offenders = a.require ? rows.filter((r) => !matchRow(r, a.require)) : rows;
      const expect = a.expect_rows ?? 0;
      const ok = offenders.length === expect;
      const show = a.show ?? [...pathsOf(a.require), ...pathsOf(a.where)];
      return {
        type: a.type,
        label,
        pass: ok,
        detail: a.require
          ? `${offenders.length} of ${rows.length} rows break the rule${expect ? ` (expected ${expect})` : ''}`
          : `${offenders.length} offending rows${expect ? ` (expected ${expect})` : ''}`,
        offenders: ok ? undefined : pickColumns(offenders, show),
        offenderCount: offenders.length,
      };
    }
    case 'sql_covers': {
      const rows = requireDb(ctx).query(a.sql).filter((r) => matchRow(r, a.where));
      const min = a.min ?? 1;
      const counts = new Map<string, number>();
      for (const r of rows) {
        const v = String(getPath(r, a.column));
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const missing = a.values.filter((v) => (counts.get(String(v)) ?? 0) < min);
      const seen = a.values.map((v) => `${v}=${counts.get(String(v)) ?? 0}`).join(', ');
      return {
        type: a.type,
        label,
        pass: missing.length === 0,
        detail: missing.length ? `missing ${missing.join(', ')} (need >= ${min} each; have ${seen})` : `all ${a.values.length} present (${seen})`,
      };
    }
    case 'sql_unique': {
      const rows = requireDb(ctx).query(a.sql).filter((r) => matchRow(r, a.where));
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        const k = keyOf(r, a.key);
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      const dups = [...groups.values()].filter((g) => g.length > 1).flat();
      const keys = Array.isArray(a.key) ? a.key : [a.key];
      return {
        type: a.type,
        label,
        pass: dups.length === 0,
        detail: dups.length ? `${dups.length} rows share a ${keys.join('+')}` : `${rows.length} rows, ${keys.join('+')} unique`,
        offenders: dups.length ? pickColumns(dups, keys) : undefined,
        offenderCount: dups.length,
      };
    }
    case 'sql_anti_join':
    case 'sql_semi_join': {
      const db = requireDb(ctx);
      const left = sideRows(db, a.left);
      const rights = Array.isArray(a.right) ? a.right : [a.right];
      const rightKeys = new Set(rights.flatMap((side) => sideRows(db, side).map((r) => keyOf(r, side.key))));
      const wantMatch = a.type === 'sql_semi_join';
      const offenders = left.filter((r) => rightKeys.has(keyOf(r, a.left.key)) === wantMatch);
      const expect = a.expect_rows ?? 0;
      const ok = offenders.length === expect;
      const lk = Array.isArray(a.left.key) ? a.left.key : [a.left.key];
      return {
        type: a.type,
        label,
        pass: ok,
        detail: `${offenders.length} of ${left.length} rows ${wantMatch ? 'have a forbidden match' : 'have no match'}${expect ? ` (expected ${expect})` : ''}`,
        offenders: ok ? undefined : pickColumns(offenders, a.show ?? [...lk, ...pathsOf(a.left.where)]),
        offenderCount: offenders.length,
      };
    }
    case 'cascade_decision': {
      const asOf = a.as_of ?? ctx.asOf;
      const r = await cascade(a.persona, a.subject_kind ?? 'customer_guarantor', asOf);
      const decisionOk = r.decision === a.expect;
      const tierOk = a.expect_tier === undefined || r.tier === a.expect_tier;
      const reasons = r.reasons.map((x) => x.code).join(', ') || 'none';
      return {
        type: a.type,
        label,
        pass: decisionOk && tierOk,
        detail: `${a.persona}: got ${r.tier}/${r.decision}, expected ${a.expect_tier ?? '*'}/${a.expect} (reasons: ${reasons})`,
      };
    }
    case 'check': {
      const fn = CHECKS[a.name];
      if (!fn) throw new Error(`unknown check ${a.name}; known: ${Object.keys(CHECKS).join(', ')}`);
      const r = await fn(requireDb(ctx), a.params ?? {}, ctx);
      return {
        type: a.type,
        label: a.label ?? a.name,
        pass: r.offenders.length === 0,
        detail: r.offenders.length ? `${r.offenders.length} of ${r.checked} ${r.unit} break the rule` : `${r.checked} ${r.unit} checked, all hold`,
        offenders: r.offenders.length ? r.offenders.slice(0, MAX_OFFENDERS).map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, trimValue(v)]))) : undefined,
        offenderCount: r.offenders.length,
      };
    }
  }
}
