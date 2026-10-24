<script lang="ts">
	// The Debate feed: one thread per Proposal, the ruling pinned on top.
	import { db } from '#lib/data/index.js';
	import type { AgentMessage } from '#lib/data/types.js';
	import DebateMessage from '#lib/components/DebateMessage.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import LiveActivity from '#lib/components/LiveActivity.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { KIND, STATUS, roleName } from '#lib/labels.js';
	import { arrive } from '#lib/motion.js';
	import { attempt } from '#lib/toast.svelte.js';
	import { ui } from '#lib/ui.svelte.js';

	type Filter = 'all' | 'cfo' | 'critiques';
	let filter = $state<Filter>('all');
	const FILTERS: { id: Filter; label: string }[] = [
		{ id: 'all', label: 'All threads' },
		{ id: 'cfo', label: 'Needs your OK' },
		{ id: 'critiques', label: 'With critiques' }
	];

	const proposals = $derived(new Map(db.proposals().map((p) => [p.id, p])));

	const threads = $derived.by(() => {
		const by = new Map<string, AgentMessage[]>();
		for (const m of db.agentMessages()) {
			const key = m.proposalId ? `p:${m.proposalId}` : `t:${m.threadId}`;
			let list = by.get(key);
			if (!list) by.set(key, (list = []));
			list.push(m);
		}
		return [...by.entries()]
			.map(([key, msgs]) => {
				const sorted = msgs.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
				const ruling = sorted.filter((m) => m.kind === 'ruling').at(-1);
				return {
					key,
					proposal: key.startsWith('p:') ? proposals.get(key.slice(2)) : undefined,
					ruling,
					messages: sorted.filter((m) => m !== ruling),
					latest: sorted.at(-1)?.createdAt ?? '',
					hasCritique: sorted.some((m) => m.kind === 'critique')
				};
			})
			.filter((t) => filter === 'all' || (filter === 'cfo' ? t.proposal?.status === 'awaiting_cfo' : t.hasCritique))
			.sort((a, b) => b.latest.localeCompare(a.latest));
	});

	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const started = $derived(db.connection().closes.some((c) => c.periodYm === ui.periodId));
</script>

<svelte:head><title>Agents · Cafoo</title></svelte:head>

<div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
	<div>
		<h1 class="text-[32px]">Agent Debate</h1>
		<p class="mt-2 max-w-[60ch] text-ink-2">Worker agents propose, the Red Team critiques, the Advisor rules. Each thread is one Proposal.</p>
	</div>
	{#if period?.status === 'open' && !started}
		<button class="btn btn-primary" onclick={() => attempt(() => db.startClose(period.id))}><Icon name="play" size={16} />Start the close</button>
	{/if}
</div>

<div class="mt-4"><LiveActivity periodId={ui.periodId} /></div>

<div class="mt-2 flex flex-wrap gap-2" role="group" aria-label="Filter threads">
	{#each FILTERS as f (f.id)}
		<button
			class="min-h-[44px] rounded-full border px-4 text-sm transition-colors duration-150 {filter === f.id ? 'border-ink bg-ink text-canvas' : 'border-line-strong text-ink-2 hover:text-ink'}"
			aria-pressed={filter === f.id}
			onclick={() => (filter = f.id)}>{f.label}</button
		>
	{/each}
</div>

<ul class="mt-6 flex max-w-[820px] flex-col gap-5">
	{#each threads as t (t.key)}
		<li class="card overflow-hidden">
			<header class="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
				<div class="min-w-0 flex-1">
					{#if t.proposal}
						<p class="text-sm text-ink-3">
							{KIND[t.proposal.kind]} by {roleName(t.proposal.proposerRole)}{#if ui.expert}<span class="num"> · {t.proposal.id}</span>{/if}
						</p>
						<p class="mt-0.5 font-medium">{t.proposal.summaryPlain}</p>
					{:else}
						<p class="text-sm text-ink-3">Close thread</p>
						<p class="mt-0.5 font-medium">Advisor coordination</p>
					{/if}
				</div>
				{#if t.proposal}
					{#key t.proposal.status}
						<span in:arrive={{ y: -6 }}><Pill tone={STATUS[t.proposal.status].tone}>{STATUS[t.proposal.status].label}</Pill></span>
					{/key}
				{/if}
			</header>
			{#if t.ruling}
				<div class="border-b border-l-4 border-b-line border-l-accent bg-accent-soft/40 px-4 py-3 sm:px-5">
					<DebateMessage m={t.ruling} pinned />
				</div>
			{/if}
			<ol class="flex flex-col gap-4 px-4 py-4 sm:px-5">
				{#each t.messages as m (m.id)}
					<li in:arrive><DebateMessage {m} /></li>
				{/each}
			</ol>
			{#if t.proposal?.status === 'awaiting_cfo'}
				<footer class="border-t border-line px-4 py-3 sm:px-5">
					<a href="/proposals?status=awaiting_cfo#proposal-{t.proposal.id}" class="drill text-sm font-medium">Review and confirm</a>
				</footer>
			{/if}
		</li>
	{:else}
		<li class="card px-5 py-10 text-center text-ink-3">No threads match this filter.</li>
	{/each}
</ul>
