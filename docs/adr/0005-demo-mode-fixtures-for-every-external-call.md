# Every external call has a demo mode that needs no key

The product must run end to end with no API keys, so each provider (Claude, Grok, CRS, Bright Data, Apify, Moss) has a stand-in chosen automatically when its key is absent, and `DEMO_MODE=1` forces the stand-ins even when keys exist.
Bright Data and CRS answer from recorded fixtures (`fixtures/brightdata/`, `fixtures/crs/`), Moss becomes a local keyword search over the policy documents in `fixtures/moss/`, and Apify is skipped.
Claude is not replayed from a recording: without it the close is a scripted close (`apps/agents/src/scripted/`) that takes every accounting decision from the real engines (`@cafoo/ledger-core` and the `@cafoo/crs-mcp` credit cascade) and scripts only the narration and the Advisor's rulings, and the Advisor chat answers from the ledger tables.
Without Grok the Red Team writes rule-based critiques.
The scripted close writes through the same role identities and reducers the live agents use, so the UI, the gate, and the audit trail are identical in both modes.
The cost is that the scripted close and its rulings are code that must keep pace with the charters, and the recorded ledger snapshot the charter evals judge (`packages/eval-harness/test/fixtures/ledger-snapshot.json`) must be re-recorded from a fresh scripted close when that close changes.
