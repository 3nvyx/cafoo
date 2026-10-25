// Pure functions: raw CRS response bodies -> normalized facts. No I/O, no clock unless passed in.
import type { Bureau } from './csv.js';
import { fraudLevel } from './tiers.js';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v == null ? [] : [v as T]);
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const DAY = 86_400_000;
const parseDate = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  // MM-DD-YYYY (CIC) -> ISO
  const m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s);
  const t = Date.parse(m ? `${m[3]}-${m[1]}-${m[2]}` : s);
  return Number.isNaN(t) ? null : t;
};

// ---------------------------------------------------------------- credit report

export type FileStatus = 'returned' | 'no_hit' | 'frozen' | 'deceased' | 'error';

export interface PublicRecordFact {
  type: string;
  status: string | null;
  date: string | null;
  amount?: number | null;
  /** True for a bankruptcy that is still open (filed, not discharged/dismissed/closed). */
  open?: boolean;
}

export interface CreditReportFacts {
  bureau: Bureau | 'unknown';
  fileStatus: FileStatus;
  score: number | null;
  scoreModel: string | null;
  noScoreReason: string | null;
  tradelines: number;
  /** Tradelines with a derogatory rating (collection, charge-off, 90+ days late, bankruptcy-included), current or historic. */
  derogatories: number;
  /** Derogatory tradelines that still carry a balance (unpaid collections, unpaid charge-offs, 90+ days currently past due). */
  activeDerogatories: number;
  collections: number;
  chargeOffs: number;
  late90: number;
  publicRecords: PublicRecordFact[];
  inquiries90d: number;
  errors: { code: string | null; text: string | null }[];
  /** Creditor names of active derogatory tradelines, used for cross-bureau corroboration. */
  activeDerogatoryCreditors: string[];
}

const DEROG_RATINGS = new Set([
  'Collection',
  'ChargeOff',
  'CollectionOrChargeOff',
  'Late90Days',
  'LateOver120Days',
  'Foreclosure',
  'ForeclosureOrRepossession',
  'BankruptcyOrWageEarnerPlan',
]);

const BUREAU_BY_SOURCE: Record<string, Bureau> = { TransUnion: 'transunion', Equifax: 'equifax', Experian: 'experian' };

function bureauFromReport(b: Json): Bureau | 'unknown' {
  const files = arr<Json>(b.creditFiles);
  const candidates: unknown[] = [
    ...files.map((f) => (isObj(f.creditFileDetail) ? f.creditFileDetail.sourceType : undefined)),
    ...arr<Json>(b.scores).map((s) => s.sourceType),
    ...arr<Json>(b.errorMessages).map((e) => e.creditErrorMessageSourceType),
  ];
  for (const c of candidates) {
    const hit = typeof c === 'string' ? BUREAU_BY_SOURCE[c] : undefined;
    if (hit) return hit;
  }
  const repo = isObj(b.repositoryIncluded) ? b.repositoryIncluded : {};
  if (repo.transunion === true) return 'transunion';
  if (repo.equifax === true) return 'equifax';
  if (repo.experian === true) return 'experian';
  return 'unknown';
}

