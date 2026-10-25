// The Risk Tier rules, pure: no imports, no I/O and no clock (the reference date is always passed in). The SpacetimeDB
// module imports this file to derive a recorded Credit Check's tier from its evidence (deriveTier), so the agent's
// cascade and the ledger classify with the same code. Change the rules here and in README.md (Tier rules) together, and
// keep to ES2021 so the module's runtime can run it.

export type Tier = 'A' | 'B' | 'C' | 'D' | 'BLOCK';
export type Decision = 'APPROVE' | 'REVIEW' | 'DECLINE' | 'NO_FILE';
/** The three credit bureaus (the same names as csv.ts's Bureau). */
export type TierBureau = 'transunion' | 'equifax' | 'experian';

export const TIERS: readonly Tier[] = ['A', 'B', 'C', 'D', 'BLOCK'];

/** Policy constants. Change here and in README together. */
export const POLICY = {
  tierAMinScore: 740,
  tierBMinScore: 680,
  thinFileTradelines: 3,
  lookbackYears: 7,
  paymentTermsDays: { A: 45, B: 30, C: 15, D: 0, BLOCK: null } as Record<Tier, number | null>,
} as const;

export const BUREAUS: TierBureau[] = ['transunion', 'equifax', 'experian'];

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

/** risk.score 0-100: <=30 low, 31-69 medium, >=70 high (AtData suggests a 70-80 cut-off); no score is medium. */
export function fraudLevel(score: number | null): 'low' | 'medium' | 'high' {
  if (score == null) return 'medium';
  if (score >= 70) return 'high';
  if (score > 30) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------- the facts the rules read

// The interpreters' fact types (interpret.ts) carry more fields; these are the ones the tier depends on.
export interface IdentityInput {
  result: 'PASS' | 'FAIL' | 'KBA_REQUIRED';
  deceased: boolean;
  synthetic: boolean;
  /** False when the identity call failed. */
  available: boolean;
}
export interface FraudInput {
  score: number | null;
  level: 'low' | 'medium' | 'high';
}
export type FileStatusInput = 'returned' | 'no_hit' | 'frozen' | 'deceased' | 'error';
export interface CreditReportInput {
  fileStatus: FileStatusInput;
  score: number | null;
  tradelines: number;
  derogatories: number;
  activeDerogatories: number;
  collections: number;
  publicRecords: { type: string; open?: boolean }[];
}
export interface PublicRecordsInput {
  /** False when one of the three record searches failed. */
  available: boolean;
  counts: { bankruptcies: number; judgments: number; liens: number };
  bankruptcies: { chapter: string | null; open: boolean }[];
  judgments: { satisfied: boolean }[];
  liens: { released: boolean }[];
  criminal: { level: 'felony' | 'misdemeanor' | 'other'; convicted: boolean; date: string | null }[];
  evictions: { outcome: 'judgment' | 'dismissed' | 'filed'; date: string | null }[];
}
/** A cascade's facts (CascadeResult.facts): bureaus and records are absent when identity or fraud stopped it early. */
export interface TierFacts {
  identity: IdentityInput;
  fraud: FraudInput;
  bureaus: Partial<Record<TierBureau, CreditReportInput>>;
  publicRecords?: PublicRecordsInput;
}

// ---------------------------------------------------------------- the rules

const SHORT: Record<TierBureau, string> = { transunion: 'TU', equifax: 'EFX', experian: 'EXP' };
const NAME: Record<TierBureau, string> = { transunion: 'TransUnion', equifax: 'Equifax', experian: 'Experian' };

/** A record date (YYYY-MM-DD, with or without a time, or CIC's MM-DD-YYYY or MM/DD/YYYY) as a UTC calendar day. */
function dayOf(date: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const us = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(date);
  if (us) return Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  return null;
}

/** True when a record falls within `years` before `asOf`. Undated or unreadable records count as recent (conservative). */
function within(date: string | null, asOf: Date, years: number): boolean {
  if (!date) return true;
  const t = dayOf(date.trim());
  if (t === null) return true;
  const cutoff = new Date(asOf.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return t >= cutoff.getTime();
}

/** Identity + fraud gate. Any reason here stops the cascade with BLOCK. */
export function gateReasons(identity: IdentityInput, fraud: FraudInput): Reason[] {
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
  identity: IdentityInput,
  fraud: FraudInput,
  bureaus: Partial<Record<TierBureau, CreditReportInput>>,
  records: PublicRecordsInput | undefined,
  asOf: Date,
): { tier: Tier; decision: Decision; reasons: Reason[] } {
  const reasons: Reason[] = [...gateReasons(identity, fraud)];
  const add = (code: string, group: ReasonGroup, plain: string): void => {
    if (!reasons.some((x) => x.code === code)) reasons.push({ code, group, plain });
  };
  const facts = BUREAUS.map((b) => [b, bureaus[b]] as const).filter((x): x is readonly [TierBureau, CreditReportInput] => x[1] !== undefined);
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

// ---------------------------------------------------------------- recorded evidence -> tier

export interface DerivedTier {
  tier: Tier;
  decision: Decision;
  paymentTermsDays: number | null;
  reasons: Reason[];
}

/**
 * The tier and decision a recorded Credit Check's evidence supports, as of `asOf`: its facts (CascadeResult.facts, as
 * recorded under `facts` in the check's summaryJson) checked for shape, consistency and completeness, then classified.
 * Throws an Error naming the problem when the facts are malformed, contradict themselves, or are incomplete: unless
 * identity or fraud already stops the cascade with BLOCK, the evidence must hold all three credit bureaus and the
 * public-records search, because missing evidence must never read as clean credit.
 */
export function deriveTier(facts: unknown, asOf: Date): DerivedTier {
  if (Number.isNaN(asOf.getTime())) throw new Error('the reference date for the lookback windows is not a valid date');
  const f = parseTierFacts(facts);
  if (gateReasons(f.identity, f.fraud).length === 0) {
    const missing = BUREAUS.filter((b) => !f.bureaus[b]);
    if (missing.length) throw new Error(`facts.bureaus lacks ${missing.join(', ')}: unless identity or fraud stops the cascade, a tier needs all three credit bureaus`);
    if (!f.publicRecords) throw new Error('facts.publicRecords is missing: unless identity or fraud stops the cascade, a tier needs the public-records search');
  }
  const { tier, decision, reasons } = classify(f.identity, f.fraud, f.bureaus, f.publicRecords, asOf);
  return { tier, decision, paymentTermsDays: POLICY.paymentTermsDays[tier], reasons };
}

type Json = Record<string, unknown>;

function show(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return 'nothing';
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
function bad(path: string, want: string, got: unknown): never {
  throw new Error(`${path} must be ${want}; got ${show(got)}`);
}
function objectAt(v: unknown, path: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(path, 'an object', v);
  return v as Json;
}
function flag(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') bad(path, 'true or false', v);
  return v as boolean;
}
function count(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) bad(path, 'a whole number of at least 0', v);
  return v as number;
}
function scoreAt(v: unknown, path: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(path, 'a number or null', v);
  return v as number;
}
function textAt(v: unknown, path: string): string {
  if (typeof v !== 'string') bad(path, 'text', v);
  return v as string;
}
function textOrNull(v: unknown, path: string): string | null {
  return v === null ? null : textAt(v, path);
}
function oneOf<T extends string>(v: unknown, options: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) bad(path, `one of ${options.join(', ')}`, v);
  return v as T;
}
function listAt<T>(v: unknown, path: string, item: (x: unknown, at: string) => T): T[] {
  if (!Array.isArray(v)) bad(path, 'a list', v);
  return (v as unknown[]).map((x, i) => item(x, `${path}[${i}]`));
}

const FILE_STATUSES: readonly FileStatusInput[] = ['returned', 'no_hit', 'frozen', 'deceased', 'error'];

function creditReportAt(v: unknown, path: string): CreditReportInput {
  const r = objectAt(v, path);
  const out: CreditReportInput = {
    fileStatus: oneOf(r.fileStatus, FILE_STATUSES, `${path}.fileStatus`),
    score: scoreAt(r.score, `${path}.score`),
    tradelines: count(r.tradelines, `${path}.tradelines`),
    derogatories: count(r.derogatories, `${path}.derogatories`),
    activeDerogatories: count(r.activeDerogatories, `${path}.activeDerogatories`),
    collections: count(r.collections, `${path}.collections`),
    publicRecords: listAt(r.publicRecords, `${path}.publicRecords`, (x, at) => {
      const p = objectAt(x, at);
      return { type: textAt(p.type, `${at}.type`), ...(p.open === undefined ? {} : { open: flag(p.open, `${at}.open`) }) };
    }),
  };
  // The interpreter counts derogatory and collection lines among the tradelines, and active ones among the derogatory.
  if (out.activeDerogatories > out.derogatories || out.derogatories > out.tradelines || out.collections > out.tradelines) {
    throw new Error(`${path} counts do not add up: ${out.tradelines} tradelines, ${out.derogatories} derogatory, ${out.activeDerogatories} active, ${out.collections} in collections`);
  }
  if (out.fileStatus !== 'returned' && (out.score !== null || out.tradelines > 0 || out.publicRecords.length > 0)) {
    throw new Error(`${path} has no file (${out.fileStatus}), so it cannot carry a score, tradelines or public records`);
  }
  return out;
}

function publicRecordsAt(v: unknown, path: string): PublicRecordsInput {
  const r = objectAt(v, path);
  const counts = objectAt(r.counts, `${path}.counts`);
  return {
    available: flag(r.available, `${path}.available`),
    counts: {
      bankruptcies: count(counts.bankruptcies, `${path}.counts.bankruptcies`),
      judgments: count(counts.judgments, `${path}.counts.judgments`),
      liens: count(counts.liens, `${path}.counts.liens`),
    },
    bankruptcies: listAt(r.bankruptcies, `${path}.bankruptcies`, (x, at) => {
      const b = objectAt(x, at);
      return { chapter: textOrNull(b.chapter, `${at}.chapter`), open: flag(b.open, `${at}.open`) };
    }),
    judgments: listAt(r.judgments, `${path}.judgments`, (x, at) => ({ satisfied: flag(objectAt(x, at).satisfied, `${at}.satisfied`) })),
    liens: listAt(r.liens, `${path}.liens`, (x, at) => ({ released: flag(objectAt(x, at).released, `${at}.released`) })),
    criminal: listAt(r.criminal, `${path}.criminal`, (x, at) => {
      const c = objectAt(x, at);
      return { level: oneOf(c.level, ['felony', 'misdemeanor', 'other'] as const, `${at}.level`), convicted: flag(c.convicted, `${at}.convicted`), date: textOrNull(c.date, `${at}.date`) };
    }),
    evictions: listAt(r.evictions, `${path}.evictions`, (x, at) => {
      const e = objectAt(x, at);
      return { outcome: oneOf(e.outcome, ['judgment', 'dismissed', 'filed'] as const, `${at}.outcome`), date: textOrNull(e.date, `${at}.date`) };
    }),
  };
}

/** Untrusted recorded facts -> the typed facts the rules read. Throws an Error naming the first field that is wrong. */
export function parseTierFacts(raw: unknown): TierFacts {
  const f = objectAt(raw, 'facts');
  const id = objectAt(f.identity, 'facts.identity');
  const identity: IdentityInput = {
    result: oneOf(id.result, ['PASS', 'FAIL', 'KBA_REQUIRED'] as const, 'facts.identity.result'),
    deceased: flag(id.deceased, 'facts.identity.deceased'),
    synthetic: flag(id.synthetic, 'facts.identity.synthetic'),
    available: flag(id.available, 'facts.identity.available'),
  };
  const fr = objectAt(f.fraud, 'facts.fraud');
  const score = scoreAt(fr.score, 'facts.fraud.score');
  const level = oneOf(fr.level, ['low', 'medium', 'high'] as const, 'facts.fraud.level');
  if (level !== fraudLevel(score)) {
    throw new Error(`facts.fraud level is ${level}, but a fraud score of ${score ?? 'none'} is ${fraudLevel(score)} (the fraud level follows the score)`);
  }
  const b = objectAt(f.bureaus, 'facts.bureaus');
  const bureaus: Partial<Record<TierBureau, CreditReportInput>> = {};
  for (const [key, v] of Object.entries(b)) {
    if (!(BUREAUS as string[]).includes(key)) throw new Error(`facts.bureaus has ${show(key)}; the bureaus are ${BUREAUS.join(', ')}`);
    bureaus[key as TierBureau] = creditReportAt(v, `facts.bureaus.${key}`);
  }
  const records = f.publicRecords === undefined ? undefined : publicRecordsAt(f.publicRecords, 'facts.publicRecords');
  return { identity, fraud: { score, level }, bureaus, ...(records ? { publicRecords: records } : {}) };
}
