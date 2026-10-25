<script lang="ts">
	// Ask the Advisor: a small chat beside the agents' activity. Live mode sends the conversation to the agent gateway's
	// Advisor (OpenAI-compatible chat), which asks the specialist agents and answers from the books. Demo mode has no
	// gateway, so it says so; the suggested questions get a lookup worked out in this browser from the demo books,
	// labelled as such and never shown as the Advisor's answer.
	import { PUBLIC_AGENT_GATEWAY } from '$app/env/public';
	import { db } from '#lib/data/index.js';
	import { postings, balanceAt } from '#lib/data/dashboard.js';
	import { formatMoney } from '#lib/data/money.js';
	import type { AgentRole } from '#lib/data/types.js';
	import { tick } from 'svelte';
	import { askAdvisor, type ChatTurn } from '#lib/advisor-chat.js';
	import { TIER, roleName } from '#lib/labels.js';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { customerTiers } from '../dashboard/insights.js';

	const live = db.kind === 'live';
	const SPECIALISTS: AgentRole[] = ['bookkeeper', 'revenue', 'credit', 'consolidation'];
	const SUGGESTED = ['What is our cash per company?', 'What needs my OK?', 'Which customers are high risk?'] as const;

	// `unsent` marks a question that was stopped or failed: it stays in the log but is never sent again as history.
	type Turn = ChatTurn & { demo?: boolean; error?: boolean; unsent?: 'stopped' | 'failed' };
	let turns = $state<Turn[]>([]);
	let question = $state('');
	let busy = $state(false);
	let controller: AbortController | null = null;
	let log: HTMLElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();
	let box: HTMLElement | undefined = $state();
	const unasked = $derived(SUGGESTED.filter((s) => !turns.some((t) => t.role === 'user' && t.content === s)));

	// Leaving the page mid-answer cancels the request.
	$effect(() => () => controller?.abort());

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
		await tick();
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		log?.scrollTo({ top: log.scrollHeight, behavior: still ? 'auto' : 'smooth' });
	}

	async function ask(text = question) {
		const q = text.trim();
		if (!q || busy) return;
		// The field and chips are disabled while the Advisor answers, which drops focus; give it back afterwards.
		const hadFocus = !!box?.contains(document.activeElement);
		question = '';
		turns = [...turns, { role: 'user', content: q }];
		const mine = turns.length - 1;
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
			const history: ChatTurn[] = turns.filter((t) => !t.error && !t.demo && !t.unsent).map(({ role, content }) => ({ role, content }));
			const answer = await askAdvisor(history, { gateway: PUBLIC_AGENT_GATEWAY, signal: controller.signal });
			turns = [...turns, { role: 'assistant', content: answer }];
		} catch (e) {
			const stopped = (e as Error).name === 'AbortError';
			turns[mine].unsent = stopped ? 'stopped' : 'failed';
			if (!stopped) turns = [...turns, { role: 'assistant', content: (e as Error).message, error: true }];
		} finally {
			busy = false;
			controller = null;
			await scrollDown();
			if (hadFocus) input?.focus();
		}
	}

	function stop() {
		controller?.abort();
	}
</script>

<section bind:this={box} aria-labelledby="advisor-h" class="card flex flex-col gap-3 p-4">
	<div class="flex items-start justify-between gap-3">
		<div class="flex min-w-0 items-center gap-3">
			<RoleAvatar role="advisor" size={28} />
			<div class="flex min-w-0 flex-col">
				<h2 id="advisor-h" class="text-subtitle">Ask the Advisor</h2>
				<p class="text-caption text-ink-3">It asks {SPECIALISTS.map(roleName).join(', ')}</p>
			</div>
		</div>
		{#if turns.length}
			<button class="btn btn-quiet min-h-9 px-2 text-body-sm" onclick={() => (turns = [])} disabled={busy}>Clear</button>
		{/if}
	</div>

	{#if !live && !turns.length}
		<p class="text-caption text-ink-2">Demo mode: no agent gateway, so no AI answers. Suggested questions show a lookup from the demo books.</p>
	{/if}

	{#if turns.length}
		<ol bind:this={log} class="flex max-h-80 flex-col gap-3 overflow-y-auto" aria-live="polite" aria-label="Conversation with the Advisor">
			{#each turns as t, i (i)}
				{#if t.role === 'user'}
					<li class="ml-8 flex flex-col items-end gap-1 self-end">
						<p class="rounded-md bg-subtle px-3 py-2 text-body-sm break-words text-on-subtle">{t.content}</p>
						{#if t.unsent}<span class="text-caption text-ink-3">{t.unsent === 'stopped' ? 'Stopped before the Advisor answered' : 'Not answered'}</span>{/if}
					</li>
				{:else}
					<li class="flex gap-2">
						<RoleAvatar role="advisor" size={24} />
						<div class="flex min-w-0 flex-col gap-1">
							{#if t.demo}
								<span class="text-caption text-ink-3">Demo lookup, not an AI answer</span>
							{/if}
							<p class="text-body-sm break-words whitespace-pre-line {t.error ? 'rounded-md bg-warn-soft px-3 py-2 text-on-warn-soft' : 'text-ink'}">{t.content}</p>
						</div>
					</li>
				{/if}
			{/each}
			{#if busy}
				<li class="flex items-center gap-2 text-body-sm text-ink-2"><RoleAvatar role="advisor" size={24} />The Advisor is asking its specialists…</li>
			{/if}
		</ol>
	{/if}

	{#if unasked.length}
		<div class="flex flex-wrap gap-2" role="group" aria-label="Suggested questions">
			{#each unasked as s (s)}
				<button class="chip" onclick={() => ask(s)} disabled={busy}>{s}</button>
			{/each}
		</div>
	{/if}

	<form
		class="flex gap-2"
		onsubmit={(e) => {
			e.preventDefault();
			ask();
		}}
	>
		<label for="advisor-q" class="sr-only">Your question for the Advisor</label>
		<input id="advisor-q" class="field min-w-0 flex-1 text-body-sm" placeholder="Ask about cash, customers, the close…" bind:this={input} bind:value={question} autocomplete="off" disabled={busy} />
		{#if busy}
			<button type="button" class="btn" onclick={stop}>Stop</button>
		{:else}
			<button type="submit" class="btn btn-primary px-3" disabled={!question.trim()} aria-label="Send"><Icon name="arrowRight" size={18} /></button>
		{/if}
	</form>
</section>
