# Cafoo roadmap

Updated 2026-10-24. "Now" is what runs in this repo today. Everything after it is roadmap.

## Now

Cafoo closes the month for one company in one currency.

Worker agents (Bookkeeper, Revenue, Credit & Risk) propose. A Red Team agent on a second model vendor critiques. The Advisor rules with a written rationale. Rulings at or above the Materiality threshold (default $10,000) wait in the CFO's "Needs your OK" queue. The CFO confirms or sends back, can reverse any entry, and always confirms the period lock. SpacetimeDB reducers enforce all of this by checking the caller's identity.

On the seeded company, a close produces about 47 Proposals:

- About 40 bank matches at 75% confidence or better, and 2 low-confidence matches the Red Team rejects.
- A duplicate vendor payment, booked as money due back from the vendor.
- Quick entries for payroll, fees, and card spend, with a live web lookup of an unknown vendor.
- An accrual for a contractor bill dated after month end.
- A missing 12-month revenue schedule rebuilt for a $26,400 contract, $64,000 of subscription revenue recognized across 14 customers, and $57,420 of usage revenue.
- A credit cascade (identity, fraud, three bureaus, public records) on every guarantor behind open receivables, with Risk Tiers A to D or BLOCK and Allowances from 1% to 100%. One customer's $48,000 is fully reserved because its guarantor is in an active bankruptcy plan.
- Two vendors blocked before their first payment because their owners fail identity and fraud checks: one is a synthetic identity, one is deceased.

Every Proposal and ruling carries a Plain summary and a technical rationale. Simple mode shows the sentence; Expert mode shows journal lines, codes, critiques, and raw payloads. The Board Pack (P&L, Balance Sheet, ARR waterfall, NRR) renders after the lock, and every figure drills down to its journal lines.

Demo mode runs all of it with zero API keys. Live mode switches on one provider at a time as keys are added. Money is stored as 64-bit integer minor units. The ledger engine has 86 unit tests, and the credit cascade reproduces all 20 expected decisions in the sandbox dataset.

Integrations today: SpacetimeDB, Claude Agent SDK, Grok through the Vercel AI SDK, Moss, Bright Data, CRS Credit API sandbox, and Open WebUI as an optional chat front-end.

## Next 90 days (roadmap)

**Multi-entity and FX with consolidation.** The schema already carries parent Subsidiaries, intercompany accounts, and FX rates. Next comes period-end revaluation, intercompany eliminations, and a consolidated Board Pack.

**Live bank and billing feeds.** Bank transactions and invoices arrive continuously instead of from a seed file, so the Bookkeeper matches as money moves rather than at month end.

**Customer-site enrichment.** Apify crawls each customer's public site into Moss, so the Credit & Risk agent and the Red Team can check what a business says it does against how it pays.

**Custom agent charters.** The finance team writes its own Charter for each agent in plain English: what it may propose, what it must never do, when it escalates. Each line becomes an eval scenario that must pass before the Charter goes live.

**Hosted deployment.** A managed Cafoo per customer, so a finance team can start without running a database or a gateway. It needs a one-time bootstrap secret for the CFO seat, so the role no longer goes to whoever connects first.

**SOC 2 readiness.** Controls, evidence collection, and access reviews, built on the audit trail the reducers already write.

## 2027 vision (roadmap)

**An agentic credit exchange.** Cafoo's books are live, audited, and explained line by line. That is what a lender wants and rarely gets. Cafoo will use them to negotiate working-capital terms for its customers directly with lenders, with the CFO confirming every offer through the same approval gate.

**A marketplace of audited agent charters.** Finance teams publish the Charters that work for them, each with its eval results attached. Other teams adopt a Charter knowing exactly what the agent may and may not do.
