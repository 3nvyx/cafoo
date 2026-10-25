<script lang="ts">
	// The Debate feed: one thread per Proposal, the ruling pinned on top.
	import { db } from '#lib/data/index.js';
	import type { AgentMessage } from '#lib/data/types.js';
	import DebateMessage from '#lib/components/DebateMessage.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import LiveActivity from '#lib/components/LiveActivity.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import { ACTIVITY_ROLES, agentActivity, type ActivityRole } from '#lib/agent-activity.js';
	import { KIND, STATUS, dateTime, roleName } from '#lib/labels.js';
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

	// What each agent did and the tools behind it (#lib/agent-activity.js): this month's Proposals and messages, and
	// every Credit Check on record.
	const customerNames = $derived(new Map(db.customers().map((c) => [c.id, c.name])));
	const vendorNames = $derived(new Map(db.vendors().map((v) => [v.id, v.name])));
	const activity = $derived(
		agentActivity({
			proposals: db.proposals().filter((p) => p.periodId === ui.periodId),
			messages: db.agentMessages().filter((m) => !m.proposalId || proposals.get(m.proposalId)?.periodId === ui.periodId),
			creditChecks: db.creditChecks(),
			nameOf: (kind, id) => (kind === 'customer' ? customerNames.get(id) : vendorNames.get(id)),
			kindLabel: (k) => KIND[k]
		})
	);
	let agent = $state<ActivityRole>('bookkeeper');
	const current = $derived(activity.find((a) => a.role === agent)!);
	const anyActivity = $derived(activity.some((a) => a.items.length));
	const demo = $derived(db.connection().ledger === 'demo');
	let showAll = $state(false);
	const SHOWN = 8;
</script>

<svelte:head><title>Agents · Cafoo</title></svelte:head>

