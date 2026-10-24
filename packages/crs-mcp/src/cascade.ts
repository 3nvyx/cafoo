// The Credit Check cascade (ADR 0006): identity -> fraud -> stop on BLOCK -> three bureaus in
// parallel -> public records (PitchPoint BLJ, criminal, eviction) -> Risk Tier -> decision.
import type { CrsClient } from './client.js';
import { persona, type Bureau } from './csv.js';
import type { CreditReportFacts, FraudFacts, IdentityFacts, PublicRecordsFacts } from './interpret.js';
import { creditReport, fraudScore, identityVerify, publicRecords, type Evidence } from './products.js';

export type Tier = 'A' | 'B' | 'C' | 'D' | 'BLOCK';
export type Decision = 'APPROVE' | 'REVIEW' | 'DECLINE' | 'NO_FILE';
export type SubjectKind = 'customer_guarantor' | 'vendor_owner';

export interface CascadeOptions {
  subjectKind: SubjectKind;
  /** Reference date for lookback windows. Default: now. */
  asOf?: Date | string;
}

/** Policy constants. Change here and in README together. */
export const POLICY = {
  tierAMinScore: 740,
  tierBMinScore: 680,
  thinFileTradelines: 3,
  lookbackYears: 7,
  paymentTermsDays: { A: 45, B: 30, C: 15, D: 0, BLOCK: null } as Record<Tier, number | null>,
} as const;

export const BUREAUS: Bureau[] = ['transunion', 'equifax', 'experian'];

/** Machine-readable reason codes. Group decides the tier: block > active > nofile > gap > mark. */
export type ReasonGroup = 'block' | 'active' | 'nofile' | 'gap' | 'mark';
export interface Reason {
  code: string;
  group: ReasonGroup;
  plain: string;
}

/** Specific-reserve reason codes the ledger's allowance module accepts. `sanctions_match` is never emitted: the cascade runs no OFAC search. */
export type AllowanceReasonCode = 'active_bankruptcy' | 'fraud_alert' | 'identity_mismatch' | 'judgment_or_lien' | 'sanctions_match' | 'deceased_guarantor';

/** Cascade reason code -> allowance reason code. Reasons not listed carry no specific reserve. */
export const ALLOWANCE_CODE: Partial<Record<string, AllowanceReasonCode>> = {
  deceased_guarantor: 'deceased_guarantor',
  identity_mismatch: 'identity_mismatch',
  synthetic_identity: 'identity_mismatch',
  fraud_high: 'fraud_alert',
  identity_step_up: 'fraud_alert',
  active_bankruptcy: 'active_bankruptcy',
  judgment_or_lien: 'judgment_or_lien',
};

