# The Red Team runs on a different model vendor through the Vercel AI SDK

Status (2026-10-24): the core agents still use the Claude Agent SDK. With `AGENT_PROVIDER=openai` (see `.env.example`) that SDK talks to OpenAI through a local Anthropic Messages bridge. Anthropic itself is optional. The Red Team stays on a second vendor.

The Red Team critiques every proposal and should not share the blind spots of the models that wrote them, so it runs on xAI Grok while the core agents run on Claude. xAI's own TypeScript SDK is pre-1.0 and weeks old, so we reach Grok through `@ai-sdk/xai` with client-side tools, which also lets Grok call local MCP servers. We never mix xAI server-side tools with client-side tools in one request because the Responses API rejects that combination.

Update (2026-10-24): Gemini joins as the Red Team's second critic, through `@ai-sdk/google` with the same two client-side tools and harness. It runs after Grok, sees Grok's critique, and submits only a point Grok missed, so the debate gains a third vendor's blind spots rather than a repeat. Both critics write as the one Red Team identity, so the gate is unchanged; Gemini's critiques start with "Gemini: " (or "Gemini (scripted): " for the Demo mode stand-ins) so the app can name the model. A live Gemini failure writes nothing rather than falling back, so scripted text never appears under the live label.
