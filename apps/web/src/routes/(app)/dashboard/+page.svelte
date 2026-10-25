<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { periodLabel, ymShort } from '#lib/data/derive.js';
	import { isWholeMonths, monthRange, monthly, monthsIn, postings, previousRange, rangeDays, summarize, type DateRange, type Summary } from '#lib/data/dashboard.js';
	import { rootOf } from '#lib/data/group.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { Minor } from '#lib/data/types.js';
	import { drill } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import AdvisorChat from './AdvisorChat.svelte';
	import AgentsPanel from './AgentsPanel.svelte';
	import CreditPanel from './CreditPanel.svelte';
	import ProposalsPanel from './ProposalsPanel.svelte';
	import CashChart from './CashChart.svelte';
	import ClosePanel from './ClosePanel.svelte';
	import CloseCard from './CloseCard.svelte';
	import KpiCard, { type Delta } from './KpiCard.svelte';
	import MonthlyChart from './MonthlyChart.svelte';
	import StatusStrip from './StatusStrip.svelte';
	import Workflows from './Workflows.svelte';
	import MetricTile from '../metrics/MetricTile.svelte';
	import { aiTiles, efficiencyTiles, usdRate } from '#lib/kpis.js';
	import { burnReading } from '#lib/saas-metrics.js';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId) ?? db.periods().at(-1));
	const months = $derived([...new Set(db.periods().map((p) => p.id))].sort());
	const bounds = $derived<DateRange | null>(months.length ? { from: monthRange(months[0]).from, to: monthRange(months.at(-1)!).to } : null);

	// The range: one month (the app-wide Period, shared with the sidebar), or any two days.
	let mode = $state<'month' | 'range'>('month');
	let from = $state('');
	let to = $state('');
	/** A month clicked on a chart becomes the shown month (and the app-wide Period, like the sidebar's picker). */
	function pickMonth(ym: string) {
		if (!months.includes(ym)) return;
		ui.periodId = ym;
		mode = 'month';
	}
	function pickRange() {
		mode = 'range';
		if (!from || !to) ({ from, to } = monthRange(ui.periodId));
	}
	const range = $derived.by<DateRange | null>(() => {
		if (mode === 'month') return period ? monthRange(period.id) : null;
		if (!from || !to) return null;
		return from <= to ? { from, to } : { from: to, to: from };
	});
	const label = $derived.by(() => {
		if (!range) return '';
		if (mode === 'month' && period) return periodLabel(period);
		const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
		return `${day(range.from)} to ${day(range.to)}`;
	});

	// Cafoo Inc's own books, in its own currency. The group view, translated and eliminated, is the Board Pack's.
	const root = $derived(rootOf(db.subsidiaries()));
	const ps = $derived(root ? postings(db.accounts().filter((a) => a.subsidiaryId === root.id), db.journalEntries(), db.journalLines()) : []);
	const contracts = $derived(db.contracts());
	const s = $derived(range ? summarize(ps, contracts, range) : null);
	// The strip at the top always shows the selected month, whatever range the figures below show.
	const monthSummary = $derived(period ? summarize(ps, contracts, monthRange(period.id)) : null);
	const prevRange = $derived(range ? previousRange(range) : null);
	const prev = $derived(prevRange && bounds && prevRange.from >= bounds.from ? summarize(ps, contracts, prevRange) : null);
	const against = $derived(!prevRange ? '' : mode === 'month' ? `vs ${ymShort(prevRange.from.slice(0, 7))}` : `vs the ${rangeDays(prevRange)} days before`);

	const series = $derived(monthly(ps, contracts, months));
	const selected = $derived(range ? monthsIn(range) : []);
	const spark = (pick: (m: (typeof series)[number]) => number) => ({ values: series.map(pick), on: series.map((m) => selected.includes(m.ym)) });

	const money = (m: Minor) => formatMoney(m, { whole: true });
	const pct = (bp: number | null) => (bp === null ? '–' : `${(bp / 100).toFixed(1)}%`);

	/** The change from the range before; null when the books do not reach back that far. */
	function moneyDelta(key: keyof Summary, upIsGood: boolean | null): Delta | null {
		if (!s || !prev) return null;
		const d = toBig(s[key] as Minor) - toBig(prev[key] as Minor);
		const dir = d > 0n ? 1 : d < 0n ? -1 : 0;
		return { text: formatMoney(d.toString(), { compact: true, signed: true }), dir, good: upIsGood === null ? null : dir > 0 === upIsGood, against };
	}

	// The ledger filters by month, so figures drill only when the range is whole months; a link for part of a month
	// would open lines the figure does not count.
	const drillable = $derived(!!range && isWholeMonths(range) && selected.length > 0);
	const span = $derived(selected.length === 1 ? selected[0] : { from: selected[0], to: selected.at(-1) });
	const through = $derived({ to: selected.at(-1) });
	const link = (href: string) => (drillable ? href : undefined);
	const company = $derived(root?.code);

	// Runway is the Metrics page's: cash over the average monthly operating burn of the quarter ending with the range.
	const firstMonth = $derived(db.periods()[0]?.id);
	const burnAt = $derived(range && firstMonth ? burnReading(ps, range.to.slice(0, 7), firstMonth) : null);
	const runway = $derived.by(() => {
		if (!burnAt) return '';
		const r = burnAt.runwayMonths;
		if (r === null) return burnAt.cash > 0n ? 'Running the business did not use cash over the last three months' : 'Cash is gone at this rate of spend';
		if (r > 36) return 'Over 3 years of runway at this rate of spend';
		if (r < 1) return 'Less than a month of runway at this rate of spend';
		const n = Math.round(r);
		return `About ${n} month${n === 1 ? '' : 's'} of runway at this rate of spend`;
	});

	// The headline readings from the Metrics page, for the month the strip shows.
	const health = $derived.by(() => {
		if (!period || !monthSummary || !firstMonth) return [];
		const all = [
			...efficiencyTiles({ ps, endYm: period.id, firstYm: firstMonth, contracts, employees: db.employees() }),
			...aiTiles({
				ym: period.id,
				revenueMinor: monthSummary.revenue,
				now: db.now(),
				cloudCosts: db.cloudCosts(),
				employees: db.employees(),
				batches: db.batches(),
				deals: db.deals(),
				tickets: db.supportTickets(),
				invoices: db.invoices(),
				contracts,
				rate: usdRate(db.fxRates())
			}).unit
		];
		return ['runway', 'burn-multiple', 'gm-after-inference', 'ndr'].flatMap((k) => all.filter((t) => t.key === k));
	});
