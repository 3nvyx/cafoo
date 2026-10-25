<script lang="ts">
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { daysBetween, periodEnd } from '#lib/data/derive.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import { list, matchesOf, normId, parsePayload } from '#lib/data/payload.js';
	import type { Proposal } from '#lib/data/types.js';
	import FootprintPanel from '#lib/components/FootprintPanel.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import { KIND, STATUS, TIER, VERIFICATION, dateTime, drill, roleName, shortDate } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import { paymentsFor } from '../../customers/receivables';
	import { checksFor, parseCheckSummary } from '../../customers/credit-summary';
	import { vendorRows } from '../payables';

	const money = (m: string) => formatMoney(m, { whole: true });
	const v = $derived(db.vendors().find((x) => x.id === page.params.id));
	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const asOf = $derived(period ? periodEnd(period) : '9999-12-31');
	const row = $derived(v ? vendorRows([v], db.bills(), asOf)[0] : undefined);
	const bills = $derived(v ? db.bills().filter((b) => b.vendorId === v.id).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)) : []);
	const billIds = $derived(new Set(bills.map((b) => b.id)));
	const payments = $derived(paymentsFor('bill', billIds, db.bankMatches(), db.bankTransactions()));
	const paidBy = $derived(new Map(payments.map((p) => [p.targetId, p])));

	// The owner check: the latest CRS cascade on the person behind the vendor.
	const checks = $derived(v ? checksFor(db.creditChecks(), 'vendor', v.id) : []);
	const latest = $derived(checks[0]);
	const latestSummary = $derived(latest ? parseCheckSummary(latest.summaryJson) : undefined);
	const cascade = $derived(latest ? checks.filter((k) => Math.abs(daysBetween(k.checkedAt, latest.checkedAt)) <= 1) : []);
	const IDENTITY_KEYS = new Set(['identity', 'fraud', 'fraudScore', 'identityMatch', 'deceased', 'syntheticIdentity']);
	const ownerFacts = $derived(latestSummary ? latestSummary.facts.filter((f) => IDENTITY_KEYS.has(f.key)) : []);
	const otherFacts = $derived(latestSummary ? latestSummary.facts.filter((f) => !IDENTITY_KEYS.has(f.key)) : []);

	/** Proposals about this vendor: rulings that name it, lines that carry its id, and Bank Matches that pay its bills. */
	const related = $derived.by((): Proposal[] => {
		if (!v) return [];
		return db
			.proposals()
			.filter((p) => {
				const pl = parsePayload(p.payloadJson);
				if (!pl) return false;
				if (normId(pl.vendorId) === v.id) return true;
				if (list(pl.lines).some((l) => normId(l.vendorId) === v.id)) return true;
				return matchesOf(pl).some((m) => m.targetKind === 'bill' && billIds.has(m.targetId));
			})
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	});
	const blockProposal = $derived(related.find((p) => p.kind === 'vendor_block'));
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

	// Public web lookups (Bright Data) on file for this vendor.
	const lookups = $derived(v ? db.publicFootprints().filter((f) => f.subjectKind === 'vendor' && f.subjectId === v.id) : []);
	const liveLookups = $derived(lookups.filter((f) => f.live).length);
</script>

<svelte:head><title>{v?.name ?? 'Vendor'} · Luyten</title></svelte:head>

<a href="/vendors" class="drill inline-flex min-h-11 items-center gap-1 text-body-sm text-ink-2"><Icon name="chevronLeft" size={16} />Vendors</a>