export function interpretCreditReport(body: unknown): CreditReportFacts {
  const b = isObj(body) ? body : {};
  const errors = arr<Json>(b.errorMessages).map((e) => ({
    code: str(e.creditErrorMessageCode),
    text: str(e.creditErrorMessageText),
  }));
  const files = arr<Json>(b.creditFiles);
  const scores = arr<Json>(b.scores);
  const statuses = files.map((f) => (isObj(f.creditFileDetail) ? str(f.creditFileDetail.creditFileResultStatusType) : null));
  const deceased =
    errors.some((e) => /deceas/i.test(`${e.code ?? ''} ${e.text ?? ''}`)) ||
    scores.some((s) => s.noScoreReasonType === 'NotScoredSubjectDeceased') ||
    arr<Json>(b.responseAlertMessages).some((a) => a.responseAlertMessageCategoryType === 'DeathClaim');

  let fileStatus: FileStatus;
  if (deceased) fileStatus = 'deceased';
  else if (statuses.includes('FileReturned')) fileStatus = 'returned';
  else if (statuses.includes('NoFileReturnedCreditFreeze')) fileStatus = 'frozen';
  else if (statuses.some((s) => s === 'NoFileReturnedNoHit' || s === 'NoFileReturnedThinFile')) fileStatus = 'no_hit';
  else fileStatus = 'error';

  const scored = scores.find((s) => num(s.scoreValue) != null);
  const first = scored ?? scores[0];
  const tradelines = fileStatus === 'returned' ? arr<Json>(b.tradelines) : [];
  const isDerog = (t: Json): boolean =>
    t.derogatoryDataIndicator === true ||
    DEROG_RATINGS.has(String(t.currentRatingType)) ||
    (num(t.chargeOffAmount) ?? 0) > 0 ||
    t.businessType === 'CollectionServices' ||
    (num(t._90DayLates) ?? 0) > 0 ||
    (num(t._120DayLates) ?? 0) > 0;
  const isActive = (t: Json): boolean =>
    isDerog(t) &&
    t.currentRatingType !== 'BankruptcyOrWageEarnerPlan' &&
    t.accountStatusType !== 'Paid' &&
    ((num(t.currentBalanceAmount) ?? 0) > 0 || (num(t.pastDueAmount) ?? 0) > 0);
  const derog = tradelines.filter(isDerog);
  const active = tradelines.filter(isActive);

  const ordered = parseDate(isObj(b.responseDetail) ? b.responseDetail.dateOrdered : null) ?? Date.now();
  const inquiries90d = (fileStatus === 'returned' ? arr<Json>(b.inquiries) : []).filter((q) => {
    const t = parseDate(q.inquiryDate);
    return t != null && ordered - t <= 90 * DAY && t <= ordered;
  }).length;

  const publicRecords: PublicRecordFact[] = (fileStatus === 'returned' ? arr<Json>(b.publicRecords) : []).map((p) => {
    const type = str(p.publicRecordType) ?? 'Unknown';
    const status = str(p.dispositionType);
    const isBk = type.startsWith('Bankruptcy');
    return {
      type,
      status,
      date: str(p.filedDate) ?? str(p.reportedDate),
      amount: num(p.legalObligationAmount),
      ...(isBk ? { open: !['Discharged', 'Dismissed', 'Completed', 'Canceled', 'InvoluntarilyDischarged'].includes(status ?? '') } : {}),
    };
  });

  return {
    bureau: bureauFromReport(b),
    fileStatus,
    score: fileStatus === 'returned' && first ? num(first.scoreValue) : null,
    scoreModel: first ? str(first.modelName) : null,
    noScoreReason: first ? str(first.noScoreReasonType) : null,
    tradelines: tradelines.length,
    derogatories: derog.length,
    activeDerogatories: active.length,
    collections: tradelines.filter((t) => t.currentRatingType === 'Collection' || t.businessType === 'CollectionServices').length,
    chargeOffs: tradelines.filter((t) => t.currentRatingType === 'ChargeOff' || t.currentRatingType === 'CollectionOrChargeOff' || (num(t.chargeOffAmount) ?? 0) > 0).length,
    late90: tradelines.filter((t) => (num(t._90DayLates) ?? 0) > 0 || t.currentRatingType === 'Late90Days' || t.currentRatingType === 'LateOver120Days').length,
    publicRecords,
    inquiries90d,
    errors,
    activeDerogatoryCreditors: active.map((t) => String(t.originalCreditorName ?? t.creditorName ?? '').toUpperCase()),
  };
}

// ---------------------------------------------------------------- identity (TU TruValidate)

export interface IdentityFacts {
  result: 'PASS' | 'FAIL' | 'KBA_REQUIRED';
  codes: string[];
  texts: string[];
  deceased: boolean;
  /** SSN issued before DOB, or several names on one SSN: the synthetic-identity pattern. */
  synthetic: boolean;
}

/** 2101 address mismatch and 2401 fraud alert are step-up conditions; everything else is a hard fail. */
const STEP_UP_CODES = new Set(['2101', '2401']);

export function interpretIdentity(body: unknown): IdentityFacts {
  const b = isObj(body) ? body : {};
  const addOn = arr<Json>(b.addOnProducts)[0];
  const idm = addOn && isObj(addOn.idManagerVerification) ? addOn.idManagerVerification : {};
  const messages = arr<Json>(idm.messages);
  const codes = messages.map((m) => String(m.code ?? ''));
  const texts = messages.map((m) => String(m.text ?? ''));
  const all = texts.join(' ');
  const deceased = codes.includes('2301') || /deceas|death master/i.test(all);
  const synthetic = codes.includes('2202') || /issue date inconsistent|multiple names/i.test(all);
  let result: IdentityFacts['result'] = 'PASS';
  if (messages.length) result = codes.every((c) => STEP_UP_CODES.has(c)) ? 'KBA_REQUIRED' : 'FAIL';
  return { result, codes, texts, deceased, synthetic };
}

// ---------------------------------------------------------------- fraud finder (AtData)

export interface FraudFacts {
  score: number | null;
  level: 'low' | 'medium' | 'high';
  signals: string[];
}

// risk.score 0-100 -> level lives with the tier rules, which re-check it on recorded evidence.
export { fraudLevel };

