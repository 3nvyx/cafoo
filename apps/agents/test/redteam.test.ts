import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCall, HARNESSES } from '../src/harness';
import { call, ruleSuite } from './helpers';

const h = HARNESSES.redteam;
const critique = (input: Record<string, unknown> = {}) =>
  call('submit_critique', { proposalId: '14', body: 'Confidence 61% is below the auto threshold and the counterparty only partly matches.', summaryPlain: 'The Red Team doubts this match: the name only partly fits.', ...input });
const status = (s: string | undefined) => ({ proposalStatus: () => s });

ruleSuite(h, {
  'redteam.may.1': {
    allow: [{ call: critique(), ctx: status('Open') }, { call: critique() }, { call: call('search_policies', { query: 'bank match threshold' }) }],
    deny: [
      { call: critique({ proposalId: undefined }), why: /one Proposal/ },
      { call: critique(), ctx: status('SentBack'), why: /SentBack, not open/ },
    ],
  },
  'redteam.never.1': {
    allow: [{ call: critique() }],
    deny: [
      { call: call('mcp__bookkeeper__propose_journal_entry', {}), why: /critiques only/ },
      { call: call('mcp__advisor__reject_proposal', {}), why: /critiques only/ },
    ],
  },
  'redteam.never.2': {
    allow: [{ call: critique() }],
    deny: [{ call: call('mcp__advisor__approve_proposal', {}), why: /posts to the ledger/ }],
  },
  'redteam.never.3': {
    allow: [{ call: critique(), ctx: status('Open') }, { call: critique() }],
    deny: [
      { call: critique(), ctx: status('Approved'), why: /already ruled/ },
      { call: critique(), ctx: status('awaiting_cfo'), why: /late critique/ },
    ],
  },
  'redteam.plain': {
    allow: [{ call: critique() }],
    deny: [{ call: critique({ summaryPlain: 'Weak match at 6100 bp; score below 762000 threshold.' }), why: /raw number "762000"/ }],
  },
});

describe('red team harness as a whole', () => {
  it('lets a clean critique on an open Proposal through', () => {
    expect(checkCall(h, critique(), status('Open'))).toEqual({ allow: true });
  });
  it('names both broken rules on a late critique', () => {
    const d = checkCall(h, critique(), status('Rejected'));
    expect(d).toMatchObject({ allow: false, ruleIds: ['redteam.may.1', 'redteam.never.3'] });
  });
  it('has only its two Vercel AI SDK tools and the step cap it ran with before', () => {
    expect([...h.tools]).toEqual(['search_policies', 'submit_critique']);
    expect(h.maxTurns).toBe(6);
  });
});

describe('scripted Red Team critiques (Demo mode fallback)', () => {
  it('all pass the Red Team harness on an open Proposal', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/redteam.ts', import.meta.url)), 'utf8');
    const fn = src.slice(src.indexOf('function scriptedCritique'), src.indexOf('async function grokCritique'));
    const summaries = [...fn.matchAll(/summaryPlain: `([^`$]*)`/g)].map(m => m[1]!);
    expect(summaries.length).toBeGreaterThanOrEqual(7);
    for (const s of summaries) expect(checkCall(h, critique({ summaryPlain: s }), status('Open')), s).toEqual({ allow: true });
  });
});
