import { readFileSync } from 'node:fs';
import { datasetPath } from './paths.js';

export type Product =
  | 'credit_report'
  | 'tu_identity_verification'
  | 'fraud_finder'
  | 'pitchpoint_blj'
  | 'criminal'
  | 'eviction'
  | 'accurate_append';

export type ExpectedDecision = 'APPROVE' | 'REVIEW' | 'DECLINE' | 'NO_FILE';

export type Bureau = 'transunion' | 'equifax' | 'experian';

/** One row of crs-sandbox-dataset.csv: a request the sandbox has a canned answer for. */
export interface PersonaRequest {
  /** 'persona' rows belong to P01..P20; 'test_case' rows exercise validation and have no persona. */
  source: 'persona' | 'test_case';
  /** P01..P20, or '' for test cases. */
  personaId: string;
  personaName: string;
  profile: string;
  /** '' for test cases. */
  expectedDecision: ExpectedDecision | '';
  personaSummary: string;
  product: Product;
  /** For credit_report: TransUnion | Equifax | Experian. */
  variant: string;
  method: string;
  /** Path under the base URL, e.g. /transunion/credit-report/standard/tu-prequal-fico9 */
  endpoint: string;
  config: string;
  description: string;
  expectedOutcome: string;
  /** The parsed request_body_json. Sent verbatim (re-serialized), never modified. */
  body: unknown;
  /** 1-based data row number in the CSV, for traceability. */
  row: number;
}

/** Persona summary, one per P01..P20. */
export interface Persona {
  personaId: string;
  personaName: string;
  profile: string;
  expectedDecision: ExpectedDecision;
  personaSummary: string;
  products: Product[];
}

/**
 * RFC 4180 CSV parser: quoted fields may contain commas, newlines and doubled quotes.
 * Returns rows of raw string cells. Strips a leading BOM.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

let cache: PersonaRequest[] | undefined;

/** All 207 dataset rows (180 persona rows + 27 test cases). */
export function loadDataset(path: string = datasetPath()): PersonaRequest[] {
  if (cache && path === datasetPath()) return cache;
  const [header, ...data] = parseCsv(readFileSync(path, 'utf8'));
  if (!header) throw new Error(`empty dataset: ${path}`);
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`dataset column missing: ${name}`);
    return i;
  };
  const c = {
    source: col('source'),
    personaId: col('persona_id'),
    personaName: col('persona_name'),
    profile: col('profile'),
    expectedDecision: col('expected_decision'),
    personaSummary: col('persona_summary'),
    product: col('product'),
    variant: col('variant'),
    method: col('method'),
    endpoint: col('endpoint'),
    config: col('config'),
    description: col('description'),
    expectedOutcome: col('expected_outcome'),
    body: col('request_body_json'),
  };
  const out = data.map((r, idx): PersonaRequest => {
    const get = (i: number): string => r[i] ?? '';
    const rawBody = get(c.body);
    return {
      source: get(c.source) === 'persona' ? 'persona' : 'test_case',
      personaId: get(c.personaId),
      personaName: get(c.personaName),
      profile: get(c.profile),
      expectedDecision: get(c.expectedDecision) as ExpectedDecision | '',
      personaSummary: get(c.personaSummary),
      product: get(c.product) as Product,
      variant: get(c.variant),
      method: get(c.method) || 'POST',
      endpoint: get(c.endpoint),
      config: get(c.config),
      description: get(c.description),
      expectedOutcome: get(c.expectedOutcome),
      body: rawBody ? (JSON.parse(rawBody) as unknown) : undefined,
      row: idx + 1,
    };
  });
  if (path === datasetPath()) cache = out;
  return out;
}

/** The 20 sandbox personas, in id order. */
export function personas(): Persona[] {
  const byId = new Map<string, Persona>();
  for (const r of loadDataset()) {
    if (r.source !== 'persona') continue;
    let p = byId.get(r.personaId);
    if (!p) {
      p = {
        personaId: r.personaId,
        personaName: r.personaName,
        profile: r.profile,
        expectedDecision: r.expectedDecision as ExpectedDecision,
        personaSummary: r.personaSummary,
        products: [],
      };
      byId.set(r.personaId, p);
    }
    if (!p.products.includes(r.product)) p.products.push(r.product);
  }
  return [...byId.values()].sort((a, b) => a.personaId.localeCompare(b.personaId));
}

export function persona(personaId: string): Persona {
  const p = personas().find((x) => x.personaId === personaId.toUpperCase());
  if (!p) throw new Error(`unknown persona ${personaId}; expected P01..P20`);
  return p;
}

/** Persona rows for one persona, optionally narrowed to one product. */
export function requestsFor(personaId: string, product?: Product): PersonaRequest[] {
  const id = personaId.toUpperCase();
  return loadDataset().filter(
    (r) => r.source === 'persona' && r.personaId === id && (!product || r.product === product),
  );
}

/** Test-case rows (validation failures and route examples). No persona id. */
export function testCases(product?: Product): PersonaRequest[] {
  return loadDataset().filter((r) => r.source === 'test_case' && (!product || r.product === product));
}

export function bureauOf(req: PersonaRequest): Bureau | undefined {
  if (req.product !== 'credit_report') return undefined;
  const e = req.endpoint.toLowerCase();
  if (e.startsWith('/transunion')) return 'transunion';
  if (e.startsWith('/equifax')) return 'equifax';
  if (e.startsWith('/experian')) return 'experian';
  return undefined;
}

/** The one credit-report request for a persona at a bureau. */
export function creditRequest(personaId: string, bureau: Bureau): PersonaRequest {
  const r = requestsFor(personaId, 'credit_report').find((x) => bureauOf(x) === bureau);
  if (!r) throw new Error(`no ${bureau} credit_report row for ${personaId}`);
  return r;
}

/** The single request for a persona and a non-credit product. */
export function singleRequest(personaId: string, product: Exclude<Product, 'credit_report'>): PersonaRequest {
  const r = requestsFor(personaId, product)[0];
  if (!r) throw new Error(`no ${product} row for ${personaId}`);
  return r;
}

/**
 * Fixture file name (without .json) under fixtures/crs/<product>/.
 * Credit reports carry the bureau: P01.transunion.json; every other product: P01.json.
 */
export function fixtureName(req: PersonaRequest): string {
  if (req.source !== 'persona') throw new Error(`test-case row ${req.row} has no fixture`);
  const b = bureauOf(req);
  return b ? `${req.personaId}.${b}` : req.personaId;
}

/** Short bureau label used in request ids and summaries. */
export const BUREAU_SHORT: Record<Bureau, string> = { transunion: 'tu', equifax: 'efx', experian: 'exp' };
