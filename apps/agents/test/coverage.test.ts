// Every numbered charter line (and the Plain summary rule) maps to exactly one harness rule or one evalOnly entry
// whose scenario file exists, so a new charter line cannot land without a runtime rule or an eval behind it. A rule
// that covers only part of its line says so with `partial`, naming the scenario that checks the rest.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chartersDir, HARNESSES, type CharterLine, type Role } from '../src/harness';

const scenariosDir = fileURLToPath(new URL('../../../packages/eval-harness/scenarios/', import.meta.url));
const SECTIONS: Record<string, string> = { May: 'May', 'Must never': 'Must never', Escalates: 'Escalates' };
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Charter lines by label: "May 1", "Must never 2", "Escalates 3", "Plain summary". */
function charterLines(file: string): Map<string, string> {
  const lines = new Map<string, string>();
  let section: string | undefined;
  for (const raw of readFileSync(`${chartersDir}${file}`, 'utf8').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      section = heading[1] === 'Plain summary rule' ? 'Plain summary' : SECTIONS[heading[1]!];
      continue;
    }
    if (!section || !raw.trim()) continue;
    if (section === 'Plain summary') lines.set('Plain summary', squash(`${lines.get('Plain summary') ?? ''} ${raw}`));
    const numbered = /^(\d+)\.\s+(.*)$/.exec(raw);
    if (numbered) lines.set(`${section} ${numbered[1]}`, squash(numbered[2]!));
  }
  return lines;
}

/** `agent` and `charter_line` of a scenario file (top-level keys; the files are flat YAML). */
function scenarioHeader(file: string) {
  const text = readFileSync(`${scenariosDir}${file}`, 'utf8');
  const agent = /^agent:\s*(\S+)/m.exec(text)?.[1];
  const line = /^charter_line:\s*"(.*)"\s*$/m.exec(text)?.[1];
  return { agent, charterLine: line ? squash(line.replace(/\\"/g, '"')) : undefined };
}

describe.each(Object.keys(HARNESSES) as Role[])('%s charter coverage', role => {
  const h = HARNESSES[role];
  const lines = charterLines(h.charterFile);
  const targets = new Map<string, string[]>();
  const add = (charter: CharterLine, target: string) => targets.set(charter, [...(targets.get(charter) ?? []), target]);
  for (const r of h.rules) add(r.charter, `rule ${r.id}${r.partial ? ` (partial; rest: eval ${r.partial.scenario})` : ''}`);
  for (const e of h.evalOnly) add(e.charter, `eval ${e.scenario}`);
  /** Every scenario the harness names, with the line it stands for. */
  const scenarios = [...h.evalOnly.map(e => ({ charter: e.charter, scenario: e.scenario })), ...h.rules.flatMap(r => (r.partial ? [{ charter: r.charter, scenario: r.partial.scenario }] : []))];

  it('parses the charter into numbered lines and the Plain summary rule', () => {
    expect(lines.has('May 1')).toBe(true);
    expect(lines.has('Must never 1')).toBe(true);
    expect(lines.has('Escalates 1')).toBe(true);
    expect(lines.get('Plain summary')).toMatch(/one plain sentence/);
  });

  it('maps every charter line to exactly one rule or evalOnly scenario', () => {
    const unmapped = [...lines.keys()].filter(l => !targets.has(l));
    const doubled = [...targets].filter(([, t]) => t.length > 1).map(([l, t]) => `${l}: ${t.join(', ')}`);
    expect(unmapped, `unmapped ${role} charter lines`).toEqual([]);
    expect(doubled, `${role} charter lines mapped twice`).toEqual([]);
  });

  it('references only lines the charter has', () => {
    expect([...targets.keys()].filter(l => !lines.has(l))).toEqual([]);
  });

  it('points every evalOnly entry and partial rule at a scenario file that exists', () => {
    for (const e of scenarios) expect(existsSync(`${scenariosDir}${e.scenario}`), e.scenario).toBe(true);
  });

  it('says what the scenario of a partial rule checks', () => {
    for (const r of h.rules.filter(x => x.partial)) expect(r.partial!.rest.length, r.id).toBeGreaterThan(10);
  });

  it("checks the same line as its own agent's scenario", () => {
    for (const e of scenarios) {
      const s = scenarioHeader(e.scenario);
      if (s.agent !== role) continue;
      expect(lines.get(e.charter), `${e.scenario} charter_line`).toContain(s.charterLine);
    }
  });
});

describe('harness data', () => {
  it('lists exact tool names in every harness, never wildcards', () => {
    for (const h of Object.values(HARNESSES)) expect(h.tools.filter(t => t.includes('*')), h.role).toEqual([]);
  });
});

describe('rule ids', () => {
  it('are unique and follow <role>.<may|never|escalates>.<n> or <role>.plain, matching their charter line', () => {
    const all = Object.values(HARNESSES).flatMap(h => h.rules.map(r => ({ role: h.role, ...r })));
    expect(new Set(all.map(r => r.id)).size).toBe(all.length);
    const word: Record<string, string> = { May: 'may', 'Must never': 'never', Escalates: 'escalates' };
    for (const r of all) {
      const m = /^(May|Must never|Escalates) (\d+)$/.exec(r.charter);
      expect(r.id).toBe(m ? `${r.role}.${word[m[1]!]}.${m[2]}` : `${r.role}.plain`);
    }
  });
});
