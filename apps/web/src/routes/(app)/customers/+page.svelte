<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { contractArr, openReceivable, periodEnd } from '#lib/data/derive.js';
	import { formatMoney } from '#lib/data/money.js';
	import type { RiskTier } from '#lib/data/types.js';
	import FootprintChip from '#lib/components/FootprintChip.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { TIER } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';

	let q = $state('');
	let tier = $state<RiskTier | 'all' | 'none'>('all');
	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const asOf = $derived(period ? periodEnd(period) : '9999-12-31');
	const rows = $derived(
		db
			.customers()
			.filter((c) => (tier === 'all' ? true : tier === 'none' ? !c.creditTier : c.creditTier === tier))
			.filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()))
			.map((c) => ({ c, ar: openReceivable(db.invoices(), c.id), arr: contractArr(db.contracts(), c.id, asOf) }))
			.sort((a, b) => a.c.name.localeCompare(b.c.name))
	);
	const TIERS: (RiskTier | 'all' | 'none')[] = ['all', 'A', 'B', 'C', 'D', 'BLOCK', 'none'];
</script>

<svelte:head><title>Customers · Cafoo</title></svelte:head>

<h1 class="text-[32px]">Customers</h1>
<p class="mt-2 max-w-[60ch] text-ink-2">Each customer is a small business with an owner who guarantees the account. Their Risk Tier sets payment terms and the Allowance.</p>

<div class="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
	<label class="flex flex-col gap-1 text-sm text-ink-2 sm:w-[280px]">
		Search
		<input class="field text-ink" type="search" bind:value={q} placeholder="Customer name" />
	</label>
	<div class="flex flex-wrap gap-2" role="group" aria-label="Filter by Risk Tier">
		{#each TIERS as t (t)}
			<button
				class="min-h-[44px] rounded-full border px-3.5 text-sm transition-colors duration-150 {tier === t ? 'border-ink bg-ink text-canvas' : 'border-line-strong text-ink-2 hover:text-ink'}"
				aria-pressed={tier === t}
				onclick={() => (tier = t)}>{t === 'all' ? 'All' : t === 'none' ? 'Not checked' : TIER[t].label}</button
			>
		{/each}
	</div>
</div>

<div class="mt-6 border-t border-line">
	<div class="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_110px_90px_120px] gap-4 border-b border-line py-2 text-sm text-ink-3 md:grid xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_150px_110px_90px_120px]">
		<span>Customer</span><span>Guarantor</span><span class="hidden xl:block">Public footprint</span><span>Risk Tier</span><span class="text-right">Terms</span><span class="text-right">Owed to us</span>
	</div>
	<ul>
		{#each rows as { c, ar } (c.id)}
			<li class="border-b border-line">
				<a href="/customers/{c.id}" class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-3 hover:bg-subtle/60 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_110px_90px_120px] md:items-center xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_150px_110px_90px_120px]">
					<span class="min-w-0">
						<span class="block truncate font-medium">{c.name}</span>
						<span class="block truncate text-sm text-ink-3">{c.domain}</span>
						<FootprintChip kind="customer" id={c.id} class="max-w-full xl:hidden" />
					</span>
					<span class="order-3 truncate text-sm text-ink-2 md:order-none md:text-[15px]">{c.guarantorName}</span>
					<span class="hidden min-w-0 xl:block"><FootprintChip kind="customer" id={c.id} class="max-w-full" /></span>
					<span class="order-2 justify-self-end md:order-none md:justify-self-start">
						{#if c.creditTier}<Pill tone={TIER[c.creditTier].tone}>{TIER[c.creditTier].label}</Pill>{:else}<Pill tone="muted">Not checked</Pill>{/if}
					</span>
					<span class="num order-4 text-right text-sm text-ink-2 md:order-none md:text-[15px]">{c.paymentTermsDays === 0 ? 'Prepay' : `${c.paymentTermsDays} days`}</span>
					<span class="num order-5 col-span-2 text-sm md:order-none md:col-span-1 md:text-right md:text-[15px]"><span class="text-ink-3 md:hidden">Owed </span>{formatMoney(ar, { whole: true })}</span>
				</a>
			</li>
		{:else}
			<li class="py-10 text-center text-ink-3">No customers match.</li>
		{/each}
	</ul>
</div>
