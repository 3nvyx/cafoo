<script lang="ts">
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import { normId, parsePayload } from '#lib/data/payload.js';
	import FootprintPanel from '#lib/components/FootprintPanel.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { STATUS, TIER, VERIFICATION, dateTime, drill, shortDate } from '#lib/labels.js';

	const v = $derived(db.vendors().find((x) => x.id === page.params.id));
	const bills = $derived(v ? db.bills().filter((b) => b.vendorId === v.id).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)) : []);
	const open = $derived(bills.filter((b) => b.status !== 'paid'));
	const openMinor = $derived(open.reduce((t, b) => t + toBig(b.amountMinor), 0n).toString());
	/** vendor_block and vendor_verify Proposals that name this vendor ("05" and "5" are the same id). */
	const related = $derived(
		v ? db.proposals().filter((p) => (p.kind === 'vendor_block' || p.kind === 'vendor_verify') && normId(parsePayload(p.payloadJson)?.vendorId) === v.id) : []
	);
	const check = $derived(
		v
			? db
					.creditChecks()
					.filter((k) => k.subjectKind === 'vendor' && k.subjectId === v.id)
					.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0]
			: undefined
	);
</script>

<svelte:head><title>{v?.name ?? 'Vendor'} · Cafoo</title></svelte:head>

<a href="/vendors" class="drill inline-flex min-h-[44px] items-center gap-1 text-sm text-ink-2"><Icon name="chevronLeft" size={16} />Vendors</a>

{#if !v}
	<p class="card mt-4 px-5 py-10 text-center text-ink-3">We could not find that vendor.</p>
{:else}
	<div class="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
		<div class="min-w-0">
			<h1 class="flex items-center gap-2 text-[32px]">
				{#if v.verification === 'blocked'}<Icon name="alert" size={24} class="shrink-0 text-neg" />{/if}{v.name}
			</h1>
			<p class="mt-1 text-ink-2">{v.category}</p>
		</div>
		<Pill tone={VERIFICATION[v.verification].tone}>{VERIFICATION[v.verification].label}</Pill>
	</div>
	{#if v.notePlain}<p class="mt-3 max-w-[70ch] text-[15px] {v.verification === 'blocked' ? 'text-ink' : 'text-ink-2'}">{v.notePlain}</p>{/if}

	<dl class="mt-6 grid grid-cols-2 divide-line border-y border-line sm:grid-cols-3 sm:divide-x">
		<div class="py-4 sm:pr-4"><dt class="eyebrow">Open bills</dt><dd class="num mt-1 text-xl">{open.length}</dd></div>
		<div class="py-4 sm:px-4"><dt class="eyebrow">We owe them</dt><dd class="num mt-1 text-xl"><a class="drill" href={drill({ vendor: v.id }, 'all')}>{formatMoney(openMinor, { whole: true })}</a></dd></div>
		<div class="col-span-2 py-4 sm:col-span-1 sm:pl-4">
			<dt class="eyebrow">Owner check</dt>
			<dd class="mt-1 text-xl">{#if check}<span class="num">{TIER[check.tier]?.label ?? check.tier}</span>{:else}<span class="text-ink-3">None yet</span>{/if}</dd>
			{#if check}<dd class="text-sm text-ink-3">checked {dateTime(check.checkedAt)}</dd>{/if}
		</div>
	</dl>

	<div class="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
		<section aria-labelledby="bills-h">
			<h2 id="bills-h" class="text-2xl">Bills</h2>
			<ul class="mt-4 divide-y divide-line border-y border-line">
				{#each bills as b (b.id)}
					<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-3">
						<span>
							<span class="num block">{b.number}</span>
							<span class="block text-sm text-ink-3">Billed {shortDate(b.issuedAt)}, due {shortDate(b.dueAt)}</span>
						</span>
						<span class="text-right">
							<span class="num block">{formatMoney(b.amountMinor)}</span>
							<Pill tone={b.status === 'paid' ? 'pos' : b.status === 'overdue' ? 'neg' : 'neutral'}>{b.status === 'paid' ? 'Paid' : b.status === 'overdue' ? 'Overdue' : 'Open'}</Pill>
						</span>
					</li>
				{:else}
					<li class="py-6 text-ink-3">No bills.</li>
				{/each}
			</ul>

			{#if related.length}
				<h3 class="mt-8 text-lg">Proposals about this vendor</h3>
				<ul class="mt-2 flex flex-col gap-2">
					{#each related as p (p.id)}
						<li class="flex flex-wrap items-center gap-2 text-[15px]">
							<Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>
							<a class="drill" href="/proposals?status=all#proposal-{p.id}">{p.summaryPlain}</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#key v.id}
			<FootprintPanel kind="vendor" id={v.id} listings={{ yelpUrl: v.yelpUrl, jobBoard: v.jobBoard, linkedinUrl: v.linkedinUrl }} />
		{/key}
	</div>
{/if}
