# @cafoo/ledger-core

Updated 2026-10-24. Agent-facing doc: keep it terse, one rule per line, guarantees not tutorials.

Pure, deterministic double-entry engine shared by the SpacetimeDB module, the agents, and tests.

## Hard constraints

Never add a runtime dependency; dev deps are `typescript` and `vitest` only.
Never use `Date`, `Math.random`, `Intl`, `localeCompare`, `toLocale*`, `Buffer`, or any Node API in `src/`; the module runs in V8 with none of them.
Never use `number` for money; amounts are `bigint` minor units, FX rates are `bigint` scaled by 1e6 (`rateE6`, `1_000_000n` = 1:1).
Callers pass the clock as `bigint` microseconds; nothing here reads time.
Every sort has an explicit tie-break, so outputs do not depend on input order where documented.
Never name the reference product anywhere; `bash scripts/lint-refs.sh` from the repo root enforces it.

## Commands

Run `pnpm -F @cafoo/ledger-core test`, `pnpm -F @cafoo/ledger-core check`, `pnpm -F @cafoo/ledger-core build` from the repo root.
Update plain-summary snapshots only after reading the diff: `pnpm -F @cafoo/ledger-core exec vitest run -u`.
Package `exports` point at `src/index.ts` (bundlers, vitest, tsx); `@cafoo/ledger-core/dist` is the built JS for plain Node after `build`.

## Errors

Every failure throws `LedgerError` with a `code` and a plain-English `message` safe to show the CFO.

## Modules

`types.ts`: domain types and the `ProposalPayload` union (`journal_entry`, `bank_match`, `revenue_schedule`, `credit_decision`, `accrual`, `vendor_block`); `journal_entry` and `accrual` are flat `JournalEntryInput` plus their extra fields.
`JournalLine` carries `ym` so reports need no period lookup; `Bill.billedAt` is optional.
`ym.ts`: `{year, month}` math, UTC calendar conversion from micros, `lastCompletedYm(nowMicros)` = month before the one containing now.
`money.ts`: `parseMinor` rejects more than 2 decimals and bad grouping instead of rounding; `formatMinor` uses `$` (USD), `£` (GBP), else `CODE ` prefix; `applyFx`/`applyBp` round half away from zero; `allocateLargestRemainder` sums exactly, ties to lower index, zero weights get zero.
`posting.ts`: `assertBalanced` requires 2+ lines, exactly one positive side per line, positive FX rate, and equal functional totals (per-line FX rounding first); `validateEntry` adds period open, same subsidiary, accounts exist and belong; `reversalOf` swaps sides and strips posting metadata; `materializeEntry` assigns sequential line ids.
`balances.ts`: all reports are in functional currency and every row carries sorted `lineIds`; `trialBalance` debits equal credits when all posted entries balanced; `balanceSheet` balances because retained earnings = all revenue minus expense through `asOfYm` (prior years + current fiscal year incl. the current period); `drilldown(lines, accountId, ym)` takes lines explicitly.
`revrec.ts`: subscription schedules are straight-line over start..end inclusive, remainder in the last month, total defaults to `priceMinor * qty * months` unless `allocatedMinor` is passed; usage schedules put `quantity * unitPriceMinor` in the usage month; `allocateBySsp` weights by `sspMinor` (the whole item line's SSP); `recognitionEntry` is one Dr Deferred Revenue line and one Cr Revenue line per item, or null.
`matching.ts`: scores are integer bp, max 10000 (amount 5000/3000, date 2000 decaying to 0 at 10 days vs `dueAt`, name words up to 2000, reference 1000); inflows match only invoices, outflows only bills, paid documents are skipped; one-to-one greedy on pairs >= 5000; leftover txs report their best unconsumed candidate as `unmatched`, or are omitted.
`refInText` matches references as whole tokens tolerant of one separator; references under 3 alphanumerics never match.
`findDuplicatePayments`: an outflow carrying a bill's `externalRef` within 45 days (inclusive) of the earliest earlier one.
`allowance.ts`: rates A 100, B 500, C 1000, D 5000, BLOCK 10000 bp; target = max(openAr, 0) * rate; `allowanceEntry` books the delta only, null when zero; `specificReserveReasons` are clauses written to follow "because".
`accruals.ts`: a bill is missing an accrual when its `ym` is the close month, `billedAt ?? dueAt` is at or after month end, and its id is not in `accruedBillIds`; reverses in the next month.
`metrics.ts`: ARR = 12 * sum(priceMinor * qty) of active subscription items, usage excluded; every waterfall row satisfies starting + new + expansion - contraction - churn = ending and chains to the next; a returning customer counts as new; `nrr` uses only customers with ARR in the cohort month; `aging` always returns 5 buckets, paid excluded, under one full day late is current.
`proposals.ts`: wire JSON has every bigint as a base-10 string; `parseProposalPayload` validates shape only, so run `validateEntry` before posting.
`plain.ts`: one sentence, no account codes, no debit/credit wording, whole amounts drop `.00`; set `purpose` on `journal_entry` payloads (`allowance`, `reversal`, `duplicate_payment`, `revenue_recognition`) or the summary falls back to the memo.
