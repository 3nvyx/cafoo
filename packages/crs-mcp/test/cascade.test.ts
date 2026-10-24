import { describe, expect, it } from 'vitest';
import { CrsClient } from '../src/client.js';
import { runCascade, POLICY } from '../src/cascade.js';
import { personas } from '../src/csv.js';

const client = new CrsClient({ mode: 'replay' });
const AS_OF = '2026-10-24';

describe('runCascade in replay mode', () => {
  const all = personas();

  it('covers all 20 personas', () => {
    expect(all.map((p) => p.personaId)).toEqual(Array.from({ length: 20 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`));
  });

  for (const p of all) {
    it(`${p.personaId} ${p.personaName} (${p.profile}) -> ${p.expectedDecision}`, async () => {
      const r = await runCascade(client, p.personaId, { subjectKind: 'customer_guarantor', asOf: AS_OF });
      expect(r.decision, r.summaryTechnical).toBe(p.expectedDecision);
      expect(r.paymentTermsDays).toBe(POLICY.paymentTermsDays[r.tier]);
      expect(r.summaryPlain).toMatch(/\.$/);
      expect(r.summaryPlain.split(/(?<=\.)\s/).length).toBe(1);
      for (const e of r.evidence) expect(e.requestId).toMatch(/^fx-P\d\d-/);
    });
  }

  it('assigns the documented tiers', async () => {
    const tiers: Record<string, string> = {};
    for (const p of all) tiers[p.personaId] = (await runCascade(client, p.personaId, { subjectKind: 'customer_guarantor', asOf: AS_OF })).tier;
    expect(tiers).toEqual({
      P01: 'A', P02: 'A', P03: 'C', P04: 'C', P05: 'D', P06: 'D', P07: 'BLOCK', P08: 'D', P09: 'D', P10: 'B',
      P11: 'D', P12: 'BLOCK', P13: 'BLOCK', P14: 'BLOCK', P15: 'C', P16: 'C', P17: 'C', P18: 'D', P19: 'A', P20: 'C',
    });
  });

  it('emits the ledger allowance reason codes on BLOCK and D tiers only', async () => {
    const codes: Record<string, string[]> = {};
    for (const p of all) codes[p.personaId] = (await runCascade(client, p.personaId, { subjectKind: 'customer_guarantor', asOf: AS_OF })).allowanceReasonCodes;
    expect(codes).toMatchObject({
      P01: [], P03: [], P05: [], P07: ['active_bankruptcy'], P08: ['judgment_or_lien'], P11: ['judgment_or_lien'],
      P12: ['identity_mismatch', 'fraud_alert'], P13: ['identity_mismatch', 'fraud_alert'], P14: ['deceased_guarantor', 'fraud_alert'], P16: [],
    });
    const allowed = new Set(['active_bankruptcy', 'fraud_alert', 'identity_mismatch', 'judgment_or_lien', 'sanctions_match', 'deceased_guarantor']);
    for (const list of Object.values(codes)) for (const c of list) expect(allowed.has(c)).toBe(true);
  });

  it('stops after identity and fraud on a BLOCK gate (deceased, identity FAIL, high fraud)', async () => {
    for (const id of ['P12', 'P13', 'P14']) {
      const r = await runCascade(client, id, { subjectKind: 'vendor_owner', asOf: AS_OF });
      expect(r.stoppedEarly).toBe(true);
      expect(r.evidence.map((e) => e.product)).toEqual(['tu_identity_verification', 'fraud_finder']);
      expect(r.paymentTermsDays).toBeNull();
    }
  });

  it('pulls all three bureaus and the three record searches otherwise', async () => {
    const r = await runCascade(client, 'P01', { subjectKind: 'customer_guarantor', asOf: AS_OF });
    expect(r.evidence.map((e) => e.product)).toEqual([
      'tu_identity_verification', 'fraud_finder', 'credit_report:tu', 'credit_report:efx', 'credit_report:exp', 'pitchpoint_blj', 'criminal', 'eviction',
    ]);
    expect(r.paymentTermsDays).toBe(45);
  });

  it('lets an old felony fall outside the seven-year lookback', async () => {
    const r = await runCascade(client, 'P09', { subjectKind: 'customer_guarantor', asOf: '2029-01-01' });
    expect(r.decision).toBe('APPROVE');
  });

  it('words the vendor-owner summary for onboarding, not payment terms', async () => {
    const r = await runCascade(client, 'P19', { subjectKind: 'vendor_owner', asOf: AS_OF });
    expect(r.summaryPlain).toMatch(/onboard/);
    expect(r.summaryPlain).not.toMatch(/day payment terms/);
  });
});
