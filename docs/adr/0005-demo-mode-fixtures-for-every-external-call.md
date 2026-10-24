# Every external call has a recorded demo mode

The product must run end to end with no API keys, so each provider (Claude, Grok, CRS, Bright Data, Apify, Moss) has a fixture-backed implementation chosen automatically when its key is absent, and `DEMO_MODE=1` forces fixtures even when keys exist. Agent runs are replayed from a recorded step file through the same reducers the live agents use, so the UI, the gate, and the audit trail are identical in both modes. The cost is that fixtures must be re-recorded when charters change.
