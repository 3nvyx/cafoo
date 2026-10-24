// One function per CRS product: send the persona's dataset request, interpret the answer,
// and return facts plus an evidence line (with the RequestID) for the Credit Check record.
import type { CrsClient, CrsResponse } from './client.js';
import { BUREAU_SHORT, creditRequest, singleRequest, type Bureau, type PersonaRequest } from './csv.js';
import {
  interpretCreditReport,
  interpretFraud,
  interpretIdentity,
  interpretPublicRecords,
  type CreditReportFacts,
  type FraudFacts,
  type IdentityFacts,
  type PublicRecordsFacts,
} from './interpret.js';

export interface Evidence {
  product: string;
  requestId: string | null;
  summary: string;
  /** HTTP status of the call (200 for credit reports even on no-file). */
  status: number;
}

export interface ProductResult<F> {
  facts: F;
  evidence: Evidence[];
  raw: unknown[];
}

const BUREAU_LABEL: Record<Bureau, string> = { transunion: 'TransUnion', equifax: 'Equifax', experian: 'Experian' };

async function send(client: CrsClient, req: PersonaRequest): Promise<CrsResponse> {
  return client.call(req);
}

export function describeCredit(f: CreditReportFacts, bureau: Bureau): string {
  const label = BUREAU_LABEL[bureau];
  switch (f.fileStatus) {
    case 'deceased':
      return `${label}: subject reported deceased (${f.errors.map((e) => e.code).join(', ')}), no credit file`;
    case 'no_hit':
      return `${label}: NoFileReturnedNoHit`;
    case 'frozen':
      return `${label}: NoFileReturnedCreditFreeze`;
    case 'error':
      return `${label}: error ${f.errors.map((e) => `${e.code ?? ''} ${e.text ?? ''}`.trim()).join('; ') || 'no file status'}`;
    case 'returned': {
      const score = f.score == null ? `no score (${f.noScoreReason ?? 'unknown reason'})` : `score ${f.score} (${f.scoreModel ?? 'model n/a'})`;
      const pr = f.publicRecords.length ? `, public records: ${f.publicRecords.map((p) => `${p.type} ${p.status ?? ''}`.trim()).join(', ')}` : '';
      return `${label}: FileReturned, ${score}, ${f.tradelines} tradelines, ${f.derogatories} derogatory (${f.activeDerogatories} with balance; ${f.collections} collections, ${f.chargeOffs} charge-offs, ${f.late90} 90+ days late), ${f.inquiries90d} inquiries in 90 days${pr}`;
    }
  }
}

export async function creditReport(client: CrsClient, personaId: string, bureau: Bureau): Promise<ProductResult<CreditReportFacts>> {
  const res = await send(client, creditRequest(personaId, bureau));
  const facts = interpretCreditReport(res.body);
  if (facts.bureau === 'unknown') facts.bureau = bureau;
  return {
    facts,
    evidence: [{ product: `credit_report:${BUREAU_SHORT[bureau]}`, requestId: res.headers.requestId, summary: describeCredit(facts, bureau), status: res.status }],
    raw: [res.body],
  };
}

export async function identityVerify(client: CrsClient, personaId: string): Promise<ProductResult<IdentityFacts & { available: boolean }>> {
  const res = await send(client, singleRequest(personaId, 'tu_identity_verification'));
  const available = res.status >= 200 && res.status < 300;
  const facts = { ...interpretIdentity(res.body), available };
  const summary = !available
    ? `TU identity unavailable (HTTP ${res.status})`
    : facts.result === 'PASS'
      ? 'TU identity PASS: name, SSN, DOB and address verify (no messages)'
      : `TU identity ${facts.result}: ${facts.codes.map((c, i) => `${c} ${facts.texts[i] ?? ''}`.trim()).join('; ')}`;
  return { facts, evidence: [{ product: 'tu_identity_verification', requestId: res.headers.requestId, summary, status: res.status }], raw: [res.body] };
}

export async function fraudScore(client: CrsClient, personaId: string, asOf?: Date): Promise<ProductResult<FraudFacts & { available: boolean }>> {
  const res = await send(client, singleRequest(personaId, 'fraud_finder'));
  const available = res.status >= 200 && res.status < 300;
  const facts = { ...interpretFraud(res.body, asOf), available };
  const summary = !available
    ? `Fraud Finder unavailable (HTTP ${res.status})`
    : `Fraud Finder risk.score ${facts.score ?? 'n/a'} (${facts.level})${facts.signals.length ? `: ${facts.signals.join(', ')}` : ''}`;
  return { facts, evidence: [{ product: 'fraud_finder', requestId: res.headers.requestId, summary, status: res.status }], raw: [res.body] };
}

export async function publicRecords(client: CrsClient, personaId: string): Promise<ProductResult<PublicRecordsFacts & { available: boolean }>> {
  const [pp, crim, evct] = await Promise.all([
    send(client, singleRequest(personaId, 'pitchpoint_blj')),
    send(client, singleRequest(personaId, 'criminal')),
    send(client, singleRequest(personaId, 'eviction')),
  ]);
  const ok = (r: CrsResponse): boolean => r.status >= 200 && r.status < 300;
  const facts = { ...interpretPublicRecords(ok(pp) ? pp.body : {}, ok(crim) ? crim.body : undefined, ok(evct) ? evct.body : undefined), available: ok(pp) && ok(crim) && ok(evct) };
  const c = facts.counts;
  const bk = facts.bankruptcies.map((b) => `Ch.${b.chapter ?? '?'} ${b.open ? 'open' : (b.status ?? 'closed')}`);
  const jl = [
    ...facts.judgments.map((j) => `judgment $${j.amount ?? '?'}${j.satisfied ? ' satisfied' : ''}`),
    ...facts.liens.map((l) => `${l.type ?? 'lien'} $${l.amount ?? '?'}${l.released ? ' released' : ''}`),
  ];
  const ppSummary = ok(pp)
    ? `PitchPoint BankruptciesFound/JudgmentsFound/LiensFound ${c.bankruptcies}/${c.judgments}/${c.liens}${[...bk, ...jl].length ? `: ${[...bk, ...jl].join(', ')}` : ''}`
    : `PitchPoint unavailable (HTTP ${pp.status})`;
  const crimSummary = ok(crim)
    ? facts.criminal.length
      ? `Criminal: ${facts.criminal.map((r) => `${r.level.toUpperCase()} ${r.description ?? ''}, ${r.disposition ?? 'no disposition'} ${r.date ?? ''}`.trim()).join('; ')}`
      : 'Criminal: no records'
    : `Criminal unavailable (HTTP ${crim.status})`;
  const evSummary = ok(evct)
    ? facts.evictions.length
      ? `Eviction: ${facts.evictions.map((e) => `${e.outcome}${e.amount != null ? ` $${e.amount}` : ''} ${e.date ?? ''}`.trim()).join('; ')}`
      : 'Eviction: no records'
    : `Eviction unavailable (HTTP ${evct.status})`;
  return {
    facts,
    evidence: [
      { product: 'pitchpoint_blj', requestId: pp.headers.requestId, summary: ppSummary, status: pp.status },
      { product: 'criminal', requestId: crim.headers.requestId, summary: crimSummary, status: crim.status },
      { product: 'eviction', requestId: evct.headers.requestId, summary: evSummary, status: evct.status },
    ],
    raw: [pp.body, crim.body, evct.body],
  };
}
