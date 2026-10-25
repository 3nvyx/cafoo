<script lang="ts">
	// Customers, and the small CRM around them: deals from the CRM, support tickets from the help desk, promotion codes
	// from billing. Cafoo reads those tools and never edits them; repeat customers are computed from the books.
	import { db } from '#lib/data/index.js';
	import { contractArr, openReceivable, periodEnd } from '#lib/data/derive.js';
	import { formatMoney } from '#lib/data/money.js';
	import type { DealStage, RiskTier, SupportTicket } from '#lib/data/types.js';
	import { OPEN_STAGES, STAGES, promotionTotals, repeatCustomers, supportSummary, ticketSla, weightedPipeline, type RepeatReason, type SlaState } from '#lib/crm.js';
	import FootprintChip from '#lib/components/FootprintChip.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Integrations from '#lib/components/Integrations.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import UploadDemo from '#lib/components/UploadDemo.svelte';
	import { TIER, dateTime, shortDate, type Tone } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import Freshness from '../costs/Freshness.svelte';

	type Tab = 'customers' | 'deals' | 'support' | 'promotions';
	const TABS: { id: Tab; label: string }[] = [
		{ id: 'customers', label: 'Customers' },
		{ id: 'deals', label: 'Deals' },
		{ id: 'support', label: 'Support' },
		{ id: 'promotions', label: 'Promotions' }
	];
	let tab = $state<Tab>('customers');

	// The demo clock, refreshed each second so SLA timers move on their own.
	let now = $state(db.now());
	$effect(() => {
		const t = setInterval(() => (now = db.now()), 1000);
		return () => clearInterval(t);
	});

	const money = (m: string) => formatMoney(m, { whole: true });
	const customerName = (id?: string) => (id ? db.customers().find((c) => c.id === id)?.name : undefined);

	// Customers
	let q = $state('');
	let tier = $state<RiskTier | 'all' | 'none'>('all');
	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const asOf = $derived(period ? periodEnd(period) : '9999-12-31');
	const repeat = $derived(repeatCustomers(db.invoices(), db.contracts(), db.batches()));
	const REPEAT: Record<RepeatReason, string> = {
		paid_in_several_months: 'paid in several months',
		expanded: 'grew their contract',
		several_contracts: 'signed more than once',
		bought_credits_again: 'bought credits again'
	};
	const rows = $derived(
		db
			.customers()
			.filter((c) => (tier === 'all' ? true : tier === 'none' ? !c.creditTier : c.creditTier === tier))
			.filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()))
			.map((c) => ({ c, ar: openReceivable(db.invoices(), c.id), arr: contractArr(db.contracts(), c.id, asOf), why: repeat.get(c.id) }))
			.sort((a, b) => a.c.name.localeCompare(b.c.name))
	);
	const TIERS: (RiskTier | 'all' | 'none')[] = ['all', 'A', 'B', 'C', 'D', 'BLOCK', 'none'];

	// Deals
	const STAGE_LABEL: Record<DealStage, string> = { lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
	const stageTone = (s: DealStage): Tone => (s === 'won' ? 'pos' : s === 'lost' ? 'muted' : 'neutral');
	const deals = $derived(db.deals().slice().sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || Number(BigInt(b.amountMinor) - BigInt(a.amountMinor))));
	const pipeline = $derived(weightedPipeline(db.deals()));

	// Support
	const PRIORITY_TONE: Record<SupportTicket['priority'], Tone> = { urgent: 'neg', high: 'warn', normal: 'neutral', low: 'muted' };
	const SLA: Record<SlaState, { label: string; tone: Tone }> = {
		met: { label: 'Answered in time', tone: 'pos' },
		breached: { label: 'SLA missed', tone: 'neg' },
		at_risk: { label: 'SLA at risk', tone: 'warn' },
		on_track: { label: 'Within SLA', tone: 'neutral' }
	};
	const CHANNEL: Record<SupportTicket['channel'], string> = { email: 'Email', chat: 'Chat', phone: 'Phone', slack: 'Slack' };
	const STATUS_LABEL: Record<SupportTicket['status'], string> = { new: 'New', open: 'Open', pending: 'Waiting on customer', solved: 'Solved' };
	const tickets = $derived(
		db
			.supportTickets()
			.slice()
			.sort((a, b) => Number(a.status === 'solved') - Number(b.status === 'solved') || b.openedAt.localeCompare(a.openedAt))
	);
	const support = $derived(supportSummary(db.supportTickets(), now));

	// Promotions
	const promotions = $derived(db.promotions());
	const promo = $derived(promotionTotals(promotions));
	const PROMO_TONE: Record<string, Tone> = { active: 'pos', scheduled: 'neutral', ended: 'muted' };
