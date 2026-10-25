<script lang="ts">
	// Book cash at each month end, as a line (shadcn-svelte's chart on LayerChart). The axis spans the months' own range
	// rather than starting at zero, so a month's burn shows as a slope; the tick labels say where it starts.
	import { LineChart } from 'layerchart';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import type { MonthPoint } from '#lib/data/dashboard.js';
	import { ymShort } from '#lib/data/derive.js';
	import { money, niceMax, padMonths, tick } from './chart.js';

	let { points, selected }: { points: MonthPoint[]; selected: string[] } = $props();

	const config = { cash: { label: 'Book cash', color: 'var(--ink)' } } satisfies Chart.ChartConfig;

	const monthStart = (ym: string) => new Date(`${ym}-01T00:00:00Z`);
	const ymOf = (d: Date) => d.toISOString().slice(0, 7);
	const data = $derived(points.map((p) => ({ month: monthStart(p.ym), cash: p.cash })));

	const scale = $derived.by(() => {
		const vals = points.map((p) => p.cash);
		const lo = Math.min(...vals), hi = Math.max(...vals);
		const step = niceMax((hi - lo) / 2 || Math.abs(hi) / 20 || 1);
		const from = Math.floor(lo / step) * step;
		return { from, to: Math.max(from + step, Math.ceil(hi / step) * step), step };
	});

	const band = $derived.by(() => {
		const on = points.filter((p) => selected.includes(p.ym));
		if (!on.length) return [];
		const half = 15 * 86_400_000;
		return [{ type: 'range' as const, layer: 'below' as const, x: [new Date(monthStart(on[0].ym).getTime() - half), new Date(monthStart(on.at(-1)!.ym).getTime() + half)], fill: 'var(--accent-soft)' }];
	});
	const last = $derived(points.findLast((p) => selected.includes(p.ym)) ?? points.at(-1));
</script>

<div class="flex flex-col gap-3">
	{#if last}
		<p class="text-caption text-ink-2">
			<span class="font-medium text-ink">End of {ymShort(last.ym)}</span>
			<span class="num">· {money(last.cash)}</span>
		</p>
	{/if}
	<Chart.Container {config} class="h-56 w-full" role="img" aria-label="Book cash at each month end: {points.map((p) => `${ymShort(p.ym)} ${money(p.cash)}`).join(', ')}">
		<LineChart
			{data}
			x="month"
			xDomain={padMonths(points.map((p) => p.ym))}
			yDomain={[scale.from, scale.to]}
			axis
			annotations={band}
			series={[{ key: 'cash', label: 'Book cash', color: 'var(--color-cash)' }]}
			props={{
				spline: { strokeWidth: 2 },
				xAxis: { format: (d: Date) => ymShort(ymOf(d)), ticks: Math.min(data.length, 6) },
				yAxis: { format: (v: number) => tick(v, scale.step), ticks: 3 },
				highlight: { points: { r: 4 } }
			}}
			points={{ r: 3.5 }}
		>
			{#snippet tooltip()}
				<Chart.Tooltip labelFormatter={(d: Date) => `End of ${ymShort(ymOf(d))}`} hideIndicator>
					{#snippet formatter({ value, name })}
						<span class="flex flex-1 items-center justify-between gap-4">
							<span class="text-ink-2">{name}</span>
							<span class="num font-medium text-ink">{money(Number(value))}</span>
						</span>
					{/snippet}
				</Chart.Tooltip>
			{/snippet}
		</LineChart>
	</Chart.Container>
</div>
