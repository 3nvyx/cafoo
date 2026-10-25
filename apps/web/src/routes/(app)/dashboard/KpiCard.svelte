<script lang="ts" module>
	export interface Delta {
		text: string;
		/** +1 rose, -1 fell, 0 unchanged. */
		dir: 1 | -1 | 0;
		/** Whether the move is good news; null when it is neither (receivables, payables). */
		good: boolean | null;
		/** What it is compared with ("vs Aug 2026"). */
		against: string;
	}
</script>

<script lang="ts">
	// One figure for the selected range: label, value, the change against the range before, a one-line note, and a
	// sparkline of the same figure by month with the selected months marked.
	import Icon from '#lib/components/Icon.svelte';

	let {
		label,
		value,
		hint,
		href,
		delta,
		spark
	}: {
		label: string;
		value: string;
		hint?: string;
		href?: string;
		/** Undefined shows nothing; null says there is nothing earlier to compare with. */
		delta?: Delta | null;
		spark?: { values: number[]; on: boolean[] };
	} = $props();

	let w = $state(0);
	const H = 32;
	const sx = (i: number, n: number) => (n <= 1 ? w / 2 : 3 + (i * (w - 6)) / (n - 1));
	const sy = (v: number, lo: number, hi: number) => (hi === lo ? H / 2 : 4 + (H - 8) * (1 - (v - lo) / (hi - lo)));
	const path = $derived.by(() => {
		if (!spark || spark.values.length < 2) return '';
		const lo = Math.min(...spark.values), hi = Math.max(...spark.values);
		return spark.values.map((v, i) => `${i ? 'L' : 'M'}${sx(i, spark.values.length)},${sy(v, lo, hi)}`).join('');
	});
	const dots = $derived.by(() => {
		if (!spark) return [];
		const lo = Math.min(...spark.values), hi = Math.max(...spark.values);
		return spark.values.map((v, i) => ({ x: sx(i, spark.values.length), y: sy(v, lo, hi), on: spark.on[i] })).filter((d) => d.on);
	});

	const tone = $derived(!delta || delta.dir === 0 || delta.good === null ? 'bg-subtle text-on-subtle' : delta.good ? 'bg-pos-soft text-on-pos-soft' : 'bg-neg-soft text-on-neg-soft');
</script>

<svelte:element this={href ? 'a' : 'div'} {href} class="card group flex flex-col gap-2 p-5 {href ? 'transition-colors hover:bg-subtle' : ''}">
	<span class="text-body-sm text-ink-2">{label}</span>
	<span class="text-display-sm font-medium text-ink {href ? 'group-hover:text-accent-ink' : ''}">{value}</span>
	<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
		{#if delta}
			<span class="inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 font-medium {tone}">
				{#if delta.dir !== 0}<Icon name={delta.dir > 0 ? 'arrowUp' : 'arrowDown'} size={12} />{/if}
				<span class="num">{delta.text}</span>
			</span>
			<span class="text-ink-3">{delta.against}</span>
		{:else if delta === null}
			<span class="text-ink-3">No earlier figures to compare</span>
		{/if}
	</span>
	{#if spark && spark.values.length > 1}
		<div bind:clientWidth={w} class="mt-1 min-h-8 w-full" aria-hidden="true">
			{#if w > 0}<svg width={w} height={H}>
				<path d={path} fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
				{#each dots as d, i (i)}
					<circle cx={d.x} cy={d.y} r="3.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" />
				{/each}
			</svg>{/if}
		</div>
	{/if}
	{#if hint}<span class="mt-auto text-caption text-ink-3">{hint}</span>{/if}
</svelte:element>
