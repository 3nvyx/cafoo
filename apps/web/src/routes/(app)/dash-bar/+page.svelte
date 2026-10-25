<script lang="ts">
	// The Dash bar: every table the books hold, as a dense read-only spreadsheet. Live mode reads the SpacetimeDB client
	// cache directly (every public table, mapped by the screens or not); Demo mode reads the in-browser tables.
	// The page holds the list of data sets; DataGrid draws the chosen one and is remounted per table. Nothing writes.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import Icon from '#lib/components/Icon.svelte';
	import DataGrid from './DataGrid.svelte';

	const sets = $derived(db.dataSets());
	const conn = $derived(db.connection());
	const live = db.kind === 'live';
	const loading = $derived(live && conn.ledger === 'connecting');
	const offline = $derived(live && conn.ledger === 'offline');

	// The open table lives in the URL (?set=), so a link or a reload lands on the same table.
	const requested = $derived(page.url.searchParams.get('set') ?? '');
	const current = $derived(sets.find((s) => s.id === requested) ?? sets[0]);

	function choose(id: string) {
		const url = new URL(page.url.href);
		url.searchParams.set('set', id);
		void goto(url, { replace: true, reset: false });
	}

	let setFilter = $state('');
	const visibleSets = $derived(setFilter.trim() ? sets.filter((s) => s.label.toLowerCase().includes(setFilter.trim().toLowerCase())) : sets);

	// Skeleton bar widths, from the spacing scale.
	const BARS = ['w-24', 'w-16', 'w-20', 'w-14', 'w-28', 'w-12', 'w-20'];
</script>

<svelte:head><title>Dash bar · Cafoo</title></svelte:head>

<div class="flex min-h-0 flex-1">
	<!-- Data sets: every table, with its row count. Phones choose from the select in the toolbar instead. -->
	<aside class="hidden w-60 shrink-0 flex-col border-r border-line md:flex" aria-label="Data sets">
		<div class="flex flex-col gap-2 px-3 pt-4 pb-2">
			<p class="px-2 text-caption font-medium text-ink-3">Data sets{sets.length ? ` · ${sets.length}` : ''}</p>
			<label class="relative block">
				<span class="sr-only">Find a data set</span>
				<span class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3"><Icon name="search" size={14} /></span>
				<input class="h-7 w-full rounded-md bg-subtle pr-2 pl-8 text-caption text-ink placeholder:text-ink-3" placeholder="Find a data set" bind:value={setFilter} />
			</label>
		</div>
		<ul class="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-3 pb-3">
			{#each visibleSets as s (s.id)}
				<li>
					<button
						type="button"
						class="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-body-sm transition-colors duration-150 {s.id === current?.id ? 'bg-subtle font-medium text-ink' : 'text-ink-2 hover:bg-subtle hover:text-ink'}"
						aria-current={s.id === current?.id ? 'true' : undefined}
						onclick={() => choose(s.id)}
					>
						<span class="min-w-0 flex-1 truncate">{s.label}</span>
						<span class="num text-caption text-ink-3">{s.count.toLocaleString('en-US')}</span>
					</button>
				</li>
			{:else}
				<li class="px-2 py-3 text-caption text-ink-3">{loading ? 'Connecting to the ledger database…' : sets.length ? 'No data set matches.' : 'No data sets yet.'}</li>
			{/each}
		</ul>
		<p class="border-t border-line px-5 py-3 text-caption text-ink-3">
			{live ? (conn.ledger === 'live' ? 'Live from SpacetimeDB' : offline ? 'SpacetimeDB is unreachable' : 'Connecting to SpacetimeDB') : 'Demo data in this browser'}
		</p>
	</aside>

	{#if loading}
		<div class="min-w-0 flex-1 animate-pulse" role="status" aria-label="Loading the data sets">
			<div class="flex h-12 items-center border-b border-line px-4"><span class="h-3 w-32 rounded-sm bg-subtle"></span></div>
			{#each Array.from({ length: 14 }, (_, i) => i) as i (i)}
				<div class="flex h-9 items-center gap-6 border-b border-line pl-16">
					{#each [0, 1, 2, 3, 4] as j (j)}<span class="h-3 rounded-sm bg-subtle {BARS[(i + j * 3) % BARS.length]}"></span>{/each}
				</div>
			{/each}
		</div>
	{:else if current}
		{#key current.id}
			<DataGrid set={current} {sets} {choose} {offline} />
		{/key}
	{:else}
		<div class="grid min-w-0 flex-1 place-items-center px-6 text-center">
			<div class="flex flex-col items-center gap-2">
				<Icon name="database" size={28} class="text-ink-3" />
				<h1 class="font-sans text-body-sm font-medium">{offline ? 'The ledger database is unreachable' : 'No data sets to show'}</h1>
				<p class="max-w-sm text-caption text-ink-3">{offline ? (conn.message ?? 'Check that SpacetimeDB is running, then reload.') : 'Tables appear here as soon as the source holds any.'}</p>
			</div>
		</div>
	{/if}
</div>
