<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { periodEnd } from '#lib/data/derive.js';
	import { formatMoney } from '#lib/data/money.js';
	import { normId, parsePayload } from '#lib/data/payload.js';
	import type { Proposal, VendorVerification } from '#lib/data/types.js';
	import FootprintChip from '#lib/components/FootprintChip.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import UploadDemo from '#lib/components/UploadDemo.svelte';
	import { STATUS, VERIFICATION, drill, shortDate } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import { paginate } from '../customers/receivables';
	import { VERIFICATIONS, filterVendorRows, sortVendorRows, topSpend, vendorRows, vendorSummary, type VendorSortKey } from './payables';

	const money = (m: string) => formatMoney(m, { whole: true });
	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const asOf = $derived(period ? periodEnd(period) : '9999-12-31');
	const allRows = $derived(vendorRows(db.vendors(), db.bills(), asOf));
	const summary = $derived(vendorSummary(allRows));
	const spend = $derived(topSpend(allRows, 10));

	/** The latest vendor_block or vendor_verify Proposal per vendor ("05" and "5" are the same id). */
	const ruling = $derived.by(() => {
		const m = new Map<string, Proposal>();
		for (const p of db.proposals()) {
			if (p.kind !== 'vendor_block' && p.kind !== 'vendor_verify') continue;
			const id = normId(parsePayload(p.payloadJson)?.vendorId);
			if (id) m.set(id, p);
		}
		return m;
	});

	let q = $state('');
	let status = $state<VendorVerification | 'all'>('all');
	let openOnly = $state(false);
	let sortKey = $state<VendorSortKey>('status');
	let sortDir = $state<'asc' | 'desc'>('asc');
	let pageNo = $state(1);
	const filtered = $derived(sortVendorRows(filterVendorRows(allRows, { q, status, openOnly }), sortKey, sortDir));
	const paged = $derived(paginate(filtered, pageNo, 25));
	$effect(() => {
		void [q, status, openOnly, sortKey, sortDir];
		pageNo = 1;
	});
	function sortBy(k: VendorSortKey) {
		if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		else {
			sortKey = k;
			sortDir = k === 'name' || k === 'status' ? 'asc' : 'desc';
		}
	}
	const SORTS: { key: VendorSortKey; label: string }[] = [
		{ key: 'status', label: 'Status' },
		{ key: 'name', label: 'Vendor' },
		{ key: 'spend', label: 'Spend' },
		{ key: 'open', label: 'Open bills' }
	];
</script>

<svelte:head><title>Vendors · Cafoo</title></svelte:head>

