# Luyten

Luyten is automated finance for 10x growth startups.
Worker agents propose changes to the books, a Chief Finance Advisor agent rules on them, and the human CFO confirms anything material.
Every number drills down to the journal lines behind it.

## Language

### Ledger

**Subsidiary**: A legal entity of the group that keeps its own books in its Functional currency. The root Subsidiary has no parent; every other one has a parent.
_Avoid_: company, entity, org

**Group**: The root Subsidiary and every Subsidiary under it, reported together as one company.
_Avoid_: consolidated entity, corporate

**Functional currency**: The currency a Subsidiary keeps its books in.
_Avoid_: base currency, local currency

**Account**: A chart-of-accounts line of one Subsidiary with a type (asset, liability, equity, revenue, expense).
_Avoid_: GL code, ledger

**Group code**: The part of an Account's code that is the same in every Subsidiary (2950 for the UK's 2950-UK), which lines Accounts up across the group.
_Avoid_: base code, master account

**Intercompany account**: An Account that records what one Subsidiary owes, is owed, charges or is charged by another Subsidiary of the group.

**Journal Entry**: A balanced set of Journal Lines posted to one Subsidiary in one Period.
_Avoid_: transaction, JE batch

**Journal Line**: One debit or credit on one Account, in minor units, with an FX rate to functional currency.

**Period**: A calendar month of the whole group, shared by every Subsidiary, that is open, closing, or locked; the CFO locks it once for all of them. Months close in order: a Period's close starts and it locks only once every earlier Period is locked. A group Period locks only once consolidated: every foreign-currency balance stands at its closing rate and every intercompany pair is eliminated.
_Avoid_: group period, company month

**Close Task**: A checklist item in the month-end close with an owner (human or agent role), a status, and evidence.

**Bank Exception**: An unmatched bank line that still needs reconciliation.

**Bank Exception Acceptance**: The CFO's recorded decision to close a Period with a specific set of Bank Exceptions and a stated reason.
It leaves those bank lines unmatched and requires renewed acceptance when the reviewed books change.

**Soft close**: The state of a Period from the Advisor's opening of its close (a Close Task has left todo): only the close's own work posts to it, and the live feed stops booking into it. Not a Period status; the Period stays open until the lock is requested.
_Avoid_: cutoff, pre-lock

**Board Pack**: The deterministic report bundle (P&L, Balance Sheet, ARR waterfall, NRR) rendered after a Period locks, consolidated for the group or for one Subsidiary.

### Group and currency

**Reporting currency**: The single currency the group reports in and measures materiality in (USD).
_Avoid_: presentation currency, group currency

**Consolidation**: Combining every Subsidiary's books into one set of group statements: Revaluation, then Translation, with Eliminations removed.
_Avoid_: roll-up, aggregation

**Revaluation**: Restating a Subsidiary's foreign-currency asset and liability balances at the month's closing rate, posting the difference to FX gain or loss in that Subsidiary's books.
_Avoid_: remeasurement, mark-to-market

**Translation**: Expressing a Subsidiary's books in the Reporting currency for group statements (balance sheet at the closing rate, income and expense at each month's average rate); computed for reports, never posted.
_Avoid_: conversion, revaluation

**CTA**: The cumulative translation adjustment: the equity figure that makes a translated balance sheet balance. Computed, never posted.
_Avoid_: FX reserve, plug

**Elimination**: Removing what group companies owe each other (balance basis, reversed the next month) or charged each other in a month (activity basis) from the group statements.
_Avoid_: intercompany offset, netting

**Elimination subsidiary**: The group's bookkeeping-only Subsidiary in the Reporting currency that holds every Elimination, so no trading Subsidiary's books carry them.
_Avoid_: consolidation entity, elim company

### Governance

**Proposal**: A worker agent's request to change the ledger (journal entry, revenue schedule, bank match, credit decision, accrual, vendor block, vendor check, Revaluation, Elimination). Never affects balances until approved.
_Avoid_: draft, suggestion, pending entry

**Approval**: The Advisor's ruling on a Proposal: approve, reject, or amend, always with a rationale. An amendment always waits for the CFO, whatever its amount.
_Avoid_: sign-off, OK

**Advisor**: The Chief Finance Advisor agent, the only agent identity that may commit Proposals. It never proposes, and no identity approves or confirms a Proposal it proposed.
_Avoid_: supervisor, orchestrator, CFO bot

**CFO**: The human owner of the books with final say above the Advisor: confirms material rulings, can reverse anything, may be non-technical or technical.
_Avoid_: admin, user, operator

**Bootstrap secret**: The one-time secret, armed by whoever set up the database, that seats the first CFO through a claim link and then expires or is used up.
_Avoid_: invite code, admin password

**Materiality threshold**: The amount above which an Advisor ruling waits for the CFO's one-click confirmation before posting.

**Plain summary**: The one-sentence, jargon-free explanation every Proposal, critique, and ruling carries for the CFO.

**Worker agent**: Bookkeeper, Revenue, Credit & Risk, Consolidation. May propose, never commit.

**Red Team**: The agent that critiques Proposals before the Advisor rules. Cannot propose or commit.

**Debate**: The thread of agent messages attached to one Proposal, ended by a ruling.

**Charter**: An agent's plain-English rules (may propose X, must never Y, escalates Z). Each line maps to an eval scenario.

