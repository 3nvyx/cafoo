# Cafoo

Cafoo is an agentic finance ERP for SaaS companies. Worker agents do the month-end close for a group of companies in more than one currency: they match the bank feed, rebuild revenue schedules, accrue late bills, revalue foreign-currency balances, eliminate what the group's companies owe each other, and check the credit of the people behind your customers and vendors. They can only propose. A Chief Finance Advisor agent rules on every Proposal with a written rationale, and anything material waits for the CFO's one-click confirmation. Every number in the Board Pack drills down to the journal lines, the Proposal, and the agent debate that produced it.

## The problem

The monthly close still takes a team of people about ten days. Most of that time goes to matching deposits, chasing receipts, and rebuilding schedules in spreadsheets. AI agents could do most of it, but no finance team will let a model post straight to the books, and they are right not to.

## The answer

Agents propose, an Advisor rules, the CFO confirms, and every number drills down.

Worker agents (Bookkeeper, Revenue, Credit & Risk, Consolidation) create Proposals and can never commit them. A Red Team agent on a second model vendor critiques each Proposal. The Advisor approves, rejects, or amends it, always with a rationale. Any ruling at or above the Materiality threshold (default $10,000) waits in the CFO's "Needs your OK" queue. The CFO confirms or sends it back, can reverse any entry, and always confirms the period lock.

The gate is enforced in the database, not in prompts. SpacetimeDB reducers check the caller's identity, so a worker agent that ignores its instructions still cannot write to the ledger. The live feed has its own identity that can only add raw bank lines and invoices, and nobody becomes CFO by asking: the seat is claimed with a one-time secret. Every Proposal and ruling carries a Plain summary (one sentence, no jargon) and a technical rationale. Simple mode shows the sentence. Expert mode shows the journal lines, account codes, critiques, and raw payloads.

## Architecture

```
SvelteKit UI (CFO app)      <- live subscriptions ->  SpacetimeDB module (ledger, Proposals, Approvals, agent messages,
                                                      charter versions, feed log, audit trail)
Agent orchestrator (:8787)  -- reducer calls, one identity per role -->  SpacetimeDB
  Advisor, Bookkeeper, Revenue, Credit & Risk, Consolidation: Claude Agent SDK (TypeScript)
  Red Team: Grok through the Vercel AI SDK
  Feed: simulated bank and invoice feed (ingest only) and the continuous Bookkeeper
  Charter eval runner: full eval on a scratch database, or a quick check against the recorded close
  Tools: ledger-core engine, CRS Credit API cascade, Bright Data lookups, Moss vector search
Open WebUI (optional)       -- OpenAI-compatible /v1 on the gateway -->  Advisor chat
```

## Quickstart

You need Node 22.9 or later, pnpm 10, and the SpacetimeDB CLI. Docker is only needed for Open WebUI.

```sh
pnpm install
cp .env.example .env            # leave every value empty for Demo mode

# terminal 1: local SpacetimeDB on :3000
spacetime start

# terminal 2: publish the module fresh, then generate and load the demo company
pnpm demo:fresh                 # prints the one-time CFO claim link

# terminal 3: agent orchestrator and gateway on :8787
pnpm -F @cafoo/agents orchestrator

# terminal 4: the CFO app
pnpm -F @cafoo/web dev
```

Start a close from the app, or from the shell:

```sh
curl -X POST http://localhost:8787/close -H 'content-type: application/json' -d '{"periodYm":"2026-09"}'
```

`pnpm demo:fresh` publishes the module with `--delete-data` (to the database in `SPACETIMEDB_DB_NAME`, default `cafoo`), generates the demo group and loads it.

**Claim the CFO seat.** Nobody becomes CFO by asking. The seed loader, acting as the database owner through the spacetime CLI, arms a one-time Bootstrap secret and prints a claim link once (`http://localhost:5173/claim#secret=…`, valid for a day). It also saves the link in `.secrets/cfo-bootstrap.<db>.txt`; the gateway prints only that file's path while the seat is empty. Open the link in the browser you will use as the CFO; the secret is then used up. `pnpm cfo:bootstrap` arms a new link while the seat is still empty, for example after it expired. A fresh publish wipes identities, so claim the seat again after each `pnpm demo:fresh`.

The loader takes the `advisor` role (the first connection to ask for it keeps it), and the agents' role identities are kept per database in `.secrets/<db>/` (`advisor.token`, `bookkeeper.token`, and so on), so several databases on one machine never share or overwrite an identity.

`pnpm -F @cafoo/web dev` on its own runs the UI against an in-browser Demo mode with nothing else started. To point it at the live database and gateway, set `PUBLIC_DATA_SOURCE=spacetime`; see `apps/web/README.md`.

Optional chat front-end. Open WebUI talks to the gateway's OpenAI-compatible endpoint:

