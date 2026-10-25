# Scaling work to the task (applies to every chat)

Before starting a request, size it and say which size you picked in one short line.

- **Quick**: questions, explanations, non-coding chats, a small edit in one or two files. Do it yourself. No agents.
- **Medium**: a feature or bug fix touching a few files. Build it yourself, then run `reviewer` and, for changes
  that will be committed, `codex-reviewer` in parallel. Fix the findings you agree with; at most 2 review rounds.
  Use `researcher` first when the work depends on current docs or versions; use `tester` when tests are missing.
  For UI/visual changes or a risky design decision, also ask `gemini-advisor` for a critique.
- **Large or parallel**: several independent parts (frontend + backend + tests), research and build at once,
  or a bug with competing explanations. Form an agent team of 2–4 named teammates from the agents below.
  Before spawning, state the team in one line (name → role → files it owns).

Experts: `researcher`, `ui-designer`, `tester`, `reviewer`, `codex-reviewer` (OpenAI), `gemini-advisor` (Google).

Team rules:
- Each teammate owns its own files; two agents never edit the same file.
- Teammates message each other directly with findings and blockers; the lead (you) integrates and reports.
- Reviewers never edit. Review happens after building, never in parallel with edits to the same files.
- Never push, merge, deploy, or delete branches unless I ask.
- Reach Gemini only through `gemini-advisor` (official `agy` CLI, read-only): at most 2 calls per task, never in a loop.
- If I say "solo" or "no agents", work alone. If I say "team", use a team even if the task looks small.

# Design tokens (apps/web)

Every colour, type size, radius and agent-role colour is a token in `packages/design-tokens/tokens/*.tokens.json`
(W3C DTCG format). `packages/design-tokens/NAMING.md` has the tiers and the naming rules; each token's own
`$description`, `usage` and `rules` say what it is for. The build writes `packages/design-tokens/css/cafoo-tokens.css`,
whose `@theme` block is the complete list of design classes that exist (`bg-accent-soft`, `text-on-accent-soft`, `text-caption`,
`rounded-md`, `bg-role-advisor`, …). If a class is not in that file, it does not exist. Until `apps/web/src/app.css` imports that
file (migration pending; the raw-values baseline tracks it), only the classes `app.css` itself defines render.

Never in `apps/web`: raw hex or `rgb()` colours; bracketed sizes such as `text-[13px]` or `w-[220px]` (use the type
scale and the 4px spacing scale); Tailwind's palette, size and radius classes such as `bg-red-500`, `text-sm`, `text-2xl`
or `rounded-2xl` (they are switched off; use `text-caption`, `rounded-md`, …);
invented names such as `bg-primary-container` or `text-on-error-container`; coloured borders (every box uses
`border-line`; differences show through fill); all-caps eyebrows or labels (sentence case). The accent is for actions
and selection only, never for status; status colours always travel as a pair (`bg-pos-soft text-on-pos-soft`).

Commands: `pnpm -F @cafoo/design-tokens build` regenerates the CSS (commit it), `pnpm -F @cafoo/design-tokens check`
validates the token files, `pnpm -F @cafoo/design-tokens test` runs the checks (CSS drift, contrast, usage-note format,
raw values in `apps/web/src` against `scripts/raw-values-baseline.json`, whose total may only go down; tighten it with
`pnpm -F @cafoo/design-tokens baseline`). Design decisions are recorded in `docs/adr/0012-design-tokens-as-data.md`.
