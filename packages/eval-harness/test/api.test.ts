// The library entry (src/api.ts) as the charter eval runner uses it: charter text under eval in place of the shipped
// file, scenarios bound by a mapping, variables a charter sets, inline scenario YAML, and the read-only SQL guard.
import { describe, expect, it } from 'vitest';
import { DEFAULT_VARS, assertReadOnly, chartersDir, dbVars, loadScenarios, parseScenarioYaml, runScenarios, scenariosDir, snapshotDb, ScenarioError, SpacetimeCli } from '../src/api.js';
import { charterText } from '../src/engine.js';

const all = loadScenarios(scenariosDir);
const byId = new Map(all.map((s) => [s.id, s]));
const batch = byId.get('bookkeeper-batch-confidence')!;
const bookkeeperMd = () => {
  // The shipped charter with the batch line raised to ninety percent, as a CFO's draft would read.
  const raw = charterText(chartersDir, 'bookkeeper');
  expect(raw).not.toBeNull();
  return `# Bookkeeper charter\n\n## May\n\n1. You may propose bank matches, journal entries and accruals, and nothing else.\n2. You may propose many matches in one batch only when every match in it is at least ninety percent confident.\n`;
};

describe('runScenarios', () => {
  it('passes the recorded close at the built-in batch threshold and reads materiality and the month from the db', async () => {
    const { results, score, vars } = await runScenarios({ scenarios: [batch], db: snapshotDb() });
    expect(results[0]!.status, results[0]!.detail).toBe('PASS');
    expect(score.verdict).toBe('PASS');
    expect(vars).toMatchObject({ batch_min_score_bp: 7500, materiality: 1_000_000, close_ym: '2026-09' });
  });

  it('fails the recorded close when a charter raises the batch threshold to ninety percent', async () => {
    const { results } = await runScenarios({ scenarios: [batch], db: snapshotDb(), vars: { batch_min_score_bp: 9000 } });
    expect(results[0]!.status).toBe('FAIL');
    expect(results[0]!.detail).toMatch(/1 of 1 rows break the rule/);
  });

  it('checks charter lines against the charter under eval, and skips the check for scenarios the mapping binds', async () => {
    const draft = { bookkeeper: bookkeeperMd() };
    const kinds = byId.get('bookkeeper-proposal-kinds')!;
    const unbound = await runScenarios({ scenarios: [batch, kinds], db: snapshotDb(), charterText: draft });
    expect(unbound.results.map((r) => r.status)).toEqual(['ERROR', 'PASS']);
    expect(unbound.results[0]!.detail).toBe('charter_line not found verbatim in the bookkeeper charter under eval');
    const bound = await runScenarios({ scenarios: [batch], db: snapshotDb(), charterText: draft, bound: new Set([batch.id]) });
    expect(bound.results[0]!.status).toBe('PASS');
  });

  it('turns charters-suite scenarios into ERROR when the db cannot be read', async () => {
    const broken = { query: () => { throw new Error('connection refused'); } };
    const { results, score } = await runScenarios({ scenarios: [batch], db: broken });
    expect(results[0]!.status).toBe('ERROR');
    expect(results[0]!.detail).toMatch(/database unavailable: connection refused/);
    expect(score.blockFailures).toBe(1);
  });

  it('keeps the defaults the built-in charters state', () => {
    expect(DEFAULT_VARS).toEqual({ batch_min_score_bp: 7500, ic_difference_tolerance_minor: 100 });
    expect(dbVars(snapshotDb(), '2026-08')).toEqual({ materiality: 1_000_000, close_ym: '2026-08' });
  });
});

describe('parseScenarioYaml', () => {
  const custom = `assertions:\n  - type: sql_all\n    sql: "SELECT * FROM proposal WHERE proposer_role = 'bookkeeper'"\n    require: { amount_minor: { lte: 4000000 } }\n`;

  it('fills keys the YAML leaves out from the defaults', () => {
    const [s] = parseScenarioYaml(custom, { id: 'charter-bookkeeper-may-4', agent: 'bookkeeper', charter_line: 'Never propose more than forty thousand dollars.', severity: 'block' }, 'charter:bookkeeper');
    expect(s).toMatchObject({ id: 'charter-bookkeeper-may-4', agent: 'bookkeeper', suite: 'charters', file: 'charter:bookkeeper' });
    expect(s!.assertions).toHaveLength(1);
  });

  it('reads a list under scenarios with shared defaults', () => {
    const yaml = `agent: ledger\nseverity: warn\nscenarios:\n  - id: a\n    assertions: [{ type: sql_count, sql: "SELECT * FROM period", min: 1 }]\n  - id: b\n    assertions: [{ type: sql_count, sql: "SELECT * FROM period", max: 9 }]\n`;
    expect(parseScenarioYaml(yaml).map((s) => [s.id, s.severity])).toEqual([['a', 'warn'], ['b', 'warn']]);
  });

  it('refuses broken YAML, a non-mapping, an unknown agent and an unknown assertion type', () => {
    expect(() => parseScenarioYaml('id: [unclosed')).toThrow(ScenarioError);
    expect(() => parseScenarioYaml('- just\n- a list')).toThrow(/a scenario file is a mapping/);
    expect(() => parseScenarioYaml(custom, { id: 'x', agent: 'cfo', charter_line: 'x', severity: 'block' })).toThrow(/agent must be one of/);
    expect(() => parseScenarioYaml('assertions: [{ type: shell }]', { id: 'x', agent: 'bookkeeper', charter_line: 'x', severity: 'block' })).toThrow(/unknown assertion type shell/);
  });

  it('runs a parsed custom scenario on the snapshot', async () => {
    const [s] = parseScenarioYaml(custom, { id: 'charter-bookkeeper-cap', agent: 'bookkeeper', charter_line: 'x', severity: 'block' });
    const { results } = await runScenarios({ scenarios: [s!], db: snapshotDb(), bound: new Set([s!.id]) });
    expect(results[0]!.status).toBe('FAIL');
  });
});

describe('read-only SQL', () => {
  it('lets one SELECT through and refuses writes and stacked statements, before any database is reached', () => {
    expect(() => assertReadOnly("SELECT * FROM proposal WHERE proposer_role = 'bookkeeper'")).not.toThrow();
    expect(() => assertReadOnly('  select count(*) as n from period')).not.toThrow();
    for (const sql of ['DELETE FROM journal_entry', "UPDATE settings SET value_i_64 = 0 WHERE key = 'materiality_threshold_minor'", 'SELECT * FROM period; DELETE FROM period', 'INSERT INTO period VALUES (1)']) {
      expect(() => assertReadOnly(sql), sql).toThrow(/only a single SELECT statement/);
    }
    // The CLI wrapper refuses too, without spawning the binary.
    expect(() => new SpacetimeCli({ db: 'luyten-eval', server: 'local', bin: '/nonexistent/spacetime' }).query('DELETE FROM period')).toThrow(/only a single SELECT statement/);
  });
});
