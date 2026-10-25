# Luyten product spec

Updated 2026-10-24 (group close, feed, charters). Terms follow [CONTEXT.md](../CONTEXT.md).

## Positioning

Luyten is the finance ERP where agents do the close and the CFO stays in charge. Worker agents propose every change to the books. A Red Team critiques. The Advisor rules with a written rationale. The CFO confirms anything material and locks the month. Nothing posts without a ruling, and every number drills down to the journal lines behind it.

Legacy ERPs record what people type. Spreadsheets hold the real work. Luyten replaces the people-hours between them with agents, and replaces blind trust in those agents with a gate the database enforces.

## Who it is for

Finance teams at SaaS companies, from a solo controller to a CFO with a small team. The CFO may be technical or not, so every screen leads with a Plain summary and keeps the technical depth one toggle away.

Luyten fits best when the company sells to small businesses. Those customers are often backed by an owner-guarantor, and the owner's personal credit decides whether an invoice gets paid. Luyten checks that owner before extending terms and reserves against the receivable when the check fails.

## Modules

| Module | Adequate today | Out of scope today |
|---|---|---|
| General ledger | Double-entry journal entries and lines in minor units, chart of accounts per Subsidiary with Group codes, trial balance, balance sheet, reversals, one group Period per month (open, closing, locked), per-line FX rates checked against recorded rates | Multi-book, statistical accounts, custom segments, per-Subsidiary locks |
| Revenue recognition | Straight-line schedules per contract item, usage recognized in the month of use, SSP allocation, deferred revenue release, missing-schedule detection | Variable consideration, contract modifications, usage forecasting |
| Receivables & billing | Contracts, contract items, invoices, open AR, aging buckets, payment terms set from Risk Tier | Invoice generation and delivery, dunning, payment portal |
| Payables | Vendors, bills, duplicate-payment detection, accruals for bills dated after month end that reverse next month, vendor verification and block | Bill pay, approval routing for spend, 1099s |
| Bank reconciliation | Integer-scored matching on amount, date, counterparty, and reference; one-to-one; auto bucket at 75% and above, review bucket below; a simulated live Feed of bank lines and invoices with a continuous Bookkeeper; each bank line explained by at most one waiting Proposal | Connections to real bank and billing providers, multi-currency bank accounts |
| Close management | Close Tasks with owner role, status, and evidence Proposals, including Consolidate subsidiaries for the Consolidation agent; months close in order (a month starts its close and locks only after every earlier month is locked); a group month locks only once its revaluation and eliminations match the books; opening a close stops the live feed booking into the month; the Advisor requests the lock, the CFO confirms it | Custom close templates, recurring task calendars |
| Reporting & Board Pack | P&L, Balance Sheet, ARR waterfall, NRR, AR aging; consolidated for the group (per-company columns, Eliminations column, CTA) or for one Subsidiary in its own currency; deterministic; every figure drills down to journal lines | Custom report builder, budget versus actual |
| Credit & Risk | Credit cascade on every guarantor behind open AR and every unverified vendor owner: identity, fraud, three bureaus, public records; Risk Tier A, B, C, D, or BLOCK; Allowance from 1% to 100%; Public footprint per customer and vendor (Yelp, job board, LinkedIn) stored per run | Business credit bureaus, ongoing monitoring alerts, weekly footprint refresh |
| Agents & governance | Bookkeeper, Revenue, Credit & Risk, Consolidation, Red Team, Advisor, and the ingest-only Feed; role identities; two-tier gate in reducers; Materiality threshold in the Reporting currency; Debate threads; audit trail; CFO seat claimed with a Bootstrap secret; Charter versions the finance team edits, stricter only, published after a passing full eval | A separate evaluator identity, charters that loosen a shipped rule |
| CFO experience | Plain summaries, amounts and two buttons on every screen; figures drill down to journal lines | Mobile app |
| Multi-entity & FX | A group of Subsidiaries with parent links and Functional currencies; Intercompany accounts; month-end Revaluation at the closing rate; balance and activity Eliminations posted to the Elimination subsidiary; Translation and CTA computed for reports | Partly owned subsidiaries and minority interests, more than one Elimination subsidiary, a Reporting currency other than USD in the demo |

