# @luyten/ledger-core

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

Run `pnpm -F @luyten/ledger-core test`, `pnpm -F @luyten/ledger-core check`, `pnpm -F @luyten/ledger-core build` from the repo root.
Update plain-summary snapshots only after reading the diff: `pnpm -F @luyten/ledger-core exec vitest run -u`.
Package `exports` point at `src/index.ts` (bundlers, vitest, tsx); `@luyten/ledger-core/dist` is the built JS for plain Node after `build`.

## Errors

Every failure throws `LedgerError` with a `code` and a plain-English `message` safe to show the CFO; a missing FX rate is `missing_rate`.

## Modules

`types.ts`: domain types and the `ProposalPayload` union (`journal_entry`, `bank_match`, `revenue_schedule`, `credit_decision`, `accrual`, `vendor_block`, `vendor_verify`, `fx_revaluation`, `ic_elimination`); `journal_entry`, `accrual` and both consolidation kinds are flat `JournalEntryInput` (account ids) plus their extra fields.
`JournalLine` carries `ym` so reports need no period lookup; `Bill.billedAt` is optional.
`ym.ts`: `{year, month}` math, UTC calendar conversion from micros, `lastCompletedYm(nowMicros)` = month before the one containing now.
`money.ts`: `parseMinor` rejects more than 2 decimals and bad grouping instead of rounding; `formatMinor` uses `$` (USD), `£` (GBP), else `CODE ` prefix; `applyFx`/`applyBp` round half away from zero; `allocateLargestRemainder` sums exactly, ties to lower index, zero weights get zero.
`fx.ts`: `fxRate(rates, from, to, ym, kind)` is exactly 1e6 within one currency, else the first direct rate of that month and kind, else `divRound(1e12, inverse)`, else throws `missing_rate`; currency codes compare case-insensitively; `translate` = `applyFx` at that rate; `groupCode('2950-UK')` = `2950`; `subsidiaryCode(base, sub)` is bare for the root (no parent), `<base>-<SUB>` otherwise.
`posting.ts`: `assertBalanced` requires 2+ lines, exactly one positive side per line, positive FX rate, and equal functional totals (per-line FX rounding first); `validateEntry` adds period open, same subsidiary, accounts exist and belong; `reversalOf` swaps sides and strips posting metadata; `materializeEntry` assigns sequential line ids.
`balances.ts`: all reports are in functional currency and every row carries sorted `lineIds`; `trialBalance` debits equal credits when all posted entries balanced; `balanceSheet` balances because retained earnings = all revenue minus expense through `asOfYm` (prior years + current fiscal year incl. the current period); `drilldown(lines, accountId, ym)` takes lines explicitly.
`revrec.ts`: subscription schedules are straight-line over start..end inclusive, remainder in the last month, total defaults to `priceMinor * qty * months` unless `allocatedMinor` is passed; usage schedules put `quantity * unitPriceMinor` in the usage month; `allocateBySsp` weights by `sspMinor` (the whole item line's SSP); `recognitionEntry` is one Dr Deferred Revenue line and one Cr Revenue line per item, or null.
`matching.ts`: scores are integer bp, max 10000 (amount 5000/3000, date 2000 decaying to 0 at 10 days vs `dueAt`, name words up to 2000, reference 1000); inflows match only invoices, outflows only bills, paid documents are skipped; one-to-one greedy on pairs >= 5000; leftover txs report their best unconsumed candidate as `unmatched`, or are omitted.
`refInText` matches references as whole tokens tolerant of one separator; references under 3 alphanumerics never match.
`findDuplicatePayments`: an outflow carrying a bill's `externalRef` within 45 days (inclusive) of the earliest earlier one.
`allowance.ts`: rates A 100, B 500, C 1000, D 5000, BLOCK 10000 bp; target = max(openAr, 0) * rate; `allowanceEntry` books the delta only, null when zero; `specificReserveReasons` are clauses written to follow "because".
`accruals.ts`: a bill is missing an accrual when its `ym` is the close month, `billedAt ?? dueAt` is at or after month end, and its id is not in `accruedBillIds`; reverses in the next month.
`metrics.ts`: ARR = 12 * sum(priceMinor * qty) of active subscription items, usage excluded; every waterfall row satisfies starting + new + expansion - contraction - churn = ending and chains to the next; a returning customer counts as new; `nrr` uses only customers with ARR in the cohort month; `aging` always returns 5 buckets, paid excluded, under one full day late is current.
`consolidation.ts`: balances in payloads are debit-positive (a liability is negative); report rows are normal-signed like `balances.ts`.
`foreignBalances` lists asset and liability accounts of one entity holding lines in exactly one foreign currency (two throws); txn balance = raw sum of the foreign lines, booked = functional sum of all the account's lines, so posted revaluations count.
`revaluation`: target = `applyFx(txn, closing rate)`, delta = target - booked, one functional line per non-zero delta plus the offset on the given FX account (credit = gain); `gainMinor` = sum of deltas; null entry when nothing moves, so a second run after posting is a no-op.
`eliminations`: `IC_PAIRS` pairs 1900/2900 and 1950/2950 (`balance`, reverses next month) and 4900/5900 (`activity`, that month only); the source side must be in the reporting currency; amount = |source|; the counter side is its post-revaluation balance at the closing rate (balance) or its month activity at the average rate (activity), mirrored so agreement means equal; difference = amount - counter; lines post at the source amount on the elimination entity's accounts for the same group codes, so entries always balance.
`eliminations` is not idempotent: it never reads the elimination entity's books, so after posting it returns the same entries again; the caller (and the module, "already eliminated") decides whether a month is done.
`translateBooks`: current-rate method; assets and liabilities at the closing rate, posted equity at each posting month's average, income and expense per account-month at that month's average (converted once, then summed); retained earnings = all translated income through `asOfYm`; CTA is the computed plug, never posted; a reporting-currency entity translates 1:1 with zero CTA; the closing rate is looked up only when a balance-sheet account has lines.
`balanced` checks the functional books (assets = liabilities + posted equity + functional retained earnings) and, for a reporting-currency entity, CTA = 0; the translated totals always agree because CTA is their plug.
`consolidate`: every entity translated, rows summed by group code; `byEntity` holds trading entities, the elimination entity's amounts are `eliminationsMinor`; `balanced` is false as soon as any entity's books are unbalanced; `unmatchedIcMinor` sums what is left on intercompany group codes (balance sheet and fiscal year-to-date income statement); a root entity has `parentId` unset or null.
`fxRevaluationPayload` / `icEliminationPayload` turn results into proposal payloads (null when nothing to post).
`proposals.ts`: wire JSON has every bigint as a base-10 string; `parseProposalPayload` validates shape only (plus `ic_elimination`: `balance` needs `reversesInYm`, `activity` must not have it), so run `validateEntry` before posting.
`consolidationWireJson(payload, accountsById)` gives the module's JSON for the two consolidation kinds: account codes, months as `YYYY-MM`, no line memos.
`plain.ts`: one sentence, no account codes, no debit/credit wording, whole amounts drop `.00`; set `purpose` on `journal_entry` payloads (`allowance`, `reversal`, `duplicate_payment`, `revenue_recognition`) or the summary falls back to the memo.
Consolidation summaries name companies from `PlainContext.subsidiaries`; pass `isElimination` (and `parentId`) so a revaluation can name the counterparty, else it says "<company>'s $X of dollar balances".

## Tests outside src

`test/feed.test.ts` and `test/seed-group.test.ts` import `seed/src/feed.ts`, `group.ts` and `accounts.ts` by relative path (test only; the seed package has no test runner): the feed plan is scored with `scoreBankMatches`, and the group seed must give the September figures to the cent.
