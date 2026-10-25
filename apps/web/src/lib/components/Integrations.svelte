<script lang="ts">
	// The tools an area reads from: connect or disconnect each one, and see when it last sent something. Connected tools
	// keep streaming in Demo mode, so "Updated 4s ago" moves on its own.
	import { onMount } from 'svelte';
	import { db } from '#lib/data/index.js';
	import type { IntegrationCategory } from '#lib/data/types.js';
	import { attempt } from '#lib/toast.svelte.js';
	import Pill from './Pill.svelte';

	let { categories, title = 'Connected tools' }: { categories: IntegrationCategory[]; title?: string } = $props();

	const list = $derived(db.integrations().filter((i) => categories.includes(i.category)));

	// A clock for the "ago" labels, so they count up between syncs.
	let clock = $state(Date.parse(db.now()));
	onMount(() => {
		const t = setInterval(() => (clock = Date.parse(db.now())), 1000);
		return () => clearInterval(t);
	});
	function ago(iso?: string): string {
		if (!iso) return 'Never synced';
		const s = Math.max(0, Math.round((clock - Date.parse(iso)) / 1000));
		if (s < 60) return `Updated ${s}s ago`;
		const m = Math.round(s / 60);
		return m < 60 ? `Updated ${m} min ago` : `Updated ${Math.round(m / 60)} h ago`;
	}

	let busy = $state<string | null>(null);
	async function toggle(id: string, connected: boolean) {
		busy = id;
		await attempt(() => (connected ? db.disconnectIntegration(id) : db.connectIntegration(id)), connected ? 'Disconnected.' : 'Connected. Syncing now.');
		busy = null;
	}
</script>

<section class="card flex flex-col gap-3 p-5" aria-label={title}>
	<h2 class="text-subtitle">{title}</h2>
	{#if !list.length}
		<p class="text-body-sm text-ink-3">No tools for this area yet.</p>
	{:else}
		<ul class="flex flex-col divide-y divide-line">
			{#each list as i (i.id)}
				{@const on = i.status === 'connected' || i.status === 'syncing'}
				<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
					<span class="font-medium">{i.name}</span>
					{#if i.status === 'syncing'}<Pill tone="neutral">Syncing</Pill>{:else if i.status === 'error'}<Pill tone="neg">Error</Pill>{:else if on}<Pill tone="pos">Connected</Pill>{/if}
					<span class="min-w-0 flex-1 text-caption text-ink-3">{on ? `${ago(i.lastSyncAt)} · ${i.recordsSynced} records` : i.readsPlain}</span>
					<button class="btn btn-quiet min-h-9 px-3 text-body-sm" disabled={busy === i.id} onclick={() => toggle(i.id, on)}>{on ? 'Disconnect' : 'Connect'}</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>
