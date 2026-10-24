// The active charter: the eval override forces a draft, a published version applies next, the built-in charter last;
// and the tool gate follows whichever applies through harnessGate's resolve option.
import type { HookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { activeCharter, activeHarnessResolver, builtinCharter, charterSource, DEFAULT_PARAMS } from '../src/charter/active';
import { CharterError, defaultMapping } from '../src/charter/build';
import { agentPrompt, HARNESSES } from '../src/harness';
import { harnessGate } from '../src/harness/hook';
import { STDB_DB } from '../src/env';
import type { RoleConn } from '../src/stdb';
import { ninetyPercentDraft } from '../src/charter/examples';

/** A connection whose cache holds just these charter_version rows. */
function conn(rows: { id: bigint; role: string; version: number; status: string; bodyMd: string; mappingJson: string }[]): RoleConn {
  const charterVersion = { iter: () => rows.map(r => ({ ...r, status: { tag: r.status } }))[Symbol.iterator]() };
  return { role: 'advisor', db: { charterVersion } } as unknown as RoleConn;
}
const draft = ninetyPercentDraft();
/** The override as the dry run sets it: for this process's database. */
const overrideEnv = (o: unknown, db: string = STDB_DB) => ({ CHARTER_OVERRIDE_JSON: JSON.stringify(o), CHARTER_OVERRIDE_DB: db }) as NodeJS.ProcessEnv;
const batch = { tool: 'mcp__bookkeeper__propose_bank_match', input: { periodYm: '2026-09', rationale: 'x', summaryPlain: 'Match two customer payments to their invoices.', matches: [{ bankTxId: '1', targetKind: 'invoice', targetId: '1', scoreBp: 9500 }, { bankTxId: '2', targetKind: 'invoice', targetId: '2', scoreBp: 8571 }] } };
const live = (version: number, status = 'Live', md = draft.bodyMd, mapping: unknown = draft.mapping) => ({ id: BigInt(100 + version), role: 'bookkeeper', version, status, bodyMd: md, mappingJson: JSON.stringify(mapping) });

describe('activeCharter', () => {
  it('is the built-in charter, version 0, with the default params, when nothing else applies', () => {
    const c = activeCharter(undefined, 'credit', {});
    expect(c).toBe(builtinCharter('credit'));
    expect(c).toMatchObject({ role: 'credit', version: 0, harness: HARNESSES.credit, params: DEFAULT_PARAMS });
    expect(c.versionId).toBeUndefined();
    expect(c.bodyMd).toMatch(/^# Credit & Risk charter/);
    expect(c.prompt).toBe(agentPrompt(HARNESSES.credit));
    expect(builtinCharter('redteam').prompt).toBe(agentPrompt(HARNESSES.redteam, { withInstructions: true }));
    expect(charterSource(c)).toBe('built-in');
  });

  it('forces the override draft for its role only', () => {
    const env = overrideEnv({ role: 'bookkeeper', bodyMd: draft.bodyMd, mapping: draft.mapping, version: 3 });
    const c = activeCharter(undefined, 'bookkeeper', env);
    expect(c).toMatchObject({ role: 'bookkeeper', version: 3, bodyMd: draft.bodyMd });
    expect(c.versionId).toBeUndefined();
    expect(c.params.batchMinScoreBp).toBe(9000);
    expect(c.prompt.startsWith(draft.bodyMd)).toBe(true);
    expect(c.prompt).toMatch(/every scoreBp is at least 9000;[^\n]*\(bookkeeper\.may\.2\)/);
    expect(charterSource(c)).toBe('dry-run override v3');
    expect(activeCharter(undefined, 'revenue', env)).toBe(builtinCharter('revenue'));
  });

  it('ignores an override meant for another database, or with no database named, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o = { role: 'bookkeeper', bodyMd: draft.bodyMd, mapping: draft.mapping, version: 3 };
    expect(activeCharter(undefined, 'bookkeeper', overrideEnv(o, 'cafoo-eval-elsewhere'))).toBe(builtinCharter('bookkeeper'));
    expect(activeCharter(undefined, 'bookkeeper', { CHARTER_OVERRIDE_JSON: JSON.stringify({ ...o, version: 4 }) })).toBe(builtinCharter('bookkeeper'));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/CHARTER_OVERRIDE_DB is "cafoo-eval-elsewhere", not this process's database .*; ignored/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/CHARTER_OVERRIDE_DB is unset/));
    warn.mockRestore();
  });

  it('refuses an override that fails coverage, such as an empty mapping', () => {
    expect(() => activeCharter(undefined, 'bookkeeper', overrideEnv({ role: 'bookkeeper', bodyMd: '# x\n\n## Plain summary rule\n\nanything', mapping: [] }))).toThrow(/fails coverage: .*May 1 is a shipped line/);
    const dropped = draft.bodyMd.replace(/^3\. Never propose without citing evidence.*\n/m, '');
    expect(() => activeCharter(undefined, 'bookkeeper', overrideEnv({ role: 'bookkeeper', bodyMd: dropped, mapping: defaultMapping('bookkeeper', dropped) }))).toThrow(/Must never 3 is a shipped line/);
  });

  it('carries several roles in one override: the draft and the other roles\' published charters', () => {
    const env = overrideEnv({ charters: [{ role: 'bookkeeper', bodyMd: draft.bodyMd, mapping: draft.mapping, version: 5 }, { role: 'revenue', bodyMd: builtinCharter('revenue').bodyMd, mapping: defaultMapping('revenue'), version: 2 }] });
    expect(charterSource(activeCharter(undefined, 'bookkeeper', env))).toBe('dry-run override v5');
    expect(charterSource(activeCharter(undefined, 'revenue', env))).toBe('dry-run override v2');
    expect(activeCharter(undefined, 'credit', env)).toBe(builtinCharter('credit'));
    expect(() => activeCharter(undefined, 'credit', overrideEnv({ charters: [{ role: 'credit', bodyMd: 'x', mapping: [] }, { role: 'credit', bodyMd: 'x', mapping: [] }] }))).toThrow(/two credit charters/);
  });

  it('throws on a broken override instead of running the built-in charter in its place', () => {
    expect(() => activeCharter(undefined, 'bookkeeper', { CHARTER_OVERRIDE_JSON: '{nope', CHARTER_OVERRIDE_DB: STDB_DB })).toThrow(CharterError);
    expect(() => activeCharter(undefined, 'bookkeeper', overrideEnv({ role: 'cfo', bodyMd: 'x', mapping: [] }))).toThrow(/known role/);
    const bad = draft.mapping.map(e => (e.label === 'May 2' ? { ...e, target: { kind: 'rule', template: 'batch_min_confidence', params: { minScoreBp: 1 } } } : e));
    expect(() => activeCharter(undefined, 'bookkeeper', overrideEnv({ role: 'bookkeeper', bodyMd: draft.bodyMd, mapping: bad }))).toThrow(/7500 \(the shipped 75%\) to 10000/);
  });

  it('applies the published version, ignoring drafts and retired versions, and caches it by row id', () => {
    const c1 = conn([live(1, 'Retired', draft.bodyMd, defaultMapping('bookkeeper')), live(2), live(3, 'Draft')]);
    const c = activeCharter(c1, 'bookkeeper', {});
    expect(c).toMatchObject({ version: 2, versionId: 102n });
    expect(c.params.batchMinScoreBp).toBe(9000);
    expect(charterSource(c)).toBe('published v2');
    expect(activeCharter(c1, 'bookkeeper', {})).toBe(c);
    expect(activeCharter(c1, 'revenue', {})).toBe(builtinCharter('revenue'));
    expect(activeCharter(conn([live(1, 'Retired')]), 'bookkeeper', {})).toBe(builtinCharter('bookkeeper'));
  });

  it('lets the override win over the published version', () => {
    const env = overrideEnv({ role: 'bookkeeper', bodyMd: builtinCharter('bookkeeper').bodyMd, mapping: defaultMapping('bookkeeper') });
    expect(activeCharter(conn([live(4)]), 'bookkeeper', env).params.batchMinScoreBp).toBe(7500);
  });

  it('falls back to the built-in charter, with a warning, when a published version no longer builds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = live(5, 'Live', draft.bodyMd, [{ label: 'May 1', text: 'x', target: { kind: 'rule', template: 'retired_template' } }]);
    expect(activeCharter(conn([broken]), 'bookkeeper', {})).toBe(builtinCharter('bookkeeper'));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/published bookkeeper charter v5 does not build/));
    warn.mockRestore();
  });
});

