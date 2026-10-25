# @cafoo/crs-mcp

Updated 2026-10-24. Agent-facing: keep one rule per line, imperative, no filler. Change the tier rules here and in `src/tiers.ts` (`POLICY`, `classify`) together.

CRS Credit API sandbox client, response interpreters, the Credit Check cascade (ADR 0006), and the in-process `crs` MCP server for the Credit & Risk agent.

## Hard rules

Never retry a failed login and never loop on 401 at login: repeated failed logins permanently disable the sandbox account.
Log in at most once per process; `CrsClient.login()` is a memoized promise shared by every client with the same base URL and username, failures included.
A 401 on a product call triggers at most one more login per process, then the call fails.
A failed login (non-2xx) writes `.secrets/crs.login-failed.json`; every later process refuses to log in until a human fixes the credentials and deletes that file.
The token is cached in `.secrets/crs.json` (gitignored) and reused until 60 s before `expires`.
Send only rows of `crs-sandbox-dataset.csv`: `call()` rejects any request whose endpoint, method or body differs from a dataset row. Never build request bodies by hand.
Test-case rows are refused live unless `allowTestCases: true`; some reach the real vendor.
Never put real people's data in fixtures, tests or docs; the 20 personas are fake.
Credit reports return HTTP 200 for no-file, frozen, deceased and validation errors; read the interpreted `fileStatus`, never the status code.

## Modes

Replay is the default: `CRS_USERNAME` empty or `CRS_REPLAY="1"` answers every call from `fixtures/crs/<product>/<personaId>.json` (credit reports: `<personaId>.<bureau>.json`) with no network.
Live: set `CRS_USERNAME`, `CRS_PASSWORD`, `CRS_REPLAY="0"`; `CRS_BASE_URL` defaults to `https://api-sandbox.stitchcredit.com/api`.
The package reads `process.env` only; the caller loads `.env`.
Record: `new CrsClient({ record: dir })` writes each live persona response to `dir` in fixture layout with the real `RequestID` and `synthesized: false`.
Refresh all fixtures once credentials exist: `pnpm -F @cafoo/crs-mcp fixtures:record` (optional persona filter: `... fixtures:record P05`). It loads `../../.env` via `node --env-file-if-exists`.
Regenerate synthesized fixtures: `pnpm -F @cafoo/crs-mcp fixtures:synth` (overwrites recordings; check `fixtures/crs/_meta.json` first).
429 waits `Retry-After` seconds (capped at 120), up to 3 retries per call.
Every response keeps `headers.requestId` (the `RequestID` header; fixtures use `fx-<persona>-<product>[-<bureau>]`). Store it with the Credit Check.

## API

`personas()`, `requestsFor(personaId, product?)`, `creditRequest(personaId, bureau)`, `singleRequest(personaId, product)` read the dataset (`src/csv.ts`, hand-written RFC 4180 parser).
`new CrsClient(opts)` / `client.call(req)` returns `{ status, headers: { requestId }, body, source }`.
`interpretCreditReport`, `interpretIdentity`, `interpretFraud`, `interpretPublicRecords(pitchpoint, criminal?, eviction?)`, `interpretAppend` are pure (`src/interpret.ts`).
`creditReport`, `identityVerify`, `fraudScore`, `publicRecords` call one product and return `{ facts, evidence, raw }` (`src/products.ts`).
`runCascade(client, personaId, { subjectKind, asOf? })` returns `{ personaId, tier, decision, paymentTermsDays, evidence[], reasons[], allowanceReasonCodes[], summaryPlain, summaryTechnical, stoppedEarly, facts }`.
`classify(...)` is the pure tier function; use it to re-tier stored facts without calling CRS.
`src/tiers.ts` holds the tier rules (`POLICY`, `classify`, `gateReasons`, `fraudLevel`, `deriveTier`) with no imports, I/O or clock; the SpacetimeDB module imports it, so keep it to ES2021.
`deriveTier(facts, asOf)` checks untrusted recorded facts (shape, consistency, completeness) and returns `{ tier, decision, paymentTermsDays, reasons }`, or throws an Error naming the bad field.
`creditCheckSummaryJson(result, evidence)` is the `summaryJson` of one recorded Credit Check row: the evidence row plus `facts`; pass it to `recordCreditCheck` unchanged.
`allowanceReasonCodes` on the cascade result holds the ledger allowance codes (`active_bankruptcy`, `fraud_alert`, `identity_mismatch`, `judgment_or_lien`, `deceased_guarantor`) for BLOCK and D tiers only; pass them to the allowance Proposal unchanged.
Mapping in `ALLOWANCE_CODE`: `synthetic_identity` -> `identity_mismatch`; `fraud_high` and `identity_step_up` -> `fraud_alert`. `sanctions_match` is never emitted (no OFAC search runs).

## MCP server

Register with the Agent SDK as `mcpServers: { crs: createCrsMcpServer() }`; pass `{ client, asOf }` to override.
Tools, all `readOnlyHint: true`: `crs_personas`, `crs_credit_report {personaId, bureau}`, `crs_identity_verify {personaId}`, `crs_fraud_score {personaId}`, `crs_public_records {personaId}`, `crs_cascade {personaId, subjectKind}`.
Results are `{ content: [{ type: 'text', text: JSON }], structuredContent }`; errors come back with `isError: true`, never thrown.
Pass `raw: true` to the single-product tools to include raw bodies (Expert mode).
The tools never write to the ledger; the agent turns a cascade result into a Proposal.

## Cascade order

