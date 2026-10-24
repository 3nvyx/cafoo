# Cafoo

Cafoo is an agentic finance ERP for SaaS companies. Worker agents propose changes to the books, a Chief Finance Advisor agent rules on them, and the human CFO confirms anything material. Every number drills down to the journal lines behind it.

## Language

### Ledger

**Subsidiary**: A legal entity that keeps its own books in a base currency.
_Avoid_: company, entity, org

**Account**: A chart-of-accounts line with a type (asset, liability, equity, revenue, expense).
_Avoid_: GL code, ledger

**Journal Entry**: A balanced set of Journal Lines posted to one Subsidiary in one Period.
_Avoid_: transaction, JE batch

**Journal Line**: One debit or credit on one Account, in minor units, with an FX rate to functional currency.

**Period**: A calendar month of a Subsidiary that is open, closing, or locked.

**Close Task**: A checklist item in the month-end close with an owner (human or agent role), a status, and evidence.

**Board Pack**: The deterministic report bundle (P&L, Balance Sheet, ARR waterfall, NRR) rendered after a Period locks.

### Governance

**Proposal**: A worker agent's request to change the ledger (journal entry, revenue schedule, bank match, credit decision, accrual, vendor block, vendor check). Never affects balances until approved.
_Avoid_: draft, suggestion, pending entry

**Approval**: The Advisor's ruling on a Proposal: approve, reject, or amend, always with a rationale.
_Avoid_: sign-off, OK

**Advisor**: The Chief Finance Advisor agent, the only agent identity that may commit Proposals.
_Avoid_: supervisor, orchestrator, CFO bot

**CFO**: The human owner of the books with final say above the Advisor: confirms material rulings, can reverse anything, may be non-technical or technical.
_Avoid_: admin, user, operator

**Materiality threshold**: The amount above which an Advisor ruling waits for the CFO's one-click confirmation before posting.

**Plain summary**: The one-sentence, jargon-free explanation every Proposal, critique, and ruling carries for the CFO.

**Simple mode**: The default view: plain summaries, two buttons, no account codes.

**Expert mode**: The same screens with journal lines, account codes, raw payloads, agent transcripts, a SQL console, shortcuts, and edit-before-approve.

**Worker agent**: Bookkeeper, Revenue, Credit & Risk. May propose, never commit.

**Red Team**: The agent that critiques Proposals before the Advisor rules. Cannot propose or commit.

**Debate**: The thread of agent messages attached to one Proposal, ended by a ruling.

**Charter**: An agent's plain-English rules (may propose X, must never Y, escalates Z). Each line maps to an eval scenario.

**Demo mode**: Runtime with no API keys where every external call replays recorded fixtures.
_Avoid_: mock mode, offline

### Revenue and receivables

**Contract**: A customer's commercial agreement with Contract Items that drive both invoicing and revenue.
_Avoid_: deal, subscription

**Revenue Schedule**: The ASC 606 recognition plan for a Contract Item, independent of its invoice schedule.

**Deferred Revenue**: Invoiced but not yet recognized revenue (a liability).

**Bank Match**: A link from a Bank Transaction to an invoice, bill, or journal entry with a confidence score in basis points.

### Credit and risk

**Guarantor**: The owner of a small-business customer whose personal credit is checked.

**Credit Check**: One cascade run (identity, fraud, credit report, public records) with stored results and request ids.

**Vendor check**: A Proposal from the Credit & Risk agent to mark a Vendor verified, citing the request ids of the identity and fraud results in the owner's Credit Check. A Vendor becomes verified only when its Vendor check is approved (and, at or above the Materiality threshold, confirmed by the CFO); a verified Vendor is not re-checked at the next close.

**Risk Tier**: The Credit & Risk agent's classification of a Guarantor or Vendor (A, B, C, D, or BLOCK) from a Credit Check.

**Allowance**: The expected-credit-loss reserve against a customer's receivables, proposed from Risk Tier.
_Avoid_: bad debt reserve, provision

## Relationships

- A **Subsidiary** has many **Accounts**, **Periods**, and **Journal Entries**
- A **Worker agent** creates **Proposals**; the **Red Team** attaches critiques; the **Advisor** issues exactly one **Approval** per Proposal
- An approved journal **Proposal** produces exactly one **Journal Entry**
- An **Approval** above the **Materiality threshold** waits for the **CFO** before the Journal Entry exists
- A **Contract Item** has one **Revenue Schedule** and one invoice schedule
- A **Customer** has one **Guarantor**; a **Guarantor** has many **Credit Checks**; the latest yields the **Risk Tier**
- A **Risk Tier** drives the customer's payment terms and its **Allowance** Proposal

## Example dialogue

> **Dev:** "When the Bookkeeper finds a duplicate payment, does it post the reversal?"
> **Domain expert:** "No. It creates a **Proposal**. The **Red Team** may critique it, the **Advisor** rules, and because a reversal that size is above the **Materiality threshold**, the **CFO** sees a **Plain summary** and clicks Approve before any **Journal Entry** exists."
> **Dev:** "And in **Expert mode**?"
> **Domain expert:** "Same rows, same reducers. The CFO just also sees the journal lines and can edit them, which records an amend."

## Flagged ambiguities

- "account" is used in finance for both the chart-of-accounts line and a customer relationship. Resolved: **Account** means the chart-of-accounts line only; the relationship is a **Customer**.
- "approve" was used for both the Advisor's ruling and the CFO's click. Resolved: the Advisor issues an **Approval**; the CFO **confirms**.
- "overrules everything" was first read as a post-hoc veto. Resolved: it is an approval gate; worker agents never commit.
