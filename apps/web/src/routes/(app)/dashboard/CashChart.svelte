<script lang="ts">
	// Book cash at each month end, as a line. The axis spans the months' own range rather than starting at zero, so a
	// month's burn shows as a slope; the tick labels say where it starts. Hover a month to read it.
	import type { MonthPoint } from '#lib/data/dashboard.js';
	import { ymShort } from '#lib/data/derive.js';
	import { money, niceMax, tick } from './chart.js';

	let { points, selected }: { points: MonthPoint[]; selected: string[] } = $props();

	let w = $state(0);
	const H = 220, top = 12, bottom = 28, left = 52;

	const scale = $derived.by(() => {
		const vals = points.map((p) => p.cash);
		const lo = Math.min(...vals), hi = Math.max(...vals);
		const step = niceMax((hi - lo) / 2 || Math.abs(hi) / 20 || 1);
		const from = Math.floor(lo / step) * step;
		const to = Math.max(from + step, Math.ceil(hi / step) * step);
		const ticks: number[] = [];
		for (let t = from; t <= to + step / 2; t += step) ticks.push(t);
		return { from, to, ticks, step };
	});
	const band = $derived(Math.max(0, w - left) / Math.max(1, points.length));
	const x = (i: number) => left + i * band + band / 2;
	const y = (v: number) => top + (H - top - bottom) * (1 - (v - scale.from) / (scale.to - scale.from));
	const line = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.cash)}`).join(''));
	const on = (ym: string) => selected.includes(ym);
	// Month labels need about 64px; with less room, label every nth month, always including the last.
	const every = $derived(Math.max(1, Math.ceil(64 / Math.max(1, band))));
	const labelled = (i: number) => (points.length - 1 - i) % every === 0;

	let hover = $state<number | null>(null);
	const at = $derived(hover ?? points.findLastIndex((p) => on(p.ym)));
	const shown = $derived(points[at] ?? points.at(-1));
	const firstOn = $derived(points.findIndex((p) => on(p.ym)));
	const lastOn = $derived(points.findLastIndex((p) => on(p.ym)));
</script>

<div class="flex flex-col gap-3">
	{#if shown}
		<p class="text-caption text-ink-2" aria-live="polite">
			<span class="font-medium text-ink">End of {ymShort(shown.ym)}</span>
			<span class="num">· {money(shown.cash)}</span>
		</p>
	{/if}
	<div bind:clientWidth={w} class="min-h-55 w-full">
		{#if w > left}
		<svg width={w} height={H} role="img" aria-label="Book cash at each month end: {points.map((p) => `${ymShort(p.ym)} ${money(p.cash)}`).join(', ')}" onpointerleave={() => (hover = null)}>
			{#if firstOn >= 0}
				<rect x={left + firstOn * band + 2} y={top - 8} width={(lastOn - firstOn + 1) * band - 4} height={H - bottom - top + 8} rx="8" fill="var(--accent-soft)" />
			{/if}
			{#each scale.ticks as t (t)}
				<line x1={left} x2={w} y1={y(t)} y2={y(t)} stroke="var(--line)" />
				<text x={left - 8} y={y(t) + 4} text-anchor="end" font-size="12" fill="var(--ink-3)" class="num">{tick(t, scale.step)}</text>
			{/each}
			<path d={line} fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
			{#each points as p, i (p.ym)}
				<circle cx={x(i)} cy={y(p.cash)} r={i === at ? 5 : 4} fill={on(p.ym) ? 'var(--ink)' : 'var(--ink-3)'} stroke="var(--surface)" stroke-width="2" />
				{#if labelled(i)}<text x={x(i)} y={H - 8} text-anchor="middle" font-size="12" fill={on(p.ym) ? 'var(--ink)' : 'var(--ink-3)'}>{ymShort(p.ym)}</text>{/if}
				<rect x={left + i * band} y={top} width={band} height={H - top} fill="transparent" role="presentation" onpointerenter={() => (hover = i)} />
			{/each}
		</svg>
		{/if}
	</div>
</div>
