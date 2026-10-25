# Naming and tiers

One token is one design decision with a name. The name says what the value is *for*; the value says what it *is*. Code, agents and this document all use the names, so a value can change without anything else moving.

## Three tiers

| Tier | File | Example | Answers | Read by |
|---|---|---|---|---|
| Primitives | `tokens/primitives.tokens.json` | `palette.ocean.500` = `#00b4ff` | What values exist? | The semantic tier only. Never emitted to CSS. |
| Semantic | `tokens/semantic.tokens.json` | `color.accent` → `{palette.ocean.500}` | What is this value for? | Components and screens, through CSS variables and Tailwind classes. |

Following one value all the way down: the class `bg-accent-soft` is Tailwind's `--color-accent-soft`, which is the CSS variable `--accent-soft`, which is the token `color.accent-soft`, which in light mode points at `palette.ocean.50`, which holds `#dcf0fb`. Change the primitive and every use follows; repoint the semantic token and only that meaning changes.

## Groups and the CSS they become

| Group | Token id | CSS variable | Tailwind theme | Classes |
|---|---|---|---|---|
| `color` | `color.accent-soft` | `--accent-soft` | `--color-accent-soft` | `bg-accent-soft`, `text-accent-soft`, `border-…`, `fill-…`, `stroke-…`, `ring-…`, `divide-…` |
| `role` | `role.advisor` | `--role-advisor` | `--color-role-advisor` | `bg-role-advisor`, `text-role-advisor`, `fill-role-advisor` |
| `type` | `type.caption` | `--type-caption-font-size` and `-line-height`, `-letter-spacing`, `-font-weight`, `-font-family` | `--text-caption` (+ `--line-height`, `--letter-spacing`) | `text-caption`; weight stays `font-medium` etc. |
| `shape` | `shape.md` | `--shape-md` | `--radius-md` | `rounded-md` |
| `font` (primitive) | `font.display` | none | `--font-display` | `font-display` |

Tailwind's own palette (`bg-red-500`), type sizes (`text-sm`, `text-2xl`), radii (`rounded-2xl`) and font families (`font-serif`) are switched off in the `@theme` block, so those classes do not exist. `rounded-full`, `rounded-none`, the font weights (`font-medium`) and everything colour-independent stay. Spacing keeps Tailwind's 4px scale (`p-3`, `gap-2`); only bracketed values (`p-[14px]`) are banned.

## Colour grammar

- **Neutrals**: `canvas` (the page), `surface` (cards and controls), `subtle` (hover, neutral chips); `ink`, `ink-2`, `ink-3` for text from primary to tertiary; `line` for every border, `line-strong` for control edges.
- **The accent** is `accent` with `on-accent` for text on it, `accent-ink` for the brand hue as text, `accent-soft` with `on-accent-soft` as its container pair. `accent-deep` is artwork only.
- **Status** is `pos`, `neg`, `warn`, `info`, each with three partners: `X-soft` (container fill), `on-X-soft` (text on that fill), `on-X` (text on a solid X fill). Status colours carry meaning and are never decorative. `info` is neutral grey on purpose: blue means action. `info-soft` is one step firmer than `subtle`, so an info badge stays visible on a hovered row, and `on-info-soft` is one step darker than `info` to stay readable on it.
- **`soft` means container; `on-` means the thing placed on it.** Every `-soft` fill has an `on-` partner; use them together: `bg-neg-soft text-on-neg-soft`.
- **`scrim`** dims the page behind dialogs; **`inverse`** with **`on-inverse`** is the small mode-flipping surface for toasts and tooltips.
- **`focus`** is the focus ring. 3:1 against canvas and surface in both modes.
- **Roles** are one colour per agent, for avatars and names only.

## Modes

Light is the default `$value`; a token that changes in dark mode carries both under `$extensions.mode` (`light`, `dark`). The CSS has one block per mode: `:root` (light), `:root[data-theme='dark']` and `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])`. The web app toggles `data-theme` on `<html>`. There is one accent and it does not switch.

## Usage notes

Tokens that are easy to misuse carry, under `$extensions["com.luyten"]`, `usage` (a short list of kebab-case use cases) and `rules` (one string of sentences, each starting with "Never" or "Only"). These are written for the agents and people who read the token files directly. `tests/usage-notes.test.ts` keeps the format honest and fails if a listed token loses its notes.

## Type scale

Eight steps by role: `micro` 11/16, `caption` 12/18, `body-sm` 13/20, `body` 15/22, `subtitle` 17/24, `title` 20/26, `display-sm` 28/32, `display` 44/46 (size/line height in px; the three largest use `font-display` and tighter tracking). The class sets size, line height and tracking; weight is still `font-medium` or `font-semibold`, and each token's `fontWeight` records the recommended pairing.

## Adding a token

1. If the value does not exist yet, add it to a ramp in `primitives.tokens.json` as `{ "colorSpace": "srgb", "components": [r, g, b], "hex": "#rrggbb" }` (components are 0–1; the test checks they agree with the hex). Dimensions are `{ "value": 8, "unit": "px" }`.
2. Add the semantic token with a one-sentence `$description`, both modes if they differ, and usage notes if it could be misused. Status fills come as a pair with their `on-` partner.
3. If it is text on a fill, add the pair to `contrast.json`.
4. `pnpm -F @luyten/design-tokens build`, then `test`. Commit the token files and the regenerated CSS together.

Three uses make a token. One screen's special case is not a token; it is a component style on that screen.
