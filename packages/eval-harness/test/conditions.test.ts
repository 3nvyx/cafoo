import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPath, matchRow, substitute } from '../src/conditions.js';
import { decodeSqlJson } from '../src/db.js';

describe('decodeSqlJson', () => {
  const rows = decodeSqlJson(readFileSync(new URL('./fixtures/sql-proposal-sample.json', import.meta.url), 'utf8'));
  it('turns enums into snake_case tags, options into value-or-null, identities and timestamps into scalars', () => {
    const r = rows[0]!;
    expect(typeof r.id).toBe('number');
    expect(['journal_entry', 'bank_match', 'revenue_schedule', 'credit_decision', 'accrual', 'vendor_block']).toContain(r.kind);
    expect(['open', 'approved', 'rejected', 'amended', 'awaiting_cfo', 'sent_back', 'superseded']).toContain(r.status);
    expect(String(r.proposed_by)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typeof r.created_at).toBe('number');
    expect(r.close_task_id === null || typeof r.close_task_id === 'number').toBe(true);
  });
});

describe('conditions', () => {
  const row = { id: 1, kind: 'bank_match', summary_plain: 'Match 9 bank transactions', payload_json: JSON.stringify({ matches: [{ scoreBp: 8000 }, { scoreBp: 7000 }] }), note: null };
  it('walks into JSON text columns', () => {
    expect(getPath(row, 'payload_json.matches.1.scoreBp')).toBe(7000);
  });
  it('evaluates operators, each, any_of and not', () => {
    expect(matchRow(row, { kind: 'bank_match', summary_plain: { min_length: 10 } })).toBe(true);
    expect(matchRow(row, { 'payload_json.matches': { each: { scoreBp: { gte: 7500 } } } })).toBe(false);
    expect(matchRow(row, { 'payload_json.matches': { min_items: 2, max_items: 2 } })).toBe(true);
    expect(matchRow(row, { any_of: [{ kind: 'accrual' }, { note: { is_null: true } }] })).toBe(true);
    expect(matchRow(row, { not: { kind: { in: ['bank_match'] } } })).toBe(false);
    expect(matchRow(row, { summary_plain: { imatches: '^match' } })).toBe(true);
  });
  it('compares ids across number and string', () => {
    expect(matchRow({ a: 29 }, { a: '29' })).toBe(true);
  });
  it('substitutes variables, keeping numbers numeric when the whole string is a variable', () => {
    expect(substitute({ sql: 'x >= ${m}', v: '${m}' }, { m: 1000000 })).toEqual({ sql: 'x >= 1000000', v: 1000000 });
    expect(() => substitute('${nope}', {})).toThrow(/unknown variable/);
  });
});
