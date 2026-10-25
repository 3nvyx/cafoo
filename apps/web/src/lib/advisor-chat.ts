// The browser side of "Ask the Advisor": one OpenAI-compatible chat call to the agent gateway
// (POST {gateway}/v1/chat/completions, model "cafoo-advisor"). The gateway answers only this machine unless it has an
// API key, so a refusal comes back as a plain sentence for the chat to show. The caller passes the gateway URL
// (PUBLIC_AGENT_GATEWAY, the same one the live data source uses), which keeps this module free of SvelteKit and testable.

export interface ChatTurn {
	role: 'user' | 'assistant';
	content: string;
}

/** Pull the assistant's text out of a chat.completion body; throws when there is none. */
export function completionText(body: unknown): string {
	const choice = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0];
	const content = choice?.message?.content;
	if (typeof content !== 'string' || !content.trim()) throw new Error('The Advisor sent back an empty answer.');
	return content;
}

/** The error a failed gateway response carries, in plain words. */
export function errorText(status: number, body: unknown): string {
	const e = (body as { error?: unknown } | null)?.error;
	const msg = typeof e === 'string' ? e : typeof (e as { message?: unknown } | undefined)?.message === 'string' ? (e as { message: string }).message : '';
	return msg ? `The Advisor could not answer (${status}): ${msg}` : `The Advisor could not answer (${status}).`;
}

/** Ask the Advisor. `history` is the whole conversation so far, ending with the CFO's question. */
export async function askAdvisor(history: ChatTurn[], opts: { gateway: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<string> {
	const f = opts.fetch ?? fetch;
	let res: Response;
	try {
		res = await f(`${opts.gateway.replace(/\/+$/, '')}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'cafoo-advisor', messages: history }),
			signal: opts.signal
		});
	} catch (e) {
		if ((e as Error).name === 'AbortError') throw e;
		throw new Error('The agent gateway is offline. Start it, then ask again.');
	}
	const body = await res.json().catch(() => null);
	if (!res.ok) throw new Error(errorText(res.status, body));
	return completionText(body);
}
