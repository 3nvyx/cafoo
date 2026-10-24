import { describe, expect, it } from 'vitest';
import { CrsClient } from '../src/client.js';
import { createCrsMcpServer, crsTools } from '../src/mcp.js';

const tools = crsTools({ client: new CrsClient({ mode: 'replay' }), asOf: '2026-10-24' });
const byName = (n: string) => tools.find((t) => t.name === n)!;

describe('crs MCP tools', () => {
  it('exposes six read-only tools', () => {
    expect(tools.map((t) => t.name)).toEqual(['crs_personas', 'crs_credit_report', 'crs_identity_verify', 'crs_fraud_score', 'crs_public_records', 'crs_cascade']);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(createCrsMcpServer({ client: new CrsClient({ mode: 'replay' }) })).toMatchObject({ type: 'sdk', name: 'crs' });
  });

  it('returns text JSON plus structuredContent', async () => {
    const r = await byName('crs_cascade').handler({ personaId: 'P07', subjectKind: 'customer_guarantor' } as never, {});
    const s = r.structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ personaId: 'P07', tier: 'BLOCK', decision: 'DECLINE', mode: 'replay' });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(s);
  });

  it('credit report tool omits raw unless asked', async () => {
    const a = await byName('crs_credit_report').handler({ personaId: 'P15', bureau: 'transunion' } as never, {});
    expect((a.structuredContent as Record<string, unknown>).raw).toBeUndefined();
    expect(a.structuredContent).toMatchObject({ facts: { fileStatus: 'frozen' } });
    const b = await byName('crs_credit_report').handler({ personaId: 'P15', bureau: 'transunion', raw: true } as never, {});
    expect((b.structuredContent as { raw: unknown[] }).raw).toHaveLength(1);
  });

  it('reports errors as isError results instead of throwing', async () => {
    const r = await byName('crs_identity_verify').handler({ personaId: 'P99' } as never, {});
    expect(r.isError).toBe(true);
  });
});
