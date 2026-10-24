# @cafoo/eval-harness

Updated 2026-10-24. Agent-facing: one rule per line, imperative, no filler.

Two eval layers, both with zero API keys:
(A) charter evals: each checkable line of `apps/agents/src/charters/<agent>.md` is a scenario checked against the live ledger;
(B) deterministic correctness: the credit cascade, replayed in-process, must reproduce the dataset's expected decision for all 20 personas.

## Commands

Run from the repo root.
`pnpm -F @cafoo/eval-harness run run` evaluates the current database (all suites). `pnpm -F @cafoo/eval-harness run` alone only lists scripts (pnpm built-in), so the `eval` script is an alias: `pnpm -F @cafoo/eval-harness eval`.
Flags: `--suite charters|personas|all` (default all), `--rerun`, `--db <name>` (default `cafoo`), `--server <name>` (default `local`), `--ym YYYY-MM` (close month; default: month of the newest proposal), `--as-of YYYY-MM-DD` (persona cascade date; default 2026-10-24), `--only <id substring>`.
`--rerun` is destructive: it runs seed generate, `SEED_RESET=1` seed load and the scripted close for `--ym` (default 2026-09) against `--db`, about 30 s. Never use it on a database someone else is demoing from.
`--suite personas` needs no database.
`pnpm -F @cafoo/eval-harness test` runs the harness's own tests offline (vitest, no database).
`pnpm -F @cafoo/eval-harness check` type-checks.
The `spacetime` CLI is found via `SPACETIME_BIN`, then `~/.local/bin/spacetime`, then `PATH`.

## Results and scoring

Each scenario is PASS when every assertion holds.
A failing scenario is FAIL when `severity: block`, WARN when `severity: warn`.
ERROR means the scenario could not be judged: SQL error, database unreachable, unknown check, or `charter_line` not found verbatim in the charter. ERROR on a block scenario counts as a blocking failure.
Exit code 1 when any block scenario is FAIL or ERROR, 0 otherwise, 2 on usage or `--rerun` failure.
The console prints `scenario | agent | result | detail`; `reports/<timestamp>.md` and `.json` (gitignored) add offending rows (first 10) for every failure.
The score line is `passed/total` overall and per suite.
Never weaken an assertion to make a run pass; a failing charter scenario means an agent broke its charter. Report it with the SQL and the offending rows.

## Adding a scenario

Add the rule to the agent's charter first; write charters as instructions to the agent (they are live-mode prompts too).
Create `scenarios/<agent>-<rule>.yaml` with `id` (unique, same as the file stem), `agent` (advisor, bookkeeper, revenue, credit, redteam), `charter_line`, `severity` (block or warn), optional `description`, and `assertions`.
`charter_line` must be a verbatim substring of the charter file (whitespace and list numbers ignored); otherwise the scenario errors.
A cross-cutting ledger-integrity rule that belongs to no agent's charter (FX rates, bank-match payment entries) uses `agent: ledger` and no `charter_line`; name the file `ledger-<rule>.yaml`. It is a charters-suite scenario in every other way, mutation included.
Use `severity: warn` only when the rule depends on what the seed happens to contain.
A file may instead hold `scenarios:` (a list) plus shared top-level defaults, as `personas.yaml` does; set `suite: personas` for DB-free cascade scenarios (default `charters`).
Add a mutation for the new id to `MUTATIONS` in `test/scenarios.test.ts` that breaks exactly that rule on the recorded snapshot; the test suite fails if a charter scenario has none.
Refresh `test/fixtures/ledger-snapshot.json` only from a clean scripted close, with `node --conditions=source --import tsx scripts/record-snapshot.ts --db <name>` from this package: it reseeds that database, runs the waiting-mode close with the demo CFO stand-in (`apps/agents/src/demo-cfo.ts`) confirming material rulings until the lock is requested, and dumps the tables the scenarios read. `--db` is required because the database is reset, and the demo CFO takes that database's CFO seat. Then make sure the baseline test still passes.

## SQL the endpoint accepts

Write `SELECT * FROM <table> [WHERE ...]` or `SELECT COUNT(*) AS n FROM <table> [WHERE ...]`, with `=`, `!=`, `<`, `<=`, `>`, `>=`, `AND`, `OR` on string, number and bool columns.
Never use `LIKE`, `IN`, `GROUP BY`, or enum literals (`status = 'approved'` errors); filter those with `where` in code.
Joins work only as `SELECT a.* FROM a JOIN b ON ...` on non-optional columns, and duplicate column names error; prefer `sql_anti_join` / `sql_semi_join`.
Tables and columns are snake_case. Rows are decoded from `--format json`: enums become snake_case tags (`awaiting_cfo`), options become value or `null`, identities hex strings, timestamps microseconds.
`${materiality}` (settings `materiality_threshold_minor`, default 1000000) and `${close_ym}` are substituted into every string before running.

## Assertion types

`sql_count {sql, where?, expect | min | max}`: number of rows (or the COUNT value) after `where`.
`sql_all {sql, where?, require?, expect_rows (default 0), show?}`: rows matching `where` that fail `require` are offenders; without `require`, every row matching `where` is an offender.
`sql_covers {sql, where?, column, values, min (default 1)}`: each value appears in `column` at least `min` times.
`sql_unique {sql, where?, key}`: no two rows share `key`.
`sql_anti_join {left: {sql, where?, key}, right: side or list of sides, expect_rows (default 0)}`: left rows with no matching key on any right side are offenders.
`sql_semi_join {...same}`: left rows that do have a matching key are offenders.
`cascade_decision {persona, expect, expect_tier?, subject_kind?, as_of?}`: runs `runCascade` in forced replay mode (never live, whatever `CRS_*` says); `expect` must also equal the dataset's `expected_decision`.
`check {name, params?}`: a named check in `src/checks.ts` for rules needing several tables, payload arithmetic, time order, or the cascade: `revenue_schedule_sums`, `revenue_schedule_within_term`, `no_early_recognition`, `annual_contracts_scheduled`, `credit_full_cascade`, `credit_request_ids_cited`, `credit_tier_matches_cascade`, `vendor_check_cites_clean_checks`, `critique_before_ruling`, `plain_summary_clean {sql, where?, column}`, `single_ruling_per_proposal`, `done_tasks_ruled`, `lock_revenue_recognized`, `revenue_credits_only_in_recognition`, `material_entries_confirmed`, `fx_rates_recorded`, `bank_match_payment_entries`.
Every assertion takes an optional `label` for the report.

## Conditions (`where`, `require`, join sides)

A condition map ANDs `<path>: <condition>` entries; `any_of: [maps]`, `all_of: [maps]` and `not: map` nest.
A path is a column, or a dotted walk into a JSON-text column: `payload_json.matches.0.scoreBp`, `summary_json.requestId`.
A bare value means equals; ids compare as strings, so `29` equals `"29"`.
Operators: `eq`, `ne`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `min_length`, `max_length`, `matches`, `not_matches`, `imatches`, `not_imatches` (case-insensitive regex), `is_null`, `min_items`, `max_items`, `length`, `each` (condition map applied to every array element), `eq_column`, `ne_column`.
Escape backslashes in double-quoted YAML regexes (`"^done\\b"`).

## Plain summary rule (`plain_summary_clean`)

Flags summaries shorter than 10 characters, more than one sentence, any account code from the `account` table, bookkeeping jargon (debit, accrual, Dr, Cr, GL, JE, AR, AP, ECL, ASC 606), bureau jargon (tradeline, FICO, KBA, BLJ, PitchPoint), machine reason codes (`thin_file_tu`), and raw minor-unit numbers of five or more digits.
