// The Credit Check cascade (ADR 0006): identity -> fraud -> stop on BLOCK -> three bureaus in
// parallel -> public records (PitchPoint BLJ, criminal, eviction) -> Risk Tier -> decision.
import type { CrsClient } from './client.js';
import { persona, type Bureau } from './csv.js';
import type { CreditReportFacts, FraudFacts, IdentityFacts, PublicRecordsFacts } from './interpret.js';
import { creditReport, fraudScore, identityVerify, publicRecords, type Evidence } from './products.js';
import { allowanceReasonCodes, BUREAUS, classify, gateReasons, POLICY, type AllowanceReasonCode, type Decision, type Reason, type ReasonGroup, type Tier } from './tiers.js';

// The tier rules live in tiers.ts (pure, shared with the ledger module); this file keeps exporting them.
export * from './tiers.js';

export type SubjectKind = 'customer_guarantor' | 'vendor_owner';

export interface CascadeOptions {
  subjectKind: SubjectKind;
  /** Reference date for lookback windows. Default: now. */
  asOf?: Date | string;
}

export interface CascadeResult {
  personaId: string;
  personaName: string;
  subjectKind: SubjectKind;
  tier: Tier;
  decision: Decision;
  paymentTermsDays: number | null;
  /** True when the cascade stopped after identity + fraud (no bureau or records calls). */
  stoppedEarly: boolean;
  reasons: Reason[];
  /** Ledger allowance codes for BLOCK/D tiers; hand straight to the allowance Proposal. */
  allowanceReasonCodes: AllowanceReasonCode[];
  evidence: Evidence[];
  summaryPlain: string;
  summaryTechnical: string;
  facts: {
    identity: IdentityFacts & { available: boolean };
    fraud: FraudFacts & { available: boolean };
    bureaus: Partial<Record<Bureau, CreditReportFacts>>;
    publicRecords?: PublicRecordsFacts & { available: boolean };
  };
}

const SHORT: Record<Bureau, string> = { transunion: 'TU', equifax: 'EFX', experian: 'EXP' };

function joinPlain(parts: string[]): string {
  const p = [...new Set(parts)].slice(0, 2);
  return p.length === 2 ? `${p[0]} and ${p[1]}` : (p[0] ?? '');
}

export function plainSummary(name: string, subjectKind: SubjectKind, tier: Tier, decision: Decision, reasons: Reason[]): string {
  const who = subjectKind === 'customer_guarantor' ? `${name} (the customer's guarantor)` : `${name} (the vendor's owner)`;
  const terms = POLICY.paymentTermsDays[tier];
  const customer = subjectKind === 'customer_guarantor';
  const of = (g: ReasonGroup): string[] => reasons.filter((r) => r.group === g).map((r) => r.plain);
  switch (true) {
    case tier === 'BLOCK':
      return `Stop: for ${who}, ${joinPlain(of('block'))}, so we should not ${customer ? 'extend any credit' : 'onboard or pay this vendor'} until a person looks into it.`;
    case decision === 'DECLINE':
      return `Decline: for ${who}, ${joinPlain(of('active'))}, so we should ${customer ? 'only work with them on payment upfront' : 'not onboard this vendor without a manual review'}.`;
    case decision === 'NO_FILE':
      return `No credit history: for ${who}, ${joinPlain(of('nofile'))}, so there is nothing to score; ${customer ? `ask for a deposit or bank reference and start on ${terms}-day terms` : 'check a bank reference before onboarding'}.`;
    case tier === 'C':
      return `Needs a person to review: for ${who}, ${joinPlain(of('gap'))}${customer ? `, so we'd hold them to ${terms}-day terms until someone checks` : ', so someone should check before onboarding'}.`;
    case tier === 'D':
      return `Needs a person to review: for ${who}, ${joinPlain(of('mark'))}${customer ? ', so we would ask for payment upfront until someone signs off' : ', so someone should sign off before onboarding'}.`;
    case tier === 'A':
      return `Approve: ${who} has strong, clean credit at every bureau${customer ? `, so we can offer ${terms}-day payment terms` : ', so the vendor is safe to onboard'}.`;
    default:
      return `Approve: ${who} has good credit with no serious problems${customer ? `, so we can offer ${terms}-day payment terms` : ', so the vendor is safe to onboard'}.`;
  }
}

