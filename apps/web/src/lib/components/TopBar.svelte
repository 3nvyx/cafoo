<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { periodShort } from '#lib/data/derive.js';
	import { ui } from '#lib/ui.svelte.js';
	import Icon from './Icon.svelte';
	import ModeToggle from './ModeToggle.svelte';

	// mobileOnly: the Dashboard has its own period picker and close status, so on wide screens the bar goes.
	// Phones keep it, since it holds the only button that opens the navigation drawer.
	let { mobileOnly = false }: { mobileOnly?: boolean } = $props();

	const periods = $derived(db.periods());
	const conn = $derived(db.connection());
	const seat = $derived(db.cfoSeat());
	const statusWord = { open: 'Open', closing: 'Closing', closed: 'Locked' } as const;
	const current = $derived(periods.find((p) => p.id === ui.periodId));
</script>

<header class="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-canvas/95 px-4 backdrop-blur sm:gap-3 lg:px-6 {mobileOnly ? 'lg:hidden' : ''}">
	<button class="btn btn-quiet -ml-2 w-11 px-0 lg:hidden" aria-label="Open navigation" onclick={() => (ui.navOpenMobile = true)}>
		<Icon name="menu" />
	</button>

	<label class="relative flex items-center">
		<span class="sr-only">Period</span>
		<select class="field num appearance-none pr-8 text-sm" bind:value={ui.periodId}>
			{#each periods as p (p.id)}
				<option value={p.id}>{periodShort(p)}</option>
			{/each}
		</select>
		<Icon name="chevronDown" size={16} class="pointer-events-none absolute right-2.5 text-ink-3" />
	</label>

	{#if current}
		<span class="hidden text-sm text-ink-2 sm:inline">{statusWord[current.status]}</span>
	{/if}

	{#if conn.ledger !== 'demo'}
		<span class="hidden items-center gap-1.5 text-sm text-ink-3 md:inline-flex" title={conn.message ?? ''}>
			<span class="size-2 rounded-full {conn.ledger === 'live' ? 'bg-pos' : conn.ledger === 'connecting' ? 'bg-warn' : 'bg-neg'}"></span>
			{conn.ledger === 'live' ? 'Live' : conn.ledger === 'connecting' ? 'Connecting' : 'Offline'}
		</span>
		{#if seat.status === 'other' || seat.status === 'unclaimed'}
			<a href="/claim" class="hidden items-center gap-1.5 rounded-btn bg-warn-soft px-2 py-0.5 text-sm text-warn md:inline-flex" title={conn.message ?? ''}>
				{seat.status === 'other' ? 'CFO seat held by another browser' : 'Claim the CFO seat'}
			</a>
		{/if}
	{:else}
		<span class="hidden text-sm text-ink-3 md:inline">Demo mode</span>
	{/if}

	<div class="flex-1"></div>

	<ModeToggle />
</header>