<div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
	<div>
		<h1 class="text-[34px] sm:text-[42px]">Agent Debate</h1>
		<p class="mt-2 max-w-[60ch] text-ink-2">Worker agents propose, the Red Team critiques, the Advisor rules. Each thread is one Proposal.</p>
	</div>
	{#if period?.status === 'open' && !started}
		<button class="btn btn-primary" onclick={() => attempt(() => db.startClose(period.id))}><Icon name="play" size={16} />Start the close</button>
	{/if}
</div>

<div class="mt-4"><LiveActivity periodId={ui.periodId} /></div>

<section class="mt-6 flex flex-col gap-4" aria-labelledby="activity-h">
	<div>
		<h2 id="activity-h" class="text-subtitle">What each agent did</h2>
		<p class="mt-1 text-body-sm text-ink-2">
			Each line shows the tools on that agent's harness for that kind of work (see <a class="drill" href="/charters">Charters</a>); they describe the work, not a log of model calls.
			{#if demo}In Demo mode this is the recorded demo close, not a live AI run.{/if}
		</p>
	</div>
	<div class="flex flex-wrap gap-2" role="group" aria-label="Agent">
		{#each ACTIVITY_ROLES as r (r)}
			{@const a = activity.find((x) => x.role === r)}
			<button
				type="button"
				class="chip"
				aria-pressed={agent === r}
				onclick={() => {
					agent = r;
					showAll = false;
				}}>{roleName(r)} <span class="num text-caption opacity-80">{a?.items.length ?? 0}</span></button
			>
		{/each}
	</div>
	{#if !anyActivity}
		<div class="card flex flex-col items-center gap-3 px-5 py-10 text-center">
			<p class="text-ink-2">No agent has done anything for this month yet. Start the close and the Bookkeeper begins with the bank feed.</p>
			<a class="btn btn-primary" href="/close"><Icon name="play" size={16} />Start the close</a>
		</div>
	{:else if current}
		<div class="card flex flex-col gap-4 p-4 sm:p-5">
			<div class="flex flex-wrap items-center gap-3">
				<RoleAvatar role={current.role} size={32} />
				<div class="min-w-0 flex-1">
					<p class="font-medium">{roleName(current.role)}</p>
					<p class="text-body-sm text-ink-2">
						{#if current.made}
							<span class="num">{current.made}</span> Proposals: {current.byKind.map((k) => `${k.count} ${k.label}`).join(', ')} · <span class="num">{current.approved}</span> approved ·
							<span class="num">{current.waitingCfo}</span> waiting for the CFO
						{:else}
							{current.items.length} item{current.items.length === 1 ? '' : 's'} this month
						{/if}
					</p>
				</div>
			</div>
			{#if current.toolsUsed.length}
				<div>
					<p class="eyebrow">Tools behind this work</p>
					<ul class="mt-2 flex flex-wrap gap-2">
						{#each current.toolsUsed as t (t.name)}
							<li class="rounded-sm border border-line px-2 py-0.5 text-caption"><code class="font-mono">{t.name}</code> <span class="num text-ink-3">×{t.count}</span></li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if current.items.length}
				<ol class="flex flex-col divide-y divide-line border-y border-line">
					{#each showAll ? current.items : current.items.slice(0, SHOWN) as i (i.id)}
						<li class="flex flex-col gap-1 py-3">
							<div class="flex flex-wrap items-center gap-2 text-caption text-ink-3">
								<span class="font-medium text-ink-2">{i.label}</span>
								<span>{dateTime(i.at)}</span>
								{#if i.status}<Pill tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Pill>{/if}
							</div>
							{#if i.proposalId}
								<a class="drill text-body-sm" href="/proposals?status=all#proposal-{i.proposalId}">{i.text}</a>
							{:else}
								<p class="text-body-sm">{i.text}</p>
							{/if}
							{#if i.tools.length}
								<p class="text-caption text-ink-3">Tools: {#each i.tools as t, k (t)}<code class="font-mono text-ink-2">{t}</code>{k < i.tools.length - 1 ? ', then ' : ''}{/each}</p>
							{/if}
						</li>
					{/each}
				</ol>
				{#if current.items.length > SHOWN}
					<button class="btn btn-text self-start" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show ${current.items.length - SHOWN} more`}</button>
				{/if}
			{:else}
				<p class="text-body-sm text-ink-3">
					{roleName(current.role)} has nothing on record for this month yet.
					{#if !started}<a class="drill" href="/close">Start the close</a> to put it to work.{/if}
				</p>
			{/if}
		</div>
	{/if}
</section>

<h2 class="mt-10 text-subtitle">Debate threads</h2>

<div class="mt-2 flex flex-wrap gap-2" role="group" aria-label="Filter threads">
	{#each FILTERS as f (f.id)}
		<button
			class="chip"
			aria-pressed={filter === f.id}
			onclick={() => (filter = f.id)}>{#if filter === f.id}<Icon name="check" size={16} />{/if}{f.label}</button
		>
	{/each}
</div>

<ul class="mt-6 flex max-w-[820px] flex-col gap-5">
	{#each threads as t (t.key)}
		<li class="card overflow-hidden">
			<header class="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
				<div class="min-w-0 flex-1">
					{#if t.proposal}
						<p class="text-sm text-ink-3">
							{KIND[t.proposal.kind]} by {roleName(t.proposal.proposerRole)}
						</p>
						<p class="mt-0.5 text-[17px] leading-snug font-medium">{t.proposal.summaryPlain}</p>
					{:else}
						<p class="text-sm text-ink-3">Close thread</p>
						<p class="mt-0.5 text-[17px] leading-snug font-medium">Advisor coordination</p>
					{/if}
				</div>
				{#if t.proposal}
					{#key t.proposal.status}
						<span in:arrive={{ y: -6 }}><Pill tone={STATUS[t.proposal.status].tone}>{STATUS[t.proposal.status].label}</Pill></span>
					{/key}
				{/if}
			</header>
			{#if t.ruling}
				<div class="border-b border-l-2 border-b-line border-l-primary bg-surface-container-low px-4 py-3 sm:px-5">
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
