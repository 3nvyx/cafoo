<script lang="ts">
	// One KPI: its value, how healthy it reads against the usual yardstick, the inputs behind it, and optionally its
	// trend (a sparkline over the last months) and the formula it is computed with.
	import type { Health } from '#lib/kpis.js';

	let {
		label,
		value,
		health,
		yardstick,
		inputs,
		href,
		spark,
		sparkLabel,
		formula
	}: { label: string; value: string; health: Health; yardstick: string; inputs?: string; href?: string; spark?: string; sparkLabel?: string; formula?: string } = $props();

	const PILL: Record<Exclude<Health, null>, { text: string; cls: string }> = {
		good: { text: 'Healthy', cls: 'bg-pos-soft text-on-pos-soft' },
		watch: { text: 'Watch', cls: 'bg-warn-soft text-on-warn-soft' },
		poor: { text: 'Needs attention', cls: 'bg-neg-soft text-on-neg-soft' }
	};
</script>

<svelte:element this={href ? 'a' : 'div'} {href} class="card flex h-full flex-col gap-2 p-5 {href ? 'transition-colors hover:bg-subtle' : ''}">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<span class="text-body-sm text-ink-2">{label}</span>
		{#if health}<span class="rounded-sm px-1.5 py-0.5 text-caption font-medium {PILL[health].cls}">{PILL[health].text}</span>{/if}
	</div>
	<div class="flex items-end justify-between gap-3">
		<span class="text-display-sm font-medium text-ink">{value}</span>
		{#if spark}
			<svg class="h-8 w-24 shrink-0" viewBox="-2 -2 100 36" preserveAspectRatio="none" role="img" aria-label={sparkLabel ?? `${label} trend`}>
				<path d={spark} fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
			</svg>
		{/if}
	</div>
	{#if inputs}<span class="text-caption text-ink-2">{inputs}</span>{/if}
	<span class="mt-auto text-caption text-ink-3">{yardstick}</span>
	{#if formula}<span class="num text-caption text-ink-3">{formula}</span>{/if}
</svelte:element>