export function interpretFraud(body: unknown, asOf?: Date): FraudFacts {
  const b = isObj(body) ? body : {};
  const risk = isObj(b.risk) ? b.risk : {};
  const score = num(risk.score);
  const signals: string[] = [];
  const ev = isObj(b.email_validation) ? b.email_validation : {};
  if (ev.status === 'invalid' || ev.status === 'risky') signals.push(`email ${String(ev.status)}`);
  if (ev.domain_type === 'disposable') signals.push('disposable email domain');
  const eam = isObj(b.eam) ? b.eam : {};
  const seen = parseDate(eam.date_first_seen);
  const ref = asOf?.getTime();
  if (seen != null && ref != null && ref - seen < 30 * DAY) signals.push(`email first seen ${Math.max(0, Math.round((ref - seen) / DAY))} days ago`);
  else if (eam.longevity === 0) signals.push('email address is brand new');
  if ((num(risk.tumbling_risk) ?? 0) > 0) signals.push(`tumbling risk ${String(risk.tumbling_risk)}`);
  const phone = isObj(risk.phone) ? risk.phone : {};
  const owner = isObj(phone.owner) ? phone.owner : {};
  if (owner.last_name_match === 'no_match' || owner.first_name_match === 'no_match') signals.push('phone owner does not match applicant');
  if (phone.status === 'dead' || phone.status === 'invalid') signals.push(`phone ${String(phone.status)}`);
  if (phone.line_type === 'voip') signals.push('VoIP phone');
  if (phone.prepaid === true) signals.push('prepaid phone');
  if (phone.line_type === 'landline') signals.push('landline phone');
  const postal = isObj(risk.postal) ? risk.postal : {};
  if (postal.last_name_match === 'no_match') signals.push('postal address not linked to applicant');
  if (postal.ip_postal_distance === '> 1000 miles' || postal.ip_postal_distance === '500-1000 miles') signals.push(`IP ${String(postal.ip_postal_distance)} from address`);
  if (postal.deliverability === 'undeliverable') signals.push('address undeliverable');
  const ip = isObj(risk.ip) ? risk.ip : {};
  if (ip.hosting_facility === true || (typeof ip.proxy_type === 'string' && ip.proxy_type !== '')) signals.push('IP is a proxy or hosting facility');
  return { score, level: fraudLevel(score), signals };
}

// ---------------------------------------------------------------- public records (PitchPoint BLJ + CIC criminal/eviction)

export interface BankruptcyFact {
  chapter: string | null;
  status: string | null;
  open: boolean;
  filedDate: string | null;
  closedDate: string | null;
}
export interface JudgmentFact {
  amount: number | null;
  date: string | null;
  plaintiff: string | null;
  satisfied: boolean;
}
export interface LienFact {
  type: string | null;
  amount: number | null;
  date: string | null;
  released: boolean;
}
export interface CriminalFact {
  level: 'felony' | 'misdemeanor' | 'other';
  description: string | null;
  disposition: string | null;
  convicted: boolean;
  date: string | null;
  court: string | null;
}
export interface EvictionFact {
  filingDate: string | null;
  outcome: 'judgment' | 'dismissed' | 'filed';
  amount: number | null;
  date: string | null;
  court: string | null;
}
export interface PublicRecordsFacts {
  counts: { bankruptcies: number; judgments: number; liens: number };
  bankruptcies: BankruptcyFact[];
  judgments: JudgmentFact[];
  liens: LienFact[];
  criminal: CriminalFact[];
  evictions: EvictionFact[];
}

/** Case-insensitive deep collection of every value stored under `key` (XML-derived JSON). */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const n of node) collect(n, key, out);
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k.toLowerCase() === key.toLowerCase()) out.push(...arr(v));
      else collect(v, key, out);
    }
  }
  return out;
}
const pick = (o: Json, ...keys: string[]): unknown => {
  const lower = new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) {
    const v = lower.get(k.toLowerCase());
    if (v != null && v !== '') return v;
  }
  return undefined;
};

