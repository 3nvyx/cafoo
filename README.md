# Cafoo

Cafoo is an agentic finance ERP for SaaS companies. Worker agents do the month-end close: they match the bank feed, rebuild revenue schedules, accrue late bills, and check the credit of the people behind your customers and vendors. They can only propose. A Chief Finance Advisor agent rules on every Proposal with a written rationale, and anything material waits for the CFO's one-click confirmation. Every number in the Board Pack drills down to the journal lines, the Proposal, and the agent debate that produced it.

## The problem

The monthly close still takes a team of people about ten days. Most of that time goes to matching deposits, chasing receipts, and rebuilding schedules in spreadsheets. AI agents could do most of it, but no finance team will let a model post straight to the books, and they are right not to.

## The answer

Agents propose, an Advisor rules, the CFO confirms, and every number drills down.

Worker agents (Bookkeeper, Revenue, Credit & Risk) create Proposals and can never commit them. A Red Team agent on a second model vendor critiques each Proposal. The Advisor approves, rejects, or amends it, always with a rationale. Any ruling at or above the Materiality threshold (default $10,000) waits in the CFO's "Needs your OK" queue. The CFO confirms or sends it back, can reverse any entry, and always confirms the period lock.

The gate is enforced in the database, not in prompts. SpacetimeDB reducers check the caller's identity, so a worker agent that ignores its instructions still cannot write to the ledger. Every Proposal and ruling carries a Plain summary (one sentence, no jargon) and a technical rationale. Simple mode shows the sentence. Expert mode shows the journal lines, account codes, critiques, and raw payloads.

## Architecture

```
SvelteKit UI (CFO app)      <- live subscriptions ->  SpacetimeDB module (ledger, Proposals, Approvals, agent messages, audit trail)
Agent orchestrator (:8787)  -- reducer calls, one identity per role -->  SpacetimeDB
  Advisor, Bookkeeper, Revenue, Credit & Risk: Claude Agent SDK (TypeScript)
  Red Team: Grok through the Vercel AI SDK
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

# terminal 2: publish the module, then generate and load the demo company
cd spacetimedb && spacetime publish cafoo --server local --yes && cd ..
pnpm -F @cafoo/seed generate && pnpm -F @cafoo/seed load

# terminal 3: agent orchestrator and gateway on :8787
pnpm -F @cafoo/agents orchestrator

# terminal 4: the CFO app
pnpm -F @cafoo/web dev
```

Start a close from the app, or from the shell:

```sh
curl -X POST http://localhost:8787/close -H 'content-type: application/json' -d '{"periodYm":"2026-09"}'
```

The first connection to claim the `advisor` or `cfo` role keeps it; later claims need a grant from the advisor. The seed loader claims `advisor`, and the first browser to open the app against a fresh database claims `cfo`. That is fine for a demo on one machine, but anyone who can reach port 3000 before you could take the CFO seat, so do not expose a fresh database. A one-time bootstrap secret is on the roadmap.

`pnpm -F @cafoo/web dev` on its own runs the UI against an in-browser Demo mode with nothing else started. To point it at the live database and gateway, set `PUBLIC_DATA_SOURCE=spacetime`; see `apps/web/README.md`.

Optional chat front-end. Open WebUI talks to the gateway's OpenAI-compatible endpoint:

```sh
docker run -d -p 3001:8080 --add-host=host.docker.internal:host-gateway -e OPENAI_API_BASE_URL=http://host.docker.internal:8787/v1 -e OPENAI_API_KEY=dev -v open-webui:/app/backend/data ghcr.io/open-webui/open-webui:main
```

Then open http://localhost:3001 and pick the `cafoo-advisor` model.

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
| `DEMO_MODE` | Force fixtures | `1` in the example file |
| `CLOSE_PERIOD` | Close month for seed data, `YYYY-MM` | Last completed month |

Quote every value in `.env`. Never retry a failed CRS login: repeated failures disable the sandbox account permanently.

## Checks

```sh
pnpm test        # every package's tests, including the ledger engine and the credit cascade
pnpm check       # reference lint plus type checks
```

Money is stored as 64-bit integer minor units. The ledger engine is deterministic and has 86 unit tests. The credit cascade reproduces all 20 expected decisions from the sandbox dataset.

## Repo layout

```
apps/web/                 SvelteKit CFO app: Launchpad, Proposals, Agents, Close, Ledger, Board Pack, Customers, Vendors, Settings, /pitch
apps/agents/              Orchestrator, gateway (:8787), agent charters, scripted Demo mode close
packages/ledger-core/     Pure double-entry engine: posting, matching, revenue schedules, accruals, allowances, metrics, plain summaries
packages/crs-mcp/         CRS Credit API client, credit cascade, and MCP server for the Credit & Risk agent
packages/stdb-bindings/   Generated SpacetimeDB client bindings
spacetimedb/spacetimedb/  SpacetimeDB module: tables and reducers, including the approval gate
seed/                     Deterministic demo company with planted anomalies
fixtures/                 Recorded responses for Demo mode (agents, brightdata, crs, moss)
docs/                     Product spec, pitch, roadmap, ADRs
```

## Read next

- [CONTEXT.md](CONTEXT.md): the glossary. Use these words in code and docs.
- [docs/adr/](docs/adr/): architecture decisions, starting with [the two-tier approval gate](docs/adr/0001-two-tier-approval-gate-enforced-in-reducers.md).
- [docs/product-spec.md](docs/product-spec.md): modules, entity model, governance, UX principles.
- [docs/pitch.md](docs/pitch.md): the three-minute pitch and slide outline.
- [docs/roadmap.md](docs/roadmap.md): what ships today and what comes next.
