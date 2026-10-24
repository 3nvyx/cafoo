import { describe, expect, it } from 'vitest';
import { CrsClient } from '../src/client.js';
import { creditCheckSummaryJson, runCascade } from '../src/cascade.js';
import { personas } from '../src/csv.js';
import { classify, deriveTier, POLICY } from '../src/tiers.js';

const client = new CrsClient({ mode: 'replay' });
const AS_OF = new Date('2026-10-24T12:00:00Z');

/** The facts as the ledger module reads them back: through the recorded summaryJson. */
const recorded = (json: string): unknown => (JSON.parse(json) as { facts?: unknown }).facts;

const bureau = (score: number) => ({ fileStatus: 'returned', score, tradelines: 9, derogatories: 0, activeDerogatories: 0, collections: 0, publicRecords: [] });
const clean = () => ({
  identity: { result: 'PASS', codes: [], texts: [], deceased: false, synthetic: false, available: true },
  fraud: { score: 12, level: 'low', signals: [], available: true },
  bureaus: { transunion: bureau(781), equifax: bureau(760), experian: bureau(790) } as Record<string, unknown>,
  publicRecords: { available: true, counts: { bankruptcies: 0, judgments: 0, liens: 0 }, bankruptcies: [], judgments: [], liens: [], criminal: [], evictions: [] } as Record<string, unknown> | undefined,
});