export function interpretPitchpoint(body: unknown): Pick<PublicRecordsFacts, 'counts' | 'bankruptcies' | 'judgments' | 'liens'> {
  const bankruptcies = collect(body, 'Bankruptcy').filter(isObj).map((r): BankruptcyFact => {
    const status = str(pick(r, 'Status', 'Disposition', 'DispositionType'));
    const closedDate = str(pick(r, 'DischargeDate', 'DismissalDate', 'ClosedDate'));
    return {
      chapter: str(pick(r, 'Chapter')),
      status,
      open: !closedDate && !/discharg|dismiss|closed|complete|terminat/i.test(status ?? ''),
      filedDate: str(pick(r, 'FilingDate', 'FiledDate', 'DateFiled')),
      closedDate,
    };
  });
  const judgments = collect(body, 'Judgment').filter(isObj).map((r): JudgmentFact => ({
    amount: num(pick(r, 'Amount', 'JudgmentAmount')),
    date: str(pick(r, 'JudgmentDate', 'FilingDate', 'FiledDate')),
    plaintiff: str(pick(r, 'Plaintiff', 'Creditor')),
    satisfied: /satisfied|paid|released|vacated/i.test(String(pick(r, 'Status') ?? '')) && !/unsatisfied/i.test(String(pick(r, 'Status') ?? '')),
  }));
  const liens = collect(body, 'Lien').filter(isObj).map((r): LienFact => ({
    type: str(pick(r, 'LienType', 'Type')),
    amount: num(pick(r, 'Amount', 'LienAmount')),
    date: str(pick(r, 'FilingDate', 'FiledDate')),
    released: /released|satisfied|paid/i.test(String(pick(r, 'Status') ?? '')) && !/unreleased|unsatisfied/i.test(String(pick(r, 'Status') ?? '')),
  }));
  const found = (k: string, fallback: number): number => {
    const v = collect(body, k)[0];
    return num(v) ?? fallback;
  };
  return {
    counts: {
      bankruptcies: found('BankruptciesFound', bankruptcies.length),
      judgments: found('JudgmentsFound', judgments.length),
      liens: found('LiensFound', liens.length),
    },
    bankruptcies,
    judgments,
    liens,
  };
}

function candidates(body: unknown): Json[] {
  const b = isObj(body) ? body : {};
  const resp = isObj(b.response) ? arr<Json>(b.response.candidate) : [];
  const cic = isObj(b.cicCriminal) && isObj(b.cicCriminal.candidates) ? arr<Json>(b.cicCriminal.candidates.candidate) : [];
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const c of [...resp, ...cic].filter(isObj)) {
    const key = JSON.stringify([isObj(c.subject) ? c.subject.caseNumber : null, c.offenses, c.activity]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function interpretCriminal(body: unknown): CriminalFact[] {
  return candidates(body).flatMap((c) =>
    (isObj(c.offenses) ? arr<Json>(c.offenses.offense) : []).filter(isObj).map((o): CriminalFact => {
      const kind = `${String(o.caseType ?? '')} ${String(o.description ?? '')}`;
      const disposition = str(o.amendedDisposition) ?? str(o.disposition);
      return {
        level: /felony/i.test(kind) ? 'felony' : /misdemeanor/i.test(kind) ? 'misdemeanor' : 'other',
        description: str(o.description),
        disposition,
        convicted: /convict|guilty|sentenced/i.test(disposition ?? '') || (str(o.convictionDate) != null && !/dismiss|acquit|not guilty/i.test(disposition ?? '')),
        date: str(o.convictionDate) ?? str(o.dispositionDate) ?? str(o.offenseDate) ?? str(o.filingDate),
        court: str(o.court),
      };
    }),
  );
}

export function interpretEviction(body: unknown): EvictionFact[] {
  return candidates(body).flatMap((c) =>
    arr<Json>(c.activity).filter(isObj).map((a): EvictionFact => {
      const j = String(a.judgement ?? '');
      const dismissed = a.dismissalDate != null || /dismiss/i.test(j);
      const judgment = !dismissed && (num(a.judgementAmount) != null || /judg/i.test(j) || a.judgementDate != null);
      return {
        filingDate: str(a.filingDate),
        outcome: dismissed ? 'dismissed' : judgment ? 'judgment' : 'filed',
        amount: num(a.judgementAmount),
        date: str(a.judgementDate) ?? str(a.dismissalDate) ?? str(a.filingDate),
        court: str(a.court),
      };
    }),
  );
}

export function interpretPublicRecords(pitchpoint: unknown, criminal?: unknown, eviction?: unknown): PublicRecordsFacts {
  return {
    ...interpretPitchpoint(pitchpoint),
    criminal: criminal === undefined ? [] : interpretCriminal(criminal),
    evictions: eviction === undefined ? [] : interpretEviction(eviction),
  };
}

// ---------------------------------------------------------------- accurate append (reverse phone)

export interface AppendFacts {
  records: { firstName: string | null; lastName: string | null; city: string | null; state: string | null }[];
  /** true when a returned record carries the applicant's last name; null when nothing came back. */
  matchesSubject: boolean | null;
}

export function interpretAppend(body: unknown, subjectLastName?: string): AppendFacts {
  const b = isObj(body) ? body : {};
  const data = isObj(b.data) ? b.data : {};
  const records = arr<Json>(data.records ?? b.data).filter(isObj).map((r) => ({
    firstName: str(r.firstName),
    lastName: str(r.lastName),
    city: str(r.city),
    state: str(r.state),
  }));
  const matchesSubject =
    records.length === 0 || !subjectLastName ? null : records.some((r) => r.lastName?.toUpperCase() === subjectLastName.toUpperCase());
  return { records, matchesSubject };
}

export const __test = { parseDate, collect };