**Charter version**: One numbered, unchangeable text of a Charter with its line mapping: a draft, the live one, or retired. It may add or tighten rules but never loosen the shipped ones. The Built-in Charter is version 0.
_Avoid_: charter revision, custom charter

**Built-in Charter**: The Charter shipped with an agent; it applies whenever no Charter version of that role is live.
_Avoid_: default charter, stock charter

**Charter eval**: One recorded run of a Charter version's scenarios and rule probes, passed or failed: a full eval (the whole close rerun with that version on a scratch copy of the books, then its scenarios) or a quick check (its scenarios against the close already recorded). A version goes live only if its latest Charter eval is a passing full eval.
_Avoid_: charter test, validation

**Demo mode**: Runtime with no API keys where the agents run a scripted close over the real engines and the credit, vendor-lookup and search calls replay recorded fixtures.
_Avoid_: mock mode, offline

### Revenue and receivables

**Contract**: A customer's commercial agreement with Contract Items that drive both invoicing and revenue.
_Avoid_: deal, subscription

**Revenue Schedule**: The ASC 606 recognition plan for a Contract Item, independent of its invoice schedule.

**Deferred Revenue**: Invoiced but not yet recognized revenue (a liability).

**Bank Match**: A link from a Bank Transaction to an invoice, bill, or journal entry with a confidence score in basis points.

**Feed**: The continuous arrival of bank lines and invoices into the open month after one the CFO locked, until that month's close starts, switched on and off by the CFO; it books raw rows only and never proposes.
_Avoid_: sync, import, integration

**Continuous Bookkeeper**: The Bookkeeper working between closes, proposing matches for Feed rows as they land.
_Avoid_: auto-matcher, background job

### Credit and risk

**Guarantor**: The owner of a small-business customer whose personal credit is checked.

**Credit Check**: One cascade run (identity, fraud, credit report, public records) with stored results, request ids and the cascade's facts, recorded only on the customer's own Guarantor or the vendor's own owner.

**Vendor check**: A Proposal from the Credit & Risk agent to mark a Vendor verified, citing the request ids of the identity and fraud results in the owner's Credit Check. A Vendor becomes verified only when its Vendor check is approved (and, at or above the Materiality threshold, confirmed by the CFO); a verified Vendor is not re-checked at the next close.

**Risk Tier**: The classification of a Guarantor or Vendor (A, B, C, D, or BLOCK), derived by the module from a Credit Check's recorded facts with the shared tier rules; the agent never states it.

**Allowance**: The expected-credit-loss reserve against a customer's receivables, proposed from Risk Tier.
_Avoid_: bad debt reserve, provision

**Public footprint**: What a logged-out visitor can see about a Customer or Vendor (a Yelp listing, a public job board, a LinkedIn company page), collected on request and stored per run with its fetch time so a person sees change over time. Signals for a person, never a decision; it changes no balance and no Risk Tier by itself.
_Avoid_: scrape, enrichment, score

**Listing**: A public URL or board on file for a Customer or Vendor that the Public footprint reads from (Yelp URL, job board such as `greenhouse:<org>`, LinkedIn company URL).

## Relationships

- A **Subsidiary** has many **Accounts**, **Periods**, and **Journal Entries**
- A **Worker agent** creates **Proposals**; the **Red Team** attaches critiques; the **Advisor** issues exactly one **Approval** per Proposal
- An approved journal **Proposal** produces exactly one **Journal Entry**
- An **Approval** above the **Materiality threshold** waits for the **CFO** before the Journal Entry exists
- A **Contract Item** has one **Revenue Schedule** and one invoice schedule
- A **Customer** has one **Guarantor**; a **Guarantor** has many **Credit Checks**; the latest yields the **Risk Tier**
- A **Risk Tier** drives the customer's payment terms and its **Allowance** Proposal
- A **Subsidiary** with a foreign-currency balance gets one **Revaluation** Proposal per **Period**; each pair of **Intercompany accounts** is cleared by an **Elimination** posted to the **Elimination subsidiary**
- A group **Period** locks only once its **Revaluation** and **Elimination** Proposals match the posted books; a later decision that moves a foreign-currency or intercompany balance makes them stale until they are redone
- A **Charter** has many **Charter versions**, at most one live; a **Charter version** has many **Charter evals**

## Example dialogue

> **Dev:** "When the Bookkeeper finds a duplicate payment, does it post the reversal?"
> **Domain expert:** "No. It creates a **Proposal**. The **Red Team** may critique it, the **Advisor** rules, and because a reversal that size is above the **Materiality threshold**, the **CFO** sees a **Plain summary** and clicks Approve before any **Journal Entry** exists."

## Flagged ambiguities

- "account" is used in finance for both the chart-of-accounts line and a customer relationship. Resolved: **Account** means the chart-of-accounts line only; the relationship is a **Customer**.
- "approve" was used for both the Advisor's ruling and the CFO's click. Resolved: the Advisor issues an **Approval**; the CFO **confirms**.
- "overrules everything" was first read as a post-hoc veto. Resolved: it is an approval gate; worker agents never commit.
- "Group period" and "Period" were both used once the group had several Subsidiaries. Resolved: there is one **Period** per month for the whole group; per-Subsidiary locks are roadmap.
- "Revaluation" and "Translation" were used interchangeably for FX. Resolved: a **Revaluation** posts in a Subsidiary's own books; a **Translation** only restates them in the **Reporting currency** for group reports and is never posted.
