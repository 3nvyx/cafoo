# SpacetimeDB is the ledger, the approval queue, and the agent message bus

One SpacetimeDB module holds the ledger tables, proposals, approvals, close tasks, and every agent message, and the UI subscribes to all of it live. We chose one backend over a relational database plus a separate queue plus websockets because the demo's core claim is that humans watch agents work on the books in real time, and a single transactional store with live subscriptions makes that claim cheap to keep true. Moss is used only for vector search; it never holds a record of truth.
