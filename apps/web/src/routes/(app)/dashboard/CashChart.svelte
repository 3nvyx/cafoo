<script lang="ts">
	// Book cash at each month end, as a line (shadcn-svelte's chart on LayerChart). The axis spans the months' own range
	// rather than starting at zero, so a month's burn shows as a slope; the tick labels say where it starts.
	import { LineChart } from 'layerchart';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import type { MonthPoint } from '#lib/data/dashboard.js';
	import { ymShort } from '#lib/data/derive.js';
	import { money, niceMax, padMonths, tick } from './chart.js';
	import { stepIndex } from './insights.js';

	// Hover a month to read it, click it to show that month. From the keyboard: arrows step, Enter shows one.
	let { points, selected, onpick }: { points: MonthPoint[]; selected: string[]; onpick?: (ym: string) => void } = $props();

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

	let focusAt = $state<number | null>(null);
	const focused = $derived(focusAt === null ? null : (points[Math.min(focusAt, points.length - 1)] ?? null));
	const annotations = $derived.by(() => {
		if (!focused) return band;
		const half = 15 * 86_400_000;
		const t = monthStart(focused.ym).getTime();
		return [...band, { type: 'range' as const, layer: 'below' as const, x: [new Date(t - half), new Date(t + half)], fill: 'var(--line)' }];
	});
	const shownAt = $derived(focused ?? last);
	function onkeydown(e: KeyboardEvent) {
		if ((e.key === 'Enter' || e.key === ' ') && focused) {
			e.preventDefault();
			onpick?.(focused.ym);
			return;
		}
		const next = stepIndex(focusAt, e.key, points.length);
		if (next === null) return;
		e.preventDefault();
		focusAt = next;
	}
	const pickAt = (d: { month?: Date } | null | undefined) => {
		if (d?.month) onpick?.(ymOf(d.month));
	};
</script>

<div class="flex flex-col gap-3">
	{#if shownAt}
		<p class="text-caption text-ink-2" aria-live="polite">
			<span class="font-medium text-ink">End of {ymShort(shownAt.ym)}</span>
			<span class="num">· {money(shownAt.cash)}</span>
			{#if focused && onpick}<span class="text-ink-3"> · Enter to show this month</span>{:else if onpick}<span class="text-ink-3"> · Click a month to show it</span>{/if}
		</p>
	{/if}
	<div
		class="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus {onpick ? 'cursor-pointer' : ''}"
		tabindex="0"
		role="slider"
		aria-valuemin={0}
		aria-valuemax={Math.max(0, points.length - 1)}
		aria-valuenow={focusAt ?? Math.max(0, points.length - 1)}
		aria-valuetext={focused ? `End of ${ymShort(focused.ym)}: ${money(focused.cash)}` : 'No month read yet'}
		aria-label="Book cash by month end. Left and right arrows read each month{onpick ? ', Enter shows that month' : ''}."
		{onkeydown}
		onblur={() => (focusAt = null)}
	>
	<Chart.Container {config} class="h-56 w-full" role="img" aria-label="Book cash at each month end: {points.map((p) => `${ymShort(p.ym)} ${money(p.cash)}`).join(', ')}">
		<LineChart
			{data}
			x="month"
			xDomain={padMonths(points.map((p) => p.ym))}
			yDomain={[scale.from, scale.to]}
			axis
			{annotations}
			tooltipContext={{ onclick: (_e: MouseEvent, { data: d }: { data: { month?: Date } | null }) => pickAt(d) }}
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
</div>
