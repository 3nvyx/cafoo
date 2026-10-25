# Live close proof, 25 October 2026

Two live closes of September 2026 on the Quillmesh books (`SEED_PROFILE=quillmesh`), on the demo laptop, with real keys.
Agents ran on the Claude Agent SDK through the OpenAI bridge (Advisor gpt-6.1-sol, workers gpt-6-luna), with Grok as the Red Team, CRS sandbox, Apify and Moss live.
Gemini, Nessie and Slides were not configured and ran their labelled stand-ins. Budget cap: `CLOSE_BUDGET_USD=5`.
Provider-level proof (one minimal real call each) is in `live-2026-10-25T11-24-47-095Z.md`.

## Run 1: before the fix (database `cafoo-live`, code at bf1d65c)

- The workers filed 45 Proposals and recorded 102 credit checks. Agent SDK cost $3.81.
- The Advisor called `list_proposals` once. The whole month with full payloads overflowed the tool's output limit, and the Advisor reported that it had read none of them.
- The safety net logged "45 proposal(s) left unruled by the Advisor; applying the standard rulings". Every ruling in this run was the scripted standard ruling, not the Advisor's.
- Grok answered 12 critiques and timed out on 33 (all 45 started at once, 30 s deadline). The 33 fell back to the scripted critique, labelled as scripted.
- CRS: 15 real calls, 0 fallbacks. Moss: 152 real searches, 6 fallbacks. Apify: 10 crawls counted ok, 3 fallbacks.

## Run 2: with the fix (database `cafoo-live2`, code at c5c5c43)

- `list_proposals` pages 10 at a time with payload previews; the ruling prompts read Open Proposals until none are left; the Red Team critiques 4 Proposals at a time.
- The workers filed 48 Proposals and recorded 102 credit checks. Agent SDK cost $4.92, under the $5 cap.
- The Advisor made 79 paged `list_proposals` reads and 58 approve or reject calls (more calls than Proposals; I did not break down which were retries or refused by the gate). The safety net did not fire: no Proposal was left unruled.
- Outcome: 34 Proposals approved by the Advisor and waiting for the CFO, 14 rejected. 55 Advisor rulings are recorded in the close thread.
- Grok still timed out on 35 of 48 critiques (13 answered); those 35 fell back to the scripted critique, labelled as scripted. The cause is the 30 s deadline against Grok's up to six tool steps. Commit 39401a4 raises the default to 90 s; that change has not been run live yet.
- CRS: 15 real calls, 0 fallbacks. Moss: 150 real searches, 1 fallback. Apify: 1 ok, 13 fallbacks. The fallbacks are customers on made-up `.example` domains, which return no page text and now count as a failure instead of "crawled 0 pages" (579ee2d).

## Not covered

- The CFO steps (confirm, accept bank exceptions, lock) were not driven in these runs; both closes stopped at "waiting for the CFO". Demo mode and CI cover that path (module smoke, eval rerun, `smoke:feed`).
- Bright Data failed in the provider proof (no Web Unlocker zone named `mcp_unlocker` on the account) and was not exercised.
- Nessie needs `NESSIE_ACCOUNT_IDS`; with only `NESSIE_API_KEY` set the gateway refuses to start, so both runs blanked the key and used the simulated feed.
