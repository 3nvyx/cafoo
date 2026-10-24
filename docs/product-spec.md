# Cafoo product spec

Updated 2026-10-24. Terms follow [CONTEXT.md](../CONTEXT.md).

## Positioning

Cafoo is the finance ERP where agents do the close and the CFO stays in charge. Worker agents propose every change to the books. A Red Team critiques. The Advisor rules with a written rationale. The CFO confirms anything material and locks the month. Nothing posts without a ruling, and every number drills down to the journal lines behind it.

Legacy ERPs record what people type. Spreadsheets hold the real work. Cafoo replaces the people-hours between them with agents, and replaces blind trust in those agents with a gate the database enforces.

## Who it is for

Finance teams at SaaS companies, from a solo controller to a CFO with a small team. The CFO may be technical or not, so every screen leads with a Plain summary and keeps the technical depth one toggle away.

Cafoo fits best when the company sells to small businesses. Those customers are often backed by an owner-guarantor, and the owner's personal credit decides whether an invoice gets paid. Cafoo checks that owner before extending terms and reserves against the receivable when the check fails.

## Modules

| Module | Adequate today | Out of scope today |
|---|---|---|
| General ledger | Double-entry journal entries and lines in minor units, chart of accounts, trial balance, balance sheet, reversals, period open/closing/locked, per-line FX rate field | Multi-book, statistical accounts, custom segments |
| Revenue recognition | Straight-line schedules per contract item, usage recognized in the month of use, SSP allocation, deferred revenue release, missing-schedule detection | Variable consideration, contract modifications, usage forecasting |
| Receivables & billing | Contracts, contract items, invoices, open AR, aging buckets, payment terms set from Risk Tier | Invoice generation and delivery, dunning, payment portal |
| Payables | Vendors, bills, duplicate-payment detection, accruals for bills dated after month end that reverse next month, vendor verification and block | Bill pay, approval routing for spend, 1099s |
| Bank reconciliation | Integer-scored matching on amount, date, counterparty, and reference; one-to-one; auto bucket at 75% and above, review bucket below | Live bank feeds (roadmap), multi-currency accounts |
| Close management | Close Tasks with owner role, status, and evidence Proposals; the Advisor requests the lock, the CFO confirms it | Custom close templates, recurring task calendars |
| Reporting & Board Pack | P&L, Balance Sheet, ARR waterfall, NRR, AR aging; deterministic; every figure drills down to journal lines | Custom report builder, budget versus actual |
| Credit & Risk | Credit cascade on every guarantor behind open AR and every unverified vendor owner: identity, fraud, three bureaus, public records; Risk Tier A, B, C, D, or BLOCK; Allowance from 1% to 100% | Business credit bureaus, ongoing monitoring alerts |
| Agents & governance | Bookkeeper, Revenue, Credit & Risk, Red Team, Advisor; role identities; two-tier gate in reducers; Materiality threshold; Debate threads; audit trail | Charters written by the finance team (roadmap) |
| CFO experience (Simple / Expert) | Simple mode with Plain summaries and two buttons; Expert mode with journal lines, codes, critiques, raw payloads, transcripts | Mobile app |
| Multi-entity & FX | Subsidiary table with parent link, FX rate table, functional currency per Subsidiary | Consolidation, intercompany eliminations, revaluation (all roadmap) |

## Entity model

All records live in one SpacetimeDB module. The UI subscribes to them live.

| Table | What it holds |
|---|---|
| `subsidiary` | A legal entity with its own books, functional currency, and optional parent |
| `account` | A chart-of-accounts line with type (asset, liability, equity, revenue, expense) and an intercompany flag |
| `period` | One calendar month of a Subsidiary and its status |
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
| `bank_transaction` | One line of the bank feed and whether it is matched |
| `bank_match` | The link from a bank transaction to an invoice, bill, or journal entry, with a confidence score in basis points |
| `proposal` | A worker agent's requested change: kind, payload, rationale, Plain summary, amount, status, and Debate thread |
| `approval` | The Advisor's ruling on one Proposal, with rationale, Plain summary, and the CFO's confirmation if required |
| `settings` | Key-value settings, including the Materiality threshold |
| `agent_identity` | Private: which connection holds which role |
| `agent_roster` | Public: which roles are online and on which model |
| `agent_message` | Every statement, critique, question, and ruling in a Debate |
| `close_task` | A close checklist item with owner role, status, and evidence |
| `credit_check` | One product call in a credit cascade, with its request id, Risk Tier, and decision |
| `audit_event` | Every action: who, what role, which record, when |

Proposal kinds are journal entry, bank match, revenue schedule, credit decision, accrual, vendor block, and vendor check. A vendor check marks a vendor verified after its owner passes the identity and fraud checks; no agent can mark a vendor verified any other way. Proposal statuses are open, approved, rejected, amended, awaiting CFO, sent back, and superseded.

## Governance model

There are two tiers, and both are enforced in database reducers that check the caller's identity.

Tier one is the Advisor. Worker agents may propose. Only the Red Team may critique. Only the Advisor may approve, reject, or amend, and only the Advisor's ruling can apply a Proposal to the ledger. A ruling without a Plain summary is refused.

Tier two is the CFO. When a Proposal's amount is at or above the Materiality threshold, the Advisor's approval does not post. The Proposal moves to "Needs your OK" and waits. Only the CFO can confirm it, send it back with a note, reverse a posted entry, change the threshold, or lock and unlock a Period. The Advisor can request a lock, and the request is refused while any Proposal for the month still needs a ruling or a confirmation.

The Materiality threshold defaults to $10,000 and is a setting the CFO controls. The module computes a Proposal's amount from its payload and stores the larger of that and the amount the proposer states, so understating never avoids the CFO: the debits of a journal entry or accrual, the bank transactions a bank match settles, the lines of a revenue schedule, and the unpaid bills a vendor block or vendor check affects. A credit decision moves no balances; its Allowance arrives as a separate journal entry.

Plain summaries are a required field, not a display option. Every Proposal, critique, and ruling carries one sentence the CFO can read without accounting training, next to a technical rationale for anyone who wants it.

The audit trail is complete by construction. Every reducer that changes state writes an `audit_event` with the actor's identity and role. Every journal entry points back to its Proposal, and every Proposal points to its Debate. Credit checks keep the provider's request id.

The agent runtime adds hooks as a second layer. The reducers are the layer that cannot be talked around.

## UX principles

Every number drills down. Any figure in the Board Pack, the ledger, or a Proposal opens the journal lines behind it, then the Proposal and the Debate that produced them.

Nothing posts without a ruling. The UI never offers a path that writes to the ledger around the Advisor and the CFO.

Plain language first. Simple mode is the default. It shows Plain summaries, amounts, and two buttons. Account codes stay out of sight.

One toggle to expert depth. Expert mode shows the same screens with journal lines, account codes, critiques, raw payloads, agent transcripts, and edit-before-approve. Nothing moves; detail is added.

Live data motion only. Rows appear, statuses change, and totals count when the underlying data changes. Nothing animates for decoration.

## Design tokens

| Token | Value |
|---|---|
| Background | White `#ffffff` |
| Text | Near-black `#18181b` |
| Accent | Violet `#582efd` |
| Border | `#e5e7eb` |
| Cards | Flat, 8px radius, 1px border, no shadow |
| Headings | Space Grotesk |
| Body | DM Sans |
| Numbers | JetBrains Mono, tabular figures |

Tokens are defined in `apps/web/src/app.css`.
