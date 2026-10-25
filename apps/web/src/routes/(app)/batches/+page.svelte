<script lang="ts">
	// Batches: prepaid credit packs customers bought and stock lots the company holds. Credits draw down live as
	// customers use Copilot; a pack that expires with credits left becomes breakage revenue, an expired lot a write-off,
	// each through a Proposal.
	import { db } from '#lib/data/index.js';
	import { ymShort } from '#lib/data/derive.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { Batch } from '#lib/data/types.js';
	import { batchStatus, breakage, creditTotals, expiringSoon, unusedValue, usedBp, type BatchStatus } from '#lib/costs.js';
	import Notice from '#lib/components/Notice.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { shortDate, type Tone } from '#lib/labels.js';
	import KpiCard from '../dashboard/KpiCard.svelte';
	import Freshness from '../costs/Freshness.svelte';

	const money = (m: string | bigint) => formatMoney(m.toString(), { whole: true });

	// The demo clock, refreshed each second so expiries and "expires in" move on their own.
	let now = $state(db.now());
	$effect(() => {
		const t = setInterval(() => (now = db.now()), 1000);
		return () => clearInterval(t);
	});

	const batches = $derived(db.batches());
	const packs = $derived(batches.filter((b) => b.kind === 'credit_pack'));
	const lots = $derived(batches.filter((b) => b.kind === 'stock_lot'));
	const totals = $derived(creditTotals(batches, now));
	const month = $derived(now.slice(0, 7));
	const thisBreakage = $derived(breakage(batches, month, now));
	const soon = $derived(expiringSoon(batches, now));
	const onHand = $derived(lots.filter((b) => batchStatus(b, now) !== 'expired').reduce((t, b) => t + toBig(unusedValue(b)), 0n));

	const customerName = (id?: string) => db.customers().find((c) => c.id === id)?.name ?? 'Unknown customer';
	const vendorName = (id?: string) => db.vendors().find((v) => v.id === id)?.name ?? 'Unknown vendor';

	// The Proposal an expiry led to, if any.
	const proposalFor = (b: Batch) => db.proposals().find((p) => (p.kind === 'credit_breakage' || p.kind === 'inventory_writeoff') && p.payloadJson.includes(`"batchId":"${b.id}"`));

	const STATUS: Record<BatchStatus, { label: string; tone: Tone }> = {
		active: { label: 'Active', tone: 'pos' },
		expiring: { label: 'Expiring soon', tone: 'warn' },
		expired: { label: 'Expired', tone: 'neg' },
		depleted: { label: 'Used up', tone: 'muted' }
	};

	function expiresText(b: Batch): string {
		if (!b.expiresAt) return 'No expiry';
		const ms = Date.parse(b.expiresAt) - Date.parse(now);
		if (ms <= 0) return `Expired ${dated(b.expiresAt)}`;
		const mins = Math.round(ms / 60000);
		if (mins < 60) return `Expires in ${mins} min`;
		const days = Math.round(ms / 86_400_000);
		return days <= 1 ? 'Expires within a day' : days <= 45 ? `Expires in ${days} days` : `Expires ${dated(b.expiresAt)}`;
	}
	/** "Sep 2", with the year when it is not this year's. */
	const dated = (iso: string) => (iso.slice(0, 4) === now.slice(0, 4) ? shortDate(iso) : `${shortDate(iso)}, ${iso.slice(0, 4)}`);
	const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
</script>

<svelte:head><title>Batches · Luyten</title></svelte:head>

{#snippet row(b: Batch, who: string, from?: string)}
	{@const st = batchStatus(b, now)}
	{@const pr = proposalFor(b)}
	<li class="flex flex-col gap-2 py-3">
		<div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
			<span class="min-w-0">
				<span class="block font-medium">{who}</span>
				<span class="block text-caption text-ink-3">{from ?? b.name} · {b.sku} · bought {dated(b.acquiredAt)}</span>
			</span>
			<span class="flex items-center gap-2">
				<Pill tone={STATUS[st].tone}>{STATUS[st].label}</Pill>
				<span class="num text-body-sm">{money(unusedValue(b))}</span>
			</span>
		</div>
		<div class="flex flex-col gap-1">
			<div class="h-1.5 w-full rounded-sm bg-subtle" role="img" aria-label="{qty(b.remaining)} of {qty(b.quantity)} {b.unit} left">
				<div class="h-1.5 rounded-sm bg-ink-3" style="width: {100 - usedBp(b) / 100}%"></div>
			</div>
			<div class="flex flex-wrap justify-between gap-x-4 text-caption text-ink-3">
				<span class="num">{qty(b.remaining)} of {qty(b.quantity)} {b.unit} left</span>
				<span>{expiresText(b)}</span>
			</div>
		</div>
		{#if pr}
			<a class="drill text-body-sm text-ink-2" href="/proposals?status=all#proposal-{pr.id}">{pr.kind === 'credit_breakage' ? 'Breakage' : 'Write-off'} proposed: {money(pr.amountMinor)}</a>
		{/if}
	</li>
{/snippet}

<div class="flex flex-col gap-8">
	<header class="flex flex-col gap-2">
		<h1 class="text-display-sm sm:text-display">Batches</h1>
		<p class="max-w-prose text-body text-ink-2">
			Prepaid credit packs customers bought, and stock the company holds. Unused credits are money we owe as usage; credits left when a pack expires become breakage revenue, and expired stock is written off.
		</p>
		<Freshness ids={['stripe']} label="Usage live" />
	</header>

	<section aria-label="Batch figures" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
		<KpiCard label="Unused credits" value={money(totals.unusedMinor)} hint="Left to use; usage is booked to 2450 at month end" />
		<KpiCard label="Expiring in 30 days" value={money(totals.expiringMinor)} hint="{soon.filter((b) => b.kind === 'credit_pack').length} credit packs" />
		<KpiCard label="Breakage, {ymShort(month)}" value={money(thisBreakage.amountMinor)} hint="{thisBreakage.packs.length} {thisBreakage.packs.length === 1 ? 'pack' : 'packs'} expired this month with credits left" />
		<KpiCard label="Stock on hand" value={money(onHand)} hint="At cost (1300)" />
	</section>

	{#if soon.length}
		<Notice tone="warn" title="Expiring soon">
			{soon.map((b) => `${b.kind === 'credit_pack' ? customerName(b.customerId) : b.name} (${expiresText(b).toLowerCase()})`).join('; ')}.
		</Notice>
	{/if}

	<section class="card flex flex-col gap-1 p-5" aria-labelledby="packs-h">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h2 id="packs-h" class="text-title">Credit packs</h2>
			<span class="text-caption text-ink-3">Sold {money(totals.soldMinor)} · used {money(totals.usedMinor)}</span>
		</div>
		<ul class="flex flex-col divide-y divide-line" aria-live="off">
			{#each packs as b (b.id)}
				{@render row(b, customerName(b.customerId))}
			{:else}
				<li class="py-3 text-body-sm text-ink-3">No credit packs sold yet.</li>
			{/each}
		</ul>
	</section>

	<section class="card flex flex-col gap-1 p-5" aria-labelledby="lots-h">
		<h2 id="lots-h" class="text-title">Stock lots</h2>
		<ul class="flex flex-col divide-y divide-line">
			{#each lots as b (b.id)}
				{@render row(b, b.name, `From ${vendorName(b.vendorId)}`)}
			{:else}
				<li class="py-3 text-body-sm text-ink-3">No stock on hand.</li>
			{/each}
		</ul>
	</section>
</div>
