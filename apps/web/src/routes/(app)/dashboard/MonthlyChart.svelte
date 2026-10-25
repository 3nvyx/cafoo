<script lang="ts">
	// Revenue and expenses as two lines across every month on the books (shadcn-svelte's chart on LayerChart). The
	// months the range covers sit on the selection band; hover or tap a month to read it, click it to show that month.
	// From the keyboard: focus the chart, arrows step through the months, Enter shows one. The table holds every figure.
	import { LineChart } from 'layerchart';
	import { db } from '#lib/data/index.js';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import type { MonthPoint } from '#lib/data/dashboard.js';
	import { ymShort } from '#lib/data/derive.js';
	import { money, padMonths, tick } from './chart.js';
	import { stepIndex } from './insights.js';

	let { points, selected, onpick }: { points: MonthPoint[]; selected: string[]; onpick?: (ym: string) => void } = $props();

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

	// The month the keyboard is on, and its band; null until the chart is focused and an arrow pressed.
	let focusAt = $state<number | null>(null);
	const focused = $derived(focusAt === null ? null : (shown[Math.min(focusAt, shown.length - 1)] ?? null));
	const annotations = $derived.by(() => {
		if (!focused) return band;
		const half = 15 * 86_400_000;
		const t = monthStart(focused.ym).getTime();
		return [...band, { type: 'range' as const, layer: 'below' as const, x: [new Date(t - half), new Date(t + half)], fill: 'var(--line)' }];
	});
	function onkeydown(e: KeyboardEvent) {
		if ((e.key === 'Enter' || e.key === ' ') && focused) {
			e.preventDefault();
			onpick?.(focused.ym);
			return;
		}
		const next = stepIndex(focusAt, e.key, shown.length);
		if (next === null) return;
		e.preventDefault();
		focusAt = next;
	}
	const pickAt = (d: { month?: Date } | null | undefined) => {
		if (d?.month) onpick?.(ymOf(d.month));
	};
</script>

<div class="flex flex-col gap-3">
	<ul class="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-2" aria-label="Legend">
		{#each Object.entries(config) as [key, s] (key)}
			<li class="flex items-center gap-1.5">
				<svg class="h-2 w-5" viewBox="0 0 20 8" aria-hidden="true"><line x1="0" x2="20" y1="4" y2="4" stroke={s.color} stroke-width="2" stroke-dasharray={key === 'expenses' ? '5 4' : undefined} /></svg>{s.label}
			</li>
		{/each}
		{#if band.length}
			<li class="flex items-center gap-1.5"><span class="h-3 w-4 rounded-sm bg-accent-soft"></span>Months you picked</li>
		{/if}
	</ul>

	<div
		class="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus {onpick ? 'cursor-pointer' : ''}"
		tabindex="0"
		role="slider"
		aria-valuemin={0}
		aria-valuemax={Math.max(0, shown.length - 1)}
		aria-valuenow={focusAt ?? Math.max(0, shown.length - 1)}
		aria-valuetext={focused ? `${ymShort(focused.ym)}: revenue ${money(focused.revenue)}, expenses ${money(focused.expenses)}` : 'No month read yet'}
		aria-label="Revenue and expenses by month. Left and right arrows read each month{onpick ? ', Enter shows that month' : ''}. The table below lists every figure."
		{onkeydown}
		onblur={() => (focusAt = null)}
	>
	<Chart.Container {config} class="h-56 w-full" role="img" aria-label="Revenue and expenses by month">
		<LineChart
			{data}
			x="month"
			{xDomain}
			axis
			{annotations}
			tooltipContext={{ onclick: (_e: MouseEvent, { data: d }: { data: { month?: Date } | null }) => pickAt(d) }}
			series={[
				{ key: 'revenue', label: 'Revenue', color: 'var(--color-revenue)' },
				{ key: 'expenses', label: 'Expenses', color: 'var(--color-expenses)', props: { class: '[stroke-dasharray:5_4]' } }
			]}
			props={{
				spline: { strokeWidth: 2 },
				xAxis: { format: (d: Date) => ymShort(ymOf(d)), ticks: Math.min(data.length, 6) },
				yAxis: { format: (v: number) => tick(v), ticks: 4 },
				highlight: { points: { r: 4 } }
			}}
		>
			{#snippet tooltip()}
				<Chart.Tooltip labelFormatter={(d: Date) => ymShort(ymOf(d))} indicator="line">
					{#snippet formatter({ value, name, item })}
						<svg class="h-2 w-3 shrink-0 self-center" viewBox="0 0 12 8" aria-hidden="true"><line x1="0" x2="12" y1="4" y2="4" stroke={item.color} stroke-width="2" stroke-dasharray={item.key === 'expenses' ? '4 3' : undefined} /></svg>
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
	<p class="min-h-5 text-caption text-ink-2" aria-live="polite">
		{#if focused}
			<span class="font-medium text-ink">{ymShort(focused.ym)}</span>
			<span class="num">· Revenue {money(focused.revenue)} · Expenses {money(focused.expenses)} · Net income {money(focused.netIncome)}</span>
			{#if onpick}<span class="text-ink-3"> · Enter to show this month</span>{/if}
		{:else if onpick}
			<span class="text-ink-3">Click a month to show it</span>
		{/if}
	</p>

	<details class="text-body-sm">
		<summary class="cursor-pointer text-ink-2">Show as a table</summary>
		<table class="mt-2 w-full">
			<thead class="text-left text-caption text-ink-3">
				<tr><th class="py-1 font-medium">Month</th><th class="py-1 text-right font-medium">Revenue</th><th class="py-1 text-right font-medium">Expenses</th><th class="py-1 text-right font-medium">Net income</th></tr>
			</thead>
			<tbody class="num">
				{#each points as p (p.ym)}
					<tr class="border-t border-line {on(p.ym) ? 'text-ink' : 'text-ink-3'}">
						<td class="py-1 font-sans">{ymShort(p.ym)}{#if p.ym === current}<span class="text-ink-3"> (so far)</span>{/if}</td><td class="py-1 text-right">{money(p.revenue)}</td><td class="py-1 text-right">{money(p.expenses)}</td><td class="py-1 text-right">{money(p.netIncome)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</details>
</div>
