# @cafoo/web

The CFO's app: Launchpad, Proposals, Agent Debate, Close, Ledger, Board Pack, Charters, Customers, Vendors, Settings, `/claim`, plus `/pitch` and `/pricing`. SvelteKit 3, Svelte 5 runes, Tailwind v4.

```sh
pnpm -F @cafoo/web dev      # Demo mode: in-browser mock, nothing else needed
PUBLIC_DATA_SOURCE=spacetime pnpm -F @cafoo/web dev   # live ledger database + agent gateway
pnpm -F @cafoo/web check && pnpm -F @cafoo/web build
pnpm -F @cafoo/web test     # unit tests (vitest.config.ts, without the SvelteKit plugin)
```

The SvelteKit plugin writes the dev server's static env (`.svelte-kit/generated/dev/env`) from the environment of whichever process loads it.
A second dev server started without `PUBLIC_DATA_SOURCE=spacetime` switches a running live dev server to Demo mode until that server restarts, so the unit tests run on plain Vite.

## Data

- `src/lib/data/source.ts`: the `DataSource` interface. Every screen reads and acts only through it.
- `src/lib/data/index.ts`: picks the implementation from `PUBLIC_DATA_SOURCE` (declared in `src/env.ts`).
- `src/lib/data/mock/`: Demo mode. Seed JSON in `mock/seed/`, the scripted ~23 s September close in `mock/script.ts`.
  `mock/seed/group.json` is Cafoo Ltd, the Elimination subsidiary and their rates and intercompany entries, generated once from `seed/src/group.ts`; the close's Consolidation step computes its Revaluation and Eliminations with `@cafoo/ledger-core`.
  `mock/seed/charters.json` is the gateway's `GET /charters/catalog`; a Demo mode eval checks the line mapping only.
- `src/lib/data/spacetime/`: live mode over the generated bindings in `src/lib/module_bindings/` (gitignored, run `spacetime generate`). Env: `PUBLIC_STDB_URI` (default `ws://localhost:3000`), `PUBLIC_STDB_DATABASE` (`cafoo`), `PUBLIC_AGENT_GATEWAY` (`http://localhost:8787`: `POST /close`, `GET /charters/catalog`, `POST`/`GET /charters/:versionId/eval`).
- `src/lib/data/group.ts`: the Board Pack's P&L and balance sheet, consolidated or for one company, from `@cafoo/ledger-core` (`consolidate`, `translateBooks`): translation into the Reporting currency, the CTA (computed, never posted), the Eliminations column and the rates used.
- `src/lib/data/derive.ts`: other pure read-side maths (ARR waterfall, aging, Allowance, period labels).
- `src/lib/charter.ts`: the Charter editor's helpers (the eval harness's line parser, the line mapping, the publish rule). The gateway's eval is the authority; these only flag problems before a draft is saved.

Imports use package `imports` (`#lib/...`); TypeScript modules need a `.js` specifier, for example `#lib/data/index.js`.

## The CFO seat (live mode)

The browser never registers itself as CFO; the module refuses that.
Open the claim link the seed loader prints (`/claim#secret=...`, also saved in `.secrets/cfo-bootstrap.<db>.txt`).
The page reads the secret from the fragment, removes it from the address bar, and calls `claimCfo`.
The seat stays with the connection identity in the saved token (`cafoo.stdb.token` in localStorage), so it survives reloads.
`agent_identity` is private to the module, so `cfoSeat()` in `src/lib/data/spacetime/spacetime-source.svelte.ts` reads the seat from public tables: the `cfo` row in `agent_roster`, and `audit_event` rows written by this identity as `cfo`.
A browser without the seat shows a read-only banner, and the module's refusals come back as plain read-only messages.

## Design

Material 3 color roles generated from an autumn seed (terracotta primary, olive secondary, burgundy tertiary), as CSS custom properties in `src/app.css`.
Each token is `light-dark(light, dark)`: the page follows the system theme, and Settings (or the top bar's theme button) pins Light or Dark through `data-theme` on `<html>`.
Tailwind 4 reads the tokens through `@theme inline`, so `bg-primary`, `bg-surface-container`, `text-on-surface-variant` and the older short names (`canvas`, `ink`, `line`, `accent`, `pos`, `neg`, `warn`) all work.
Component classes: `.btn` (outlined), `.btn-primary` (filled), `.btn-tonal`, `.btn-text`, `.btn-quiet`, `.btn-danger`, `.chip`, `.segmented`, `.card`, `.card-elevated`, `.card-filled`, `.field`, `.state` (M3 state layer), `.num` (tabular mono figures).
Fonts are self-hosted and SIL Open Font License: Newsreader (display), Instrument Sans (interface), IBM Plex Mono (figures).
Navigation is a bottom bar on phones, a rail on tablets, and a drawer that collapses to the rail on desktops.
