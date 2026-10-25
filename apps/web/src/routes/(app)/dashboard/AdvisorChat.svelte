<script lang="ts">
	// Ask the Advisor: a question box and the conversation. Live mode sends it to the agent gateway's Advisor
	// (OpenAI-compatible chat). Demo mode has no gateway, so it says so; the three suggested questions get a lookup
	// worked out in this browser from the demo books, labelled as such and never shown as the Advisor's answer.
	import { PUBLIC_AGENT_GATEWAY } from '$app/env/public';
	import { db } from '#lib/data/index.js';
	import { postings, balanceAt } from '#lib/data/dashboard.js';
	import { formatMoney } from '#lib/data/money.js';
	import { askAdvisor, type ChatTurn } from '#lib/advisor-chat.js';
	import { TIER } from '#lib/labels.js';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { customerTiers } from './insights.js';

	const live = db.kind === 'live';
	const SUGGESTED = ['What is our cash per company?', 'What needs my OK?', 'Which customers are high risk?'] as const;

	type Turn = ChatTurn & { demo?: boolean; error?: boolean };
	let turns = $state<Turn[]>([]);
	let question = $state('');
	let busy = $state(false);
	let controller: AbortController | null = null;
	let log: HTMLElement | undefined = $state();

	// ---- Demo lookups: plain reads of the demo books, for the suggested questions only ----
	function cashPerCompany(): string {
		const asOf = db.now().slice(0, 10);
		const lines = db
			.subsidiaries()
			.filter((s) => !s.isElimination)
			.map((s) => {
				const ps = postings(db.accounts().filter((a) => a.subsidiaryId === s.id), db.journalEntries(), db.journalLines());
				const cash = balanceAt(ps, ['1000', `1000-${s.code}`], asOf);
				return `${s.name}: ${formatMoney(cash.toString(), { whole: true, currency: s.baseCurrency })}`;
			});
		return lines.length ? `Book cash on ${asOf}, in each company's own currency:\n${lines.join('\n')}` : 'There are no companies on the books yet.';
	}
	function needsOk(): string {
		const waiting = db.proposals().filter((p) => p.status === 'awaiting_cfo');
		if (!waiting.length) return 'Nothing is waiting for your confirmation.';
		const top = waiting.slice(0, 5).map((p) => `${p.summaryPlain} (${formatMoney(p.amountMinor, { whole: true })})`);
		return `${waiting.length} Proposal${waiting.length === 1 ? ' is' : 's are'} waiting for your confirmation:\n${top.join('\n')}${waiting.length > 5 ? `\nand ${waiting.length - 5} more on the Proposals page.` : ''}`;
	}
	function highRisk(): string {
		const tiers = customerTiers(db.customers(), db.creditChecks());
		const risky = db.customers().filter((c) => {
			const t = tiers.get(c.id);
			return t === 'D' || t === 'BLOCK';
		});
		if (!risky.length) return 'No customer is in Risk Tier D or BLOCK.';
		return `${risky.length} customer${risky.length === 1 ? ' is' : 's are'} in Risk Tier D or BLOCK:\n${risky
			.slice(0, 8)
			.map((c) => `${c.name}: ${TIER[tiers.get(c.id)!].label}, ${TIER[tiers.get(c.id)!].plain.toLowerCase()}`)
			.join('\n')}`;
	}
	function demoAnswer(q: string): string | null {
		if (q === SUGGESTED[0]) return cashPerCompany();
		if (q === SUGGESTED[1]) return needsOk();
		if (q === SUGGESTED[2]) return highRisk();
		return null;
	}

	async function scrollDown() {
		await Promise.resolve();
		log?.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
	}

	async function ask(text = question) {
		const q = text.trim();
		if (!q || busy) return;
		question = '';
		turns = [...turns, { role: 'user', content: q }];
		scrollDown();
		if (!live) {
			const a = demoAnswer(q);
			turns = [
				...turns,
				a === null
					? { role: 'assistant', content: 'Advisor chat needs the agent gateway, and Demo mode runs without one. Try a suggested question for a lookup from the demo books.', error: true }
					: { role: 'assistant', content: a, demo: true }
			];
			scrollDown();
			return;
		}
		busy = true;
		controller = new AbortController();
		try {
			const history: ChatTurn[] = turns.filter((t) => !t.error && !t.demo).map(({ role, content }) => ({ role, content }));
			const answer = await askAdvisor(history, { gateway: PUBLIC_AGENT_GATEWAY, signal: controller.signal });
			turns = [...turns, { role: 'assistant', content: answer }];
		} catch (e) {
			if ((e as Error).name !== 'AbortError') turns = [...turns, { role: 'assistant', content: (e as Error).message, error: true }];
		} finally {
			busy = false;
			controller = null;
			scrollDown();
		}
	}

	function stop() {
		controller?.abort();
	}
</script>

<section aria-labelledby="advisor-h" class="card flex flex-col gap-4 p-5">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex items-center gap-3">
			<RoleAvatar role="advisor" />
			<div class="flex flex-col">
				<h2 id="advisor-h" class="text-subtitle">Ask the Advisor</h2>
				<p class="text-caption text-ink-2">
					{live ? 'Answers come from the Advisor agent, reading the live books' : 'Demo mode: no agent gateway, so no AI answers. Suggested questions show a lookup from the demo books.'}
				</p>
			</div>
		</div>
		{#if turns.length}
			<button class="btn btn-quiet text-body-sm" onclick={() => (turns = [])} disabled={busy}>Clear</button>
		{/if}
	</div>

	{#if turns.length}
		<ol bind:this={log} class="flex max-h-80 flex-col gap-3 overflow-y-auto" aria-live="polite" aria-label="Conversation with the Advisor">
			{#each turns as t, i (i)}
				{#if t.role === 'user'}
					<li class="ml-auto max-w-prose rounded-md bg-subtle px-3 py-2 text-body-sm text-on-subtle">{t.content}</li>
				{:else}
					<li class="flex max-w-prose gap-2">
						<RoleAvatar role="advisor" size={24} />
						<div class="flex min-w-0 flex-col gap-1">
							{#if t.demo}
								<span class="text-caption text-ink-3">Demo lookup from the demo books, not an AI answer</span>
							{/if}
							<p class="text-body-sm whitespace-pre-line {t.error ? 'rounded-md bg-warn-soft px-3 py-2 text-on-warn-soft' : 'text-ink'}">{t.content}</p>
						</div>
					</li>
				{/if}
			{/each}
			{#if busy}
				<li class="flex items-center gap-2 text-body-sm text-ink-2"><RoleAvatar role="advisor" size={24} />The Advisor is reading the books…</li>
			{/if}
		</ol>
	{/if}

	<div class="flex flex-wrap gap-2" role="group" aria-label="Suggested questions">
		{#each SUGGESTED as s (s)}
			<button class="chip" onclick={() => ask(s)} disabled={busy}>{s}</button>
		{/each}
	</div>

	<form
		class="flex gap-2"
		onsubmit={(e) => {
			e.preventDefault();
			ask();
		}}
	>
		<label for="advisor-q" class="sr-only">Your question for the Advisor</label>
		<input id="advisor-q" class="field min-w-0 flex-1 text-body-sm" placeholder="Ask about cash, the close, customers, Proposals…" bind:value={question} autocomplete="off" disabled={busy} />
		{#if busy}
			<button type="button" class="btn" onclick={stop}>Stop</button>
		{:else}
			<button type="submit" class="btn btn-primary" disabled={!question.trim()}><Icon name="arrowRight" size={18} /><span class="sr-only sm:not-sr-only">Send</span></button>
		{/if}
	</form>
</section>
