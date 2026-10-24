<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import { normId, parsePayload } from '#lib/data/payload.js';
	import Icon from '#lib/components/Icon.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { STATUS, VERIFICATION, drill } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';

	const ORDER = { blocked: 0, unverified: 1, verified: 2 } as const;
	/** The vendor a vendor_block or vendor_verify Proposal names ("05" and "5" are the same id), or undefined. */
	const vendorOf = (json: string): string | undefined => normId(parsePayload(json)?.vendorId);
	const rows = $derived(
		db
			.vendors()
			.map((v) => {
				const open = db.bills().filter((b) => b.vendorId === v.id && b.status !== 'paid');
				const vendorProposal = db.proposals().findLast((p) => (p.kind === 'vendor_block' || p.kind === 'vendor_verify') && vendorOf(p.payloadJson) === v.id);
				return { v, openCount: open.length, openMinor: open.reduce((t, b) => t + toBig(b.amountMinor), 0n).toString(), vendorProposal };
			})
			.sort((a, b) => ORDER[a.v.verification] - ORDER[b.v.verification] || a.v.name.localeCompare(b.v.name))
	);
	const blocked = $derived(rows.filter((r) => r.v.verification === 'blocked').length);
</script>

<svelte:head><title>Vendors · Cafoo</title></svelte:head>

<h1 class="text-[34px] sm:text-[42px]">Vendors</h1>
<p class="mt-2 max-w-[60ch] text-ink-2">
	Who we pay, and whether we trust their details. {blocked ? `${blocked} vendor${blocked === 1 ? ' is' : 's are'} blocked from payment.` : ''}
</p>

<ul class="mt-6 border-t border-line">
	{#each rows as { v, openCount, openMinor, vendorProposal } (v.id)}
		<li id="vendor-{v.id}" class="scroll-mt-24 border-b border-line py-4 {v.verification === 'blocked' ? 'border-l-2 border-l-neg bg-neg-soft/50 pl-3' : ''}">
			<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 md:grid-cols-[minmax(0,1.5fr)_140px_110px_150px] md:items-center">
				<div class="min-w-0">
					<p class="flex items-center gap-2 font-medium">
						{#if v.verification === 'blocked'}<Icon name="alert" size={18} class="shrink-0 text-neg" />{/if}
						<span class="truncate">{v.name}</span>
					</p>
					<p class="text-sm text-ink-3">{v.category}{#if ui.expert}<span class="num"> · {v.id}</span>{/if}</p>
				</div>
				<span class="justify-self-end md:justify-self-start"><Pill tone={VERIFICATION[v.verification].tone}>{VERIFICATION[v.verification].label}</Pill></span>
				<span class="text-sm text-ink-2 md:text-[15px]">{openCount} open bill{openCount === 1 ? '' : 's'}</span>
				<a class="drill num text-right md:text-[15px]" href={drill({ vendor: v.id }, 'all')}>{formatMoney(openMinor, { whole: true })}</a>
			</div>
			{#if v.notePlain}<p class="mt-2 max-w-[70ch] text-[15px] {v.verification === 'blocked' ? 'text-ink' : 'text-ink-2'}">{v.notePlain}</p>{/if}
			{#if vendorProposal}
				<p class="mt-2 flex flex-wrap items-center gap-2 text-sm">
					<Pill tone={STATUS[vendorProposal.status].tone}>{STATUS[vendorProposal.status].label}</Pill>
					<a class="drill text-ink-2" href="/proposals?status=all#proposal-{vendorProposal.id}">{vendorProposal.summaryPlain}</a>
				</p>
			{/if}
		</li>
	{/each}
</ul>