```sh
docker run -d --name open-webui -p 3001:8080 --add-host=host.docker.internal:host-gateway \
  -e OPENAI_API_BASE_URL=http://host.docker.internal:8787/v1 -e OPENAI_API_KEY=dev \
  -e ENABLE_OLLAMA_API=false -e ENABLE_TITLE_GENERATION=false -e ENABLE_TAGS_GENERATION=false -e ENABLE_FOLLOW_UP_GENERATION=false \
  -v open-webui:/app/backend/data ghcr.io/open-webui/open-webui:main
```

Then open http://localhost:3001 and pick the `cafoo-advisor` model. The image is about 1.6 GB to download. The three `ENABLE_*_GENERATION` flags stop Open WebUI from sending its own background prompts (titles, tags, follow-ups) to the Advisor. Starting a close is allowed only from this machine (a loopback connection) or with `Authorization: Bearer <GATEWAY_API_KEY>`; Open WebUI in Docker connects from the Docker network, so to start a close from its chat, set `GATEWAY_API_KEY` and pass the same value as `OPENAI_API_KEY`.

## The group close, the feed, and charters

**A group of three companies.** The demo books hold Cafoo Inc (USD, the parent), Cafoo Ltd (GBP) and the Elimination subsidiary, which holds only eliminations. One Period per month covers the whole group, and the CFO locks it once. Account codes line up across companies by Group code (`2950-UK` is the UK's 2950).

**The Consolidation agent.** After Credit & Risk, the close runs a Consolidation step. It proposes a Revaluation of Cafoo Ltd's dollar balances at the month's closing rate and two Eliminations: the balances the companies owe each other (reversed the next month) and the month's intercompany service fees. Each goes through the Red Team, the Advisor and, when material, the CFO like any other Proposal, and the module recomputes every figure from the books before it posts.

**The consolidated Board Pack.** The Board Pack has a company switcher: Consolidated (in the Reporting currency, USD) or one company in its own currency. The consolidated view shows each company's column, an Eliminations column, and the currency translation adjustment (CTA), which is computed when the pound balances are translated and never posted. Expert mode adds the rates used, and every figure drills down per company to its journal lines.

**The October feed.** Lock September, then switch the feed on (the Launchpad's "Bank and invoice feed" card or Settings; the CFO's switch). Bank lines and new invoices for October then arrive every few seconds, and the continuous Bookkeeper proposes matches as they land; material ones still wait for the CFO. The feed only books into the month after one the CFO locked (the locks that come with the seed data do not count, so it never touches the month being closed), and it stops once that month's close opens.

**Custom charters.** The Charters page (`/charters`) shows each agent's Charter. Edit one, map every line to a rule, a scenario or a custom scenario, give a plain summary of the change, and save it as a new draft version. A custom Charter can only make the gate stricter: every shipped rule stays, and lines may add rules or tighten them (a higher batch-match threshold, a lower intercompany tolerance, narrower Proposal kinds, an amount cap). Run the full eval (a whole close on a scratch database, about a minute) before the CFO can publish; the quick check against the recorded close only informs. Restoring the built-in Charter is one click for the CFO.

The agent gateway reports what is running: `GET /status` (providers, closes, `feed`, `charterEval`), `GET /feed/status` (whether the feed is on, the month it fills, events planned and ingested, and why it is paused), `GET /charters/catalog`, and `POST`/`GET /charters/:versionId/eval`. Starting a close or an eval is allowed only from this machine or with the gateway API key.

## Demo mode and environment

With zero API keys, Cafoo runs end to end. Every external call replays recorded fixtures, and the close runs over the real accounting engines with scripted narration. The writes go through the same role identities and reducers as live agents, so the gate and the audit trail are identical. Each key you add switches that one provider to live calls. `DEMO_MODE="1"` forces fixtures even when keys are present.

| Variable | Used for | When empty |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Agent SDK: Advisor, Bookkeeper, Revenue, Credit & Risk | Replays `fixtures/agents/` |
| `XAI_API_KEY` | Grok: Red Team | Scripted critiques |
| `API_TOKEN` | Bright Data: live vendor lookups during the close | `fixtures/brightdata/` |
| `APIFY_TOKEN` | Apify: customer-site crawls into Moss (roadmap) | Skipped |
| `CRS_USERNAME`, `CRS_PASSWORD`, `CRS_BASE_URL`, `CRS_REPLAY` | CRS Credit API sandbox: identity, fraud, bureaus, public records | `fixtures/crs/` |
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` | Moss: vector search over policies and past entries | Local keyword search |
| `SPACETIMEDB_URI`, `SPACETIMEDB_DB_NAME` | Ledger database | `http://localhost:3000`, `cafoo` |
| `GATEWAY_PORT` | Agent gateway and OpenAI-compatible endpoint | `8787` |
| `GATEWAY_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the gateway and start a close | The web app's dev and preview origins on localhost and 127.0.0.1 (ports 5173 and 4173) |
| `GATEWAY_ALLOWED_HOSTS` | Extra Host names the gateway answers to (comma-separated; `*` turns the check off, e.g. for a LAN address) | localhost, 127.0.0.1, [::1], host.docker.internal, and the host of every allowed origin |
| `GATEWAY_API_KEY` | When set, `/v1/*` requires `Authorization: Bearer <key>`; give Open WebUI the same value as `OPENAI_API_KEY` | Open |
| `DEMO_MODE` | Force fixtures | `1` in the example file |
| `CLOSE_PERIOD` | Close month for seed data, `YYYY-MM` | Last completed month |
| `FEED_INTERVAL_MS` | Milliseconds between feed events (`0` sends a month's events back to back) | `8000` |
| `FEED_DEBOUNCE_MS` | Quiet time after the last new bank line before the continuous Bookkeeper proposes | `2000` |
| `PUBLIC_WEB_ORIGIN` | Origin of the CFO app in the claim link the seed loader prints | `http://localhost:5173` |
| `CFO_BOOTSTRAP_TTL_MINUTES` | How long a claim link armed by `pnpm cfo:bootstrap` stays valid (at most a week) | `1440` |
| `CHARTER_EVAL_DB` | Scratch database the full charter eval resets and closes; never the gateway's own | `cafoo-eval` |
| `CHARTER_SMOKE_DB` | Database the charter smoke test resets | `cafoo-charter-smoke` |

Quote every value in `.env`. Never retry a failed CRS login: repeated failures disable the sandbox account permanently. The variables a full charter eval uses to force a draft Charter are internal, and the agents honour them only on the eval database.

## Checks

```sh
pnpm test        # every package's tests, including the ledger engine and the credit cascade
pnpm check       # reference lint plus type checks
```

The smoke tests need the local SpacetimeDB on :3000 and the spacetime CLI. Each one republishes its own databases, so none of them touches `cafoo`:

```sh
pnpm -F @cafoo/stdb-bindings smoke   # every module gate and refusal, on cafoo-smoke and cafoo-smoke-legacy (an in-place upgrade)
pnpm -F @cafoo/agents smoke:feed     # September close, CFO claim and lock, then the October feed end to end (cafoo-c1; refuses cafoo)
pnpm -F @cafoo/agents smoke:charter  # draft, eval and publish a stricter Charter (CHARTER_SMOKE_DB and CHARTER_EVAL_DB)
pnpm eval --rerun                    # reseed, rerun the scripted close and check every charter scenario against the result
```

Money is stored as 64-bit integer minor units, and every currency conversion rounds half away from zero in both the module and the engine. The ledger engine is deterministic and has 142 unit tests. The credit cascade reproduces all 20 expected decisions from the sandbox dataset.

## Repo layout

```
apps/web/                 SvelteKit CFO app: Launchpad, Proposals, Agents, Close, Ledger, Board Pack, Charters, Customers, Vendors, Settings, /claim, /pitch
apps/agents/              Orchestrator, gateway (:8787), agent charters, scripted Demo mode close
  src/scripted/           The scripted close, including the Consolidation step (consolidate.ts) and the Advisor's rulings
  src/feed/               The simulated bank and invoice feed (feeder.ts)
  src/continuous/         The continuous Bookkeeper that proposes matches as feed rows land
  src/charter/            Charter versions: build, coverage, the eval runner, gateway routes, smoke test
  src/charters/           The shipped (built-in) Charters, one per agent
packages/ledger-core/     Pure double-entry engine: posting, matching, revenue schedules, accruals, allowances, FX, revaluation,
                          eliminations, translation and consolidation, metrics, plain summaries
packages/eval-harness/    Charter evals: one scenario per checkable charter line, run against the ledger
packages/crs-mcp/         CRS Credit API client, credit cascade, and MCP server for the Credit & Risk agent
packages/stdb-bindings/   Generated SpacetimeDB client bindings and the module smoke test
spacetimedb/spacetimedb/  SpacetimeDB module: tables and reducers, including the approval gate
seed/                     Deterministic demo group (Cafoo Inc, Cafoo Ltd, eliminations) with planted anomalies, the October feed
                          plan, and the CFO bootstrap (bootstrap.ts)
fixtures/                 Recorded responses for Demo mode (agents, brightdata, crs, moss)
docs/                     Product spec, pitch, roadmap, ADRs
```

## Read next

- [CONTEXT.md](CONTEXT.md): the glossary. Use these words in code and docs.
- [docs/adr/](docs/adr/): architecture decisions, starting with [the two-tier approval gate](docs/adr/0001-two-tier-approval-gate-enforced-in-reducers.md).
- [docs/product-spec.md](docs/product-spec.md): modules, entity model, governance, UX principles.
- [docs/pitch.md](docs/pitch.md): the three-minute pitch and slide outline.
- [docs/roadmap.md](docs/roadmap.md): what ships today and what comes next.
