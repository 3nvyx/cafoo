<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { periodLabel } from '#lib/data/derive.js';
	import { monthRange, monthly, monthsIn, postings, summarize, type DateRange } from '#lib/data/dashboard.js';
	import { rootOf } from '#lib/data/group.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { Minor } from '#lib/data/types.js';
	import { drill } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import AgentsPanel from './AgentsPanel.svelte';
	import CreditPanel from './CreditPanel.svelte';
	import ProposalsPanel from './ProposalsPanel.svelte';
	import CashChart from './CashChart.svelte';
	import ClosePanel from './ClosePanel.svelte';
	import KpisCard, { type KpiRow } from './KpisCard.svelte';
	import MonthlyChart from './MonthlyChart.svelte';
	import StatusStrip from './StatusStrip.svelte';
	import Workflows from './Workflows.svelte';
	import { aiTiles, dsoHealth, efficiencyTiles, reserveHealth, usdRate } from '#lib/kpis.js';
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
	const series = $derived(monthly(ps, contracts, months));
	const selected = $derived(range ? monthsIn(range) : []);

	const money = (m: Minor | bigint) => formatMoney(m.toString(), { whole: true });

	// The KPIs card reads the month the strip shows, with the Metrics page's own readings where it has one.
	// Burn is the Metrics page's too: net operating cash burn averaged over the quarter ending with the month.
	const firstMonth = $derived(db.periods()[0]?.id);
	const kpis = $derived.by<KpiRow[]>(() => {
		if (!period || !monthSummary || !firstMonth) return [];
		const m = monthSummary;
		const burn = burnReading(ps, period.id, firstMonth);
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
		const tile = (key: string, label: string): KpiRow[] =>
			all.filter((t) => t.key === key).map((t) => ({ label, value: t.value, health: t.health, href: t.href ?? '/metrics' }));
		const receivables = toBig(m.receivables);
		const reserveBp = receivables > 0n ? Number((toBig(m.allowance) * 10000n) / receivables) : null;
		return [
			{ label: 'Cash', value: money(m.cash), health: null, href: drill({ account: '1000' }, { to: period.id }) },
			{ label: 'Monthly net burn', value: money(burn.monthlyBurn), health: null, href: '/metrics' },
			...tile('runway', 'Runway'),
			{ label: 'ARR', value: money(m.arr), health: null, href: '/reports' },
			...tile('ndr', 'Net dollar retention'),
			...tile('gm-after-inference', 'Gross margin'),
			{ label: 'Days to get paid', value: m.dsoDays === null ? '–' : `${m.dsoDays} days`, health: dsoHealth(m.dsoDays), href: drill({ account: '1100' }, { to: period.id }) },
			{ label: 'Receivables at risk', value: reserveBp === null ? '–' : `${(reserveBp / 100).toFixed(1)}%`, health: reserveHealth(reserveBp), href: '/customers' }
		];
	});
</script>

<svelte:head><title>Dashboard · Luyten</title></svelte:head>

{#if period && root}
	<header class="flex flex-col gap-1 pb-6">
		<p class="text-body-sm text-ink-2">{root.name} · {periodLabel(period)}</p>
		<h1 class="text-display">Dashboard</h1>
	</header>

	{#if monthSummary}<StatusStrip {period} month={monthSummary} />{/if}

	<!-- The month's KPIs, beside the Proposals by status. -->
	<div class="mt-8 grid gap-8 lg:grid-cols-3">
		<div class="min-w-0 lg:col-span-2">{#if kpis.length}<KpisCard rows={kpis} />{/if}</div>
		<div class="min-w-0"><ProposalsPanel /></div>
	</div>

	<!-- What the rest of the app holds, one panel per page: the close, the agents, customer credit. -->
	<div class="mt-8 grid gap-8 md:grid-cols-2 xl:grid-cols-3">
		<div class="min-w-0"><ClosePanel {period} /></div>
		<div class="min-w-0"><AgentsPanel /></div>
		<div class="min-w-0 md:col-span-2 xl:col-span-1"><CreditPanel /></div>
	</div>

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
			<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
