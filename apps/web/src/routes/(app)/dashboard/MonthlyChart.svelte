<script lang="ts">
	// Revenue and expenses as two lines across every month on the books (shadcn-svelte's chart on LayerChart). The
	// months the range covers sit on the selection band; hover or tap a month to read it; the table holds every figure.
	import { LineChart } from 'layerchart';
	import { db } from '#lib/data/index.js';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import type { MonthPoint } from '#lib/data/dashboard.js';
	import { ymShort } from '#lib/data/derive.js';
	import { money, padMonths, tick } from './chart.js';

	let { points, selected }: { points: MonthPoint[]; selected: string[] } = $props();

	// Revenue solid in ink, expenses dashed in the quieter ink: told apart by weight and dash, not by colour, and never
	// in the accent (reserved for actions) or a status colour (they are not good or bad news on their own).
	const config = {
		revenue: { label: 'Revenue', color: 'var(--ink)' },
		expenses: { label: 'Expenses', color: 'var(--ink-3)' }
	} satisfies Chart.ChartConfig;

	const monthStart = (ym: string) => new Date(`${ym}-01T00:00:00Z`);
	const ymOf = (d: Date) => d.toISOString().slice(0, 7);
	// A month still under way would drag both lines towards zero, so it shows only when it is part of the range.
	const current = $derived(db.now().slice(0, 7));
	const shown = $derived(points.filter((p) => p.ym < current || selected.includes(p.ym)));
	const data = $derived(shown.map((p) => ({ month: monthStart(p.ym), revenue: p.revenue, expenses: p.expenses })));
	// Half a month of room either side, so the first and last months sit inside the plot like the rest.
	const xDomain = $derived(padMonths(shown.map((p) => p.ym)));

	// The selection band runs half a month either side of the first and last selected month.
	const band = $derived.by(() => {
		const on = points.filter((p) => selected.includes(p.ym));
		if (!on.length) return [];
		const half = 15 * 86_400_000;
		return [{ type: 'range' as const, layer: 'below' as const, x: [new Date(monthStart(on[0].ym).getTime() - half), new Date(monthStart(on.at(-1)!.ym).getTime() + half)], fill: 'var(--accent-soft)' }];
	});

	const on = (ym: string) => selected.includes(ym);
</script>

<div class="flex flex-col gap-3">
	<ul class="flex gap-4 text-caption text-ink-2" aria-label="Legend">
		{#each Object.entries(config) as [key, s] (key)}
			<li class="flex items-center gap-1.5">
				<svg class="h-2 w-5" viewBox="0 0 20 8" aria-hidden="true"><line x1="0" x2="20" y1="4" y2="4" stroke={s.color} stroke-width="2" stroke-dasharray={key === 'expenses' ? '5 4' : undefined} /></svg>{s.label}
			</li>
		{/each}
	</ul>

	<Chart.Container {config} class="h-56 w-full" role="img" aria-label="Revenue and expenses by month. The table below lists every figure.">
		<LineChart
			{data}
			x="month"
			{xDomain}
			axis
			annotations={band}
			series={[
				{ key: 'revenue', label: 'Revenue', color: 'var(--color-revenue)' },
				{ key: 'expenses', label: 'Expenses', color: 'var(--color-expenses)', props: { class: '[stroke-dasharray:5_4]' } }
			]}
			props={{
				spline: { strokeWidth: 2 },
				xAxis: { format: (d: Date) => ymShort(ymOf(d)), ticks: data.length },
				yAxis: { format: (v: number) => tick(v), ticks: 3 },
				highlight: { points: { r: 4 } }
			}}
		>
			{#snippet tooltip()}
				<Chart.Tooltip labelFormatter={(d: Date) => ymShort(ymOf(d))} indicator="line">
					{#snippet formatter({ value, name, item })}
						<span class="h-0.5 w-3 shrink-0 self-center rounded-sm" style="background:{item.color}"></span>
						<span class="flex flex-1 items-center justify-between gap-4">
							<span class="text-ink-2">{name}</span>
							<span class="num font-medium text-ink">{money(Number(value))}</span>
						</span>
					{/snippet}
				</Chart.Tooltip>
			{/snippet}
		</LineChart>
	</Chart.Container>

	<details class="text-body-sm">
		<summary class="cursor-pointer text-ink-2">Show as a table</summary>
		<table class="mt-2 w-full">
			<thead class="text-left text-caption text-ink-3">
				<tr><th class="py-1 font-medium">Month</th><th class="py-1 text-right font-medium">Revenue</th><th class="py-1 text-right font-medium">Expenses</th><th class="py-1 text-right font-medium">Net income</th></tr>
			</thead>
			<tbody class="num">
				{#each points as p (p.ym)}
					<tr class="border-t border-line {on(p.ym) ? 'text-ink' : 'text-ink-3'}">
						<td class="py-1 font-sans">{ymShort(p.ym)}</td><td class="py-1 text-right">{money(p.revenue)}</td><td class="py-1 text-right">{money(p.expenses)}</td><td class="py-1 text-right">{money(p.netIncome)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</details>
</div>
