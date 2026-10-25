<script lang="ts">
	// Cost of service: what it takes to run the product for customers. Cloud and model usage come from the connected
	// providers (October keeps ticking), the service share of engineering pay from the people records, revenue from
	// the books. Everything is derived from the live tables, so the page moves as the meters do.
	import { db } from '#lib/data/index.js';
	import { ymShort } from '#lib/data/derive.js';
	import { monthRange, postings, summarize } from '#lib/data/dashboard.js';
	import { rootOf } from '#lib/data/group.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { Minor } from '#lib/data/types.js';
	import {
		CATEGORY_LABEL,
		ENVIRONMENT_LABEL,
		PROVIDER_LABEL,
		REVENUE_MIX_BP,
		costByProvider,
		costOfService,
		costPerMTokens,
		creditPricePerM,
		grossMarginAfterInference,
		hostingTieOut,
		ledgerByMonth,
		marginByProduct,
		monthsOf,
		serviceEngineering,
		type RateE6
	} from '#lib/costs.js';
	import Integrations from '#lib/components/Integrations.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import UploadDemo from '#lib/components/UploadDemo.svelte';
	import { ui } from '#lib/ui.svelte.js';
	import KpiCard from '../dashboard/KpiCard.svelte';
	import Freshness from './Freshness.svelte';

	const money = (m: Minor | bigint) => formatMoney(m.toString(), { whole: true });
	const pct = (bp: number | null) => (bp === null ? 'n/a' : `${(bp / 100).toFixed(1)}%`);

	const rows = $derived(db.cloudCosts());
	const months = $derived(monthsOf(rows));
	const current = $derived(db.now().slice(0, 7));
	let picked = $state<string | null>(null);
	const ym = $derived(picked && months.includes(picked) ? picked : months.includes(ui.periodId) ? ui.periodId : (months.at(-1) ?? current));
	const partial = $derived(ym === current);

	const rate: RateE6 = (ccy, m) => {
		if (ccy === 'USD') return 1_000_000n;
		const r = db.fxRates().find((x) => x.fromCcy === ccy && x.toCcy === 'USD' && x.ym === m && x.kind === 'average') ?? db.fxRates().filter((x) => x.fromCcy === ccy && x.toCcy === 'USD').at(-1);
		return r ? BigInt(r.rateE6) : 1_000_000n;
	};

	// Revenue from Cafoo Inc's own books, as the dashboard reads it.
	const root = $derived(rootOf(db.subsidiaries()));
	const ps = $derived(root ? postings(db.accounts().filter((a) => a.subsidiaryId === root.id), db.journalEntries(), db.journalLines()) : []);
	const revenueOf = (m: string) => summarize(ps, db.contracts(), monthRange(m)).revenue;

	const employees = $derived(db.employees());
	// The month in progress counts the service share of pay only for the days gone, like its usage rows.
	const series = $derived(months.map((m) => ({ cos: costOfService(rows, employees, m, rate, m === current ? db.now() : undefined), revenue: revenueOf(m) })));
	const at = $derived(series.find((x) => x.cos.ym === ym) ?? series.at(-1));
	const margin = $derived(at ? grossMarginAfterInference(at.revenue, at.cos) : null);
	const tokens = $derived(costPerMTokens(rows, ym, 'Copilot'));
	const price = $derived(creditPricePerM(db.batches()));
	const tokenMarginBp = $derived(tokens.perMMinor && price && toBig(price) > 0n ? Number(((toBig(price) - toBig(tokens.perMMinor)) * 10000n) / toBig(price)) : null);
	const svc = $derived(serviceEngineering(employees, ym, rate));
	const providers = $derived(costByProvider(rows, ym));
	const products = $derived(at ? marginByProduct(rows, ym, at.revenue) : []);
	const ledger5000 = $derived(ledgerByMonth(db.accounts(), db.journalEntries(), db.journalLines(), '5000'));
	const tie = $derived(hostingTieOut(rows, ledger5000, months));
	const lines = $derived(
		rows
			.filter((r) => r.ym === ym)
			.slice()
			.sort((a, b) => (toBig(b.amountMinor) > toBig(a.amountMinor) ? 1 : -1))
	);

	const spark = (pick: (x: (typeof series)[number]) => number) => ({ values: series.map(pick), on: series.map((x) => x.cos.ym === ym) });
	const major = (m: Minor) => Number(m) / 100;
