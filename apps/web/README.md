# @cafoo/web

The CFO's app: Launchpad (`/dashboard`), Proposals, Agent Debate, Close, Ledger, Board Pack, Customers, Vendors, Settings, plus the public landing page at `/` and `/pitch`. SvelteKit 3, Svelte 5 runes, Tailwind v4 (tokens in `src/app.css`).

```sh
pnpm -F @cafoo/web dev      # Demo mode: in-browser mock, nothing else needed
PUBLIC_DATA_SOURCE=spacetime pnpm -F @cafoo/web dev   # live ledger database + agent gateway
pnpm -F @cafoo/web check && pnpm -F @cafoo/web build
```

## Data

- `src/lib/data/source.ts`: the `DataSource` interface. Every screen reads and acts only through it.
- `src/lib/data/index.ts`: picks the implementation from `PUBLIC_DATA_SOURCE` (declared in `src/env.ts`).
- `src/lib/data/mock/`: Demo mode. Seed JSON in `mock/seed/`, the scripted ~22 s September close in `mock/script.ts`.
- `src/lib/data/spacetime/`: live mode over the generated bindings in `src/lib/module_bindings/` (tracked; regenerate with `pnpm gen:bindings` after a module change). Env: `PUBLIC_STDB_URI` (default `ws://localhost:3000`), `PUBLIC_STDB_DATABASE` (`cafoo`), `PUBLIC_AGENT_GATEWAY` (`http://localhost:8787`, `POST /close`, `POST /footprint`).
- `src/lib/data/derive.ts`: pure Board Pack maths (P&L, balance sheet, ARR waterfall, aging, Allowance).
- `src/lib/footprint.ts`: public footprint derivations (per-source latest and previous run, change since last run, list chip). Rendered by `FootprintPanel` on `/customers/[id]` and `/vendors/[id]`; collecting goes through the gateway, never the browser.

Imports use package `imports` (`#lib/...`); TypeScript modules need a `.js` specifier, for example `#lib/data/index.js`.
