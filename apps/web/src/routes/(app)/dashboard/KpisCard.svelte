<script lang="ts" module>
	import type { Health } from '#lib/kpis.js';

	export interface KpiRow {
		label: string;
		value: string;
		health: Health;
		href: string;
	}
</script>

<script lang="ts">
	// The handful of figures a SaaS CFO checks every month, one row each: how long the cash lasts, whether revenue is
	// growing and staying, and whether small-business customers are paying. Metrics has the rest.
	let { rows }: { rows: KpiRow[] } = $props();

	const PILL: Record<Exclude<Health, null>, { text: string; cls: string }> = {
		good: { text: 'Good', cls: 'bg-pos-soft text-on-pos-soft' },
		watch: { text: 'Watch', cls: 'bg-warn-soft text-on-warn-soft' },
		poor: { text: 'At risk', cls: 'bg-neg-soft text-on-neg-soft' }
	};
</script>

<section aria-labelledby="kpis-h" class="card flex h-full flex-col gap-4 p-5">
	<div class="flex flex-wrap items-baseline justify-between gap-3">
		<h2 id="kpis-h" class="text-subtitle">KPIs</h2>
		<a href="/metrics" class="drill text-body-sm text-ink-2">All metrics</a>
	</div>
	<ul class="grid gap-x-8 sm:grid-cols-2">
		{#each rows as r (r.label)}
			<li class="border-t border-line">
				<a href={r.href} class="flex items-center justify-between gap-3 py-3 text-body-sm transition-colors hover:bg-subtle">
					<span class="text-ink-2">{r.label}</span>
					<span class="flex items-center gap-2">
						<span class="num font-medium text-ink">{r.value}</span>
						{#if r.health}<span class="rounded-sm px-1.5 py-0.5 text-caption font-medium {PILL[r.health].cls}">{PILL[r.health].text}</span>{/if}
					</span>
				</a>
			</li>
		{/each}
	</ul>
</section>
