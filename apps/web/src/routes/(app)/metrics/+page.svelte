<script lang="ts">
	// The numbers an AI startup is judged on, for the month picked in the sidebar, each against its usual yardstick.
	import { db } from '#lib/data/index.js';
	import { monthRange, postings, summarize } from '#lib/data/dashboard.js';
	import { periodLabel } from '#lib/data/derive.js';
	import { rootOf } from '#lib/data/group.js';
	import { aiTiles, efficiencyTiles, quarterStart, usdRate, type Tile } from '#lib/kpis.js';
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
	const ai = $derived(
		period && s
			? aiTiles({
					ym: period.id,
					revenueMinor: s.revenue,
					now: db.now(),
					cloudCosts: db.cloudCosts(),
					employees: db.employees(),
					batches: db.batches(),
					deals: db.deals(),
					tickets: db.supportTickets(),
					invoices: db.invoices(),
					contracts: db.contracts(),
					rate: usdRate(db.fxRates())
				})
			: null
	);
	const sections = $derived<{ id: string; title: string; note: string; tiles: Tile[] }[]>([
		{ id: 'eff', title: 'Efficiency', note: 'How much growth each dollar buys, and how long the money lasts.', tiles: efficiency },
		{ id: 'unit', title: 'AI unit economics', note: 'What it costs to serve a customer once models, cloud and on-call time are counted.', tiles: ai?.unit ?? [] },
		{ id: 'credits', title: 'Usage credits', note: 'Prepaid credits are owed to customers until used; expired ones become revenue.', tiles: ai?.credits ?? [] },
		{ id: 'market', title: 'Customers and pipeline', note: 'From the connected CRM, support and billing tools, live.', tiles: ai?.market ?? [] }
	]);
</script>

<svelte:head><title>Metrics · Cafoo</title></svelte:head>

{#if period && s}
	<header class="flex flex-col gap-1 pb-6">
		<p class="text-body-sm text-ink-2">{root?.name} · {periodLabel(period)}</p>
		<h1 class="text-display">Metrics</h1>
		<p class="max-w-prose text-body-sm text-ink-2">The numbers an AI startup is judged on, each read against the yardstick investors use. They move as the books, the team and the connected tools change.</p>
	</header>

	<div class="flex flex-col gap-12">
		{#each sections as sec (sec.id)}
			<section aria-labelledby="{sec.id}-h" class="flex flex-col gap-4">
				<div class="flex flex-col gap-1">
					<h2 id="{sec.id}-h" class="text-title">{sec.title}</h2>
					<p class="text-body-sm text-ink-2">{sec.note}</p>
				</div>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{#each sec.tiles as t (t.key)}
						<MetricTile label={t.label} value={t.value} health={t.health} inputs={t.inputs} yardstick={t.yardstick} href={t.href} />
					{/each}
				</div>
			</section>
		{/each}
	</div>
{/if}