</script>

<svelte:head><title>Cost of service · Cafoo</title></svelte:head>

<div class="flex flex-col gap-8">
	<header class="flex flex-col gap-2">
		<h1 class="text-display-sm sm:text-display">Cost of service</h1>
		<p class="max-w-prose text-body text-ink-2">
			What it takes to run the product for customers: cloud, model inference and the time engineers spend keeping the service up. The Bookkeeper splits it between cost of revenue, R&D and G&A.
		</p>
		<Freshness ids={['aws', 'vercel', 'openai', 'anthropic']} label="Meters live" />
	</header>

	<div class="flex flex-wrap gap-2" role="group" aria-label="Month">
		{#each months as m (m)}
			<button class="chip" aria-pressed={m === ym} onclick={() => (picked = m)}>{ymShort(m)}{m === current ? ' (to date)' : ''}</button>
		{/each}
	</div>

	{#if at && margin}
		<section aria-label="Key figures for {ymShort(ym)}" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<KpiCard label="Cost of revenue" value={money(at.cos.costOfRevenueMinor)} hint="Hosting, inference and service engineering" spark={spark((x) => major(x.cos.costOfRevenueMinor))} />
			<KpiCard label="Model inference" value={money(at.cos.inferenceMinor)} hint="{pct(margin.inferenceShareBp)} of revenue" spark={spark((x) => major(x.cos.inferenceMinor))} />
			<KpiCard label="Gross margin after inference" value={pct(margin.afterInferenceBp)} hint="{pct(margin.beforeInferenceBp)} before inference" spark={spark((x) => grossMarginAfterInference(x.revenue, x.cos).afterInferenceBp ?? 0)} />
			<KpiCard
				label="Copilot cost per million tokens"
				value={tokens.perMMinor ? formatMoney(tokens.perMMinor) : 'n/a'}
				hint={price ? `Credits sell at ${formatMoney(price)} per million: ${pct(tokenMarginBp)} margin` : 'No credit packs sold'}
				spark={spark((x) => major(costPerMTokens(rows, x.cos.ym, 'Copilot').perMMinor ?? '0'))}
			/>
		</section>
		{#if partial}
			<p class="-mt-4 text-caption text-ink-3">{ymShort(ym)} is month to date: the meters add to it every few seconds and revenue books as invoices go out.</p>
		{/if}
	{/if}

	<section class="card flex flex-col gap-4 p-5" aria-labelledby="month-h">
		<h2 id="month-h" class="text-title">By month and category</h2>
		<table class="w-full text-body-sm">
			<thead class="text-caption text-ink-3">
				<tr class="border-b border-line">
					<th scope="col" class="py-2 pr-2 text-left font-medium">Month</th>
					<th scope="col" class="px-2 py-2 text-right font-medium">Cost of revenue</th>
					<th scope="col" class="px-2 py-2 text-right font-medium">R&D</th>
					<th scope="col" class="hidden px-2 py-2 text-right font-medium sm:table-cell">G&A</th>
					<th scope="col" class="py-2 pl-2 text-right font-medium">Total</th>
				</tr>
			</thead>
			<tbody>
				{#each series as x (x.cos.ym)}
					<tr class="border-b border-line {x.cos.ym === ym ? 'bg-subtle' : ''}">
						<th scope="row" class="py-2 pr-2 text-left font-medium">
							<button class="drill" onclick={() => (picked = x.cos.ym)}>{ymShort(x.cos.ym)}</button>
						</th>
						<td class="num px-2 py-2 text-right">{money(x.cos.costOfRevenueMinor)}</td>
						<td class="num px-2 py-2 text-right">{money(x.cos.rAndDMinor)}</td>
						<td class="num hidden px-2 py-2 text-right sm:table-cell">{money(x.cos.gAndAMinor)}</td>
						<td class="num py-2 pl-2 text-right font-medium">{money(x.cos.totalMinor)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	{#if at && margin}
		<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
			<section class="card flex flex-col gap-3 p-5" aria-labelledby="cor-h">
				<h2 id="cor-h" class="text-title">Margin after inference, {ymShort(ym)}</h2>
				<dl class="flex flex-col text-body-sm">
					<div class="flex justify-between gap-4 border-b border-line py-2"><dt class="text-ink-2">Revenue</dt><dd class="num">{money(at.revenue)}</dd></div>
					<div class="flex justify-between gap-4 py-2"><dt class="text-ink-2">Hosting (5000)</dt><dd class="num">{money(at.cos.hostingMinor)}</dd></div>
					<div class="flex justify-between gap-4 py-2"><dt class="text-ink-2">Service engineering (5250)</dt><dd class="num">{money(at.cos.serviceEngineeringMinor)}</dd></div>
					<div class="flex justify-between gap-4 border-b border-line py-2"><dt class="text-ink-2">Gross margin before inference</dt><dd class="num">{pct(margin.beforeInferenceBp)}</dd></div>
					<div class="flex justify-between gap-4 py-2"><dt class="text-ink-2">Model inference (5200)</dt><dd class="num">{money(at.cos.inferenceMinor)}</dd></div>
					<div class="flex justify-between gap-4 py-2 font-medium"><dt>Gross margin after inference</dt><dd class="num">{pct(margin.afterInferenceBp)}</dd></div>
				</dl>
			</section>

			<section class="card flex flex-col gap-3 p-5" aria-labelledby="tie-h">
				<h2 id="tie-h" class="text-title">Hosting against the ledger</h2>
				<p class="text-body-sm text-ink-2">Production cloud from the providers, against 5000 Hosting costs in the books.</p>
				<ul class="flex flex-col divide-y divide-line text-body-sm">
					{#each tie as r (r.ym)}
						{@const gap = toBig(r.gapMinor)}
						<li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
							<span class="font-medium">{ymShort(r.ym)}</span>
							<span class="num text-ink-2">{money(r.cloudMinor)} vs {money(r.ledgerMinor)}</span>
							{#if toBig(r.ledgerMinor) === 0n}
								<Pill tone="muted">Not billed yet</Pill>
							{:else if gap === 0n}
								<Pill tone="pos">Ties out</Pill>
							{:else}
								<Pill tone="warn">{gap > 0n ? `${money(gap)} not booked` : `${money(-gap)} more in the books`}</Pill>
							{/if}
						</li>
					{/each}
				</ul>
			</section>

			<section class="card flex flex-col gap-3 p-5" aria-labelledby="prov-h">
				<h2 id="prov-h" class="text-title">By provider</h2>
				<ul class="flex flex-col gap-3">
					{#each providers as p (p.key)}
						<li class="flex flex-col gap-1">
							<div class="flex justify-between gap-4 text-body-sm">
								<span>{PROVIDER_LABEL[p.key]}</span>
								<span class="num">{money(p.amountMinor)} <span class="text-ink-3">· {pct(p.shareBp)}</span></span>
							</div>
							<div class="h-1.5 w-full rounded-sm bg-subtle" aria-hidden="true"><div class="h-1.5 rounded-sm bg-ink-3" style="width: {p.shareBp / 100}%"></div></div>
						</li>
					{:else}
						<li class="text-body-sm text-ink-3">No usage for {ymShort(ym)}.</li>
					{/each}
				</ul>
			</section>

			<section class="card flex flex-col gap-3 p-5" aria-labelledby="prod-h">
				<h2 id="prod-h" class="text-title">By product</h2>
				<p class="text-body-sm text-ink-2">Revenue split by the billing plan mix ({Object.entries(REVENUE_MIX_BP).map(([k, v]) => `${k} ${v / 100}%`).join(', ')}), against the cloud and inference tagged to each product.</p>
				<table class="w-full text-body-sm">
					<thead class="text-caption text-ink-3">
						<tr class="border-b border-line">
							<th scope="col" class="py-2 pr-2 text-left font-medium">Product</th>
							<th scope="col" class="px-2 py-2 text-right font-medium">Revenue</th>
							<th scope="col" class="px-2 py-2 text-right font-medium">Cloud and inference</th>
							<th scope="col" class="py-2 pl-2 text-right font-medium">Margin</th>
						</tr>
					</thead>
					<tbody>
						{#each products as p (p.product)}
							<tr class="border-b border-line">
								<th scope="row" class="py-2 pr-2 text-left font-medium">{p.product}</th>
								<td class="num px-2 py-2 text-right">{money(p.revenueMinor)}</td>
								<td class="num px-2 py-2 text-right">{money(toBig(p.hostingMinor) + toBig(p.inferenceMinor))}</td>
								<td class="num py-2 pl-2 text-right">{pct(p.marginBp)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		</div>
	{/if}

	<section class="card flex flex-col gap-3 p-5" aria-labelledby="svc-h">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h2 id="svc-h" class="text-title">Engineering time on the live service</h2>
			<span class="num text-body-sm">{money(svc.totalMinor)} {partial ? 'a month' : `in ${ymShort(ym)}`}</span>
		</div>
		<p class="text-body-sm text-ink-2">Each person's share of time on call, on support and on infrastructure. That share of their pay is cost of revenue; the rest stays in R&D or operating expense.</p>
		{#if svc.people.length}
			<ul class="flex flex-col divide-y divide-line text-body-sm">
				{#each svc.people as p (p.employee.id)}
					<li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
						<span class="min-w-0">
							<span class="block font-medium">{p.employee.name}</span>
							<span class="block text-caption text-ink-3">{p.employee.title}</span>
						</span>
						<span class="num text-right">
							<span class="text-ink-3">{(p.employee.serviceShareBp / 100).toFixed(0)}% of {money(p.monthlyMinor)} =</span>
							{money(p.serviceMinor)}
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-body-sm text-ink-3">No one on the payroll spends time on the live service in {ymShort(ym)}, or the people records are not loaded yet.</p>
		{/if}
	</section>

	<section class="card flex flex-col gap-3 p-5" aria-labelledby="lines-h">
		<h2 id="lines-h" class="text-title">Usage lines, {ymShort(ym)}</h2>
		<ul class="flex flex-col divide-y divide-line text-body-sm" aria-live="off">
			{#each lines as r (r.id)}
				<li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
					<span class="min-w-0">
						<span class="block font-medium">{PROVIDER_LABEL[r.provider]} · {r.service}</span>
						<span class="block text-caption text-ink-3">
							{ENVIRONMENT_LABEL[r.environment]} · {CATEGORY_LABEL[r.category]}{r.product ? ` · ${r.product}` : ''} · {r.usageQuantity.toLocaleString('en-US')} {r.usageUnit}
						</span>
					</span>
					<span class="flex items-center gap-2">
						{#if r.documentId}<Pill tone="neutral">From upload</Pill>{/if}
						<span class="num">{formatMoney(r.amountMinor)}</span>
					</span>
				</li>
			{:else}
				<li class="py-2 text-ink-3">No usage for {ymShort(ym)}.</li>
			{/each}
		</ul>
	</section>

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<UploadDemo kinds={['cloud_bill', 'model_usage']} title="Upload a cloud bill or usage export" />
		<Integrations categories={['cloud', 'model_usage']} title="Cloud and model providers" />
	</div>
</div>
