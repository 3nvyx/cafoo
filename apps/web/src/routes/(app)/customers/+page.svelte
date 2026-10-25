<script lang="ts">
	// Customers, and the small CRM around them: deals from the CRM, support tickets from the help desk, promotion codes
	// from billing. Luyten reads those tools and never edits them; repeat customers are computed from the books.
	import { db } from '#lib/data/index.js';
	import { periodEnd } from '#lib/data/derive.js';
	import { formatMoney } from '#lib/data/money.js';
	import type { DealStage, SupportTicket } from '#lib/data/types.js';
	import { AR_BUCKETS, AR_BUCKET_LABEL, SEGMENTS, SEGMENT_LABEL, TIER_KEYS, arSummary, customerRows, filterRows, paginate, sortRows, type ArBucket, type Segment, type SortDir, type SortKey, type TierKey } from './receivables';
	import { OPEN_STAGES, STAGES, promotionTotals, repeatCustomers, supportSummary, ticketSla, weightedPipeline, type RepeatReason, type SlaState } from '#lib/crm.js';
	import FootprintChip from '#lib/components/FootprintChip.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Integrations from '#lib/components/Integrations.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import UploadDemo from '#lib/components/UploadDemo.svelte';
	import { TIER, dateTime, drill, shortDate, type Tone } from '#lib/labels.js';
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

	// Customers: one row per customer, computed once per period, then filtered, sorted and paged (about 300 of them).
	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const asOf = $derived(period ? periodEnd(period) : '9999-12-31');
	const repeat = $derived(repeatCustomers(db.invoices(), db.contracts(), db.batches()));
	const REPEAT: Record<RepeatReason, string> = {
		paid_in_several_months: 'paid in several months',
		expanded: 'grew their contract',
		several_contracts: 'signed more than once',
		bought_credits_again: 'bought credits again'
	};
	const allRows = $derived(customerRows(db.customers(), db.invoices(), db.contracts(), asOf));
	const summary = $derived(arSummary(allRows));

	let q = $state('');
	let tier = $state<TierKey | 'all'>('all');
	let segment = $state<Segment | 'all'>('all');
	let overdueOnly = $state(false);
	let sortKey = $state<SortKey>('open');
	let sortDir = $state<SortDir>('desc');
	let pageNo = $state(1);
	const PAGE_SIZE = 25;
	const filtered = $derived(sortRows(filterRows(allRows, { q, tier, segment, overdueOnly }), sortKey, sortDir));
	const paged = $derived(paginate(filtered, pageNo, PAGE_SIZE));
	// A new filter starts again on page one.
	$effect(() => {
		void [q, tier, segment, overdueOnly, sortKey, sortDir];
		pageNo = 1;
	});
	function sortBy(k: SortKey) {
		if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		else {
			sortKey = k;
			sortDir = k === 'name' || k === 'tier' ? 'asc' : 'desc';
		}
	}
	const ariaSort = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
	const COLUMNS: { key: SortKey; label: string; cls: string }[] = [
		{ key: 'tier', label: 'Risk Tier', cls: 'w-24' },
		{ key: 'arr', label: 'ARR', cls: 'w-28 justify-end' },
		{ key: 'open', label: 'Owed to us', cls: 'w-28 justify-end' },
		{ key: 'overdue', label: 'Days late', cls: 'w-20 justify-end' },
		{ key: 'allowance', label: 'Allowance', cls: 'w-24 justify-end' }
	];
	const MOBILE_SORT: { key: SortKey; label: string }[] = [{ key: 'name', label: 'Customer' }, ...COLUMNS];
	const BUCKET_FILL: Record<ArBucket, string> = { '0-30': 'bg-info', '31-60': 'bg-warn-soft', '61-90': 'bg-warn', '90+': 'bg-neg' };
	const tierLabel = (t: TierKey) => (t === 'none' ? 'Not checked' : TIER[t].label);
	const tierTone = (t: TierKey): Tone => (t === 'none' ? 'muted' : TIER[t].tone);

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

<svelte:head><title>Customers · Luyten</title></svelte:head>

