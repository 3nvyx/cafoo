# Luyten pitch

A three-minute spoken script, a demo cue list, and the ten slides for the in-app `/pitch` route. The demo runs on the seeded group in Demo mode, so it needs no API keys and no network.

## Before you start

Run the quickstart in the [README](../README.md) with September 2026 as the close month (`pnpm demo:fresh`), and open the claim link it prints so your browser holds the CFO seat. Open the Overview (`/dashboard`). Keep the Proposals tab and the Board Pack one click away. Leave the Materiality threshold at $10,000 and the feed off.

## Script

### 0:00 The hook

Every month, a finance team stops and closes the books. It still takes about ten days. People match deposits to invoices, chase receipts, and rebuild revenue schedules in spreadsheets. An AI agent could do most of that work today. But ask a CFO if they would let one post to the general ledger, and the answer is no. They are right. Nobody can see what it did or stop it before it lands.

### 0:30 What Luyten is

Luyten is automated finance for 10x growth startups.
Agents do the close, but they can only propose.
A Red Team agent on a different model attacks every Proposal.
Our Chief Finance Advisor agent rules on each one and writes down why.
Anything over ten thousand dollars waits for the CFO's one click.
And this is enforced in the database itself.
An agent that ignores its prompt still cannot write to the books.

### 1:00 Live demo

Let me close September for a SaaS group: a US company with twenty customers and its UK subsidiary.

| Cue | On screen | Say |
|---|---|---|
| 1 | Overview. Click Close September. Close Tasks turn to in progress. | "One click. Six agents come online." |
| 2 | Bookkeeper files one Proposal matching 9 vendor payments to their bills, every match at least 80% confident. | "Nine payments matched in one Proposal." |
| 3 | Two more matches below 75% arrive as separate Proposals. | "Two it is unsure about. It says so." |
| 4 | Duplicate payment to Northwind Cloud, booked as money due back from the vendor. | "Same bill paid twice. Caught and booked as a refund owed to us." |
| 5 | Quick entries for payroll, bank fees, and card spend. One unknown vendor gets a live web lookup. | "It did not know this vendor, so it looked it up." |
| 6 | Accrual for a contractor bill dated after month end. | "September work, October bill. Accrued." |
| 7 | Revenue rebuilds a missing 12-month schedule for a $26,400 contract. | "This contract was never on a schedule. Now it is." |
| 8 | $66,200 of subscription revenue across 14 customers, and $57,420 of usage revenue. | "Revenue recognized and tied to deferred revenue." |
| 9 | Credit & Risk runs the cascade on every guarantor. Risk Tiers and Allowances appear. Two vendors are blocked. | "Credit is checked on the owners behind the invoices. More on that in a minute." |
| 10 | Red Team rejects the two weak matches and questions the largest reserve. | "The second model pushes back. It wins on the weak matches." |
| 11 | Consolidation agent restates Cafoo Ltd's dollar loan at September's closing rate (a £4,404.78 gain, $5,638.12) and proposes removing the $245,000 the companies owe each other and the $15,000 of service fees. | "Two companies, two currencies. The loan between them is restated and taken out of the group's books, to the cent." |
| 12 | Advisor rules on 52 Proposals. The revaluation posts; the eliminations and the other material items move to Needs your OK. | "Small items post. Big ones wait for me." |
| 13 | Open one item. One sentence, the amount, the Advisor's ruling. Confirm. | "One sentence for me. The journal lines are a click away once it posts." |
| 14 | Advisor requests the lock. Click Lock September. Board Pack renders; switch it to Consolidated: a column per company, an Eliminations column, and the currency translation adjustment. | "I lock the month. Not the agent. And here is the group as one company." |
| 15 | Click revenue in the Board Pack. Land on the journal lines, then the Proposal, then the Debate. | "Every number drills down to who proposed it and why." |
| 16 | In Settings, switch the live feed on. October's bank lines and invoices arrive one by one; exact receipts match as they land, a partial payment stays open, the $48,600 payroll run waits for the CFO. | "September is locked, so the books keep moving. October matches itself as the money arrives, and the big one still waits for me." |

### 2:00 Why now

Two things changed. Models can now read a ledger and argue about it well enough to be checked. And there is a database that streams every row to the screen as it changes, and also carries the agents' messages. So every agent action is visible the moment it happens and auditable after.

### 2:20 Credit and risk, built in

Most SaaS companies sell to small businesses, and a small business is only as good as its owner. Luyten checks identity, fraud, three credit bureaus, and public records on every guarantor. Here it reserved $48,000 in full because the owner is in an active bankruptcy plan. It also blocked two vendors before their first payment: one owner is a synthetic identity, the other is deceased.

### 2:40 Roadmap and the ask

Today Luyten closes a group of companies across currencies, keeps the next month current from a live feed, and lets the finance team tighten its own agents' charters, never loosen them. Today the Credit & Risk agent already collects its own evidence over MCP: three bureaus, identity, fraud, public records and the web. In the next ninety days an Intake agent does the same for everything else: the payables inbox, Stripe, the bank accounts and exchange rates. It can only add raw data, never post, and the database enforces that too. So a fake "new bank details" email starts a vendor check instead of a payment. We also add a lock per company and offer a hosted Luyten for each customer. By 2027, Luyten uses those audited books to negotiate working-capital terms for its customers. We are raising [amount] to take our first design partners live. If you run finance at a SaaS company, let's close your next month together.

## Slide outline for `/pitch`

1. **Automated finance for 10x growth startups.** Agents propose, an Advisor rules, the CFO confirms, every number drills down.
2. **The close still takes 10 days.** Most of it is matching, accruing, and chasing receipts by hand.
3. **Everyone has agents. Nobody trusts them to post.** So we built the approval gate first and the agents second.
4. **Propose, critique, rule, confirm.** Worker agents propose, the Red Team critiques, the Advisor rules, the CFO confirms anything material.
5. **Live demo: close September.** 52 Proposals across two companies and two currencies, a Red Team that pushes back, a CFO who locks the month, then October's feed.
6. **Every number drills down.** From the Board Pack to the journal lines, the Proposal, and the Debate behind each figure.
7. **Credit and risk, built in.** Owner checks on every guarantor and vendor, a $48,000 reserve, two vendors blocked before payment.
8. **Why now.** Models that can be checked, and a database that streams every row and every agent message live.
9. **Where this goes.** Now: the group close with consolidation, a live feed, stricter-only custom charters, and Credit & Risk collecting its own evidence over MCP. Next 90 days: an Intake agent that collects the inbox, billing, bank and rates over MCP and can only add raw data, per-company locks, hosted deployment. 2027: an agentic credit exchange.
10. **The ask.** Raising [amount] to take our first design partners live.

Replace `[amount]` before presenting.
