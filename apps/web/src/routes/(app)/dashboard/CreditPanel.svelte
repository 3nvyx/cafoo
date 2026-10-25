<script lang="ts">
	// Credit: customers per Risk Tier as bars (the tier label carries the status colour, the bars stay neutral), the
	// target Allowance those tiers imply, per currency, and how many vendors may not be paid.
	import { db } from '#lib/data/index.js';
	import { formatMoney } from '#lib/data/money.js';
	import { TIER } from '#lib/labels.js';
	import Pill from '#lib/components/Pill.svelte';
	import { TIERS, allowanceByCurrency, barPct, blockedVendors, tierCounts } from './insights.js';

	const counts = $derived(tierCounts(db.customers(), db.creditChecks()));
	const max = $derived(Math.max(...TIERS.map((t) => counts[t]), counts.unrated, 0));
	const allowance = $derived(allowanceByCurrency(db.customers(), db.creditChecks(), db.invoices(), db.subsidiaries()));
	const blocked = $derived(blockedVendors(db.vendors(), db.creditChecks()));
	const rows = $derived([
		...TIERS.map((t) => ({ key: t, label: TIER[t].label, plain: TIER[t].plain, tone: TIER[t].tone, n: counts[t] })),
		...(counts.unrated ? [{ key: 'none', label: 'Not checked', plain: 'No credit check yet', tone: 'muted' as const, n: counts.unrated }] : [])
	]);
	const total = $derived(rows.reduce((s, r) => s + r.n, 0));
</script>

<section aria-labelledby="credit-h" class="card flex flex-col gap-4 p-5">
	<div class="flex flex-wrap items-baseline justify-between gap-3">
		<h2 id="credit-h" class="text-subtitle">Customer credit</h2>
		<a href="/customers" class="drill text-body-sm text-ink-2">All customers</a>
	</div>

	<ul class="flex flex-col gap-2" aria-label="Customers by Risk Tier">
		{#each rows as r (r.key)}
			<li>
				<a href="/customers" class="group flex items-center gap-3 text-body-sm" aria-label="{r.label}, {r.plain}: {r.n} customer{r.n === 1 ? '' : 's'}" title={r.plain}>
					<span class="w-24 shrink-0"><Pill tone={r.tone}>{r.label}</Pill></span>
					<span class="h-3 flex-1 overflow-hidden rounded-sm bg-subtle"><span class="block h-full rounded-sm bg-ink-3 transition-[width] duration-500 group-hover:bg-ink-2" style="width:{barPct(r.n, max)}%"></span></span>
					<span class="num w-10 shrink-0 text-right text-ink">{r.n}</span>
				</a>
			</li>
		{/each}
	</ul>
	<p class="text-caption text-ink-3">{total} customer{total === 1 ? '' : 's'}; the latest credit check sets each tier</p>

	<dl class="grid grid-cols-2 gap-3 border-t border-line pt-3">
		<div class="flex flex-col">
			<dt class="text-caption text-ink-2">Target Allowance</dt>
			<dd class="num text-title">
				{#if allowance.length}
					{#each allowance as a, i (a.currency)}{i ? ' + ' : ''}<a href="/customers" class="drill">{formatMoney(a.minor, { whole: true, currency: a.currency })}</a>{/each}
				{:else}
					<span class="text-ink-3">None</span>
				{/if}
			</dd>
		</div>
		<div class="flex flex-col">
			<dt class="text-caption text-ink-2">Blocked vendors</dt>
			<dd class="num text-title"><a href="/vendors" class="drill" title={blocked.map((v) => v.name).join(', ')}>{blocked.length}</a></dd>
		</div>
	</dl>
</section>
