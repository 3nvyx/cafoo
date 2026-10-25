<script lang="ts">
	// Material 3 top app bar: the Period, where the books stand, search, theme and the Simple/Expert switch.
	import { db } from '#lib/data/index.js';
	import { periodShort } from '#lib/data/derive.js';
	import { ui } from '#lib/ui.svelte.js';
	import Icon from './Icon.svelte';
	import ModeToggle from './ModeToggle.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import Wordmark from './Wordmark.svelte';

	let { canCollapse = false }: { canCollapse?: boolean } = $props();

	const periods = $derived(db.periods());
	const conn = $derived(db.connection());
	const seat = $derived(db.cfoSeat());
	const statusWord = { open: 'Open', closing: 'Closing', closed: 'Locked' } as const;
	const current = $derived(periods.find((p) => p.id === ui.periodId));
	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
</script>

<header class="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-surface/90 px-4 backdrop-blur-md sm:gap-3 lg:px-8">
	<div class="-ml-1 md:hidden"><Wordmark compact href="/dashboard" /></div>
	{#if canCollapse}
		<button class="btn btn-quiet btn-icon -ml-2" aria-label={ui.navCollapsed ? 'Expand navigation' : 'Collapse navigation'} onclick={() => ui.toggleNav()}>
			<Icon name="panel" />
		</button>
	{/if}

	<label class="relative flex items-center">
		<span class="sr-only">Period</span>
		<select class="field num h-10 min-h-10 appearance-none rounded-full pr-9 pl-4 text-sm font-medium" bind:value={ui.periodId}>
			{#each periods as p (p.id)}
				<option value={p.id}>{periodShort(p)}</option>
			{/each}
		</select>
		<Icon name="chevronDown" size={16} class="pointer-events-none absolute right-3 text-ink-3" />
	</label>

	{#if current}
		<span class="hidden items-center gap-1.5 text-sm font-medium text-ink-2 sm:inline-flex">
			{#if current.status === 'closed'}<Icon name="lock" size={15} />{/if}{statusWord[current.status]}
		</span>
	{/if}

	{#if conn.ledger !== 'demo'}
		<span class="hidden items-center gap-1.5 text-sm text-ink-3 md:inline-flex" title={conn.message ?? ''}>
			<span class="size-2 rounded-full {conn.ledger === 'live' ? 'bg-pos' : conn.ledger === 'connecting' ? 'bg-warn' : 'bg-neg'}"></span>
			{conn.ledger === 'live' ? 'Live' : conn.ledger === 'connecting' ? 'Connecting' : 'Offline'}
		</span>
		{#if conn.ledger === 'live' && seat.status !== 'checking'}
			<span
				class="hidden h-7 items-center rounded-[8px] px-2.5 text-[13px] font-semibold lg:inline-flex {seat.status === 'you'
					? 'bg-secondary-container text-on-secondary-container'
					: 'bg-warning-container text-on-warning-container'}"
				title={seat.status === 'you' ? 'This browser holds the CFO seat.' : 'This browser does not hold the CFO seat.'}>{seat.status === 'you' ? 'CFO' : 'Read-only'}</span
			>
		{/if}
	{:else}
		<span class="hidden text-sm text-ink-3 md:inline">Demo mode</span>
	{/if}

	<div class="flex-1"></div>

	<button class="btn btn-quiet hidden min-h-10 px-3 sm:inline-flex" onclick={() => (ui.paletteOpen = true)} aria-label="Search (Command K)">
		<Icon name="search" size={18} />
		<span class="hidden text-sm lg:inline">Search</span>
		<kbd class="kbd hidden lg:inline-block">{isMac ? '⌘' : 'Ctrl'} K</kbd>
	</button>
	<div class="hidden sm:block"><ThemeToggle variant="icon" /></div>
	<ModeToggle />
</header>
