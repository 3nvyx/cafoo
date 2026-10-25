<script lang="ts">
	// The numbers an AI startup is judged on, for the month picked in the sidebar, each against its usual yardstick.
	import { db } from '#lib/data/index.js';
	import { monthRange, postings, summarize } from '#lib/data/dashboard.js';
	import { periodLabel } from '#lib/data/derive.js';
	import { rootOf } from '#lib/data/group.js';
	import { efficiencyTiles, quarterStart } from '#lib/kpis.js';
	import { ui } from '#lib/ui.svelte.js';
	import MetricTile from './MetricTile.svelte';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId) ?? db.periods().at(-1));
	const root = $derived(rootOf(db.subsidiaries()));
	const ps = $derived(root ? postings(db.accounts().filter((a) => a.subsidiaryId === root.id), db.journalEntries(), db.journalLines()) : []);
	const range = $derived(period ? monthRange(period.id) : null);
	const s = $derived(range ? summarize(ps, db.contracts(), range) : null);
	const first = $derived(db.periods()[0]?.id);
	const efficiency = $derived(
		range && s && first
			? efficiencyTiles({ month: s, from: range.from, to: range.to, quarterFrom: quarterStart(range.from, monthRange(first).from), contracts: db.contracts(), employees: db.employees() })
			: []
	);
</script>

<svelte:head><title>Metrics · Cafoo</title></svelte:head>

{#if period && s}
	<header class="flex flex-col gap-1 pb-6">
		<p class="text-body-sm text-ink-2">{root?.name} · {periodLabel(period)}</p>
		<h1 class="text-display">Metrics</h1>
		<p class="max-w-prose text-body-sm text-ink-2">The numbers an AI startup is judged on, each read against the yardstick investors use. They move as the books, the team and the connected tools change.</p>
	</header>

	<section aria-labelledby="eff-h" class="flex flex-col gap-4">
		<h2 id="eff-h" class="text-title">Efficiency</h2>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{#each efficiency as t (t.key)}
				<MetricTile label={t.label} value={t.value} health={t.health} inputs={t.inputs} yardstick={t.yardstick} href={t.href} />
			{/each}
		</div>
	</section>
{/if}
