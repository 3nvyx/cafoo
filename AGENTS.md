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
