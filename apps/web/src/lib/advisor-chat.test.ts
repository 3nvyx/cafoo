import { describe, expect, it } from 'vitest';
import { askAdvisor, completionText, errorText } from './advisor-chat';

const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('askAdvisor', () => {
	it('posts the conversation to the gateway as luyten and returns the answer', async () => {
		let seen: { url: string; init?: RequestInit } | null = null;
		const f = (async (url: string, init?: RequestInit) => {
			seen = { url, init };
			return ok({ choices: [{ message: { role: 'assistant', content: 'Cash is $11M.' } }] })();
		}) as typeof fetch;
		const answer = await askAdvisor([{ role: 'user', content: 'Cash?' }], { gateway: 'http://localhost:8787/', fetch: f });
		expect(answer).toBe('Cash is $11M.');
		expect(seen!.url).toBe('http://localhost:8787/v1/chat/completions');
		expect(JSON.parse(String(seen!.init?.body))).toEqual({ model: 'luyten', messages: [{ role: 'user', content: 'Cash?' }] });
	});

	it('turns a refusal into a plain sentence', async () => {
		const f = ok({ error: { message: 'missing or wrong API key' } }, 401) as unknown as typeof fetch;
		await expect(askAdvisor([{ role: 'user', content: 'x' }], { gateway: 'http://g', fetch: f })).rejects.toThrow('The Advisor could not answer (401): missing or wrong API key');
	});

	it('says the gateway is offline when the request cannot be made', async () => {
		const f = (async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch;
		await expect(askAdvisor([{ role: 'user', content: 'x' }], { gateway: 'http://g', fetch: f })).rejects.toThrow('The agent gateway is offline');
	});
});

describe('completionText and errorText', () => {
	it('refuses an empty answer', () => {
		expect(() => completionText({ choices: [{ message: { content: '  ' } }] })).toThrow('empty');
		expect(() => completionText(null)).toThrow('empty');
	});
	it('reads string and object errors', () => {
		expect(errorText(403, { error: 'origin not allowed' })).toBe('The Advisor could not answer (403): origin not allowed');
		expect(errorText(500, null)).toBe('The Advisor could not answer (500).');
	});
});