## Entity model

All records live in one SpacetimeDB module. The UI subscribes to them live.

The demo group has three Subsidiaries: Cafoo Inc (US, USD, the root), Cafoo Ltd (UK, GBP, parent US) and the Elimination subsidiary (ELIM, USD, parent US), which holds only Eliminations. Cafoo Ltd borrows $200,000 from Cafoo Inc and pays it a $15,000 service fee every month. One Period per month covers the whole group. Account codes stay unique across the group: the root company keeps bare codes (`1000`), every other company adds its code (`1000-UK`, `1900-ELIM`), and the Group code before the dash lines accounts up for consolidation. An entry may post only to its own Subsidiary's accounts.

| Table | What it holds |
|---|---|
| `subsidiary` | A legal entity with its own books, Functional currency, optional parent, and whether it is the Elimination subsidiary |
| `account` | A chart-of-accounts line of one Subsidiary with type (asset, liability, equity, revenue, expense) and an intercompany flag |
| `period` | One calendar month of the whole group and its status |
| `period_lock` | Who locked a Period, when, and why |
| `journal_entry` | A posted entry: Period, memo, source (seed, agent, manual), the Proposal it came from, who posted it, and what it reverses |
| `journal_line` | One debit or credit on one Account, in minor units, with FX rate and optional customer or vendor |
| `fx_rate` | A spot, average, or closing rate for a currency pair and month, scaled by 1e6 |
| `customer` | A customer with its Guarantor, Risk Tier, payment terms, and current Allowance |
| `contract` | A customer's agreement: term, total, and plan (annual or usage) |
| `contract_item` | One priced line of a Contract (subscription or usage) with its standalone selling price |
| `revenue_schedule_line` | One month of a Revenue Schedule and whether it has been recognized |
| `invoice` | An invoice with issue date, due date, amount, and status |
| `vendor` | A vendor with category, owner, and verification status (unverified, verified, blocked) |
| `bill` | A vendor bill with reference, dates, amount, expense account, and status |
| `bank_transaction` | One line of a Subsidiary's bank feed and whether it is matched |
| `bank_match` | The link from a bank transaction to an invoice, bill, or journal entry, with a confidence score in basis points |
| `proposal` | A worker agent's requested change: kind, payload, rationale, Plain summary, amount, status, and Debate thread |
| `approval` | The Advisor's ruling on one Proposal, with rationale, Plain summary, and the CFO's confirmation if required |
| `settings` | Key-value settings: the Materiality threshold, the Reporting currency, and the CFO's feed switch |
| `agent_identity` | Private: which connection holds which role |
| `agent_roster` | Public: which roles are online and on which model |
| `agent_message` | Every statement, critique, question, and ruling in a Debate |
| `close_task` | A close checklist item with owner role, status, and evidence |
| `credit_check` | One product call in a credit cascade, with its request id, Risk Tier, and decision |
| `public_footprint` | One run of one public source (Yelp, job board, LinkedIn) for a Customer or Vendor: fetch time, headline numbers, facts, whether it was live or recorded |
| `audit_event` | Every action: who, what role, which record, when |
| `feed_event` | Every row the Feed booked, by its external id, so a replayed row is skipped |
| `charter_version` | One numbered, unchangeable Charter text with its line mapping: draft, live, or retired, and who published it when |
| `charter_eval` | One eval run of a Charter version (full eval or quick check), passed or failed, with its report |
| `cfo_bootstrap` | Private: the hash of the armed one-time CFO claim and when it expires |

Proposal kinds are journal entry, bank match, revenue schedule, credit decision, accrual, vendor block, vendor check, Revaluation, and Elimination. A vendor check marks a vendor verified after its owner passes the identity and fraud checks; no agent can mark a vendor verified any other way. Proposal statuses are open, approved, rejected, amended, awaiting CFO, sent back, and superseded.

## Governance model

There are two tiers, and both are enforced in database reducers that check the caller's identity.

