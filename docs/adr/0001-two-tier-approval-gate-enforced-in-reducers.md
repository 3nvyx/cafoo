# Two-tier approval gate enforced in database reducers

Worker agents and the Red Team can never write to the ledger; only the Advisor's identity may call commit reducers, and above a materiality threshold even the Advisor's ruling waits for the human CFO. The gate lives in SpacetimeDB reducers (checked by sender identity), with agent-runtime hooks as a second layer, because a prompt or a hook alone can be bypassed by a misbehaving agent while a reducer cannot. Plain-English summaries are a required field on every proposal and ruling, not a UI nicety, because the final approver may be non-technical.

Only worker agents propose: the Advisor is refused by `propose`, and `approveProposal` and `cfoConfirm` refuse any identity that proposed the Proposal, so no identity can rule on its own work, even after a role grant.
An amendment replaces a worker's text with the Advisor's own, so it waits for the CFO like a material ruling, whatever its amount.
The CFO seat is the human's: only the CFO or the database owner can release it, never an agent.
