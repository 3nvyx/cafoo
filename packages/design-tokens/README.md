# @luyten/design-tokens

Luyten's design decisions as data, and the checks that keep the web app on them.

```
tokens/primitives.tokens.json   palette ramps, sizes, font stacks (W3C DTCG 2025.10)
tokens/semantic.tokens.json     colour, role, type and shape tokens with light/dark modes and usage notes
contrast.json                   foreground/background pairs that must stay readable, with their minimum ratio
terrazzo.config.mjs             the Terrazzo build (semantic tier only, aliases inlined, one block per mode)
scripts/build.mjs               runs Terrazzo, re-indents, adds color-scheme, appends the Tailwind @theme block
scripts/tokens.mjs              a small token reader used by the checks
scripts/raw-values.mjs          the scanner behind the raw-values check and its allowlist
scripts/raw-values-baseline.json  per-file counts of raw values in apps/web/src that may only go down
css/luyten-tokens.css            the committed build output that apps/web imports
tests/                          the checks (build, contrast, usage notes, raw values, Tailwind compile)
NAMING.md                       tiers, grammar, how to add a token
```

## Commands

| Command | Does |
|---|---|
| `pnpm -F @luyten/design-tokens build` | Regenerates `css/luyten-tokens.css`. Commit the result. |
| `pnpm -F @luyten/design-tokens check` | `tz check`: validates the token files (types, references, names). Part of `pnpm check`. |
| `pnpm -F @luyten/design-tokens test` | Runs the checks below. Part of `pnpm test` and CI. |
| `pnpm -F @luyten/design-tokens baseline` | Rewrites the raw-values baseline with the current counts; refuses to raise the total unless `RATCHET_ALLOW_RAISE=1`. |

## Checks

A check is a script with a fixed answer. Nobody judges whether something passes.

| Check | Fails when |
|---|---|
| `tests/build.test.ts` | the committed CSS differs from a fresh build; a semantic token is missing from the CSS; a primitive leaks into it; a mode block has the wrong resolved value; a primitive's components disagree with its hex; an alias dangles or loops |
| `tests/contrast.test.ts` | any pair in `contrast.json` is below its minimum (4.5:1 text, 3:1 focus ring) in either mode |
| `tests/usage-notes.test.ts` | a usage note has a key other than `usage`/`rules`, a use case that is not kebab-case, a rule that does not start with "Never" or "Only", or a listed token has lost its notes |
| `tests/raw-values.test.ts` | a file in `apps/web/src` has more raw colours, bracketed sizes, Tailwind palette classes or unknown colour/size/radius classes than the baseline allows, or fewer (tighten the baseline; a moved file shows as one stale and one raised entry, and `baseline` accepts that as long as the total does not rise) |
| `tests/tailwind.test.ts` | compiled with the real Tailwind, `font-medium` or a token class stops working, or `bg-red-500`, `text-sm`, `rounded-2xl` come back |

## How a value change flows

1. Edit a value in `tokens/primitives.tokens.json`, or repoint a semantic token.
2. `pnpm -F @luyten/design-tokens build`.
3. `pnpm -F @luyten/design-tokens test`. If white text on the new red fails contrast, the test names the pair and the mode.
4. Open a pull request with the token file and the regenerated CSS. The diff is values only.
5. Every screen that uses the semantic names picks up the change. No component changes.

## Using the tokens in apps/web

`app.css` imports `@luyten/design-tokens/css` after `tailwindcss` (the migration that does this, and moves the components onto the token classes, is tracked by the raw-values baseline; until it lands, `app.css` still defines its own variables and only those classes render). The `@theme` block at the end of the generated file is the complete list of design classes; a class that is not there does not exist. Rules of the road are in the root `AGENTS.md` under "Design tokens"; the grammar is in `NAMING.md`.

Sources this follows: the [W3C Design Tokens Community Group format](https://www.designtokens.org/), Nathan Curtis's writing on design-system structure and naming, and GitHub Primer's `usage`/`rules` fields for agent-readable notes.