export function technicalSummary(
  tier: Tier,
  decision: Decision,
  reasons: Reason[],
  identity: IdentityFacts,
  fraud: FraudFacts,
  bureaus: Partial<Record<Bureau, CreditReportFacts>>,
  records?: PublicRecordsFacts,
): string {
  const id = identity.result === 'PASS' ? 'ID PASS' : `ID ${identity.result} [${identity.codes.join(',')}]`;
  const fr = `fraud ${fraud.score ?? 'n/a'} ${fraud.level}`;
  const bs = BUREAUS.filter((b) => bureaus[b]).map((b) => {
    const f = bureaus[b]!;
    if (f.fileStatus !== 'returned') return `${SHORT[b]} ${f.fileStatus}`;
    const extra = [
      f.tradelines < POLICY.thinFileTradelines ? `thin ${f.tradelines}tl` : `${f.tradelines}tl`,
      f.derogatories ? `${f.derogatories} derog (${f.activeDerogatories} active)` : '',
      f.publicRecords.length ? f.publicRecords.map((p) => `${p.type}/${p.status}`).join('+') : '',
      f.inquiries90d ? `${f.inquiries90d} inq90` : '',
    ].filter(Boolean);
    return `${SHORT[b]} ${f.score ?? 'NS'}${f.score == null && f.noScoreReason ? `(${f.noScoreReason})` : ''} [${extra.join(', ')}]`;
  });
  const pr = records
    ? `BLJ ${records.counts.bankruptcies}/${records.counts.judgments}/${records.counts.liens}; crim ${records.criminal.length ? records.criminal.map((c) => `${c.level}:${c.disposition}`).join(',') : 0}; evict ${records.evictions.length ? records.evictions.map((e) => e.outcome).join(',') : 0}`
    : 'bureaus and records not pulled (stopped at gate)';
  return `Tier ${tier} -> ${decision}. ${id}; ${fr}; ${bs.length ? bs.join(' / ') + '; ' : ''}${pr}. Reasons: ${reasons.map((r) => r.code).join(', ') || 'none'}.`;
}

export async function runCascade(client: CrsClient, personaId: string, opts: CascadeOptions): Promise<CascadeResult> {
  const p = persona(personaId);
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const evidence: Evidence[] = [];

  const id = await identityVerify(client, p.personaId);
  evidence.push(...id.evidence);
  const fr = await fraudScore(client, p.personaId, asOf);
  evidence.push(...fr.evidence);

  const finish = (
    bureaus: Partial<Record<Bureau, CreditReportFacts>>,
    records: (PublicRecordsFacts & { available: boolean }) | undefined,
    stoppedEarly: boolean,
  ): CascadeResult => {
    const { tier, decision, reasons } = classify(id.facts, fr.facts, bureaus, records, asOf);
    return {
      personaId: p.personaId,
      personaName: p.personaName,
      subjectKind: opts.subjectKind,
      tier,
      decision,
      paymentTermsDays: POLICY.paymentTermsDays[tier],
      stoppedEarly,
      reasons,
      allowanceReasonCodes: allowanceReasonCodes(tier, reasons),
      evidence,
      summaryPlain: plainSummary(titleCase(p.personaName), opts.subjectKind, tier, decision, reasons),
      summaryTechnical: technicalSummary(tier, decision, reasons, id.facts, fr.facts, bureaus, records),
      facts: { identity: id.facts, fraud: fr.facts, bureaus, ...(records ? { publicRecords: records } : {}) },
    };
  };

  if (gateReasons(id.facts, fr.facts).length) return finish({}, undefined, true);

  const reports = await Promise.all(BUREAUS.map((b) => creditReport(client, p.personaId, b)));
  const bureaus: Partial<Record<Bureau, CreditReportFacts>> = {};
  reports.forEach((r, i) => {
    bureaus[BUREAUS[i]!] = r.facts;
    evidence.push(...r.evidence);
  });
  const pr = await publicRecords(client, p.personaId);
  evidence.push(...pr.evidence);
  return finish(bureaus, pr.facts, false);
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The summaryJson of one recorded Credit Check row: the evidence row (product, request id, summary, status) and, under
 * `facts`, the cascade's facts, from which the ledger module derives the row's tier and decision with deriveTier. The
 * caller never states a tier.
 */
export function creditCheckSummaryJson(result: Pick<CascadeResult, 'facts'>, evidence: Evidence): string {
  return JSON.stringify({ ...evidence, facts: result.facts });
}