<div class="flex flex-col gap-6">
	<header class="flex flex-col gap-2">
		<h1 class="text-display-sm sm:text-display">Vendors</h1>
		<p class="max-w-prose text-body text-ink-2">
			Who we pay, and whether we trust their details. Credit & Risk checks the owner behind each new vendor before the first payment; a blocked vendor is never paid.
		</p>
	</header>

	<dl class="grid grid-cols-2 gap-4 lg:grid-cols-4">
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">Spend</dt>
			<dd class="num text-title font-medium">{money(summary.billedMinor)}</dd>
			<dd class="text-caption text-ink-3">Billed by {allRows.length} vendors{asOf === '9999-12-31' ? '' : ` through ${shortDate(asOf)}`}</dd>
		</div>
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">We owe</dt>
			<dd class="num text-title font-medium"><a class="drill" href={drill({ account: '2000' }, 'all')}>{money(summary.openMinor)}</a></dd>
			<dd class="text-caption text-ink-3">{summary.openBills} open bill{summary.openBills === 1 ? '' : 's'}, {money(summary.overdueMinor)} past due</dd>
		</div>
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">Paid</dt>
			<dd class="num text-title font-medium">{money(summary.paidMinor)}</dd>
			<dd class="text-caption text-ink-3">{summary.paidBills} bill{summary.paidBills === 1 ? '' : 's'} paid</dd>
		</div>
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">Verification</dt>
			<dd class="flex flex-wrap gap-1">
				{#each VERIFICATIONS as v (v)}
					<button class="contents" onclick={() => (status = status === v ? 'all' : v)} aria-pressed={status === v}>
						<Pill tone={VERIFICATION[v].tone}>{summary.byVerification[v]} {v === 'unverified' ? 'unchecked' : VERIFICATION[v].label.toLowerCase()}</Pill>
					</button>
				{/each}
			</dd>
			<dd class="text-caption text-ink-3">{summary.byVerification.blocked ? `${money(summary.blockedOpenMinor)} held from blocked vendors` : 'No vendor is blocked'}</dd>
		</div>
	</dl>

	{#if spend.length}
		<section class="card flex flex-col gap-3 p-4" aria-labelledby="spend-h">
			<h2 id="spend-h" class="text-subtitle">Spend by vendor</h2>
			<ul class="flex flex-col gap-2">
				{#each spend as s (s.vendor.id)}
					<li class="grid grid-cols-1 gap-1 sm:grid-cols-3 sm:items-center sm:gap-3">
						<a class="drill truncate text-body-sm" href="/vendors/{s.vendor.id}">{s.vendor.name}</a>
						<span class="flex items-center gap-2 sm:col-span-2">
							<span class="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle">
								<span class="block h-full rounded-full {s.vendor.verification === 'blocked' ? 'bg-neg' : 'bg-info'}" style:width="{s.widthBp / 100}%"></span>
							</span>
							<span class="num w-24 text-right text-body-sm">{money(s.billedMinor)}</span>
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<div class="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
		<label class="flex flex-col gap-1 text-body-sm text-ink-2 lg:w-72">
			Search
			<input class="field text-ink" type="search" bind:value={q} placeholder="Vendor name or category" />
		</label>
		<div class="flex flex-wrap gap-2" role="group" aria-label="Filter by verification">
			<button class="chip" aria-pressed={status === 'all'} onclick={() => (status = 'all')}>All</button>
			{#each VERIFICATIONS as v (v)}
				<button class="chip" aria-pressed={status === v} onclick={() => (status = v)}>{v === 'unverified' ? 'Unchecked' : VERIFICATION[v].label}</button>
			{/each}
			<button class="chip" aria-pressed={openOnly} onclick={() => (openOnly = !openOnly)}>{#if openOnly}<Icon name="check" size={16} />{/if}With open bills</button>
		</div>
		<p class="text-body-sm text-ink-3 lg:ml-auto" aria-live="polite">{filtered.length} of {allRows.length} vendors</p>
	</div>

	<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Sort by">
		<span class="text-body-sm text-ink-3">Sort</span>
		{#each SORTS as s (s.key)}
			<button class="chip" aria-pressed={sortKey === s.key} onclick={() => sortBy(s.key)}
				>{s.label}{#if sortKey === s.key}<Icon name={sortDir === 'asc' ? 'arrowUp' : 'arrowDown'} size={14} />{/if}</button
			>
		{/each}
	</div>

	<div class="border-t border-line">
		<div class="hidden gap-4 border-b border-line py-2 text-body-sm text-ink-3 md:flex">
			<span class="min-w-40 flex-1">Vendor</span><span class="w-28">Status</span><span class="w-28 text-right">Spend</span><span class="w-32 text-right">Bills open / paid</span><span class="w-28 text-right">We owe</span>
		</div>
		<ul>
			{#each paged.rows as r (r.vendor.id)}
				{@const v = r.vendor}
				{@const p = ruling.get(v.id)}
				<li id="vendor-{v.id}" class="scroll-mt-24 border-b border-line py-3 {v.verification === 'blocked' ? 'bg-neg-soft px-3' : ''}">
					<div class="flex flex-wrap items-start gap-x-4 gap-y-1 md:flex-nowrap md:items-center">
						<div class="min-w-40 flex-1">
							<p class="flex items-center gap-2 font-medium">
								{#if v.verification === 'blocked'}<Icon name="alert" size={18} class="shrink-0 text-on-neg-soft" />{/if}
								<a class="drill truncate" href="/vendors/{v.id}">{v.name}</a>
							</p>
							<p class="text-body-sm text-ink-3">{v.category}{r.lastBilledAt ? ` · last bill ${shortDate(r.lastBilledAt)}` : ''}</p>
							<FootprintChip kind="vendor" id={v.id} class="max-w-full" />
						</div>
						<span class="md:w-28"><Pill tone={VERIFICATION[v.verification].tone}>{v.verification === 'unverified' ? 'Unchecked' : VERIFICATION[v.verification].label}</Pill></span>
						<span class="basis-full text-body-sm text-ink-2 md:hidden">{`Spend ${money(r.billedMinor)} · ${r.openCount} open, ${r.paidCount} paid · we owe ${money(r.openMinor)}`}</span>
						<span class="num hidden w-28 text-right text-body md:block">{money(r.billedMinor)}</span>
						<span class="num hidden w-32 text-right text-body text-ink-2 md:block">{r.openCount} / {r.paidCount}</span>
						<a class="drill num hidden w-28 text-right text-body md:block" href={drill({ vendor: v.id }, 'all')}>{money(r.openMinor)}</a>
					</div>
					{#if v.notePlain}<p class="mt-2 max-w-prose text-body-sm {v.verification === 'blocked' ? 'text-on-neg-soft' : 'text-ink-2'}">{v.verification === 'blocked' ? 'Blocked: ' : ''}{v.notePlain}</p>{/if}
					{#if p}
						<p class="mt-2 flex flex-wrap items-center gap-2 text-body-sm">
							<Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>
							<a class="drill text-ink-2" href="/proposals?status=all#proposal-{p.id}">{p.summaryPlain}</a>
						</p>
					{/if}
				</li>
			{:else}
				<li class="py-10 text-center text-ink-3">No vendors match.</li>
			{/each}
		</ul>
		{#if paged.pages > 1}
			<nav class="flex flex-wrap items-center justify-between gap-2 py-3" aria-label="Vendor pages">
				<button class="chip" disabled={paged.page <= 1} onclick={() => (pageNo = paged.page - 1)}><Icon name="chevronLeft" size={16} />Previous</button>
				<span class="text-body-sm text-ink-2">Page {paged.page} of {paged.pages}</span>
				<button class="chip" disabled={paged.page >= paged.pages} onclick={() => (pageNo = paged.page + 1)}>Next<Icon name="chevronRight" size={16} /></button>
			</nav>
		{/if}
	</div>

	<UploadDemo kinds={['bills']} title="Upload vendor bills" />
</div>
