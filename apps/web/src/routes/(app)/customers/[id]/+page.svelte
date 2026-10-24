<script lang="ts">
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { ALLOWANCE_RATE_BP, allowanceFor, bucketOf, contractArr, openReceivable, periodEnd, AGING_LABEL } from '#lib/data/derive.js';
	import { formatMoney } from '#lib/data/money.js';
	import Pill from '#lib/components/Pill.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { STATUS, TIER, dateTime, drill, shortDate } from '#lib/labels.js';
	import { customerIdsOf } from '#lib/proposals.js';
	import { ui } from '#lib/ui.svelte.js';

	const c = $derived(db.customers().find((x) => x.id === page.params.id));
	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const asOf = $derived(period ? periodEnd(period) : '9999-12-31');
	const invoices = $derived(c ? db.invoices().filter((i) => i.customerId === c.id).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)) : []);
	const checks = $derived(c ? db.creditChecks().filter((k) => k.subjectKind === 'customer' && k.subjectId === c.id).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)) : []);
	const latest = $derived(checks[0]);
	const summary = $derived.by(() => {
		if (!latest) return null;
		try {
			return JSON.parse(latest.summaryJson) as Record<string, string | number>;
		} catch {
			return null;
		}
	});
	const ar = $derived(c ? openReceivable(db.invoices(), c.id) : '0');
	const allowance = $derived(c ? allowanceFor(c, db.invoices()) : '0');
	const arr = $derived(c ? contractArr(db.contracts(), c.id, asOf) : '0');
	// Only customer-bearing payload fields count: a subsidiary, vendor or bank line with the same id is not this customer.
	const related = $derived(c ? db.proposals().filter((p) => customerIdsOf(p, db).has(c.id)) : []);

	const FACTS: { key: string; label: string }[] = [
		{ key: 'identity', label: 'Identity' },
		{ key: 'fraud', label: 'Fraud risk' },
		{ key: 'creditBand', label: 'Credit band' },
		{ key: 'scoreRange', label: 'Score range' },
		{ key: 'latePayments90d', label: 'Late payments, 90 days' },
		{ key: 'publicRecords', label: 'Public records' }
	];
</script>

<svelte:head><title>{c?.name ?? 'Customer'} · Cafoo</title></svelte:head>

<a href="/customers" class="drill inline-flex min-h-[44px] items-center gap-1 text-sm text-ink-2"><Icon name="chevronLeft" size={16} />Customers</a>

{#if !c}
	<p class="card mt-4 px-5 py-10 text-center text-ink-3">We could not find that customer.</p>
{:else}
	<div class="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
		<div>
			<h1 class="text-[32px]">{c.name}</h1>
			<p class="mt-1 text-ink-2">{c.domain} · owner {c.guarantorName}{#if ui.expert}<span class="num text-ink-3"> · {c.id} · {c.guarantorPersonaId}</span>{/if}</p>
		</div>
		{#if c.creditTier}<Pill tone={TIER[c.creditTier].tone}>{TIER[c.creditTier].label} · {TIER[c.creditTier].plain}</Pill>{/if}
	</div>

	<dl class="mt-6 grid grid-cols-2 divide-line border-y border-line sm:grid-cols-4 sm:divide-x">
		<div class="py-4 sm:pr-4"><dt class="eyebrow">Payment terms</dt><dd class="num mt-1 text-xl">{c.paymentTermsDays === 0 ? 'Prepay' : `${c.paymentTermsDays} days`}</dd></div>
		<div class="py-4 sm:px-4"><dt class="eyebrow">ARR</dt><dd class="num mt-1 text-xl">{formatMoney(arr, { whole: true })}</dd></div>
		<div class="py-4 sm:px-4"><dt class="eyebrow">Owed to us</dt><dd class="num mt-1 text-xl"><a class="drill" href={drill({ customer: c.id }, 'all')}>{formatMoney(ar, { whole: true })}</a></dd></div>
		<div class="py-4 sm:pl-4">
			<dt class="eyebrow">Allowance</dt>
			<dd class="num mt-1 text-xl"><a class="drill" href={drill({ account: '1150' }, 'all')}>{formatMoney(allowance, { whole: true })}</a></dd>
			{#if c.creditTier}<dd class="text-sm text-ink-3">{ALLOWANCE_RATE_BP[c.creditTier] / 100}% of what they owe, from {TIER[c.creditTier].label}</dd>{/if}
		</div>
	</dl>

	<div class="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
		<section aria-labelledby="cc-h">
			<h2 id="cc-h" class="text-2xl">Guarantor Credit Check</h2>
			{#if latest && summary}
				<p class="mt-1 text-sm text-ink-3">{c.guarantorName} · checked {dateTime(latest.checkedAt)}</p>
				<p class="mt-4 text-lg">{summary.recommendationPlain}</p>
				<dl class="mt-4 divide-y divide-line border-y border-line">
					{#each FACTS as f (f.key)}
						{#if summary[f.key] !== undefined}
							<div class="flex justify-between gap-4 py-2.5 text-[15px]"><dt class="text-ink-2">{f.label}</dt><dd class="text-right">{summary[f.key]}</dd></div>
						{/if}
					{/each}
				</dl>
				{#if ui.expert}
					<p class="num mt-3 text-xs text-ink-3">request {latest.requestId} · persona {latest.personaId} · tier {latest.tier}</p>
					<pre class="mt-2 overflow-x-auto rounded-btn bg-subtle p-3 font-mono text-xs leading-5">{JSON.stringify(summary, null, 2)}</pre>
				{/if}
				{#if checks.length > 1}<p class="mt-3 text-sm text-ink-3">{checks.length - 1} earlier check{checks.length > 2 ? 's' : ''} on file.</p>{/if}
			{:else}
				<p class="mt-3 text-ink-2">No Credit Check yet. Credit & Risk runs one on the owner before extending terms.</p>
			{/if}

			{#if related.length}
				<h3 class="mt-8 text-lg">Proposals about this customer</h3>
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

		<section aria-labelledby="inv-h">
			<h2 id="inv-h" class="text-2xl">Invoices</h2>
			<ul class="mt-4 divide-y divide-line border-y border-line">
				{#each invoices as i (i.id)}
					<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-3">
						<span>
							<span class="num block">{i.number}</span>
							<span class="block text-sm text-ink-3">Issued {shortDate(i.issuedAt)}, due {shortDate(i.dueAt)}{#if i.status !== 'paid'} · {AGING_LABEL[bucketOf(i, asOf)]}{/if}</span>
						</span>
						<span class="text-right">
							<span class="num block">{formatMoney(i.amountMinor)}</span>
							<Pill tone={i.status === 'paid' ? 'pos' : i.status === 'overdue' ? 'neg' : 'neutral'}>{i.status === 'paid' ? 'Paid' : i.status === 'overdue' ? 'Overdue' : 'Open'}</Pill>
						</span>
					</li>
				{:else}
					<li class="py-6 text-ink-3">No invoices.</li>
				{/each}
			</ul>
		</section>
	</div>
{/if}
