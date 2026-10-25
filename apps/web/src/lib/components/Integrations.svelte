<script lang="ts">
	// The tools an area would read from. None of them syncs yet: every row and record count comes from the demo company,
	// so the panel says "Sample" and never claims a live connection.
	import { db } from '#lib/data/index.js';
	import type { IntegrationCategory } from '#lib/data/types.js';
	import { attempt } from '#lib/toast.svelte.js';
	import Pill from './Pill.svelte';

	let { categories, title = 'Tools' }: { categories: IntegrationCategory[]; title?: string } = $props();

	const list = $derived(db.integrations().filter((i) => categories.includes(i.category)));

	let busy = $state<string | null>(null);
	async function toggle(id: string, on: boolean) {
		busy = id;
		await attempt(() => (on ? db.disconnectIntegration(id) : db.connectIntegration(id)), on ? 'Sample turned off.' : 'Sample turned on.');
		busy = null;
	}
</script>

<section class="card flex flex-col gap-3 p-5" aria-label={title}>
	<div class="flex flex-col gap-1">
		<h2 class="text-subtitle">{title}</h2>
		<p class="text-caption text-ink-3">Sample connections. Luyten does not sync with these tools yet; the records come from the demo company.</p>
	</div>
	{#if !list.length}
		<p class="text-body-sm text-ink-3">No tools for this area yet.</p>
	{:else}
		<ul class="flex flex-col divide-y divide-line">
			{#each list as i (i.id)}
				{@const on = i.status === 'connected' || i.status === 'syncing'}
				<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
					<span class="font-medium">{i.name}</span>
					{#if i.status === 'error'}<Pill tone="neg">Error</Pill>{:else if on}<Pill tone="neutral">Sample</Pill>{/if}
					<span class="min-w-0 flex-1 text-caption text-ink-3">{on ? `${i.recordsSynced.toLocaleString('en-US')} sample records · ${i.readsPlain}` : i.readsPlain}</span>
					<button class="btn btn-quiet min-h-9 px-3 text-body-sm" disabled={busy === i.id} onclick={() => toggle(i.id, on)}>{on ? 'Turn off' : 'Turn on'}</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>