<div class="flex flex-col gap-6">
	<header class="flex flex-col gap-2">
		<h1 class="text-display-sm sm:text-display">Customers</h1>
		<p class="max-w-prose text-body text-ink-2">
			Each customer is a small business with an owner who guarantees the account. Deals, tickets and promotion codes are read from your CRM, help desk and billing tool; Luyten never edits them.
		</p>
	</header>

	<div class="flex flex-wrap gap-2" role="tablist" aria-label="Customer views">
		{#each TABS as t (t.id)}
			<button class="chip" role="tab" id="tab-{t.id}" aria-selected={tab === t.id} aria-current={tab === t.id ? 'true' : undefined} aria-controls="panel-{t.id}" onclick={() => (tab = t.id)}>{t.label}</button>
		{/each}
	</div>

	{#if tab === 'customers'}
		<div id="panel-customers" role="tabpanel" aria-labelledby="tab-customers" class="flex flex-col gap-6">
			<dl class="grid grid-cols-2 gap-4 lg:grid-cols-4">
				<div class="card flex flex-col gap-1 p-4">
					<dt class="text-body-sm text-ink-2">Owed to us</dt>
					<dd class="num text-title font-medium">{money(summary.openMinor)}</dd>
					<dd class="text-caption text-ink-3">{allRows.length} customers, as of {asOf === '9999-12-31' ? 'today' : shortDate(asOf)}</dd>
				</div>
				<div class="card flex flex-col gap-1 p-4">
					<dt class="text-body-sm text-ink-2">Overdue</dt>
					<dd class="num text-title font-medium">{money(summary.overdueMinor)}</dd>
					<dd class="text-caption text-ink-3">
						<button class="drill" onclick={() => (overdueOnly = true)}>{summary.overdueCustomers} customer{summary.overdueCustomers === 1 ? '' : 's'} late</button>
					</dd>
				</div>
				<div class="card flex flex-col gap-1 p-4">
					<dt class="text-body-sm text-ink-2">Target allowance</dt>
					<dd class="num text-title font-medium">{money(summary.allowanceMinor)}</dd>
					<dd class="text-caption text-ink-3">Risk Tier rate on what is owed, not a posted entry</dd>
				</div>
				<div class="card flex flex-col gap-1 p-4">
					<dt class="text-body-sm text-ink-2">In the ledger</dt>
					<dd class="text-subtitle font-medium"><a class="drill" href={drill({ account: '1100' }, 'all')}>Receivable lines</a></dd>
					<dd class="text-caption text-ink-3">Accounts Receivable, every journal line</dd>
				</div>
			</dl>

			<div class="grid gap-4 lg:grid-cols-2">
				<section class="card flex flex-col gap-3 p-4" aria-labelledby="aging-h">
					<h2 id="aging-h" class="text-subtitle">AR aging</h2>
					<div class="flex h-4 w-full overflow-hidden rounded-full bg-subtle" role="img" aria-label="AR by days past due: {AR_BUCKETS.map((b) => `${AR_BUCKET_LABEL[b]} ${money(summary.buckets[b])}`).join(', ')}">
						{#each AR_BUCKETS as b (b)}
							{#if summary.bucketShareBp[b] > 0}<span class="h-full {BUCKET_FILL[b]}" style:width="{summary.bucketShareBp[b] / 100}%"></span>{/if}
						{/each}
					</div>
					<ul class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4">
						{#each AR_BUCKETS as b (b)}
							<li class="flex flex-col">
								<span class="flex items-center gap-2 text-caption text-ink-2"><span class="inline-block size-2 shrink-0 rounded-full {BUCKET_FILL[b]}"></span>{AR_BUCKET_LABEL[b]}</span>
								<span class="num text-body">{money(summary.buckets[b])}</span>
								<span class="text-caption text-ink-3">{Math.round(summary.bucketShareBp[b] / 100)}%</span>
							</li>
						{/each}
					</ul>
				</section>
				<section class="card flex flex-col gap-3 p-4" aria-labelledby="tier-h">
					<h2 id="tier-h" class="text-subtitle">Customers by Risk Tier</h2>
					<ul class="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-3 2xl:grid-cols-6">
						{#each TIER_KEYS as t (t)}
							<li>
								<button
									class="flex w-full flex-col items-start gap-1 rounded-md border border-line p-2 text-left transition-colors hover:bg-subtle {tier === t ? 'bg-subtle' : ''}"
									aria-pressed={tier === t}
									onclick={() => (tier = tier === t ? 'all' : t)}
								>
									<Pill tone={tierTone(t)}>{tierLabel(t)}</Pill>
									<span class="num text-title">{summary.byTier[t]}</span>
								</button>
							</li>
						{/each}
					</ul>
					<p class="text-caption text-ink-3">Select a tier to filter the list below.</p>
				</section>
			</div>

			<div class="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
				<label class="flex flex-col gap-1 text-body-sm text-ink-2 lg:w-72">
					Search
					<input class="field text-ink" type="search" bind:value={q} placeholder="Name, domain or owner" />
				</label>
				<label class="flex flex-col gap-1 text-body-sm text-ink-2 lg:w-48">
					Segment
					<select class="field text-ink" bind:value={segment}>
						<option value="all">All segments</option>
						{#each SEGMENTS as s (s)}<option value={s}>{SEGMENT_LABEL[s]}</option>{/each}
					</select>
				</label>
				<label class="flex flex-col gap-1 text-body-sm text-ink-2 lg:w-40">
					Risk Tier
					<select class="field text-ink" bind:value={tier}>
						<option value="all">All tiers</option>
						{#each TIER_KEYS as t (t)}<option value={t}>{tierLabel(t)}</option>{/each}
					</select>
				</label>
				<button class="chip self-start lg:self-end" aria-pressed={overdueOnly} onclick={() => (overdueOnly = !overdueOnly)}
					>{#if overdueOnly}<Icon name="check" size={16} />{/if}Overdue only</button
				>
				<p class="text-body-sm text-ink-3 lg:ml-auto lg:self-end" aria-live="polite">{filtered.length} of {allRows.length} customers</p>
			</div>

			<div class="border-t border-line">
				<div class="hidden items-center gap-4 border-b border-line py-2 text-body-sm text-ink-3 md:flex">
					<span class="min-w-40 flex-1" aria-sort={ariaSort('name')}
						><button class="drill inline-flex items-center gap-1" onclick={() => sortBy('name')}
							>Customer{#if sortKey === 'name'}<Icon name={sortDir === 'asc' ? 'arrowUp' : 'arrowDown'} size={14} />{/if}</button
						></span
					>
					<span class="hidden w-28 xl:block">Segment</span>
					{#each COLUMNS as col (col.key)}
						<span class="{col.key === 'allowance' ? 'hidden xl:flex' : 'flex'} {col.cls}" aria-sort={ariaSort(col.key)}>
							<button class="drill inline-flex items-center gap-1" onclick={() => sortBy(col.key)}
								>{col.label}{#if sortKey === col.key}<Icon name={sortDir === 'asc' ? 'arrowUp' : 'arrowDown'} size={14} />{/if}</button
							>
						</span>
					{/each}
				</div>
				<div class="flex flex-wrap gap-2 border-b border-line py-2 md:hidden" role="group" aria-label="Sort by">
					{#each MOBILE_SORT as col (col.key)}
						<button class="chip" aria-pressed={sortKey === col.key} onclick={() => sortBy(col.key)}
							>{col.label}{#if sortKey === col.key}<Icon name={sortDir === 'asc' ? 'arrowUp' : 'arrowDown'} size={14} />{/if}</button
						>
					{/each}
				</div>
				<ul>
					{#each paged.rows as r (r.customer.id)}
						{@const c = r.customer}
						{@const why = repeat.get(c.id)}
						<li class="border-b border-line">
							<a href="/customers/{c.id}" class="flex flex-wrap items-start gap-x-4 gap-y-1 py-3 transition-colors hover:bg-subtle md:flex-nowrap md:items-center">
								<span class="min-w-40 flex-1">
									<span class="flex flex-wrap items-center gap-2">
										<span class="truncate font-medium">{c.name}</span>
										{#if why}<span title="Repeat customer: {why.map((x) => REPEAT[x]).join(', ')}"><Pill tone="neutral">Repeat</Pill></span>{/if}
									</span>
									<span class="block truncate text-body-sm text-ink-3">{c.domain} · {c.guarantorName}</span>
									<FootprintChip kind="customer" id={c.id} class="max-w-full" />
								</span>
								<span class="hidden w-28 text-body-sm text-ink-2 xl:block">{SEGMENT_LABEL[r.segment]}</span>
								<span class="md:w-24"><Pill tone={tierTone(c.creditTier ?? 'none')}>{tierLabel(c.creditTier ?? 'none')}</Pill></span>
								<span class="basis-full text-body-sm text-ink-2 md:hidden"
									>{`${SEGMENT_LABEL[r.segment]} · ARR ${money(r.arrMinor)} · owed ${money(r.openMinor)}${r.daysOverdue ? ` · ${r.daysOverdue} days late` : ''}`}</span
								>
								<span class="num hidden w-28 text-right text-body text-ink-2 md:block">{money(r.arrMinor)}</span>
								<span class="num hidden w-28 text-right text-body md:block">{money(r.openMinor)}</span>
								<span class="num hidden w-20 text-right text-body md:block {r.daysOverdue > 60 ? 'font-semibold text-ink' : r.daysOverdue > 0 ? 'text-ink' : 'text-ink-3'}">{r.daysOverdue || '-'}</span>
								<span class="num hidden w-24 text-right text-body text-ink-2 xl:block">{money(r.allowanceMinor)}</span>
							</a>
						</li>
					{:else}
						<li class="py-10 text-center text-ink-3">No customers match.</li>
					{/each}
				</ul>
				{#if paged.pages > 1}
					<nav class="flex flex-wrap items-center justify-between gap-2 py-3" aria-label="Customer pages">
						<button class="chip" disabled={paged.page <= 1} onclick={() => (pageNo = paged.page - 1)}><Icon name="chevronLeft" size={16} />Previous</button>
						<span class="text-body-sm text-ink-2">Page {paged.page} of {paged.pages}</span>
						<button class="chip" disabled={paged.page >= paged.pages} onclick={() => (pageNo = paged.page + 1)}>Next<Icon name="chevronRight" size={16} /></button>
					</nav>
				{/if}
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
