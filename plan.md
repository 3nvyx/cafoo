# MVP plan, 25 October 2026

Target: MVP done and on `main` by 5:00am PDT.
Cal Hacks submissions close at 9:00am PDT.
If you are an agent picking this up, read this file, then `AGENTS.md`, then `CONTEXT.md`.

## Working rules

- Commit and push to `main` often. Run `pnpm check` and `pnpm -F @cafoo/web test` before every push. CI must stay green.
- Never use the em dash. Use a plain dash.
- No co-author lines naming an agent in commits.
- Do not edit `CHANGELOG.md`, lockfiles, or generated files (`apps/web/src/lib/module_bindings/`, `packages/stdb-bindings/src/`) by hand; regenerate with `pnpm gen:bindings`.
- Keep the design language: use the existing tokens (`packages/design-tokens`), classes (`card`, `chip`, `eyebrow`, `text-title`, `num`, `drill`) and components (`KpiCard`, `MetricTile`, `RoleAvatar`, `Icon`).
- Never present a demo or scripted result as a live AI result.
- Pages read data only through `db` from `#lib/data/index.js`. The contract is `apps/web/src/lib/data/source.ts` and `types.ts`. Keep changes to those files additive.

## The company: Quillmesh

Quillmesh, Inc. sells an AI document-automation API to insurance and logistics back offices.
Customers send claims, invoices and bills of lading and get structured data back.
Pricing is a platform fee plus per-page usage.

- Stage: Series A, $50M post-money, closed March 2026, $12M raised. About $4.8M ARR, growing about 3x a year.
- People: 62 (48 in the US, 14 in the UK). Cash about $11M. Runway about 24 months.
- Group: Quillmesh Inc (USD, parent), Quillmesh Ltd (GBP), Elimination.
- Customers, about 300: about 220 self-serve ($500 to $2k a month, card), about 65 mid-market ($25k to $120k a year), about 15 enterprise ($250k to $900k a year, net-60, ramped multi-year).
- Vendors: GPU cloud, a model API, payroll provider, SaaS tools, contractors.
- Finance team of 3: CFO, controller, AP/AR clerk. Daily bank feed, a two-day close, Board Pack and cap table for investors, credit checks on the owners behind self-serve and mid-market customers and on new vendors.
- History: 18 months, April 2025 to September 2026. September 2026 is the month the demo closes.
- The planted close problems from the small dataset stay in, scaled: duplicate vendor payment, missing revenue schedule, a guarantor in bankruptcy, a synthetic-identity vendor owner and a deceased one.

The small dataset stays as the test fixture, because CI asserts its exact figures.
Quillmesh is a second seed profile: `SEED_PROFILE=quillmesh pnpm demo:fresh`.

## How Cafoo grows with a startup ($10M to $1B valuation)

| Stage | What changes for finance | What Cafoo does | Today or roadmap |
|---|---|---|---|
| $10M to $50M (seed to A) | One or two entities, a few hundred customers, the founder still approves spend | Agents propose, the Advisor rules, the CFO confirms anything material. Close in days, not weeks. Cap table and round modeling | Today |
| $50M to $250M (A to B) | A second country and currency, usage pricing, enterprise contracts, a first controller | Multi-currency consolidation, revaluation and eliminations as Proposals. Revenue schedules rebuilt automatically. Credit checks on customers and vendors. Custom Charters that only tighten the gate | Today |
| $250M to $1B (B to growth) | Many entities, tens of thousands of transactions a month, audit and SOC 2 | Continuous bookkeeping between closes, per-subsidiary locks, a dedicated evaluator identity, real bank and billing feeds, hosted deployment, SOC 2 controls | Roadmap (docs/roadmap.md) |

The gate does not loosen as volume grows: the Materiality threshold and Charters scale with the company, and every number still drills down to its journal lines.

## Work streams

Phase 1 runs first because the data shapes everything else.
Page streams build against the existing `types.ts` shapes and the browser demo data, so they can start at once.

| # | Stream | Owner files | Done when |
|---|---|---|---|
| 1 | Company foundation: Quillmesh generator, SpacetimeDB tables for people, payroll, funding, cap table, cloud costs, batches, deals, tickets; live source returns them | `seed/`, `spacetimedb/`, `apps/web/src/lib/data/spacetime/` | `SEED_PROFILE=quillmesh pnpm demo:fresh` loads, every page has data on the live database |
| 2 | Landing page: journal entries open by default, "Multi-layer agent security starts in the database", founder section sells money protected, new "Built for your 10x" section | `apps/web/src/routes/(marketing)/` | No empty panels; copy matches the table above |
| 3 | Dashboard: Ask the Advisor box, close progress, agent status, credit Risk Tier panel, interactive charts | `apps/web/src/routes/(app)/dashboard/` | Each panel links to its page |
| 4 | Agents, Charters, Close bar: each agent's rules and tools (including the CRS MCP tools), tool-call activity, a progress bar at the top of Close | `agents/`, `charters/`, `close/` | No empty Charter; tool calls visible |
| 5 | Ledger, Metrics, Dash bar export: trial balance, account tree, filters, running balances, entry drill to Proposal; ERP-grade SaaS metrics; CSV and Excel export button | `ledger/`, `metrics/`, `dash-bar/` | Export downloads open in Excel |
| 6 | Customers and Vendors: detail pages with aging, credit tier and evidence, usage, contracts, payments, verification | `customers/`, `vendors/` | Every customer and vendor opens a detail page |
| 7 | People, Cost of service, Batches, Financing, cap table tools (ownership, round modeling, SAFE conversion, option pool top-up) | `people/`, `costs/`, `batches/`, `financing/` | Cap table tools compute and test correctly |

Google Slides export is out of scope for now.

## Status

Update this table when a stream lands on `main`.

| # | Status | Last commit |
|---|---|---|
| 1 | In progress | |
| 2 | In progress | |
| 3 | In progress | |
| 4 | In progress | |
| 5 | In progress | |
| 6 | In progress | |
| 7 | In progress | |
