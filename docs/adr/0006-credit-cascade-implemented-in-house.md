# The credit cascade is implemented in-house against the sandbox REST API

The credit provider's hosted workflow builder can author screening cascades but exposes no API to execute one, so the Credit & Risk agent runs its own cascade (identity verification, fraud score, three-bureau credit report, public records) against the REST sandbox, stopping early on a deceased or mismatched identity. Login happens once per process with a cached token and is never retried on failure, because repeated failed logins disable the sandbox account permanently.
