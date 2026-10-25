<script lang="ts">
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { ALLOWANCE_RATE_BP, daysBetween, periodEnd, ymShort } from '#lib/data/derive.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import FootprintPanel from '#lib/components/FootprintPanel.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import { STATUS, TIER, dateTime, drill, roleName, shortDate, KIND } from '#lib/labels.js';
	import { customerIdsOf, scheduleLinesOf, parsePayload } from '#lib/proposals.js';
	import { ui } from '#lib/ui.svelte.js';
	import { AR_BUCKETS, AR_BUCKET_LABEL, SEGMENT_LABEL, customerRows, invoicedByMonth, isOpenAt, paymentsFor, bucketForDays, type ArBucket } from '../receivables';
	import { checksFor, parseCheckSummary } from '../credit-summary';

	const money = (m: string) => formatMoney(m, { whole: true });
	const c = $derived(db.customers().find((x) => x.id === page.params.id));
	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const asOf = $derived(period ? periodEnd(period) : '9999-12-31');
	const row = $derived(c ? customerRows([c], db.invoices(), db.contracts(), asOf)[0] : undefined);
	const invoices = $derived(c ? db.invoices().filter((i) => i.customerId === c.id).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)) : []);
	const contracts = $derived(c ? db.contracts().filter((k) => k.customerId === c.id).sort((a, b) => b.startAt.localeCompare(a.startAt)) : []);
	const payments = $derived(paymentsFor('invoice', new Set(invoices.map((i) => i.id)), db.bankMatches(), db.bankTransactions()));
	const paidBy = $derived(new Map(payments.map((p) => [p.targetId, p])));
	const trend = $derived(invoicedByMonth(invoices, 12));
	const trendMax = $derived(trend.reduce((m, t) => (toBig(t.amountMinor) > m ? toBig(t.amountMinor) : m), 0n));

	// Credit: the latest CRS cascade on the owner, every row of it, and the latest credit decision Proposal.
	const checks = $derived(c ? checksFor(db.creditChecks(), 'customer', c.id) : []);
	const latest = $derived(checks[0]);
	const latestSummary = $derived(latest ? parseCheckSummary(latest.summaryJson) : undefined);
	// Live checks store one row per cascade product; rows recorded within a day of the latest belong to the same run.
	const cascade = $derived(latest ? checks.filter((k) => Math.abs(daysBetween(k.checkedAt, latest.checkedAt)) <= 1) : []);
	const related = $derived(c ? db.proposals().filter((p) => customerIdsOf(p, db).has(c.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []);
	const decision = $derived(related.find((p) => p.kind === 'credit_decision'));
	const decisionTerms = $derived.by(() => {
		const pl = decision ? parsePayload(decision.payloadJson) : null;
		if (!pl) return undefined;
		const days = typeof pl.paymentTermsDays === 'number' ? pl.paymentTermsDays : undefined;
		const tier = typeof pl.tier === 'string' ? pl.tier : undefined;
		return { days, tier };
	});

	// Revenue Schedules about this customer, summed per month across their lines.
	const schedule = $derived.by(() => {
		if (!c) return [];
		const by = new Map<string, { ym: string; amount: bigint; status: string }>();
		for (const p of related) {
			if (p.kind !== 'revenue_schedule' || p.status === 'superseded' || p.status === 'rejected') continue;
			for (const l of scheduleLinesOf(parsePayload(p.payloadJson))) {
				if (l.customerId && l.customerId !== c.id) continue;
				const cur = by.get(l.ym) ?? { ym: l.ym, amount: 0n, status: STATUS[p.status].label };
				cur.amount += toBig(l.amountMinor);
				by.set(l.ym, cur);
			}
		}
		return [...by.values()].sort((a, b) => a.ym.localeCompare(b.ym));
	});

	// The debate behind each related Proposal.
	const messagesBy = $derived.by(() => {
		const ids = new Set(related.map((p) => p.id));
		const m = new Map<string, ReturnType<typeof db.agentMessages>>();
		for (const msg of db.agentMessages()) {
			if (!msg.proposalId || !ids.has(msg.proposalId)) continue;
			const arr = m.get(msg.proposalId) ?? [];
			arr.push(msg);
			m.set(msg.proposalId, arr);
		}
		return m;
	});

	const BUCKET_FILL: Record<ArBucket, string> = { '0-30': 'bg-info', '31-60': 'bg-warn-soft', '61-90': 'bg-warn', '90+': 'bg-neg' };
	const daysLate = (dueAt: string) => Math.max(0, daysBetween(dueAt, asOf));
	const agingNote = (dueAt: string) => {
		const n = daysLate(dueAt);
		return n ? `${n} day${n === 1 ? '' : 's'} late, in the ${AR_BUCKET_LABEL[bucketForDays(n)].toLowerCase()} bucket` : 'not yet due';
	};
</script>

<svelte:head><title>{c?.name ?? 'Customer'} · Cafoo</title></svelte:head>

<a href="/customers" class="drill inline-flex min-h-11 items-center gap-1 text-body-sm text-ink-2"><Icon name="chevronLeft" size={16} />Customers</a>

{#if !c || !row}
	<p class="card mt-4 px-5 py-10 text-center text-ink-3">We could not find that customer.</p>
{:else}
	<div class="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
		<div class="min-w-0">
			<h1 class="text-display-sm sm:text-display">{c.name}</h1>
			<p class="mt-1 text-body text-ink-2">{c.domain} · owner and guarantor {c.guarantorName}</p>
			<p class="mt-1 flex flex-wrap items-center gap-2 text-body-sm">
				<Pill tone="neutral">{SEGMENT_LABEL[row.segment]}</Pill>
				<a class="drill text-ink-2" href={drill({ customer: c.id }, 'all')}>Journal lines for this customer</a>
			</p>
		</div>
		{#if c.creditTier}<Pill tone={TIER[c.creditTier].tone}>{TIER[c.creditTier].label} · {TIER[c.creditTier].plain}</Pill>{:else}<Pill tone="muted">Not checked</Pill>{/if}
	</div>

	<dl class="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
		<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">ARR</dt><dd class="num text-title">{money(row.arrMinor)}</dd><dd class="text-caption text-ink-3">{contracts.length} contract{contracts.length === 1 ? '' : 's'} on file</dd></div>
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">Owed to us</dt>
			<dd class="num text-title"><a class="drill" href="#inv-h">{money(row.openMinor)}</a></dd>
			<dd class="text-caption text-ink-3">{row.openInvoices} open invoice{row.openInvoices === 1 ? '' : 's'} · {c.paymentTermsDays === 0 ? 'prepay' : `${c.paymentTermsDays}-day terms`}</dd>
		</div>
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">Overdue</dt>
			<dd class="num text-title">{money(row.overdueMinor)}</dd>
			<dd class="text-caption text-ink-3">{row.daysOverdue ? `Oldest ${row.daysOverdue} days late` : 'Nothing late'}</dd>
		</div>
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">Target allowance</dt>
			<dd class="num text-title">{money(row.allowanceMinor)}</dd>
			<dd class="text-caption text-ink-3">{c.creditTier ? `${ALLOWANCE_RATE_BP[c.creditTier] / 100}% of what they owe, from ${TIER[c.creditTier].label}. Not a posted entry.` : 'No Risk Tier yet, so no estimate.'}</dd>
		</div>
	</dl>

	<div class="mt-8 grid gap-8 xl:grid-cols-2 xl:items-start">
		<div class="flex min-w-0 flex-col gap-8">
			<section aria-labelledby="cc-h" class="card flex flex-col gap-3 p-4">
				<h2 id="cc-h" class="text-title">Credit</h2>
				{#if latest && latestSummary}
					<div class="flex flex-wrap items-center gap-2">
						<Pill tone={TIER[latest.tier]?.tone ?? 'neutral'}>{TIER[latest.tier]?.label ?? latest.tier}</Pill>
						<span class="text-body-sm text-ink-2">{latestSummary.owner ?? c.guarantorName} · checked {dateTime(latest.checkedAt)}</span>
					</div>
					{#if latestSummary.headline}<p class="text-body">{latestSummary.headline}</p>{/if}
					{#if latestSummary.reasons.length}
						<ul class="list-disc pl-5 text-body-sm text-ink-2">
							{#each latestSummary.reasons as r (r)}<li>{r}</li>{/each}
						</ul>
					{/if}
					{#if latestSummary.facts.length}
						<dl class="divide-y divide-line border-y border-line">
							{#each latestSummary.facts as f (f.key)}
								<div class="flex justify-between gap-4 py-2 text-body-sm"><dt class="text-ink-2">{f.label}</dt><dd class="text-right">{f.value}</dd></div>
							{/each}
						</dl>
					{/if}
					{#if cascade.length > 1}
						<div>
							<h3 class="text-body-sm font-medium">Cascade on file</h3>
							<ul class="mt-1 flex flex-col gap-1">
								{#each cascade as k (k.id)}
									{@const s = parseCheckSummary(k.summaryJson)}
									<li class="flex flex-wrap justify-between gap-2 text-caption text-ink-2">
										<span>{s.product ?? 'Check'} · {dateTime(k.checkedAt)}</span><span class="num text-ink-3">{k.requestId}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if checks.length > cascade.length}<p class="text-caption text-ink-3">{checks.length - cascade.length} earlier check{checks.length - cascade.length === 1 ? '' : 's'} on file.</p>{/if}
				{:else}
					<p class="text-body text-ink-2">No Credit Check yet. Credit & Risk runs the cascade on the owner before extending terms.</p>
				{/if}
				<div class="flex flex-col gap-1 border-t border-line pt-3">
					<h3 class="text-body-sm font-medium">Decision</h3>
					{#if decision}
						<p class="flex flex-wrap items-center gap-2 text-body-sm">
							<Pill tone={STATUS[decision.status].tone}>{STATUS[decision.status].label}</Pill>
							<a class="drill" href="/proposals?status=all#proposal-{decision.id}">{decision.summaryPlain}</a>
						</p>
						{#if decisionTerms?.tier || decisionTerms?.days !== undefined}
							<p class="text-caption text-ink-3">
								{decisionTerms.tier ? `Tier ${decisionTerms.tier}` : ''}{decisionTerms.tier && decisionTerms.days !== undefined ? ' · ' : ''}{decisionTerms.days !== undefined ? `${decisionTerms.days}-day terms` : ''}
							</p>
						{/if}
						{#if decision.rationale}<p class="text-body-sm text-ink-2">{decision.rationale}</p>{/if}
					{:else}
						<p class="text-body-sm text-ink-3">No credit decision Proposal for this customer.</p>
					{/if}
				</div>
			</section>

			<section aria-labelledby="con-h" class="flex flex-col gap-3">
				<h2 id="con-h" class="text-title">Contracts and revenue schedule</h2>
				<ul class="divide-y divide-line border-y border-line">
					{#each contracts as k (k.id)}
						<li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
							<span class="min-w-0">
								<span class="block text-body">{k.billing === 'annual' ? 'Annual billing' : 'Monthly billing'}</span>
								<span class="block text-caption text-ink-3">
									{shortDate(k.startAt)}, {k.startAt.slice(0, 4)} to {k.endAt ? `${shortDate(k.endAt)}, ${k.endAt.slice(0, 4)}` : 'no end date'}{#if k.changedAt && k.priorArrMinor}
										· was {money(k.priorArrMinor)} until {shortDate(k.changedAt)}{/if}
								</span>
							</span>
							<span class="num text-body">{money(k.arrMinor)} ARR</span>
						</li>
					{:else}
						<li class="py-4 text-body-sm text-ink-3">No contracts on file.</li>
					{/each}
				</ul>
				{#if schedule.length}
					<h3 class="text-body-sm font-medium">Revenue recognized per month</h3>
					<ul class="grid grid-cols-2 gap-2 sm:grid-cols-3">
						{#each schedule as s (s.ym)}
							<li class="flex justify-between gap-2 rounded-md bg-subtle px-3 py-2 text-body-sm"><span class="text-ink-2">{ymShort(s.ym)}</span><span class="num">{money(s.amount.toString())}</span></li>
						{/each}
					</ul>
				{:else if contracts.length}
					<p class="text-body-sm text-ink-3">No Revenue Schedule Proposal names this customer yet.</p>
				{/if}
			</section>

			{#if trend.length > 1}
				<section aria-labelledby="trend-h" class="flex flex-col gap-3">
					<h2 id="trend-h" class="text-title">Billing trend</h2>
					<p class="text-caption text-ink-3">Invoiced per month, platform fee and usage together.</p>
					<div class="flex h-32 items-end gap-1" role="img" aria-label="Invoiced per month: {trend.map((t) => `${ymShort(t.ym)} ${money(t.amountMinor)}`).join(', ')}">
						{#each trend as t (t.ym)}
							<span class="flex h-full min-w-0 flex-1 flex-col justify-end" title="{ymShort(t.ym)}: {money(t.amountMinor)}">
								<span class="w-full rounded-sm bg-info" style:height="{trendMax > 0n ? Math.max(2, Number((toBig(t.amountMinor) * 100n) / trendMax)) : 0}%"></span>
							</span>
						{/each}
					</div>
					<div class="flex justify-between text-caption text-ink-3"><span>{ymShort(trend[0].ym)}</span><span>{ymShort(trend[trend.length - 1].ym)}</span></div>
				</section>
			{/if}
		</div>

		<div class="min-w-0">
			{#key c.id}
				<FootprintPanel kind="customer" id={c.id} listings={{ yelpUrl: c.yelpUrl, jobBoard: c.jobBoard, linkedinUrl: c.linkedinUrl }} />
			{/key}
		</div>
	</div>

	<section aria-labelledby="inv-h" class="mt-8 flex flex-col gap-3">
		<h2 id="inv-h" class="scroll-mt-6 text-title">Invoices and payments</h2>
		{#if toBig(row.openMinor) > 0n}
			<div class="flex flex-col gap-2">
				<div class="flex h-3 w-full overflow-hidden rounded-full bg-subtle" role="img" aria-label="Open invoices by days past due: {AR_BUCKETS.map((b) => `${AR_BUCKET_LABEL[b]} ${money(row.buckets[b])}`).join(', ')}">
					{#each AR_BUCKETS as b (b)}
						{#if toBig(row.buckets[b]) > 0n}<span class="h-full {BUCKET_FILL[b]}" style:width="{Number((toBig(row.buckets[b]) * 10000n) / toBig(row.openMinor)) / 100}%"></span>{/if}
					{/each}
				</div>
				<ul class="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-2">
					{#each AR_BUCKETS as b (b)}
						<li class="flex items-center gap-1"><span class="inline-block size-2 rounded-full {BUCKET_FILL[b]}"></span>{AR_BUCKET_LABEL[b]} <span class="num">{money(row.buckets[b])}</span></li>
					{/each}
				</ul>
			</div>
		{/if}
		<ul class="divide-y divide-line border-y border-line">
			{#each invoices as i (i.id)}
				{@const paid = paidBy.get(i.id)}
				{@const open = isOpenAt(i, asOf)}
				<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-3">
					<span class="min-w-0">
						<span class="num block">{i.number}</span>
						<span class="block text-body-sm text-ink-3">
							{`Issued ${shortDate(i.issuedAt)}, due ${shortDate(i.dueAt)}`}{#if open}{` · ${agingNote(i.dueAt)}`}{/if}
						</span>
						{#if paid}
							<span class="block text-body-sm text-ink-2">
								{`Paid ${shortDate(paid.bookedAt)} by bank line from ${paid.counterparty || 'the customer'} (${Math.round(paid.scoreBp / 100)}% match)`}{#if paid.paymentJeId}{' · '}<a class="drill" href={drill({ je: paid.paymentJeId }, 'all')}>payment entry</a>{/if}
							</span>
						{/if}
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
		{#if payments.length}<p class="text-caption text-ink-3">{payments.length} payment{payments.length === 1 ? '' : 's'} matched from the bank feed, {money(payments.reduce((t, p) => t + toBig(p.amountMinor), 0n).toString())} in all.</p>{/if}
	</section>

	<section aria-labelledby="prop-h" class="mt-8 flex flex-col gap-3">
		<h2 id="prop-h" class="text-title">Proposals and debate</h2>
		<ul class="flex flex-col gap-3">
			{#each related as p (p.id)}
				{@const msgs = messagesBy.get(p.id) ?? []}
				<li class="card flex flex-col gap-2 p-4">
					<div class="flex flex-wrap items-center gap-2 text-body-sm">
						<Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>
						<span class="text-ink-3">{KIND[p.kind]} · {roleName(p.proposerRole)} · {dateTime(p.createdAt)}</span>
					</div>
					<a class="drill text-body" href="/proposals?status=all#proposal-{p.id}">{p.summaryPlain}</a>
					{#if msgs.length}
						<ul class="flex flex-col gap-2 border-t border-line pt-2">
							{#each msgs.slice(-3) as m (m.id)}
								<li class="flex items-start gap-2 text-body-sm">
									<RoleAvatar role={m.senderRole} size={24} />
									<span class="min-w-0"><span class="font-medium">{roleName(m.senderRole)}</span> <span class="text-ink-2">{m.summaryPlain || m.body}</span></span>
								</li>
							{/each}
						</ul>
						{#if msgs.length > 3}<a class="drill text-caption text-ink-3" href="/proposals?status=all#proposal-{p.id}">{msgs.length - 3} more message{msgs.length === 4 ? "" : "s"} in the debate</a>{/if}
					{/if}
				</li>
			{:else}
				<li class="text-body-sm text-ink-3">No Proposals name this customer.</li>
			{/each}
		</ul>
	</section>
{/if}
