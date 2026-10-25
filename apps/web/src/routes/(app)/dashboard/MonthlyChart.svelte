<script lang="ts">
	// Revenue and expenses side by side for every month on the books. The months the range covers sit on the selection
	// band at full strength; the rest stay as context. Hover or tap a month to read it; the table holds every figure.
	import type { MonthPoint } from '#lib/data/dashboard.js';
	import { ymShort } from '#lib/data/derive.js';
	import { column, money, niceMax, tick } from './chart.js';

	let { points, selected }: { points: MonthPoint[]; selected: string[] } = $props();

	let w = $state(0);
	const H = 220, top = 12, bottom = 28, left = 52;
	const SERIES = [
		{ key: 'revenue', label: 'Revenue', color: 'var(--ink)' },
		{ key: 'expenses', label: 'Expenses', color: 'var(--ink-3)' }
	] as const;

	const max = $derived(niceMax(Math.max(...points.flatMap((p) => [p.revenue, p.expenses]))));
	const band = $derived(Math.max(0, w - left) / Math.max(1, points.length));
	const bar = $derived(Math.min(24, band * 0.28));
	const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
	const base = $derived(y(0));
	const on = (ym: string) => selected.includes(ym);
	// Month labels need about 64px; with less room, label every nth month, always including the last.
	const every = $derived(Math.max(1, Math.ceil(64 / Math.max(1, band))));
	const labelled = (i: number) => (points.length - 1 - i) % every === 0;

	let hover = $state<number | null>(null);
	const shown = $derived(points[hover ?? points.findLastIndex((p) => on(p.ym))] ?? points.at(-1));
	// The selection band spans the first to the last selected month.
	const firstOn = $derived(points.findIndex((p) => on(p.ym)));
	const lastOn = $derived(points.findLastIndex((p) => on(p.ym)));
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<ul class="flex gap-4 text-caption text-ink-2" aria-label="Legend">
			{#each SERIES as s (s.key)}
				<li class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm" style="background:{s.color}"></span>{s.label}</li>
			{/each}
		</ul>
		{#if shown}
			<p class="text-caption text-ink-2" aria-live="polite">
				<span class="font-medium text-ink">{ymShort(shown.ym)}</span>
				<span class="num">· {money(shown.revenue)} in · {money(shown.expenses)} out · net {money(shown.netIncome)}</span>
			</p>
		{/if}
	</div>

	<div bind:clientWidth={w} class="min-h-55 w-full">
		{#if w > left}
		<svg width={w} height={H} role="img" aria-label="Revenue and expenses by month. The table below lists every figure." onpointerleave={() => (hover = null)}>
			{#if firstOn >= 0}
				<rect x={left + firstOn * band + 2} y={top - 8} width={(lastOn - firstOn + 1) * band - 4} height={base - top + 8} rx="8" fill="var(--accent-soft)" />
			{/if}
			{#each [0, max / 2, max] as t (t)}
				<line x1={left} x2={w} y1={y(t)} y2={y(t)} stroke="var(--line)" />
				<text x={left - 8} y={y(t) + 4} text-anchor="end" font-size="12" fill="var(--ink-3)" class="num">{tick(t)}</text>
			{/each}
			{#each points as p, i (p.ym)}
				{@const cx = left + i * band + band / 2}
				<g opacity={on(p.ym) ? 1 : 0.4}>
					<path d={column(cx - bar - 1, base, bar, base - y(Math.max(0, p.revenue)))} fill={SERIES[0].color} />
					<path d={column(cx + 1, base, bar, base - y(Math.max(0, p.expenses)))} fill={SERIES[1].color} />
				</g>
				{#if labelled(i)}<text x={cx} y={H - 8} text-anchor="middle" font-size="12" fill={on(p.ym) ? 'var(--ink)' : 'var(--ink-3)'}>{ymShort(p.ym)}</text>{/if}
				<rect
					x={left + i * band}
					y={top}
					width={band}
					height={H - top}
					fill="transparent"
					role="presentation"
					onpointerenter={() => (hover = i)}
				/>
			{/each}
			{#if hover !== null}
				<line x1={left + hover * band + band / 2} x2={left + hover * band + band / 2} y1={top} y2={base} stroke="var(--line-strong)" pointer-events="none" />
			{/if}
		</svg>
		{/if}
	</div>

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
