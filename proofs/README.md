# Proofs

Evidence that each part of Cafoo works, kept next to the code it proves.

- `offline-<date>.md`: every feature mapped to the automated tests that prove it, with pass counts and the commit
  they ran on. Anyone can reproduce it with `pnpm check && pnpm test && pnpm -F @cafoo/agents test:module`.
- `live-<time>.md` and `.json`: written by `pnpm proof` on a machine with real keys in `.env`. It makes one minimal,
  real call per configured provider (nothing is written to the books) and records the provider's own ids, the model,
  and the time taken. A provider without keys is listed as skipped, never faked, and no key or token is written.
  `pnpm proof -- --crs` adds one CRS sandbox login (a failed login is never retried, because repeated failures
  disable the account); `pnpm proof -- --slides` creates and shares one small Google Slides deck.

For the SpacetimeDB gates themselves, CI runs the module smoke (every gate and refusal), the feed smoke and the eval
rerun on a real SpacetimeDB 2.13 on every pull request.
