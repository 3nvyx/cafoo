# The Red Team runs on a different model vendor through the Vercel AI SDK

Status (2026-10-24): the core agents still use the Claude Agent SDK. With `AGENT_PROVIDER=openai` (see `.env.example`) that SDK talks to OpenAI through a local Anthropic Messages bridge. Anthropic itself is optional. The Red Team stays on a second vendor.

The Red Team critiques every proposal and should not share the blind spots of the models that wrote them, so it runs on xAI Grok while the core agents run on Claude. xAI's own TypeScript SDK is pre-1.0 and weeks old, so we reach Grok through `@ai-sdk/xai` with client-side tools, which also lets Grok call local MCP servers. We never mix xAI server-side tools with client-side tools in one request because the Responses API rejects that combination.
