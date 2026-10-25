<script lang="ts">
	// The numbers an AI startup is judged on, for the month picked in the sidebar, each against its usual yardstick.
	import { db } from '#lib/data/index.js';
	import { addDays, monthRange, postings, summarize } from '#lib/data/dashboard.js';
	import { periodLabel } from '#lib/data/derive.js';
	import { rootOf } from '#lib/data/group.js';
	import { formatMoney } from '#lib/data/money.js';
	import {
		arrPerFte,
		arrPerFteHealth,
		burnMultiple,
		burnMultipleHealth,
		fte,
		ndrBp,
		ndrHealth,
		netBurn,
		netNewArr,
		ruleOf40,
		ruleOf40Health,
		runwayHealth
	} from '#lib/kpis.js';
	import { ui } from '#lib/ui.svelte.js';
	import MetricTile from './MetricTile.svelte';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId) ?? db.periods().at(-1));
	const root = $derived(rootOf(db.subsidiaries()));
	const ps = $derived(root ? postings(db.accounts().filter((a) => a.subsidiaryId === root.id), db.journalEntries(), db.journalLines()) : []);
	const contracts = $derived(db.contracts());
	const employees = $derived(db.employees());

	const range = $derived(period ? monthRange(period.id) : null);
	const s = $derived(range ? summarize(ps, contracts, range) : null);
	const end = $derived(range?.to ?? '');
	const before = $derived(range ? addDays(range.from, -1) : '');
	// Retention reads over the quarter ending this month, or as far back as the books go.
	const firstMonth = $derived(db.periods()[0]?.id);
	const quarterFrom = $derived.by(() => {
		if (!range || !firstMonth) return before;
		const d = new Date(`${range.from}T00:00:00Z`);
		d.setUTCMonth(d.getUTCMonth() - 2);
		const from = d.toISOString().slice(0, 10);
		const earliest = monthRange(firstMonth).from;
		return addDays(from < earliest ? earliest : from, -1);
	});

	const money = (m: bigint | string) => formatMoney(m.toString(), { whole: true });
	const pct = (bp: number | null) => (bp === null ? '–' : `${(bp / 100).toFixed(1)}%`);

	const burn = $derived(s ? netBurn(s) : 0n);
	const added = $derived(range ? netNewArr(contracts, before, end) : 0n);
	const multiple = $derived(burnMultiple(burn, added));
	const perFte = $derived(end ? arrPerFte(contracts, employees, end) : null);
	const heads = $derived(end ? fte(employees, end) : 0);
	// Growth over the same window as retention, annualized; one month alone swings too much early on.
	const windowMonths = $derived(quarterFrom && end ? Math.max(1, Math.round((Date.parse(end) - Date.parse(quarterFrom)) / (30.44 * 86400000))) : 1);
	const r40 = $derived(range && s ? ruleOf40(contracts, quarterFrom, end, windowMonths, s.netMarginBp) : null);
	const ndr = $derived(range ? ndrBp(contracts, quarterFrom, end) : null);
	const runway = $derived(s?.runwayMonths ?? null);
</script>

<svelte:head><title>Metrics · Cafoo</title></svelte:head>

{#if period && s}
	<header class="flex flex-col gap-1 pb-6">
		<p class="text-body-sm text-ink-2">{root?.name} · {periodLabel(period)}</p>
		<h1 class="text-display">Metrics</h1>
		<p class="max-w-prose text-body-sm text-ink-2">The numbers an AI startup is judged on, each read against the yardstick investors use. They move as the books, the team and the connected tools change.</p>
	</header>

	<section aria-labelledby="eff-h" class="flex flex-col gap-4">
		<h2 id="eff-h" class="text-title">Efficiency</h2>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
			<MetricTile
				label="Burn multiple"
				value={multiple === null ? (burn > 0n ? 'No ARR added' : '–') : `${multiple.toFixed(1)}×`}
				health={burnMultipleHealth(multiple, burn)}
				inputs="{money(burn)} burned · {money(added)} net new ARR"
				yardstick="Cash burned per dollar of new ARR. Under 1× is excellent, over 2× means growth is expensive."
			/>
			<MetricTile
				label="Runway"
				value={runway === null ? 'Cash not falling' : runway > 36 ? 'Over 3 years' : `${Math.round(runway)} months`}
				health={runwayHealth(runway)}
				inputs="{money(s.cash)} book cash"
				yardstick="18 months or more is comfortable between rounds; under 9, raise now."
				href="/dashboard"
			/>
			<MetricTile
				label="ARR per employee"
				value={perFte === null ? '–' : money(perFte)}
				health={arrPerFteHealth(perFte)}
				inputs="{money(s.arr)} ARR · {heads} full-time equivalents"
				yardstick="Early AI companies are often read against $150k to $250k."
				href="/people"
			/>
			<MetricTile
				label="Rule of 40"
				value={r40 ? `${r40.score.toFixed(0)}` : '–'}
				health={ruleOf40Health(r40?.score ?? null)}
				inputs={r40 ? `${r40.growthPct.toFixed(0)}% ARR growth, annualized · ${r40.marginPct.toFixed(0)}% net margin` : 'Needs ARR and revenue'}
				yardstick="ARR growth over the quarter, annualized, plus net margin. 40 or more is healthy."
			/>
			<MetricTile
				label="Net dollar retention"
				value={pct(ndr)}
				health={ndrHealth(ndr)}
				inputs="Existing customers' ARR, start of quarter to now"
				yardstick="Over 110% means customers grow faster than they churn."
				href="/reports"
			/>
		</div>
	</section>
{/if}
