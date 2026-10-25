# Demo rehearsal, 25 October 2026

Run by the rehearsal agent. Quillmesh profile, Demo mode (DEMO_MODE=1, no provider calls), database `cafoo-quillmesh`, gateway on 8788, web on 5190. Driven end to end through headless Chromium (Playwright) as the CFO, with `spacetime sql` and the gateway HTTP API as cross-checks. No tracked file was edited.

## Walk summary

- Seed: 103 customers, 16 vendors, 100 contracts, 121 invoices, 358 journal entries. Claim link worked; CFO seat claimed.
- Start close from Dashboard: 51 Proposals arrived within 5 s (36 resolved, 15 awaiting CFO). No console errors, no failed requests on any page.
- "Confirm all 15" shows a confirmation dialog first. After it, 52 Proposals in total (one follow-up Revenue Proposal appears once the schedule is approved), 43 approved, 9 rejected, 0 waiting.
- Bank exceptions: 9 left (matches the database, `bank_transaction.matched = false` count is 9). Accepting them as CFO needs a reason; it recorded. Lock button was enabled afterwards (the lead's close.ts fix had landed). Lock dialog and lock worked; Unlock then re-accept then re-lock also worked.
- Close checklist: "Reconcile the bank feed" correctly stays In progress while 9 lines are unmatched, before and after lock (6 of 7 done).
- Exports: all parse (details below).
- Live feed (Settings): turned on after the lock, 15 of 15 October events ingested, 2 Proposals now wait for the CFO. State left as is.

## A. Demo-breaking or demo-embarrassing (fix first)

1. Advisor chat chip "Which customers are high risk?" returns a generic cash snapshot, not an answer.
   - Page: Dashboard, Ask the Advisor (suggested question chip, so a judge will click it).
   - Saw: "Here is where Quillmesh Inc stands for 2026-09: cash ..., receivables ..." followed by the help line.
   - Expected: the tier list (A 1, B 1, C 4, D 4, BLOCK 2, 91 not checked) or the high-risk names.
   - Suspect: `apps/agents/src/advisor-chat.ts` `answerQuestion` has no risk or credit-tier intent (the only "risk" hit is the close text). Chip list is in `apps/web/src/routes/(app)/dashboard/AdvisorChat.svelte` line 16.

2. Advisor chat "Can we lock September?" does not answer the question.
   - Saw: the same generic "Here is where ... stands" snapshot, with the "Ask me about cash, receivables..." tail. Same result before and after the bank exceptions were accepted.
   - Expected: a yes or no with the blockers (9 unmatched bank lines accepted by the CFO, nothing waiting, so "yes, ready to lock").
   - Suspect: `answerQuestion` only routes "start/run the close" commands. `lockOutlook()` already computes the right text but is only reached on a close command for a month that already ran. Also "Can we lock October?" gives the snapshot.

3. Advisor chat "What is our policy on bad debt reserves?" says "No passage in the house policies answers that directly; the closest is the accruals policy".
   - Expected: the credit-and-allowance policy (tiers A to BLOCK with 1/5/10/50/100 percent reserves).
   - Cause: `fixtures/moss/credit-and-allowance.md` exists and says "reserve", but the local keyword search ranks `accruals` first, and `policyExcerpt()` in `advisor-chat.ts` matches terms by substring, so the question word "reserves" does not match "reserve" and "debt" and "bad" never appear. Suspect `apps/agents/src/moss.ts` ranking and `policyExcerpt` stemming. One-line fix idea: strip a trailing "s" from terms, and add "bad debt" to the credit doc heading.

4. Board Pack "intercompany elimination" banner is stale while the month is open.
   - Page: Board Pack (/reports) after the close ran and the three Consolidation Proposals were approved and posted (Eliminations column shows -$15,000, -$45,000, -$200,000).
   - Saw: "Draft group totals may still include intercompany charges until the elimination entries post. Check the Eliminations column before using these figures." still shown, together with "Draft - period open". It disappears only once the month is locked.
   - Expected: hidden once the eliminations are posted (consolidated intercompany lines already net to $0).
   - Suspect: `apps/web/src/routes/(app)/reports/+page.svelte` (banner condition keyed on the period lock, not on posted Eliminations).

5. Metrics page contradicts the Dashboard on burn and runway.
   - Page: Metrics (default Quarter window, Jul to Sep 2026) vs Dashboard Health check.
   - Metrics: "Runway Healthy: Over 3 years ... $48.7K operating burn over Jul to Sep", "Burn multiple 0.0x ... $48.7K burned", "Rule of 40: 190 (285 percent ARR growth annualized)". Before the close it said "$0 burned" and "Cash not falling".
   - Dashboard: "Runway 12 months, $959,656 a month of operating burn", "Burn multiple: No ARR added, -$93,708 net new ARR".
   - Expected: both near $0.8M to $1M a month of burn and about 12 months. The P&L loses about $0.7M a month, so $48.7K over a quarter is wrong. An investor or judge who opens Metrics will see "over 3 years" next to a loss-making P&L.
   - Suspect: `apps/web/src/lib/saas-metrics.ts` operating burn (probably nets cash receipts of annual prepayments or funding into the window).

6. Customers page: "Enterprise" segment is empty (0 of 103).
   - Page: Customers, Segment filter. Self-serve 20, Mid-market 68, Enterprise 0, No active contract 15.
   - The plan and landing page say about 15 enterprise contracts ($90k to $190k). 18 contracts are at or above $90k but the page labels them Mid-market (Farragut and Kowalczyk, both $96,000, show "Mid-market").
   - Suspect: thresholds in `apps/web/src/routes/(app)/customers/receivables.ts` (under $25k self-serve, under $250k mid-market, rest enterprise). Fix: enterprise from $90k, mid-market $18k to $90k, self-serve under $18k.

## B. Wrong or inconsistent numbers

7. Headline numbers vs the story.
   - ARR is $4,497,252 (about $4.5M), the story and landing say about $4.8M. ARR also falls month over month ("-$93.7K vs Aug 2026", NRR 90.4 percent, "Needs attention"), which sits badly with "growing about 3x a year" on the landing page and in plan.md.
   - Monthly revenue after the close is $655,468 consolidated ($646,084 for Quillmesh Inc), which annualizes to about $7.9M, about 1.75 times the ARR. Self-serve billing-sync revenue (about $175K a month) is in revenue but not in ARR ("from the active contracts").
   - Runway on the Dashboard is 12 months (14 before the close); plan.md says about 24.
   - People page shows Headcount 57 (47 US, 10 UK, plus 1 contractor); the story says 62. The database holds 62 employee records, but 5 have start dates from Nov 2026 to Jan 2027, so they are excluded as of today (25 Oct). The same page says "Next payday Sep 28" and payroll "Not posted yet" for Apr to Sep, so it mixes two clocks.
   - Customers: 103 (not about 300). The landing page does not say 300 (only "a few hundred customers" for stage 1 in general), so this is a plan-vs-data gap rather than a copy bug.
   - Vendors: 16, all from the small fixture (Northwind Cloud, Lumen Analytics, Harbor Payroll, ...). None of the Quillmesh vendors (GPU cloud, model API) exist as vendors. Vendors page spend is $171,945 for September while the ledger books $974,153 of "Operating costs" as a single lump entry and the Costs page shows $233,894 of cloud and model cost, so the three do not tie.

8. Cost of service page ("Hosting against the ledger") shows the ledger above the provider bills every month, "$43,797 more in the books" for Sep 2026 and $11K to $57K in every earlier month, with no explanation. It reads as an unreconciled variance.

9. Financing "Tied to the ledger": "Shares, at what was paid 3000-3310: Register $16,250,000, Books $16,600,000, Differs by +$350,000". A visible non-tie on the investor page.

10. Customers "Target allowance" $184,397 vs Board Pack posted allowance and bad debt expense $152,908.50. Labeled "not a posted entry" but the CFO will ask why they differ.

11. Board Pack CSV (gateway `/export/csv?dataset=board-pack`): the 5900 Intercompany service fees consolidated column shows 0.01 (Ltd 15000.01 against an elimination of -15000.00), while the web page shows $0. It also has both a "Group eliminations" column (all zeros) and an "Eliminations" column. Suspect `apps/agents/src/exports.ts`.

12. Feed data double counts two September receipts. After the lock, the October feed delivers "Whitcomb Antiques paid invoice INV-1072 in full, $12,960" and "Brennan Media Labs paid INV-1061, $7,065", but both were already received in September (Sep 24 and Sep 10 bank lines, accepted as unmatched exceptions). The October Proposal for the $12,960 is one of the two waiting for the CFO.

13. Chat "How much revenue is still pending for September?" answers with recognized revenue ($646,084.73 for Quillmesh Inc, GBP 19,200 for Ltd) and deferred revenue ($2,762,670). Numbers agree with the Board Pack and the ledger, but it never says what "pending" is. Acceptable, not a clean answer.

## C. Cosmetic

14. Company name drift: sidebar footer "CFO - Cafoo Inc" on every page, and the whole Financing page says "Cafoo Inc" (header, "Who owns Cafoo Inc", cap table) while everything else says Quillmesh Inc. The Board Pack balance sheet also labels the intercompany lines "Due from Cafoo Ltd", "Due to Cafoo Inc", "Loan from Cafoo Inc". Close page copy for the Consolidation task also says "Cafoo Ltd".
15. Dash bar and its exports leak an empty object: Account type shows "Asset . {}", and the Proposal export has "Bank match . {}" in the Kind column (in the CSV and xlsx). The "Proposed by" column is the raw identity hash. Suspect the enum renderer in `apps/web/src/routes/(app)/dash-bar/DataGrid.svelte` or `apps/web/src/lib/export.ts`.
16. Close page status strip, between "Confirm all" and the lock: "1. Bookkeeper: Running, Working through its tasks" and "5. CFO review: Running, The Advisor is ruling; nothing waits for you yet" while all 52 Proposals are ruled and nothing is running. They flip to Done only after the lock. After the lock the strip says "100% complete" while the checklist says "6 of 7 done".
17. The Advisor's pinned ruling "The books would not lock September 2026 yet, so it stays open for a person to check." stays at the top of the Agents thread and in the Dashboard agent status after the CFO accepted and locked.
18. Accept-exceptions audit text has doubled punctuation: `Reason: "...arrives.". The lines stay unmatched ...`.
19. Cost of service and Batches show "Meters live / Usage live - Updated 552 h ago" (stale seed timestamp under a "live" badge).
20. Settings: the "N of 15 events received" counter does not update live (showed 0 of 15 for 25 s while the gateway reported 3 ingested; a reload showed 4). Fine after a reload.
21. Proposals count: README and plan.md say 51 Proposals; after "Confirm all" the total is 52. Fine, but say "51, then one follow-up" in the demo script.
22. Ledger CSV (`/export/csv?dataset=ledger`): the Posted column is the seed time (2026-10-25) on all 323 rows, and there is no transaction date column.
23. The Confirm all dialog says only "Confirm all 15 items the Advisor already approved?" (no dollar total).

## Exports

- Gateway `GET /export/csv?dataset=ledger|board-pack|cfo-queue&period=2026-09`: all three return 200 with the right content-type and a download filename. Ledger: 323 rows, 15 columns, USD debits equal credits. Board Pack: 37 lines, the P&L and balance sheet balance. CFO queue: header only (0 waiting at that moment, correct). It is therefore not exercised with data; see gaps.
- Dash bar Export (CSV and Excel) for Journal line, Customer, Invoice, Proposal, plus the Ledger trial balance: all 10 files download. CSVs are UTF-8 with a BOM and consistent column counts; the xlsx files are valid zip packages with a sheet each (the trial balance has 3 sheets). Journal line has 1,787 rows and 1.1 MB, still fast.

## Copy vs data on the landing page

- "Quillmesh is here: a UK subsidiary in GBP, per-page usage pricing, about 15 enterprise contracts and a finance team of three." Finance of three is backed (People: Finance 3). About 15 enterprise contracts is backed in the data (18 at $90k or more) but not in the app (see item 6).
- "about $4.8M ARR growing about 3x a year": data shows $4.50M and a negative month-over-month ARR change (item 7).
- The Board Pack teaser on the landing page uses clearly labeled sample numbers ($70,950 revenue), so it is not a conflict.
- No "300 customers" claim was found on the landing page or pitch page.

## Gaps I could not cover

- The CFO queue CSV and the Slides export with real pending Proposals (queue was empty at test time; two feed Proposals wait now, so `GET /export/csv?dataset=cfo-queue&period=2026-10` can be checked).
- Mobile widths, dark mode, keyboard-only use.
- Live (non-Demo) providers, by design.
- Pitch deck beyond slide 1 (the page renders 10 slides, only the first was read).

## Left running

- Database: `cafoo-quillmesh` on SpacetimeDB 127.0.0.1:3000 (September locked, 52 September Proposals, October feed fully ingested, 2 October Proposals waiting for the CFO).
- Gateway: port 8788, PID 94743 (DEMO_MODE=1, allowed origins http://localhost:5190 and http://127.0.0.1:5190).
- Web dev server: http://127.0.0.1:5190, PID 94884 (PUBLIC_DATA_SOURCE=spacetime, database cafoo-quillmesh, gateway http://127.0.0.1:8788). The CFO seat is held by a headless Playwright browser profile (kept at the rehearsal agent's scratch directory), not by any user browser. `pnpm cfo:bootstrap` only works while the seat is empty, so to drive this database from another browser the lead must re-seed it (`SPACETIMEDB_DB_NAME=cafoo-quillmesh pnpm demo:quillmesh`, which wipes the state above) or release the seat as the database owner.