Tier one is the Advisor. Worker agents may propose. Only the Red Team may critique. Only the Advisor may approve, reject, or amend, and only the Advisor's ruling can apply a Proposal to the ledger. A ruling without a Plain summary is refused.

Tier two is the CFO. When a Proposal's amount is at or above the Materiality threshold, the Advisor's approval does not post. The Proposal moves to "Needs your OK" and waits. Only the CFO can confirm it, send it back with a note, reverse a posted entry, change the threshold, or lock and unlock a Period. The Advisor can request a lock, and the request is refused while any Proposal for the month still needs a ruling or a confirmation.

The Materiality threshold defaults to $10,000 and is a setting the CFO controls. The module computes a Proposal's amount from its payload and stores the larger of that and the amount the proposer states, so understating never avoids the CFO: the debits of a journal entry or accrual, the bank transactions a bank match settles, the lines of a revenue schedule, the unpaid bills a vendor block or vendor check affects, and the debits of a Revaluation or Elimination. Amounts are always in the Reporting currency: a foreign Subsidiary's amounts convert at the month's closing rate (or the latest earlier one), and a Proposal that cannot be sized is refused. A credit decision moves no balances; its Allowance arrives as a separate journal entry.

Consolidation Proposals are checked against the books. A group month locks only once they match the books: the module recomputes them at the lock request and at the lock, so a later decision that moves a foreign-currency or intercompany balance is caught there. The module recomputes a Revaluation's balances, rates and deltas, and an Elimination's pair amounts, from the posted ledger and recorded rates when the Proposal is made, when it is ruled on, and when it posts, and refuses a figure that is off by a cent. Eliminations post only to the Elimination subsidiary, only for the group's intercompany pairs, and a balance Elimination reverses itself the next month. Nothing else may post to the Elimination subsidiary.

The Feed has its own role that can only add raw bank lines and invoices; it cannot propose, rule, or post. It books only while the CFO has it switched on, only into the open month after one the CFO locked, and only until that month's close opens. Two waiting Proposals may never explain the same bank line, so the continuous Bookkeeper and a close cannot race each other.

The CFO seat is a person's. No connection can register itself as CFO: whoever set up the database arms a one-time Bootstrap secret, and the claim link seats the browser that opens it. After that, only the CFO can grant the seat.

Charters are versions the finance team edits. A Charter version can only make the gate stricter: every shipped rule stays, and its lines may add rules or tighten them through designed templates (a higher batch-match threshold, a lower intercompany tolerance, narrower Proposal kinds, an amount cap). A draft changes nothing until the CFO publishes it, and the module refuses to publish unless the version's latest Charter eval is a passing full eval: a whole close on a scratch database, then every mapped scenario. Retiring the live version brings back the built-in Charter.

Plain summaries are a required field, not a display option. Every Proposal, critique, and ruling carries one sentence the CFO can read without accounting training, next to a technical rationale for anyone who wants it.

The audit trail is complete by construction. Every reducer that changes state writes an `audit_event` with the actor's identity and role. Every journal entry points back to its Proposal, and every Proposal points to its Debate. Credit checks keep the provider's request id.

The agent runtime adds hooks as a second layer. The reducers are the layer that cannot be talked around.

## UX principles

Every number drills down. Any figure in the Board Pack, the ledger, or a Proposal opens the journal lines behind it, then the Proposal and the Debate that produced them.

Nothing posts without a ruling. The UI never offers a path that writes to the ledger around the Advisor and the CFO.

Plain language only. There is one view: Plain summaries, amounts, and two buttons. Account codes, raw payloads and transcripts stay out of sight.

Live data motion only. Rows appear, statuses change, and totals count when the underlying data changes. Nothing animates for decoration.

## Design tokens

The web app's colors, type and shape are defined once, as design tokens in `packages/design-tokens` (see `packages/design-tokens/NAMING.md` and ADR 0012); the build writes `packages/design-tokens/css/luyten-tokens.css`, which `apps/web/src/app.css` imports (migration in progress, tracked by the package's raw-values baseline). Components use only token classes: no raw colours, no bracketed pixel sizes.
Numbers are always set in tabular figures.
