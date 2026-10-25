<script lang="ts">
	// One data set as a dense read-only spreadsheet: toolbar, grid and the row sheet. The page mounts a fresh copy per
	// table ({#key}), so the search, the sort, the hidden columns and the open row always start clean.
	import { tick } from 'svelte';
	import { db, type DataSet } from '#lib/data/index.js';
	import { cell, columnLabel, columnsOf, compareCells, type Cell } from '#lib/data/cell.js';
	import ExportMenu from '#lib/components/ExportMenu.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { gridCell, type ExportTable } from '#lib/export.js';
	import { isTyping, ui } from '#lib/ui.svelte.js';

	let { set, sets, choose, offline = false }: { set: DataSet; sets: DataSet[]; choose: (id: string) => void; offline?: boolean } = $props();

	const PAGE = 50;
	const RIGHT: Cell['kind'][] = ['number', 'money'];

	const rows = $derived(db.dataSetRows(set.id));
	const columns = $derived(columnsOf(rows));

	// Live rows are replaced, never edited, when SpacetimeDB updates them, so a row object's cells can be kept.
	// Demo rows are edited in place, so they are formatted afresh (the demo tables are small).
	const cache = new WeakMap<object, Record<string, Cell>>();
	function cellsOf(row: Record<string, unknown>, cols: string[]): Record<string, Cell> {
		const hit = db.kind === 'live' ? cache.get(row) : undefined;
		if (hit) return hit;
		const made = Object.fromEntries(cols.map((c) => [c, cell(row[c], c, row)]));
		if (db.kind === 'live') cache.set(row, made);
		return made;
	}

	// A row's identity is its primary key when it has an id, so live inserts and deletes never swap the open row.
	function keyOf(row: Record<string, unknown>, index: number): string {
		const id = row.id;
		return id === undefined || id === null ? `#${index}` : typeof id === 'bigint' ? `id:${id}` : `id:${String(id)}`;
	}
	const table = $derived(rows.map((row, index) => ({ key: keyOf(row, index), index, row, cells: cellsOf(row, columns) })));

	let hidden = $state<string[]>([]);
	const visibleColumns = $derived(columns.filter((c) => !hidden.includes(c)));

	// The search waits for a pause in typing, then looks through the visible columns only.
	let query = $state('');
	let term = $state('');
	$effect(() => {
		const q = query.trim().toLowerCase();
		const t = setTimeout(() => (term = q), q ? 120 : 0);
		return () => clearTimeout(t);
	});

	let sort = $state<{ key: string; dir: 1 | -1 } | null>(null);
	function cycleSort(key: string) {
		if (!sort || sort.key !== key) sort = { key, dir: 1 };
		else if (sort.dir === 1) sort = { key, dir: -1 };
		else sort = null;
	}

	const filtered = $derived.by(() => {
		const hits = term ? table.filter((r) => visibleColumns.some((c) => r.cells[c].text.toLowerCase().includes(term) || r.cells[c].full.toLowerCase().includes(term))) : table;
		if (!sort || !columns.includes(sort.key)) return hits;
		const { key, dir } = sort;
		return [...hits].sort((a, b) => {
			const x = a.cells[key];
			const y = b.cells[key];
			// Empty cells stay at the bottom in both directions.
			if (x.kind === 'empty' || y.kind === 'empty') return x.kind === y.kind ? a.index - b.index : x.kind === 'empty' ? 1 : -1;
			return dir * compareCells(x, y) || a.index - b.index;
		});
	});

	// A column is right-aligned when all its values are numbers.
	const align = $derived(
		Object.fromEntries(
			columns.map((c) => [c, table.some((r) => RIGHT.includes(r.cells[c].kind)) && table.every((r) => r.cells[c].kind === 'empty' || RIGHT.includes(r.cells[c].kind))])
		) as Record<string, boolean>
	);

	// Rows appear fifty at a time as the bottom of the grid comes near; a new search or sort starts from the top.
	let shown = $state(PAGE);
	const listed = $derived(filtered.slice(0, shown));
	let scroller: HTMLDivElement | undefined = $state();
	let sentinel: HTMLDivElement | undefined = $state();
	$effect(() => {
		void term;
		void sort;
		shown = PAGE;
		scroller?.scrollTo({ top: 0 });
	});
	function near() {
		if (!scroller || !sentinel) return false;
		return sentinel.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom < 400;
	}
	function grow() {
		if (shown >= filtered.length) return;
		shown += PAGE;
		// A tall window can still show the sentinel after one step; keep going until it is out of reach.
		requestAnimationFrame(() => {
			if (near()) grow();
		});
	}
	$effect(() => {
		if (!scroller || !sentinel) return;
		const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && grow(), { root: scroller, rootMargin: '400px' });
		io.observe(sentinel);
		return () => io.disconnect();
	});

	// The row sheet: a native modal dialog, so focus stays inside it and Escape closes it.
	let openKey = $state<string | null>(null);
	const openPos = $derived(openKey === null ? -1 : filtered.findIndex((r) => r.key === openKey));
	const openRow = $derived(openPos >= 0 ? filtered[openPos] : undefined);
	let dialog: HTMLDialogElement | undefined = $state();
	let opener: HTMLElement | null = null;

	async function openSheet(key: string, from: HTMLElement) {
		// Return focus to the row's own button, however the row was opened.
		opener = (from.closest('tr')?.querySelector('button') as HTMLElement | null) ?? from;
		openKey = key;
		await tick();
		if (dialog && !dialog.open) dialog.showModal();
	}
	// The open row can leave the list (a search, a live delete): close the sheet rather than show another row.
	$effect(() => {
		if (openKey !== null && openPos < 0) dialog?.close();
	});
	function onclose() {
		openKey = null;
		opener?.focus();
		opener = null;
	}
	function step(by: 1 | -1) {
		if (openPos < 0) return;
		const next = filtered[openPos + by];
		if (next) openKey = next.key;
	}

	// The columns menu is a <details>: Escape, a click outside or tabbing out of it closes it.
	let columnsMenu: HTMLDetailsElement | undefined = $state();
	function onpointerdown(e: PointerEvent) {
		if (columnsMenu?.open && !columnsMenu.contains(e.target as Node)) columnsMenu.open = false;
	}
	function onkey(e: KeyboardEvent) {
		if (e.key === 'Escape' && columnsMenu?.open) {
			columnsMenu.open = false;
			columnsMenu.querySelector('summary')?.focus();
			return;
		}
		// Arrow keys and J/K walk the rows while the sheet is open, never while typing or with a modifier held.
		if (!openRow || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || ui.paletteOpen || isTyping(e)) return;
		if (e.key === 'ArrowDown' || e.key === 'j') {
			e.preventDefault();
			step(1);
		} else if (e.key === 'ArrowUp' || e.key === 'k') {
			e.preventDefault();
			step(-1);
		}
	}

	let searchEl: HTMLInputElement | undefined = $state();
	const n = (x: number) => x.toLocaleString('en-US');
	const countText = $derived(term ? `${n(filtered.length)} of ${n(rows.length)} rows` : `${n(rows.length)} row${rows.length === 1 ? '' : 's'}`);
	// Export what the grid shows: the visible columns, the rows the search keeps, in the current sort (every row, not
	// only the ones scrolled into view).
	const exportTables = (): ExportTable[] => [
		{ title: set.label, header: visibleColumns.map(columnLabel), rows: filtered.map((r) => visibleColumns.map((c) => gridCell(r.cells[c]))) }
	];
	const idCell = $derived(openRow && columns.includes('id') ? openRow.cells.id : undefined);