</script>

<svelte:head><title>Dashboard · Cafoo</title></svelte:head>

{#if period && root}
	<header class="flex flex-col gap-1 pb-6">
		<p class="text-body-sm text-ink-2">{root.name} · {periodLabel(period)}</p>
		<h1 class="text-display">Dashboard</h1>
	</header>

	{#if monthSummary}<StatusStrip {period} month={monthSummary} />{/if}

	<!-- Where the close stands and its next step come first; how the business is doing comes after. -->
	<div class="mt-8"><CloseCard {period} /></div>

	<!-- Then a question box for the Advisor, and the Proposals by status. -->
	<div class="mt-8 grid gap-8 lg:grid-cols-3">
		<div class="min-w-0 lg:col-span-2"><AdvisorChat /></div>
		<div class="min-w-0"><ProposalsPanel /></div>
	</div>

	<!-- What the rest of the app holds, one panel per page: the close, the agents, customer credit. -->
	<div class="mt-8 grid gap-8 md:grid-cols-2 xl:grid-cols-3">
		<div class="min-w-0"><ClosePanel {period} /></div>
		<div class="min-w-0"><AgentsPanel /></div>
		<div class="min-w-0 md:col-span-2 xl:col-span-1"><CreditPanel /></div>
	</div>

	{#if health.length}
		<section aria-labelledby="health-h" class="mt-12">
			<div class="flex flex-wrap items-baseline justify-between gap-3 pb-4">
				<h2 id="health-h" class="text-title">Health check</h2>
				<a href="/metrics" class="drill text-body-sm text-ink-2">All metrics</a>
			</div>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{#each health as t (t.key)}
					<MetricTile label={t.label} value={t.value} health={t.health} inputs={t.inputs} yardstick={t.yardstick} href={t.href ?? '/metrics'} />
				{/each}
			</div>
		</section>
	{/if}

	<section aria-labelledby="figures-h" class="mt-12">
		<div class="flex flex-col gap-4 pb-4 lg:flex-row lg:items-end lg:justify-between">
			<div class="flex flex-col gap-1">
				<h2 id="figures-h" class="text-title">How the business is doing</h2>
				<p class="text-body-sm text-ink-2">{label} · the Board Pack has the full statements</p>
			</div>
			<div class="flex flex-wrap items-end gap-3">
				<div class="flex gap-1" role="group" aria-label="Show figures for">
					<button class="chip" aria-pressed={mode === 'month'} onclick={() => (mode = 'month')}>Month</button>
					<button class="chip" aria-pressed={mode === 'range'} onclick={pickRange}>Date range</button>
				</div>
				{#if mode === 'range'}
					<label class="flex flex-col gap-1 text-caption text-ink-2">
						From
						<input type="date" class="field num text-body-sm" bind:value={from} min={bounds?.from} max={bounds?.to} />
					</label>
					<label class="flex flex-col gap-1 text-caption text-ink-2">
						To
						<input type="date" class="field num text-body-sm" bind:value={to} min={bounds?.from} max={bounds?.to} />
					</label>
				{/if}
			</div>
		</div>

		{#if !s}
			<p class="card p-5 text-body-sm text-ink-2">Pick both a start and an end date to see the figures.</p>
		{:else}
			<div aria-label="Key figures for {label}" role="group" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<KpiCard label="Book cash" value={money(s.cash)} delta={moneyDelta('cash', true)} spark={spark((m) => m.cash)} href={link(drill({ account: '1000' }, through))} hint={runway} />
				<KpiCard label="Revenue" value={money(s.revenue)} delta={moneyDelta('revenue', true)} spark={spark((m) => m.revenue)} href={link(drill({ type: ['revenue'], company }, span))} hint={toBig(s.intercompany) ? `From customers. ${money(s.intercompany)} of fees from other group companies left out` : 'From customers, deferrals applied'} />
				<KpiCard label="Net income" value={money(s.netIncome)} delta={moneyDelta('netIncome', true)} spark={spark((m) => m.netIncome)} href={link(drill({ type: ['revenue', 'expense'], company }, span))} hint="{money(s.expenses)} of expenses · {pct(s.netMarginBp)} of revenue, before intercompany fees" />
				<KpiCard label="ARR" value={money(s.arr)} delta={moneyDelta('arr', true)} spark={spark((m) => m.arr)} href="/reports" hint="Annual recurring revenue, from the contracts" />
			</div>

			<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
				<section aria-labelledby="trend-h" class="card flex flex-col gap-4 p-5">
					<h3 id="trend-h" class="text-subtitle">Revenue and expenses by month</h3>
					<MonthlyChart points={series} {selected} onpick={pickMonth} />
				</section>
				<section aria-labelledby="cash-h" class="card flex flex-col gap-4 p-5">
					<h3 id="cash-h" class="text-subtitle">Book cash at month end</h3>
					<CashChart points={series} {selected} onpick={pickMonth} />
				</section>
			</div>
		{/if}
	</section>

	<Workflows {period} />
{/if}