/** Allowance codes for BLOCK and D tiers (empty otherwise), deduplicated, in reason order. */
export function allowanceReasonCodes(tier: Tier, reasons: Reason[]): AllowanceReasonCode[] {
  if (tier !== 'BLOCK' && tier !== 'D') return [];
  return [...new Set(reasons.map((r) => ALLOWANCE_CODE[r.code]).filter((c): c is AllowanceReasonCode => c !== undefined))];
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
const NAME: Record<Bureau, string> = { transunion: 'TransUnion', equifax: 'Equifax', experian: 'Experian' };

const within = (date: string | null, asOf: Date, years: number): boolean => {
  if (!date) return true; // undated records are treated as recent (conservative)
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
  const t = Date.parse(m ? `${m[3]}-${m[1]}-${m[2]}` : date);
  if (Number.isNaN(t)) return true;
  const cutoff = new Date(asOf);
  cutoff.setFullYear(cutoff.getFullYear() - years);
  return t >= cutoff.getTime();
};

/** Identity + fraud gate. Any reason here stops the cascade with BLOCK. */
export function gateReasons(identity: IdentityFacts & { available: boolean }, fraud: FraudFacts): Reason[] {
  const r: Reason[] = [];
  if (identity.deceased) r.push({ code: 'deceased_guarantor', group: 'block', plain: 'the records say the person with this Social Security number has died' });
  if (identity.synthetic) r.push({ code: 'synthetic_identity', group: 'block', plain: 'the identity looks stitched together from different people' });
  if (identity.result === 'FAIL' && !identity.deceased && !identity.synthetic)
    r.push({ code: 'identity_mismatch', group: 'block', plain: "the name, Social Security number and birth date don't belong together" });
  if (fraud.level === 'high') r.push({ code: 'fraud_high', group: 'block', plain: 'the email, phone and location look like fraud' });
  return r;
}

/** Pure tier rules over the full fact set. Exported for tests and for the Red Team to inspect. */
export function classify(
  identity: IdentityFacts & { available: boolean },
  fraud: FraudFacts & { available: boolean },
  bureaus: Partial<Record<Bureau, CreditReportFacts>>,
  records: (PublicRecordsFacts & { available: boolean }) | undefined,
  asOf: Date,
): { tier: Tier; decision: Decision; reasons: Reason[] } {
  const reasons: Reason[] = [...gateReasons(identity, fraud)];
  const add = (code: string, group: ReasonGroup, plain: string): void => {
    if (!reasons.some((x) => x.code === code)) reasons.push({ code, group, plain });
  };
  const facts = BUREAUS.map((b) => [b, bureaus[b]] as const).filter((x): x is readonly [Bureau, CreditReportFacts] => x[1] !== undefined);
  const returned = facts.filter(([, f]) => f.fileStatus === 'returned');

  // --- BLOCK
  if (facts.some(([, f]) => f.fileStatus === 'deceased')) add('deceased_guarantor', 'block', 'the records say the person with this Social Security number has died');
  const bureauOpenBk = returned.flatMap(([, f]) => f.publicRecords.filter((p) => p.open));
  const ppOpenBk = records?.bankruptcies.filter((b) => b.open) ?? [];
  if ([...bureauOpenBk.map((p) => p.type), ...ppOpenBk.map((b) => `BankruptcyChapter${b.chapter ?? ''}`)].some((t) => /13/.test(t)))
    add('active_bankruptcy', 'block', 'they are in an active Chapter 13 bankruptcy repayment plan');
  else if (bureauOpenBk.length || ppOpenBk.length) add('active_bankruptcy', 'block', 'they are in an active bankruptcy');

  // --- active negatives (D, DECLINE)
  const withActive = returned.filter(([, f]) => f.activeDerogatories > 0);
  const corroborated = returned.length > 0 && withActive.length > returned.length / 2;
  if (withActive.length && corroborated) {
    const coll = withActive.some(([, f]) => f.collections > 0);
    add('unpaid_derogatories', 'active', coll ? 'they have unpaid debts in collections and serious missed payments' : 'they have unpaid charged-off debts or serious missed payments');
  } else if (withActive.length) {
    add('bureau_divergence', 'gap', `the credit bureaus disagree (only ${withActive.map(([b]) => NAME[b]).join(' and ')} reports an unpaid bad debt)`);
  }
  for (const c of records?.criminal ?? []) {
    if (!c.convicted || !within(c.date, asOf, POLICY.lookbackYears)) continue;
    if (c.level === 'felony') add('felony_conviction', 'active', 'a felony conviction from the last seven years showed up in the background check');
    else add('recent_conviction', 'mark', 'a minor criminal conviction from the last seven years');
  }
  for (const e of records?.evictions ?? []) {
    if (!within(e.date, asOf, POLICY.lookbackYears)) continue;
    if (e.outcome === 'judgment') add('eviction_judgment', 'active', 'a landlord won an eviction judgment against them in the last seven years');
    else if (e.outcome === 'filed') add('eviction_pending', 'mark', 'an eviction case is pending');
  }

  // --- no file anywhere
  if (facts.length && returned.length === 0 && facts.every(([, f]) => f.fileStatus === 'no_hit'))
    add('no_file', 'nofile', 'no credit bureau has any history on them');

  // --- data gaps (C, REVIEW)
  for (const [b, f] of facts) {
    if (f.fileStatus === 'returned') {
      if (f.score == null) add(`no_score_${SHORT[b].toLowerCase()}`, 'gap', 'the bureaus have a file but cannot score it because nothing has been active in years');
      if (f.tradelines < POLICY.thinFileTradelines) add(`thin_file_${SHORT[b].toLowerCase()}`, 'gap', 'there is very little credit history to judge');
    } else if (returned.length > 0 || f.fileStatus === 'frozen') {
      if (f.fileStatus === 'frozen') add(`frozen_${SHORT[b].toLowerCase()}`, 'gap', `the ${NAME[b]} file is locked by a security freeze`);
      else if (f.fileStatus === 'no_hit') add(`no_file_${SHORT[b].toLowerCase()}`, 'gap', `${NAME[b]} has no file on them`);
      else if (f.fileStatus === 'error') add(`bureau_error_${SHORT[b].toLowerCase()}`, 'gap', `${NAME[b]} did not return a usable report`);
    }
  }
  if (identity.result === 'KBA_REQUIRED') add('identity_step_up', 'gap', 'a fraud alert on file means we need extra proof of identity first');
  if (!identity.available) add('identity_unavailable', 'gap', 'the identity check did not complete');
  if (fraud.level === 'medium') add('fraud_medium', 'gap', 'some of their contact details look slightly risky');
  if (records && !records.available) add('records_unavailable', 'gap', 'the public-records search did not complete');

  // --- marks (D, REVIEW)
  const scores = returned.map(([, f]) => f.score).filter((s): s is number => s != null);
  const minScore = scores.length ? Math.min(...scores) : null;
  if (minScore != null && minScore < POLICY.tierBMinScore) add('score_below_680', 'mark', 'their credit score is below average');
  const closedBk = [
    ...returned.flatMap(([, f]) => f.publicRecords.filter((p) => p.type.startsWith('Bankruptcy') && !p.open)),
    ...(records?.bankruptcies.filter((b) => !b.open) ?? []),
  ];
  if (closedBk.length) add('discharged_bankruptcy', 'mark', 'they went through a bankruptcy that has since been closed');
  const openJl = [...(records?.judgments.filter((j) => !j.satisfied) ?? []), ...(records?.liens.filter((l) => !l.released) ?? [])];
  const bureauJl = returned.flatMap(([, f]) => f.publicRecords.filter((p) => /judg|lien/i.test(p.type)));
  if (openJl.length || bureauJl.length) add('judgment_or_lien', 'mark', 'there is an unpaid court judgment or tax lien against them');
  if (returned.some(([, f]) => f.collections > 0)) add('collections', 'mark', 'they have accounts that went to collections');

  // --- tier and decision
  const has = (g: ReasonGroup): boolean => reasons.some((x) => x.group === g);
  let tier: Tier;
  let decision: Decision;
  if (has('block')) [tier, decision] = ['BLOCK', 'DECLINE'];
  else if (has('active')) [tier, decision] = ['D', 'DECLINE'];
  else if (has('nofile')) [tier, decision] = ['C', 'NO_FILE'];
  else if (has('gap')) [tier, decision] = ['C', 'REVIEW'];
  else if (has('mark')) [tier, decision] = ['D', 'REVIEW'];
  else {
    const clean =
      returned.every(([, f]) => f.derogatories === 0 && f.publicRecords.length === 0) &&
      (records?.counts.bankruptcies ?? 0) + (records?.counts.judgments ?? 0) + (records?.counts.liens ?? 0) === 0 &&
      !(records?.criminal ?? []).some((c) => c.convicted);
    tier = minScore != null && minScore >= POLICY.tierAMinScore && clean ? 'A' : 'B';
    decision = 'APPROVE';
  }
  return { tier, decision, reasons };
}

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
