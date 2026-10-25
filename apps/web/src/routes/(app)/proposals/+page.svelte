<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { db } from '#lib/data/index.js';
	import type { ProposalStatus } from '#lib/data/types.js';
	import ConfirmAll from '#lib/components/ConfirmAll.svelte';
	import ProposalList from '#lib/components/ProposalList.svelte';

	const TABS: { id: string; label: string; statuses: ProposalStatus[] | null }[] = [
		{ id: 'awaiting_cfo', label: 'Needs your OK', statuses: ['awaiting_cfo'] },
		{ id: 'open', label: 'In debate', statuses: ['open'] },
		{ id: 'approved', label: 'Approved', statuses: ['approved', 'amended'] },
		{ id: 'sent_back', label: 'Sent back', statuses: ['sent_back'] },
		{ id: 'rejected', label: 'Rejected', statuses: ['rejected'] },
		{ id: 'superseded', label: 'Superseded', statuses: ['superseded'] },
		{ id: 'all', label: 'All', statuses: null }
	];

	const tab = $derived(TABS.find((t) => t.id === page.url.searchParams.get('status')) ?? TABS[0]);
	const all = $derived(db.proposals().slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
	const count = (t: (typeof TABS)[number]) => (t.statuses ? all.filter((p) => t.statuses!.includes(p.status)).length : all.length);
	const shown = $derived(tab.statuses ? all.filter((p) => tab.statuses!.includes(p.status)) : all);

	const awaiting = $derived(all.filter((p) => p.status === 'awaiting_cfo'));

	// On a narrow screen the tab row scrolls sideways: keep the selected tab in view (without moving the page).
	let tablist: HTMLDivElement | undefined = $state();
	$effect(() => {
		const el = document.getElementById(`tab-${tab.id}`);
		if (!tablist || !el) return;
		const box = tablist.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		if (r.right > box.right) tablist.scrollLeft += r.right - box.right + 16;
		else if (r.left < box.left) tablist.scrollLeft -= box.left - r.left + 16;
	});

	// A deep link (#proposal-20) scrolls once its card exists; live rows can arrive after the page loads.
	let landed = false;
	$effect(() => {
		const target = page.url.hash.slice(1);
		if (landed || !target.startsWith('proposal-') || !shown.some((p) => `proposal-${p.id}` === target)) return;
		landed = true;
		tick().then(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }));
	});

	function select(id: string) {
		goto(`?status=${id}`, { replace: true, reset: false });
	}

	function onTabKey(e: KeyboardEvent, i: number) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
		e.preventDefault();
		const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
		select(next.id);
		queueMicrotask(() => document.getElementById(`tab-${next.id}`)?.focus());
	}
</script>

<svelte:head><title>Proposals · Cafoo</title></svelte:head>

<h1 class="text-[34px] sm:text-[42px]">Proposals</h1>
<p class="mt-2 max-w-[60ch] text-ink-2">
	Every change an agent wants to make to the books. Nothing touches a balance until the Advisor approves it, and anything over your threshold waits for you.
</p>

<div bind:this={tablist} class="-mx-4 mt-6 overflow-x-auto px-4" role="tablist" aria-label="Proposal status">
	<div class="flex min-w-max gap-1 border-b border-line">
		{#each TABS as t, i (t.id)}
			<button
				id="tab-{t.id}"
				role="tab"
				aria-selected={tab.id === t.id}
				aria-controls="tab-panel"
				tabindex={tab.id === t.id ? 0 : -1}
				onclick={() => select(t.id)}
				onkeydown={(e) => onTabKey(e, i)}
				class="-mb-px flex min-h-[44px] items-center gap-2 border-b-2 px-3 text-[15px] transition-colors duration-150 {tab.id === t.id
					? 'border-accent font-medium text-ink'
					: 'border-transparent text-ink-2 hover:text-ink'}"
			>
				{t.label}
				<span class="num rounded-full bg-subtle px-1.5 text-xs leading-5 text-ink-2">{count(t)}</span>
			</button>
		{/each}
	</div>
</div>

<div id="tab-panel" role="tabpanel" aria-labelledby="tab-{tab.id}" class="mt-6 max-w-[820px]">
	{#if tab.id === 'awaiting_cfo'}<ConfirmAll proposals={awaiting} class="mb-4 flex justify-end" />{/if}
	<ProposalList proposals={shown} empty={tab.id === 'awaiting_cfo' ? 'Nothing needs your OK right now.' : 'No Proposals with this status.'} />
</div>