describe('activeHarnessResolver in the tool gate', () => {
  let n = 0;
  const pre = (agent: string, call: typeof batch): PreToolUseHookInput => ({ hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '/dev/null', cwd: '/', tool_name: call.tool, tool_input: call.input, tool_use_id: `t${++n}`, agent_type: agent, agent_id: `${agent}-1` });
  const run = (gate: ReturnType<typeof harnessGate>, input: HookInput) => gate(input, 't', { signal: new AbortController().signal });
  const reason = (out: unknown) => (out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason;

  it('resolves like harnessFor: the root query is the Advisor, unknown agent types get nothing', () => {
    const resolve = activeHarnessResolver(undefined, {});
    expect(resolve(undefined)).toBe(HARNESSES.advisor);
    expect(resolve('consolidation')).toBe(HARNESSES.consolidation);
    expect(resolve('general-purpose')).toBeUndefined();
    expect(resolve('toString')).toBeUndefined();
  });

  it('lets the shipped gate pass a batch at 85.71% and the published ninety percent charter refuse it', async () => {
    expect(await run(harnessGate(), pre('bookkeeper', batch))).toEqual({});
    const gate = harnessGate({ resolve: activeHarnessResolver(conn([live(2)]), {}) });
    expect(reason(await run(gate, pre('bookkeeper', batch)))).toMatch(/^Denied by the bookkeeper harness: bookkeeper\.may\.2 \(May 2\): a batch of 2 matches holds 1 below 90% confidence/);
  });
});