1. TU identity verification, then Fraud Finder.
2. Stop with BLOCK (no bureau or records calls, `stoppedEarly: true`) on deceased, identity FAIL, synthetic identity, or fraud `risk.score >= 70`.
3. TransUnion, Equifax and Experian reports in parallel.
4. PitchPoint BLJ, CIC criminal and CIC eviction in parallel.
5. Classify.

## Tier rules

Reasons are grouped; the first group present decides tier and decision.

| Order | Group | Triggers | Tier | Decision | Terms |
|---|---|---|---|---|---|
| 1 | block | deceased (identity or any bureau); identity FAIL; synthetic identity (2202 or several names on the SSN); fraud score >= 70; open bankruptcy (`active_bankruptcy`; the plain summary names Ch.13) | BLOCK | DECLINE | null |
| 2 | active | unpaid collections, unpaid charge-offs or 90+ days past due with a balance, reported by a majority of the bureaus that returned a file; felony conviction within 7 years; eviction judgment within 7 years | D | DECLINE | 0 (prepay) |
| 3 | nofile | every bureau `NoFileReturnedNoHit` | C | NO_FILE | 15 |
| 4 | gap | a bureau frozen, no-hit or errored while another returned a file; file with no score; thin file (< 3 tradelines at any bureau); identity KBA_REQUIRED (2401 fraud alert or 2101 address mismatch only); fraud score 31-69; an unpaid bad debt reported by only a minority of bureaus (`bureau_divergence`); identity or records call failed | C | REVIEW | 15 |
| 5 | mark | lowest score < 680; closed or discharged bankruptcy; unpaid judgment or unreleased lien (PitchPoint or bureau); any collection account; misdemeanor conviction or pending eviction within 7 years | D | REVIEW | 0 (prepay) |
| 6 | none | lowest score >= 740, no derogatory tradelines, no public records, no convictions | A | APPROVE | 45 |
| 7 | none | otherwise (lowest score >= 680) | B | APPROVE | 30 |

Fraud levels: <= 30 low, 31-69 medium, >= 70 high.
Dismissed criminal charges and dismissed evictions are ignored; undated records count as recent.
Lookbacks use `asOf` (default now); pass a fixed `asOf` in tests and demo replays.
Record dates are read as UTC calendar days (`YYYY-MM-DD`, `MM-DD-YYYY`, `MM/DD/YYYY`); any other text counts as recent.
The ledger never takes a tier from the agent: `recordCreditCheck` derives each row's tier and decision from `summaryJson.facts` with `deriveTier`, as of the moment of recording.
`deriveTier` refuses evidence that passes identity and fraud but lacks a bureau or the public-records search, because missing evidence must never read as clean credit.
`subjectKind: 'vendor_owner'` changes only the plain summary wording (onboarding instead of payment terms); tier and terms are the same.

## Persona results (replay, asOf 2026-10-24)

Asserted by `test/cascade.test.ts`; all 20 match the dataset's `expected_decision`.

| Persona | Profile | Tier | Decision | Deciding reasons |
|---|---|---|---|---|
| P01 | Prime | A | APPROVE | none |
| P02 | Super-prime mortgage holder | A | APPROVE | none |
| P03 | Thin file | C | REVIEW | thin_file_tu, thin_file_efx |
| P04 | Credit invisible | C | NO_FILE | no_file |
| P05 | Subprime | D | DECLINE | unpaid_derogatories |
| P06 | Chapter 7 discharged | D | REVIEW | score_below_680, discharged_bankruptcy |
| P07 | Chapter 13 active | BLOCK | DECLINE | active_bankruptcy |
| P08 | Tax lien and civil judgment | D | REVIEW | judgment_or_lien |
| P09 | Felony conviction | D | DECLINE | felony_conviction |
| P10 | Old dismissed misdemeanor | B | APPROVE | none |
| P11 | Eviction history | D | DECLINE | eviction_judgment |
| P12 | Identity mismatch | BLOCK | DECLINE | identity_mismatch, fraud_high |
| P13 | Synthetic identity | BLOCK | DECLINE | synthetic_identity, fraud_high |
| P14 | Deceased | BLOCK | DECLINE | deceased_guarantor |
| P15 | Freeze at one bureau | C | REVIEW | frozen_tu |
| P16 | Fraud alert on file | C | REVIEW | identity_step_up, fraud_medium |
| P17 | Bureau divergence | C | REVIEW | bureau_divergence, no_file_efx |
| P18 | Rebuilding | D | REVIEW | score_below_680 |
| P19 | Small-business owner | A | APPROVE | none |
| P20 | Retiree with stale file | C | REVIEW | no_score_tu, no_score_efx, no_score_exp |

## Fixtures

`fixtures/crs/` is synthesized from the documented outcomes until recorded live; `_meta.json` says which.
Unconfirmed shapes the interpreters tolerate rather than assume: PitchPoint `/pp/fcrablj/data` keys (free-form XML-derived JSON, read by case-insensitive key search for `Bankruptcy`, `Judgment`, `Lien`, `*Found`), the deceased `errorMessages` code (matched on text containing "deceas"), the login `expires` format, and score `modelName` strings.
After a live recording, run `pnpm -F @cafoo/crs-mcp test`; if a persona's decision changes, fix the interpreter, not the expected decision.

## Commands

`pnpm -F @cafoo/crs-mcp test` runs vitest (replay only, no network).
`pnpm -F @cafoo/crs-mcp check` type-checks.
`pnpm -F @cafoo/crs-mcp build` emits `dist/`.
