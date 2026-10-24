# The Red Team runs on a different model vendor through the Vercel AI SDK

The Red Team critiques every proposal and should not share the blind spots of the models that wrote them, so it runs on xAI Grok while the core agents run on Claude. xAI's own TypeScript SDK is pre-1.0 and weeks old, so we reach Grok through `@ai-sdk/xai` with client-side tools, which also lets Grok call local MCP servers. We never mix xAI server-side tools with client-side tools in one request because the Responses API rejects that combination.
