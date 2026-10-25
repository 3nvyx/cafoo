// The tools each role may call, as GET /charters/catalog reports them for the Charters page: one entry per harness
// tool, grouped by source, and the web's Demo-mode copy (mock/seed/charters.json) kept equal to it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HARNESSES, type Role } from '../src/harness';
import { CRS_TOOLS, baseName } from '../src/harness/rules';
import { charterCatalog } from '../src/charter/routes';
import { TOOL_SOURCES, roleTools, toolCatalog } from '../src/charter/tools';

const roles = Object.keys(HARNESSES) as Role[];

describe('charter tool catalog', () => {
  it('describes every tool on every harness allowlist, and nothing the harness does not allow', () => {
    for (const role of roles) {
      const tools = roleTools(role).filter(t => t.kind === 'tool');
      expect(tools.map(t => t.name).sort()).toEqual([...new Set(HARNESSES[role].tools.map(baseName))].sort());
      for (const t of tools) expect(t.description.length, `${role} ${t.name}`).toBeGreaterThan(10);
    }
  });

  it('lists the CRS MCP tools and the cascade for Credit & Risk only', () => {
    const credit = roleTools('credit');
    for (const name of [...CRS_TOOLS, 'run_credit_cascade']) expect(credit.find(t => t.name === name)?.source, name).toBe('crs');
    expect(credit.find(t => t.name === 'crs_cascade')?.description).toMatch(/identity, fraud, TransUnion, Equifax, Experian, public records/);
    expect(credit.find(t => t.name === 'collect_public_footprint')?.source).toBe('brightdata');
    for (const role of roles.filter(r => r !== 'credit')) expect(roleTools(role).some(t => t.source === 'crs'), role).toBe(false);
  });

  it('groups tools in source order and adds the Bookkeeper services', () => {
    const order = Object.keys(TOOL_SOURCES);
    for (const role of roles) {
      const idx = roleTools(role).map(t => order.indexOf(t.source));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
    const services = roleTools('bookkeeper').filter(t => t.kind === 'service');
    expect(services.map(s => s.source)).toEqual(['brightdata', 'nessie']);
    expect(roleTools('bookkeeper').map(t => t.name)).toEqual(expect.arrayContaining(['propose_bank_match', 'propose_accrual', 'score_bank_matches', 'detect_missing_accruals']));
  });

  it('is part of the charter catalog, and the web Demo-mode copy matches it', () => {
    expect(charterCatalog().tools).toEqual(toolCatalog());
    const web = JSON.parse(readFileSync(new URL('../../web/src/lib/data/mock/seed/charters.json', import.meta.url), 'utf8'));
    expect(web.tools).toEqual(toolCatalog());
  });
});