describe('deriveTier over recorded evidence', () => {
  for (const p of personas()) {
    it(`${p.personaId}: the module derives the cascade's own tier from every recorded row`, async () => {
      const r = await runCascade(client, p.personaId, { subjectKind: 'customer_guarantor', asOf: AS_OF });
      for (const ev of r.evidence) {
        const d = deriveTier(recorded(creditCheckSummaryJson(r, ev)), AS_OF);
        expect({ tier: d.tier, decision: d.decision, terms: d.paymentTermsDays }, `${ev.product}: ${r.summaryTechnical}`).toEqual({ tier: r.tier, decision: r.decision, terms: r.paymentTermsDays });
      }
    });
  }

  it('keeps the evidence row fields the evals read (requestId) next to the facts', async () => {
    const r = await runCascade(client, 'P01', { subjectKind: 'customer_guarantor', asOf: AS_OF });
    const row = JSON.parse(creditCheckSummaryJson(r, r.evidence[0]!)) as Record<string, unknown>;
    expect(row).toMatchObject({ product: 'tu_identity_verification', requestId: r.evidence[0]!.requestId, summary: r.evidence[0]!.summary });
    expect(row.facts).toEqual(JSON.parse(JSON.stringify(r.facts)));
  });

  it('derives tier A for a clean full cascade and B under 740', () => {
    expect(deriveTier(clean(), AS_OF)).toMatchObject({ tier: 'A', decision: 'APPROVE', paymentTermsDays: 45 });
    const f = clean();
    f.bureaus.equifax = bureau(700);
    expect(deriveTier(f, AS_OF)).toMatchObject({ tier: 'B', decision: 'APPROVE', paymentTermsDays: POLICY.paymentTermsDays.B });
  });

  it('refuses evidence that skips the bureaus or the records: missing evidence must not read as clean credit', () => {
    const noBureaus = { ...clean(), bureaus: {} };
    // The rules alone would approve it: no bureau file means no negative reason at all.
    expect(classify(noBureaus.identity as never, noBureaus.fraud as never, {}, noBureaus.publicRecords as never, AS_OF).decision).toBe('APPROVE');
    expect(() => deriveTier(noBureaus, AS_OF)).toThrow(/lacks transunion, equifax, experian.*all three credit bureaus/);
    const two = clean();
    delete two.bureaus.experian;
    expect(() => deriveTier(two, AS_OF)).toThrow(/lacks experian/);
    const noRecords = clean();
    delete noRecords.publicRecords;
    expect(() => deriveTier(noRecords, AS_OF)).toThrow(/public-records search/);
  });

  it('accepts an early stop only when identity or fraud already blocks', () => {
    const dead = { ...clean(), identity: { ...clean().identity, result: 'FAIL', deceased: true }, bureaus: {}, publicRecords: undefined };
    expect(deriveTier(dead, AS_OF)).toMatchObject({ tier: 'BLOCK', decision: 'DECLINE', paymentTermsDays: null });
    const highFraud = { ...clean(), fraud: { score: 88, level: 'high' }, bureaus: {}, publicRecords: undefined };
    expect(deriveTier(highFraud, AS_OF)).toMatchObject({ tier: 'BLOCK', decision: 'DECLINE' });
  });

  it('refuses malformed facts with the field that is wrong', () => {
    expect(() => deriveTier(undefined, AS_OF)).toThrow(/^facts must be an object; got nothing/);
    expect(() => deriveTier([], AS_OF)).toThrow(/^facts must be an object/);
    expect(() => deriveTier({ ...clean(), identity: { ...clean().identity, result: 'OK' } }, AS_OF)).toThrow(/facts\.identity\.result must be one of PASS, FAIL, KBA_REQUIRED; got "OK"/);
    expect(() => deriveTier({ ...clean(), identity: { ...clean().identity, deceased: 'no' } }, AS_OF)).toThrow(/facts\.identity\.deceased must be true or false/);
    expect(() => deriveTier({ ...clean(), fraud: { score: '12', level: 'low' } }, AS_OF)).toThrow(/facts\.fraud\.score must be a number or null/);
    const f = clean();
    f.bureaus.transunion = { ...bureau(781), fileStatus: 'great' };
    expect(() => deriveTier(f, AS_OF)).toThrow(/facts\.bureaus\.transunion\.fileStatus must be one of/);
    const g = clean();
    g.bureaus.transunion = { ...bureau(781), tradelines: 2.5 };
    expect(() => deriveTier(g, AS_OF)).toThrow(/facts\.bureaus\.transunion\.tradelines must be a whole number/);
    const h = clean();
    h.bureaus.dunn = bureau(800);
    expect(() => deriveTier(h, AS_OF)).toThrow(/facts\.bureaus has "dunn"/);
    const i = clean();
    i.publicRecords = { ...i.publicRecords, criminal: [{ level: 'felony', convicted: 'yes', date: null }] };
    expect(() => deriveTier(i, AS_OF)).toThrow(/facts\.publicRecords\.criminal\[0\]\.convicted must be true or false/);
  });

  it('refuses facts that contradict themselves', () => {
    expect(() => deriveTier({ ...clean(), fraud: { score: 85, level: 'low' } }, AS_OF)).toThrow(/fraud level is low, but a fraud score of 85 is high/);
    const f = clean();
    f.bureaus.equifax = { ...bureau(760), derogatories: 0, activeDerogatories: 2 };
    expect(() => deriveTier(f, AS_OF)).toThrow(/facts\.bureaus\.equifax counts do not add up/);
    const g = clean();
    g.bureaus.experian = { ...bureau(790), fileStatus: 'frozen' };
    expect(() => deriveTier(g, AS_OF)).toThrow(/facts\.bureaus\.experian has no file \(frozen\)/);
  });

  it('applies the seven-year lookback as of the date it is given, never the clock', async () => {
    const r = await runCascade(client, 'P09', { subjectKind: 'customer_guarantor', asOf: AS_OF });
    const facts = recorded(creditCheckSummaryJson(r, r.evidence[0]!));
    expect(deriveTier(facts, AS_OF)).toMatchObject({ tier: 'D', decision: 'DECLINE' });
    expect(deriveTier(facts, new Date('2029-01-01T00:00:00Z')).decision).toBe('APPROVE');
    expect(() => deriveTier(facts, new Date(Number.NaN))).toThrow(/reference date/);
  });

  it('reads record dates as UTC calendar dates in every format the records use', () => {
    const at = (date: string) => {
      const f = clean();
      f.publicRecords = { ...f.publicRecords, criminal: [{ level: 'felony', convicted: true, date }] };
      return deriveTier(f, new Date('2026-06-04T00:00:00Z')).tier;
    };
    // Exactly seven years before the reference date is inside the window; the day before is outside.
    expect([at('2019-06-04'), at('06-04-2019'), at('06/04/2019'), at('2019-06-04T23:59:59Z')]).toEqual(['D', 'D', 'D', 'D']);
    // Outside it the felony no longer declines, though any conviction still keeps the guarantor out of tier A.
    expect([at('2019-06-03'), at('06-03-2019')]).toEqual(['B', 'B']);
    // An undated or unreadable date counts as recent.
    expect([at(''), at('sometime in 2010')]).toEqual(['D', 'D']);
  });
});
