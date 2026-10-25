# Cafoo roadmap

Updated 2026-10-24. "Now" is what runs in this repo today. Everything after it is roadmap.

## Now

Cafoo closes the month for a group of companies in two currencies, and keeps the books current between closes.

Worker agents (Bookkeeper, Revenue, Credit & Risk, Consolidation) propose. A Red Team on two other model vendors critiques: Grok first, then Gemini adds what Grok missed. The Advisor rules with a written rationale. Rulings at or above the Materiality threshold (default $10,000, measured in the Reporting currency) wait in the CFO's "Needs your OK" queue. The CFO confirms or sends back, can reverse any entry, and always confirms the period lock. SpacetimeDB reducers enforce all of this by checking the caller's identity.

The demo group is Cafoo Inc (USD), its UK subsidiary Cafoo Ltd (GBP), and an Elimination subsidiary. Closing September produces 52 Proposals: 49 for Cafoo Inc, one Revaluation and two Eliminations (51 when the close runs without waiting for the CFO, because the revenue catch-up rolls over to the next run).

- 9 vendor payments ($49,065) matched to their bills in one Proposal, every match at least 80% confident. Because the batch is above the Materiality threshold, it waits for the CFO.
- 9 customer receipts that match their invoices only at 70% confidence, each in its own Proposal. The Red Team challenges them and the Advisor leaves them for a person.
- A duplicate vendor payment, booked as money due back from the vendor.
- Quick entries for payroll, fees, and card spend, with a live web lookup of an unknown vendor.
- An accrual for a contractor bill dated after month end.
- A missing 12-month revenue schedule rebuilt for a $26,400 contract, $66,200 of subscription revenue recognized across 14 customers (including a $4,400 catch-up once the CFO confirms the rebuilt schedule), and $57,420 of usage revenue.
- A credit cascade (identity, fraud, three bureaus, public records) on every guarantor behind open receivables, with Risk Tiers A to D or BLOCK and Allowances from 1% to 100%. One customer's $48,000 is fully reserved because its guarantor is in an active bankruptcy plan.
- Two vendors blocked before their first payment because their owners fail identity and fraud checks: one is a synthetic identity, one is deceased.
- One vendor verified through a Vendor check after its owner passes the identity and fraud checks.
- **Consolidation.** The Consolidation agent revalues Cafoo Ltd's dollar loan and payable at September's closing rate: a £4,404.78 gain, $5,638.12 in the Reporting currency, so the Advisor posts it. It eliminates the $245,000 the two companies owe each other (reversed in October, because October's close eliminates the balance again) and the month's $15,000 of intercompany service fees; both wait for the CFO. The service-fee pair differs by $0.01 of rounding, under the $1 tolerance, so it is not flagged. Every figure is recomputed by the module from the books before it posts.

The Board Pack (P&L, Balance Sheet, ARR waterfall, NRR) renders after the lock, consolidated for the group or for one company in its own currency. The consolidated view shows each company's column, an Eliminations column, and the CTA (−$239.56 for September after the entries post), which is computed and never posted. Every figure drills down to its journal lines.

**The October feed.** Once the CFO locks September and switches the feed on, October arrives as 15 simulated events: 4 receipts that match invoices exactly, 1 partial payment left unmatched, 1 receipt whose name only partly matches (left for review), a bank fee, card spend, a $48,600 payroll run that waits for the CFO, and 3 new usage invoices followed by their receipts. The continuous Bookkeeper proposes as rows land. The feed only books into the month after one the CFO locked and stops once that month's close opens; October's close then books the receivables for the feed's invoices in its usage entry. November is seeded so October's balance Elimination can reverse.

**Custom charters.** The finance team edits each agent's Charter on the Charters page and saves it as a new version. A custom Charter can only make the gate stricter: every shipped rule stays, and lines may add rules or tighten them (a higher batch-match threshold, a lower intercompany tolerance, narrower Proposal kinds, an amount cap). The CFO can publish a version only after its latest eval is a passing full eval, which reruns the whole close on a scratch database.

**The CFO seat.** No connection can register itself as CFO. Setting up a database arms a one-time Bootstrap secret, and the claim link seats the browser that opens it.

Every Proposal and ruling carries a Plain summary and a technical rationale. The app shows the sentence; the rationale stays on the record.

Demo mode runs all of it with zero API keys. Live mode switches on one provider at a time as keys are added. Money is stored as 64-bit integer minor units, and every currency conversion rounds half away from zero in both the module and the engine. The ledger engine has 142 unit tests, and the credit cascade reproduces all 20 expected decisions in the sandbox dataset.

Integrations today: SpacetimeDB, Claude Agent SDK (OpenAI or Anthropic behind the Anthropic Messages API; see `.env.example`), Grok and Gemini through the Vercel AI SDK, Moss, Bright Data, CRS Credit API sandbox, and Open WebUI as an optional chat front-end.

## Next 90 days (roadmap)

**Real bank and billing feeds.** Today's feed is simulated. Next it connects to real bank and billing providers through the same ingest-only role, so nothing about the gate changes.

**Per-subsidiary locks.** Today the CFO locks the group's month in one step. Each company will get its own lock, with the consolidated Board Pack final only when every company's month is.

**A dedicated evaluator identity.** Charter eval results are recorded under the Advisor's identity today. A separate evaluator identity will record them, so the agent being judged never shares an identity with its judge.

**Customer-site enrichment.** Apify crawls each customer's public site into Moss, so the Credit & Risk agent and the Red Team can check what a business says it does against how it pays.

**Hosted deployment.** A managed Cafoo per customer, so a finance team can start without running a database or a gateway. The CFO seat already needs a one-time Bootstrap secret, so a hosted database never hands the role to whoever connects first.

**SOC 2 readiness.** Controls, evidence collection, and access reviews, built on the audit trail the reducers already write.

## 2027 vision (roadmap)

**An agentic credit exchange.** Cafoo's books are live, audited, and explained line by line. That is what a lender wants and rarely gets. Cafoo will use them to negotiate working-capital terms for its customers directly with lenders, with the CFO confirming every offer through the same approval gate.

**A marketplace of audited agent charters.** Finance teams publish the Charters that work for them, each with its eval results attached. Other teams adopt a Charter knowing exactly what the agent may and may not do.
