<script lang="ts">
	// "Updated 4s ago": the latest record any of these connected tools sent, counting up between syncs.
	import { onMount } from 'svelte';
	import { db } from '#lib/data/index.js';

	let { ids, label = 'Live' }: { ids: string[]; label?: string } = $props();

	let clock = $state(Date.parse(db.now()));
	onMount(() => {
		const t = setInterval(() => (clock = Date.parse(db.now())), 1000);
		return () => clearInterval(t);
	});

	const tools = $derived(db.integrations().filter((i) => ids.includes(i.id)));
	const live = $derived(tools.filter((i) => i.status === 'connected'));
	const last = $derived(live.map((i) => i.lastSyncAt ?? '').sort().at(-1));
	const text = $derived.by(() => {
		if (!live.length) return tools.length ? 'Not connected: showing the last records read' : 'No tools connected';
		if (!last) return 'Waiting for the first sync';
		const s = Math.max(0, Math.round((clock - Date.parse(last)) / 1000));
		return s < 60 ? `Updated ${s}s ago` : s < 3600 ? `Updated ${Math.round(s / 60)} min ago` : `Updated ${Math.round(s / 3600)} h ago`;
	});
</script>

<p class="flex flex-wrap items-center gap-2 text-caption text-ink-3" aria-live="off">
	{#if live.length}
		<span class="inline-flex items-center gap-1.5 rounded-sm bg-pos-soft px-2 py-0.5 font-semibold text-on-pos-soft">
			<span class="size-1.5 rounded-full bg-pos" aria-hidden="true"></span>{label}
		</span>
	{/if}
	<span>{text}{live.length ? ` · from ${live.map((i) => i.name).join(', ')}` : ''}</span>
</p>