</script>

<svelte:window onkeydown={onkey} {onpointerdown} />

<section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-labelledby="dash-bar-h">
	<!-- Toolbar. It wraps by the space it has, not the window: with the sidebar open the middle is narrow. -->
	<div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2">
		<h1 id="dash-bar-h" class="flex min-w-0 items-baseline gap-2 font-sans text-body font-medium">
			<span>Dash bar</span><span class="text-ink-3" aria-hidden="true">/</span><span class="truncate text-ink-2">{set.label}</span>
		</h1>
		<label class="md:hidden">
			<span class="sr-only">Data set</span>
			<select class="field h-8 min-h-8 text-body-sm" value={set.id} onchange={(e) => choose((e.currentTarget as HTMLSelectElement).value)}>
				{#each sets as s (s.id)}<option value={s.id}>{s.label} · {s.count}</option>{/each}
			</select>
		</label>
		<div class="flex min-w-56 flex-1 basis-64 justify-center">
			<label class="relative block w-full max-w-sm">
				<span class="sr-only">Search the visible columns of {set.label}</span>
				<span class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3"><Icon name="search" size={14} /></span>
				<input
					bind:this={searchEl}
					class="h-7 w-full rounded-md bg-subtle pr-8 pl-8 text-caption text-ink placeholder:text-ink-3"
					placeholder={hidden.length ? 'Search the visible columns' : 'Search every column'}
					bind:value={query}
					onkeydown={(e) => {
						if (e.key === 'Escape' && query) {
							e.stopPropagation();
							query = '';
						}
					}}
				/>
				{#if query}
					<button
						type="button"
						class="absolute top-1/2 right-0.5 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-ink-3 hover:bg-line hover:text-ink"
						aria-label="Clear search"
						onclick={() => {
							query = '';
							searchEl?.focus();
						}}><Icon name="x" size={14} /></button
					>
				{/if}
			</label>
		</div>
		<div class="ml-auto flex shrink-0 items-center gap-1">
			{#if offline}<span class="mr-2 rounded-sm bg-warn-soft px-1.5 text-caption text-on-warn-soft">Offline · last rows received</span>{/if}
			<span class="num mr-2 text-caption text-ink-3" aria-live="polite">{countText}</span>
			{#if columns.length}
				<ExportMenu tables={exportTables} title="{set.label} {new Date().toISOString().slice(0, 10)}" compact />
				<details
					class="relative"
					bind:this={columnsMenu}
					onfocusout={(e) => {
						if (columnsMenu?.open && !columnsMenu.contains(e.relatedTarget as Node | null)) columnsMenu.open = false;
					}}
				>
					<summary class="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 text-caption font-medium text-ink-2 hover:bg-subtle hover:text-ink [&::-webkit-details-marker]:hidden">
						<Icon name="sliders" size={14} />{hidden.length ? `${hidden.length} hidden` : 'Columns'}
					</summary>
					<div class="absolute right-0 z-40 mt-1 flex max-h-96 w-64 flex-col overflow-hidden rounded-md border border-line bg-surface">
						<div class="flex items-center justify-between border-b border-line px-3 py-2 text-caption text-ink-3">
							<span>{visibleColumns.length} of {columns.length} shown</span>
							<button type="button" class="font-medium text-ink-2 hover:text-ink disabled:opacity-50" disabled={!hidden.length} onclick={() => (hidden = [])}>Show all</button>
						</div>
						<ul class="overflow-y-auto py-1">
							{#each columns as c (c)}
								<li>
									<label class="flex min-h-8 cursor-pointer items-center gap-2 px-3 text-body-sm text-ink-2 hover:bg-subtle hover:text-ink">
										<input
											type="checkbox"
											class="size-3.5 accent-ink"
											checked={!hidden.includes(c)}
											disabled={!hidden.includes(c) && visibleColumns.length === 1}
											onchange={(e) => (hidden = (e.currentTarget as HTMLInputElement).checked ? hidden.filter((h) => h !== c) : [...hidden, c])}
										/>
										<span class="truncate">{columnLabel(c)}</span>
									</label>
								</li>
							{/each}
						</ul>
					</div>
				</details>
			{/if}
		</div>
	</div>

	<!-- The grid scrolls both ways inside this box, so the header row and the row numbers stay put. -->
	<div bind:this={scroller} class="relative min-h-0 flex-1 overflow-auto">
		<table class="w-full border-separate border-spacing-0 text-caption">
			<thead>
				<tr>
					<th scope="col" class="sticky top-0 left-0 z-30 w-12 min-w-12 border-r border-b border-line bg-canvas"><span class="sr-only">Position</span></th>
					{#each visibleColumns as c (c)}
						<th scope="col" class="sticky top-0 z-20 border-b border-line bg-canvas p-0 font-medium whitespace-nowrap text-ink-3" aria-sort={sort?.key === c ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
							<button
								type="button"
								class="group flex h-9 w-full min-w-24 items-center gap-1.5 px-3 text-left hover:bg-subtle hover:text-ink {align[c] ? 'flex-row-reverse text-right' : ''}"
								title={sort?.key === c ? (sort.dir === 1 ? 'Sorted ascending; click for descending' : 'Sorted descending; click to clear') : `Sort by ${columnLabel(c)}`}
								onclick={() => cycleSort(c)}
							>
								<span class="min-w-0 truncate">{columnLabel(c)}</span>
								<span class="shrink-0 {sort?.key === c ? 'text-ink' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}" aria-hidden="true">
									<Icon name={sort?.key === c && sort.dir === -1 ? 'arrowDown' : 'arrowUp'} size={12} />
								</span>
							</button>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each listed as r, pos (r.key)}
					{@const open = r.key === openKey}
					<tr class="group/row {open ? 'bg-accent-soft text-on-accent-soft' : ''}">
						<td class="sticky left-0 z-10 border-r border-b border-line p-0 {open ? 'bg-accent-soft' : 'bg-canvas'}">
							<button type="button" class="num flex h-9 w-12 items-center justify-end gap-1 pr-3 {open ? '' : 'text-ink-3'} group-hover/row:text-ink" aria-label="Open row {pos + 1}" onclick={(e) => openSheet(r.key, e.currentTarget)}>
								<span class="hidden group-hover/row:inline" aria-hidden="true"><Icon name="panel" size={12} /></span>
								<span class="group-hover/row:hidden">{pos + 1}</span>
							</button>
						</td>
						{#each visibleColumns as c (c)}
							{@const v = r.cells[c]}
							<td
								class="h-9 max-w-80 cursor-pointer border-r border-b border-line px-3 last:border-r-0 hover:outline-2 hover:-outline-offset-2 hover:outline-line-strong {align[c] ? 'num text-right' : ''}"
								title={v.full || (v.text.length > 40 ? v.text : undefined)}
								onclick={(e) => openSheet(r.key, e.currentTarget)}
							>
								{#if v.kind === 'enum'}
									<span class="inline-flex h-5 items-center rounded-sm bg-subtle px-1.5 whitespace-nowrap text-on-subtle">{v.text}</span>
								{:else if v.kind === 'bool'}
									<span class={v.text === 'Yes' || open ? '' : 'text-ink-3'}>{v.text}</span>
								{:else if v.kind === 'date' || v.kind === 'id'}
									<span class="num whitespace-nowrap {open ? '' : 'text-ink-2'}">{v.text}</span>
								{:else if v.kind === 'json'}
									<span class="block truncate font-mono {open ? '' : 'text-ink-2'}">{v.text}</span>
								{:else}
									<span class="block truncate">{v.text}</span>
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>

		{#if !rows.length}
			<div class="flex h-64 flex-col items-center justify-center gap-1 text-center">
				<p class="text-body-sm font-medium">{set.label} has no rows</p>
				<p class="text-caption text-ink-3">Rows appear here the moment the source writes them.</p>
			</div>
		{:else if !filtered.length}
			<div class="flex h-64 flex-col items-center justify-center gap-2 text-center">
				<Icon name="search" size={24} class="text-ink-3" />
				<p class="text-body-sm font-medium">No rows match “{query.trim()}”</p>
				<p class="text-caption text-ink-3">The search looks through the {hidden.length ? 'visible ' : ''}columns of {set.label}.</p>
				<button type="button" class="btn mt-1 min-h-8 px-3 text-caption" onclick={() => (query = '')}>Clear search</button>
			</div>
		{:else if shown < filtered.length}
			<div bind:this={sentinel} class="py-4 text-center text-caption text-ink-3">Showing {n(shown)} of {n(filtered.length)}…</div>
		{/if}
	</div>
</section>

<!-- Row sheet: every field of one row. Escape or the backdrop closes it; arrow keys or J and K walk the rows. -->
<dialog
	bind:this={dialog}
	{onclose}
	onclick={(e) => e.target === dialog && dialog?.close()}
	aria-labelledby="row-sheet-h"
	class="sheet fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-xl border-0 border-l border-line bg-surface p-0 text-ink"
>
	{#if openRow}
		<div class="flex h-full flex-col">
			<header class="flex items-center gap-1 border-b border-line px-6 py-4">
				<div class="min-w-0 flex-1">
					<p class="text-caption text-ink-3">{set.label}</p>
					<h2 id="row-sheet-h" class="truncate font-sans text-subtitle font-medium">{idCell && idCell.kind !== 'empty' ? idCell.text : `Row ${openPos + 1}`}</h2>
				</div>
				<span class="num mr-1 text-caption text-ink-3">{openPos + 1} of {n(filtered.length)}</span>
				<button type="button" class="btn btn-quiet min-h-11 w-11 px-0 lg:min-h-9 lg:w-9" aria-label="Previous row" disabled={openPos <= 0} onclick={() => step(-1)}><Icon name="arrowUp" size={16} /></button>
				<button type="button" class="btn btn-quiet min-h-11 w-11 px-0 lg:min-h-9 lg:w-9" aria-label="Next row" disabled={openPos >= filtered.length - 1} onclick={() => step(1)}><Icon name="arrowDown" size={16} /></button>
				<button type="button" class="btn btn-quiet min-h-11 w-11 px-0 lg:min-h-9 lg:w-9" aria-label="Close" onclick={() => dialog?.close()}><Icon name="x" size={16} /></button>
			</header>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<dl class="flex-1 overflow-y-auto px-6 py-4" tabindex="0" aria-label="Fields of this row">
				{#each columns as c (c)}
					{@const v = openRow.cells[c]}
					<div class="grid gap-1 border-b border-line py-3 last:border-b-0 sm:grid-cols-3 sm:gap-4">
						<dt class="text-caption font-medium text-ink-3">{columnLabel(c)}</dt>
						<dd class="min-w-0 text-body-sm break-words sm:col-span-2">
							{#if v.kind === 'empty'}
								<span class="text-ink-3">Empty</span>
							{:else if v.kind === 'json' && v.full}
								<pre class="overflow-x-auto rounded-md bg-subtle p-3 font-mono text-caption whitespace-pre-wrap">{v.full}</pre>
							{:else if v.kind === 'enum'}
								<span class="inline-flex h-5 items-center rounded-sm bg-subtle px-1.5 text-caption text-on-subtle">{v.text}</span>
							{:else}
								<span class={RIGHT.includes(v.kind) || v.kind === 'id' || v.kind === 'date' ? 'num' : ''}>{v.text}</span>
								{#if v.full && v.full !== v.text}<span class="num mt-0.5 block text-caption break-all text-ink-3">{v.full}</span>{/if}
							{/if}
						</dd>
					</div>
				{/each}
			</dl>
		</div>
	{/if}
</dialog>

<style>
	/* The sheet slides in from the right; app.css turns motion off for people who ask for less. */
	.sheet[open] {
		animation: sheet-in 200ms ease-out;
	}
	@keyframes sheet-in {
		from {
			transform: translateX(40px);
			opacity: 0;
		}
	}
</style>