</script>

<svelte:head><title>Customers · Cafoo</title></svelte:head>

<div class="flex flex-col gap-6">
	<header class="flex flex-col gap-2">
		<h1 class="text-display-sm sm:text-display">Customers</h1>
		<p class="max-w-prose text-body text-ink-2">
			Each customer is a small business with an owner who guarantees the account. Deals, tickets and promotion codes are read from your CRM, help desk and billing tool; Cafoo never edits them.
		</p>
	</header>

	<div class="flex flex-wrap gap-2" role="tablist" aria-label="Customer views">
		{#each TABS as t (t.id)}
			<button class="chip" role="tab" id="tab-{t.id}" aria-selected={tab === t.id} aria-current={tab === t.id ? 'true' : undefined} aria-controls="panel-{t.id}" onclick={() => (tab = t.id)}>{t.label}</button>
		{/each}
	</div>

	{#if tab === 'customers'}
		<div id="panel-customers" role="tabpanel" aria-labelledby="tab-customers" class="flex flex-col gap-6">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-end">
				<label class="flex flex-col gap-1 text-body-sm text-ink-2 sm:w-72">
					Search
					<input class="field text-ink" type="search" bind:value={q} placeholder="Customer name" />
				</label>
				<div class="flex flex-wrap gap-2" role="group" aria-label="Filter by Risk Tier">
					{#each TIERS as t (t)}
						<button class="chip" aria-pressed={tier === t} onclick={() => (tier = t)}
							>{#if tier === t}<Icon name="check" size={16} />{/if}{t === 'all' ? 'All' : t === 'none' ? 'Not checked' : TIER[t].label}</button
						>
					{/each}
				</div>
			</div>

			<div class="border-t border-line">
				<div class="hidden gap-4 border-b border-line py-2 text-body-sm text-ink-3 md:flex">
					<span class="min-w-0 flex-1">Customer</span><span class="w-40">Guarantor</span><span class="hidden w-36 xl:block">Public footprint</span><span class="w-24">Risk Tier</span><span class="w-20 text-right">Terms</span><span class="w-28 text-right">Owed to us</span>
				</div>
				<ul>
					{#each rows as { c, ar, why } (c.id)}
						<li class="border-b border-line">
							<a href="/customers/{c.id}" class="flex flex-wrap items-start gap-x-4 gap-y-1 py-3 transition-colors hover:bg-subtle md:flex-nowrap md:items-center">
								<span class="min-w-0 flex-1">
									<span class="flex flex-wrap items-center gap-2">
										<span class="truncate font-medium">{c.name}</span>
										{#if why}<span title="Repeat customer: {why.map((r) => REPEAT[r]).join(', ')}"><Pill tone="neutral">Repeat</Pill></span>{/if}
									</span>
									<span class="block truncate text-body-sm text-ink-3">{c.domain}</span>
									<FootprintChip kind="customer" id={c.id} class="max-w-full xl:hidden" />
								</span>
								<span class="hidden w-40 truncate text-body-sm text-ink-2 md:block md:text-body">{c.guarantorName}</span>
								<span class="hidden w-36 min-w-0 xl:block"><FootprintChip kind="customer" id={c.id} class="max-w-full" /></span>
								<span class="md:w-24">
									{#if c.creditTier}<Pill tone={TIER[c.creditTier].tone}>{TIER[c.creditTier].label}</Pill>{:else}<Pill tone="muted">Not checked</Pill>{/if}
								</span>
								<span class="basis-full text-body-sm text-ink-2 md:hidden">{`${c.guarantorName} · ${c.paymentTermsDays === 0 ? 'Prepay' : `${c.paymentTermsDays} days`} · owed ${money(ar)}`}</span>
								<span class="num hidden w-20 text-right text-body text-ink-2 md:block">{c.paymentTermsDays === 0 ? 'Prepay' : `${c.paymentTermsDays} days`}</span>
								<span class="num hidden w-28 text-right text-body md:block">{money(ar)}</span>
							</a>
						</li>
					{:else}
						<li class="py-10 text-center text-ink-3">No customers match.</li>
					{/each}
				</ul>
			</div>

			<UploadDemo kinds={['invoices', 'contracts']} title="Upload customer files" />
		</div>
	{:else if tab === 'deals'}
		<div id="panel-deals" role="tabpanel" aria-labelledby="tab-deals" class="flex flex-col gap-6">
			<Freshness ids={['hubspot', 'salesforce', 'pipedrive']} />
			<dl class="grid grid-cols-2 gap-4 lg:grid-cols-4">
				<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">Open pipeline</dt><dd class="text-title font-medium">{money(pipeline.openMinor)}</dd><dd class="text-caption text-ink-3">{pipeline.openCount} open deals</dd></div>
				<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">Weighted</dt><dd class="text-title font-medium">{money(pipeline.weightedMinor)}</dd><dd class="text-caption text-ink-3">By stage probability</dd></div>
				<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">Won</dt><dd class="text-title font-medium">{money(pipeline.wonMinor)}</dd><dd class="text-caption text-ink-3">Annual value</dd></div>
				<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">Win rate</dt><dd class="text-title font-medium">{pipeline.winRateBp === null ? 'n/a' : `${Math.round(pipeline.winRateBp / 100)}%`}</dd><dd class="text-caption text-ink-3">Won over closed</dd></div>
			</dl>
			<ul class="card flex flex-col divide-y divide-line px-5" aria-live="off">
				{#each deals as d (d.id)}
					<li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
						<span class="min-w-0">
							<span class="flex flex-wrap items-center gap-2">
								{#if d.customerId}<a class="drill font-medium" href="/customers/{d.customerId}">{d.companyName}</a>{:else}<span class="font-medium">{d.companyName}</span>{/if}
								{#if d.customerId && repeat.has(d.customerId)}<Pill tone="neutral">Repeat</Pill>{/if}
							</span>
							<span class="block text-caption text-ink-3">{d.ownerName} · {OPEN_STAGES.includes(d.stage) ? `closes ${shortDate(d.expectedCloseAt)}` : `closed ${shortDate(d.expectedCloseAt)}`} · moved {dateTime(d.updatedAt)}</span>
						</span>
						<span class="flex items-center gap-2">
							<Pill tone={stageTone(d.stage)}>{STAGE_LABEL[d.stage]}{OPEN_STAGES.includes(d.stage) ? ` · ${d.probabilityBp / 100}%` : ''}</Pill>
							<span class="num text-body-sm">{money(d.amountMinor)}</span>
						</span>
					</li>
				{:else}
					<li class="py-3 text-body-sm text-ink-3">No deals yet. Connect a CRM to read them.</li>
				{/each}
			</ul>
			<Integrations categories={['crm']} title="CRM" />
		</div>
	{:else if tab === 'support'}
		<div id="panel-support" role="tabpanel" aria-labelledby="tab-support" class="flex flex-col gap-6">
			<Freshness ids={['zendesk', 'intercom']} />
			<dl class="grid grid-cols-2 gap-4 lg:grid-cols-4">
				<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">Open tickets</dt><dd class="text-title font-medium">{support.open}</dd><dd class="text-caption text-ink-3">{support.atRisk} at risk of missing SLA</dd></div>
				<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">SLA missed</dt><dd class="text-title font-medium">{support.breached}</dd><dd class="text-caption text-ink-3">Open, no reply in time</dd></div>
				<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">Answered in time</dt><dd class="text-title font-medium">{support.metRateBp === null ? 'n/a' : `${Math.round(support.metRateBp / 100)}%`}</dd><dd class="text-caption text-ink-3">Of answered tickets</dd></div>
				<div class="card flex flex-col gap-1 p-4"><dt class="text-body-sm text-ink-2">First reply</dt><dd class="text-title font-medium">{support.medianFirstResponseMin === null ? 'n/a' : `${support.medianFirstResponseMin} min`}</dd><dd class="text-caption text-ink-3">Median</dd></div>
			</dl>
			<ul class="card flex flex-col divide-y divide-line px-5" aria-live="off">
				{#each tickets as t (t.id)}
					{@const sla = ticketSla(t, now)}
					<li class="flex flex-col gap-1 py-3">
						<div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
							<span class="min-w-0 font-medium">{t.subject}</span>
							<span class="flex flex-wrap items-center gap-2">
								<Pill tone={PRIORITY_TONE[t.priority]}>{t.priority[0].toUpperCase() + t.priority.slice(1)}</Pill>
								{#if t.status !== 'solved'}<Pill tone={SLA[sla].tone}>{SLA[sla].label}</Pill>{:else}<Pill tone="muted">Solved</Pill>{/if}
							</span>
						</div>
						<span class="text-caption text-ink-3">
							{t.requesterName}{customerName(t.customerId) ? `, ${customerName(t.customerId)}` : ''} · {STATUS_LABEL[t.status]} · {CHANNEL[t.channel]} · opened {dateTime(t.openedAt)}{t.firstResponseAt ? '' : ` · reply due ${dateTime(t.slaDueAt)}`}
						</span>
					</li>
				{:else}
					<li class="py-3 text-body-sm text-ink-3">No tickets. Connect a help desk to read them.</li>
				{/each}
			</ul>
			<Integrations categories={['support']} title="Help desk" />
		</div>
	{:else}
		<div id="panel-promotions" role="tabpanel" aria-labelledby="tab-promotions" class="flex flex-col gap-6">
			<Freshness ids={['stripe', 'shopify']} />
			<p class="text-body-sm text-ink-2">{promo.active} active codes · {promo.redemptions} redemptions · {money(promo.discountGivenMinor)} given in discounts</p>
			<ul class="card flex flex-col divide-y divide-line px-5" aria-live="off">
				{#each promotions as p (p.id)}
					<li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
						<span class="min-w-0">
							<span class="flex flex-wrap items-center gap-2"><span class="num font-medium">{p.code}</span><Pill tone={PROMO_TONE[p.status] ?? 'neutral'}>{p.status[0].toUpperCase() + p.status.slice(1)}</Pill></span>
							<span class="block text-caption text-ink-3">{p.descriptionPlain} · {shortDate(p.startsAt)}{p.endsAt ? ` to ${shortDate(p.endsAt)}` : ''}</span>
						</span>
						<span class="num text-right text-body-sm">
							<span class="block">{p.redemptions} redeemed</span>
							<span class="block text-ink-3">{money(p.discountGivenMinor)} off</span>
						</span>
					</li>
				{:else}
					<li class="py-3 text-body-sm text-ink-3">No promotion codes. Connect a billing tool to read them.</li>
				{/each}
			</ul>
			<Integrations categories={['billing']} title="Billing" />
		</div>
	{/if}
</div>