{#if !v || !row}
	<p class="card mt-4 px-5 py-10 text-center text-ink-3">We could not find that vendor.</p>
{:else}
	<div class="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
		<div class="min-w-0">
			<h1 class="flex items-center gap-2 text-display-sm sm:text-display">
				{#if v.verification === 'blocked'}<Icon name="alert" size={28} class="shrink-0 text-on-neg-soft" />{/if}{v.name}
			</h1>
			<p class="mt-1 flex flex-wrap items-center gap-2 text-body text-ink-2">
				{v.category} · <a class="drill text-body-sm" href={drill({ vendor: v.id }, 'all')}>Journal lines for this vendor</a>
			</p>
		</div>
		<span class="self-start sm:self-auto"><Pill tone={VERIFICATION[v.verification].tone}>{v.verification === 'unverified' ? 'Unchecked' : VERIFICATION[v.verification].label}</Pill></span>
	</div>

	{#if v.verification === 'blocked'}
		<div class="mt-4 flex flex-col gap-1 rounded-md bg-neg-soft p-4 text-on-neg-soft">
			<p class="font-medium">Blocked from payment</p>
			{#if v.notePlain}<p class="text-body-sm">{v.notePlain}</p>{/if}
			{#if blockProposal}
				<p class="text-body-sm">
					<a class="drill" href="/proposals?status=all#proposal-{blockProposal.id}">{blockProposal.summaryPlain}</a> ({STATUS[blockProposal.status].label.toLowerCase()})
				</p>
			{/if}
			{#if toBig(row.openMinor) > 0n}<p class="text-body-sm">{money(row.openMinor)} in open bills is held and will not be paid.</p>{/if}
		</div>
	{:else if v.notePlain}
		<p class="mt-3 max-w-prose text-body text-ink-2">{v.notePlain}</p>
	{/if}

	<dl class="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
		<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">Spend</dt><dd class="num text-title">{money(row.billedMinor)}</dd><dd class="text-caption text-ink-3">{bills.length} bill{bills.length === 1 ? '' : 's'} on file</dd></div>
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">We owe them</dt>
			<dd class="num text-title"><a class="drill" href={drill({ vendor: v.id }, 'all')}>{money(row.openMinor)}</a></dd>
			<dd class="text-caption text-ink-3">{row.openCount} open{row.daysOverdue ? `, oldest ${row.daysOverdue} days late` : ''}</dd>
		</div>
		<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">Paid</dt><dd class="num text-title">{money(row.paidMinor)}</dd><dd class="text-caption text-ink-3">{payments.length} payment{payments.length === 1 ? '' : 's'} matched in the bank</dd></div>
		<div class="card flex flex-col gap-1 p-4">
			<dt class="text-body-sm text-ink-2">Owner check</dt>
			<dd class="text-title">{#if latest}<Pill tone={TIER[latest.tier]?.tone ?? 'neutral'}>{TIER[latest.tier]?.label ?? latest.tier}</Pill>{:else}<span class="text-ink-3">None yet</span>{/if}</dd>
			{#if latest}<dd class="text-caption text-ink-3">checked {dateTime(latest.checkedAt)}</dd>{/if}
		</div>
	</dl>

	<div class="mt-8 grid gap-8 xl:grid-cols-2 xl:items-start">
		<div class="flex min-w-0 flex-col gap-8">
			<section aria-labelledby="owner-h" class="card flex flex-col gap-3 p-4">
				<h2 id="owner-h" class="text-title">Owner check</h2>
				{#if latest && latestSummary}
					<div class="flex flex-wrap items-center gap-2">
						<Pill tone={TIER[latest.tier]?.tone ?? 'neutral'}>{TIER[latest.tier]?.label ?? latest.tier}</Pill>
						<span class="text-body-sm text-ink-2">{latestSummary.owner ?? 'Owner'} · {dateTime(latest.checkedAt)}</span>
					</div>
					{#if latestSummary.headline}<p class="text-body">{latestSummary.headline}</p>{/if}
					{#if latestSummary.reasons.length}
						<ul class="list-disc pl-5 text-body-sm text-ink-2">
							{#each latestSummary.reasons as r (r)}<li>{r}</li>{/each}
						</ul>
					{/if}
					{#if ownerFacts.length}
						<h3 class="text-body-sm font-medium">Identity and fraud</h3>
						<dl class="divide-y divide-line border-y border-line">
							{#each ownerFacts as f (f.key)}
								<div class="flex justify-between gap-4 py-2 text-body-sm"><dt class="text-ink-2">{f.label}</dt><dd class="text-right font-medium">{f.value}</dd></div>
							{/each}
						</dl>
					{/if}
					{#if otherFacts.length}
						<h3 class="text-body-sm font-medium">Credit and records</h3>
						<dl class="divide-y divide-line border-y border-line">
							{#each otherFacts as f (f.key)}
								<div class="flex justify-between gap-4 py-2 text-body-sm"><dt class="text-ink-2">{f.label}</dt><dd class="text-right">{f.value}</dd></div>
							{/each}
						</dl>
					{/if}
					{#if cascade.length > 1}
						<ul class="flex flex-col gap-1">
							{#each cascade as k (k.id)}
								{@const s = parseCheckSummary(k.summaryJson)}
								<li class="flex flex-wrap justify-between gap-2 text-caption text-ink-2"><span>{s.product ?? 'Check'} · {dateTime(k.checkedAt)}</span><span class="num text-ink-3">{k.requestId}</span></li>
							{/each}
						</ul>
					{/if}
					{#if checks.length > cascade.length}<p class="text-caption text-ink-3">{checks.length - cascade.length} earlier check{checks.length - cascade.length === 1 ? '' : 's'} on file.</p>{/if}
				{:else}
					<p class="text-body text-ink-2">No owner check yet. Credit & Risk runs the cascade on the owner before the first payment.</p>
				{/if}
			</section>

			<section aria-labelledby="bills-h" class="flex flex-col gap-3">
				<h2 id="bills-h" class="text-title">Bills and payments</h2>
				<ul class="divide-y divide-line border-y border-line">
					{#each bills as b (b.id)}
						{@const paid = paidBy.get(b.id)}
						{@const late = b.status !== 'paid' ? Math.max(0, daysBetween(b.dueAt, asOf)) : 0}
						<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-3">
							<span class="min-w-0">
								<span class="num block">{b.number}</span>
								<span class="block text-body-sm text-ink-3">{`Billed ${shortDate(b.issuedAt)}, due ${shortDate(b.dueAt)}${late ? ` · ${late} day${late === 1 ? '' : 's'} late` : ''}`}</span>
								{#if paid}
									<span class="block text-body-sm text-ink-2"
										>{`Paid ${shortDate(paid.bookedAt)} to ${paid.counterparty || v.name} (${Math.round(paid.scoreBp / 100)}% match)`}{#if paid.paymentJeId}{' · '}<a class="drill" href={drill({ je: paid.paymentJeId }, 'all')}>payment entry</a>{/if}</span
									>
								{/if}
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
			</section>
		</div>

		<div class="flex min-w-0 flex-col gap-3">
			<h2 class="text-title">Public web lookup</h2>
			<p class="text-body-sm text-ink-3">
				{lookups.length
					? `${lookups.length} lookup${lookups.length === 1 ? '' : 's'} on file through Bright Data, ${liveLookups ? `${liveLookups} fetched live` : 'replayed from recorded fixtures, not live'}.`
					: 'No Bright Data lookup on file yet.'}
			</p>
			{#key v.id}
				<FootprintPanel kind="vendor" id={v.id} listings={{ yelpUrl: v.yelpUrl, jobBoard: v.jobBoard, linkedinUrl: v.linkedinUrl }} />
			{/key}
		</div>
	</div>

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
					{/if}
				</li>
			{:else}
				<li class="text-body-sm text-ink-3">No Proposals name this vendor.</li>
			{/each}
		</ul>
	</section>
{/if}
