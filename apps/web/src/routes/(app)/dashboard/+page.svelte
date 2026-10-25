<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { AGING_BUCKETS, AGING_LABEL, aging, periodLabel, periodShort, ymShort } from '#lib/data/derive.js';
	import { isWholeMonths, monthRange, monthly, monthsIn, postings, previousRange, rangeDays, summarize, type DateRange, type Summary } from '#lib/data/dashboard.js';
	import { rootOf } from '#lib/data/group.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { Minor, Proposal } from '#lib/data/types.js';
	import { lockGate } from '#lib/close.js';
	import ConfirmAll from '#lib/components/ConfirmAll.svelte';
	import DebateMessage from '#lib/components/DebateMessage.svelte';
	import ProposalList from '#lib/components/ProposalList.svelte';
	import { drill } from '#lib/labels.js';
	import { arrive } from '#lib/motion.js';
	import { ui } from '#lib/ui.svelte.js';
	import BarList from './BarList.svelte';
	import CashChart from './CashChart.svelte';
	import CloseCard from './CloseCard.svelte';
	import KpiCard, { type Delta } from './KpiCard.svelte';
	import MonthlyChart from './MonthlyChart.svelte';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId) ?? db.periods().at(-1));
	const months = $derived([...new Set(db.periods().map((p) => p.id))].sort());
	const bounds = $derived<DateRange | null>(months.length ? { from: monthRange(months[0]).from, to: monthRange(months.at(-1)!).to } : null);

	// The range: one month (the app-wide Period, shared with the sidebar), or any two days.
	let mode = $state<'month' | 'range'>('month');
	let from = $state('');
	let to = $state('');
	function pickRange() {
		mode = 'range';
		if (!from || !to) ({ from, to } = monthRange(ui.periodId));
	}
	const range = $derived.by<DateRange | null>(() => {
		if (mode === 'month') return period ? monthRange(period.id) : null;
		if (!from || !to) return null;
		return from <= to ? { from, to } : { from: to, to: from };
	});
	const label = $derived.by(() => {
		if (!range) return '';
		if (mode === 'month' && period) return periodLabel(period);
		const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
		return `${day(range.from)} to ${day(range.to)}`;
	});

	// Cafoo Inc's own books, in its own currency. The group view, translated and eliminated, is the Board Pack's.
	const root = $derived(rootOf(db.subsidiaries()));
	const ps = $derived(root ? postings(db.accounts().filter((a) => a.subsidiaryId === root.id), db.journalEntries(), db.journalLines()) : []);
	const contracts = $derived(db.contracts());
	const s = $derived(range ? summarize(ps, contracts, range) : null);
	const prevRange = $derived(range ? previousRange(range) : null);
	const prev = $derived(prevRange && bounds && prevRange.from >= bounds.from ? summarize(ps, contracts, prevRange) : null);
	const against = $derived(!prevRange ? '' : mode === 'month' ? `vs ${ymShort(prevRange.from.slice(0, 7))}` : `vs the ${rangeDays(prevRange)} days before`);

	const series = $derived(monthly(ps, contracts, months));
	const selected = $derived(range ? monthsIn(range) : []);
	const spark = (pick: (m: (typeof series)[number]) => number) => ({ values: series.map(pick), on: series.map((m) => selected.includes(m.ym)) });

	const money = (m: Minor) => formatMoney(m, { whole: true });
	const pct = (bp: number | null) => (bp === null ? '–' : `${(bp / 100).toFixed(1)}%`);

	/** The change from the range before; null when the books do not reach back that far. */
	function moneyDelta(key: keyof Summary, upIsGood: boolean | null): Delta | null {
		if (!s || !prev) return null;
		const d = toBig(s[key] as Minor) - toBig(prev[key] as Minor);
		const dir = d > 0n ? 1 : d < 0n ? -1 : 0;
		return { text: formatMoney(d.toString(), { compact: true, signed: true }), dir, good: upIsGood === null ? null : dir > 0 === upIsGood, against };
	}
	function marginDelta(cur: number | null, before: number | null | undefined): Delta | null | undefined {
		if (cur === null) return undefined;
		if (before === null || before === undefined) return null;
		const d = cur - before;
		const dir = d > 0 ? 1 : d < 0 ? -1 : 0;
		return { text: `${d > 0 ? '+' : ''}${(d / 100).toFixed(1)} pts`, dir, good: dir > 0, against };
	}

	// The ledger filters by month, so figures drill only when the range is whole months; a link for part of a month
	// would open lines the figure does not count.
	const drillable = $derived(!!range && isWholeMonths(range) && selected.length > 0);
	const span = $derived(selected.length === 1 ? selected[0] : { from: selected[0], to: selected.at(-1) });
	const through = $derived({ to: selected.at(-1) });
	const link = (href: string) => (drillable ? href : undefined);
	const company = $derived(root?.code);

	const runway = $derived.by(() => {
		if (!s) return '';
		if (s.runwayMonths !== null) {
			if (s.runwayMonths > 36) return 'Over 3 years of runway at this rate of spend';
			if (s.runwayMonths < 1) return 'Less than a month of runway at this rate of spend';
			const n = Math.round(s.runwayMonths);
			return `About ${n} month${n === 1 ? '' : 's'} of runway at this rate of spend`;
		}
		return toBig(s.cashChange) >= 0n ? 'Cash did not fall over this range' : 'Cash is gone at this rate of spend';
	});

	const expenseRows = $derived.by(() => {
		if (!s) return [];
		const top = s.byExpense.slice(0, 6).map((e) => ({ key: e.account.id, label: e.account.name, minor: e.minor, href: link(drill({ account: e.account.code }, span)) }));
		const rest = s.byExpense.slice(6);
		if (rest.length) top.push({ key: 'other', label: `${rest.length} other account${rest.length === 1 ? '' : 's'}`, minor: rest.reduce((t, e) => t + toBig(e.minor), 0n).toString(), href: link(drill({ type: ['expense'], company }, span)) });
		return top;
	});

	// Invoices only know their status today, so aging is as of today, not the range end.
	const today = $derived(db.now().slice(0, 10));
	const ownInvoices = $derived.by(() => {
		const own = new Set(db.customers().filter((c) => !c.subsidiaryId || c.subsidiaryId === root?.id).map((c) => c.id));
		return db.invoices().filter((i) => own.has(i.customerId));
	});
	const agingRows = $derived.by(() => {
		const a = aging(ownInvoices, today);
		return AGING_BUCKETS.filter((b) => a.totals[b] !== 0n).map((b) => ({ key: b, label: AGING_LABEL[b], minor: a.totals[b].toString(), href: '/customers' }));
	});

	// Keep a just-confirmed card on screen briefly so the state flip is visible.
	const gate = $derived(lockGate(db, period?.id ?? ''));
	const awaiting = $derived(db.proposals().filter((p) => p.status === 'awaiting_cfo'));
	let lingering = $state<string[]>([]);
	let prevIds: string[] = [];
	$effect(() => {
		const ids = awaiting.map((p) => p.id);
		const gone = prevIds.filter((id) => !ids.includes(id));
		prevIds = ids;
		if (!gone.length) return;
		lingering = [...lingering, ...gone];
		setTimeout(() => (lingering = lingering.filter((id) => !gone.includes(id))), 900);
	});
	const queue = $derived<Proposal[]>(db.proposals().filter((p) => p.status === 'awaiting_cfo' || lingering.includes(p.id)));

	// Every message, including close-thread narration that has no Proposal.
	const feed = $derived(db.agentMessages().slice(-6).reverse());
</script>

<svelte:head><title>Dashboard · Cafoo</title></svelte:head>

{#if period && root}
	<header class="flex flex-col gap-5 pb-6 lg:flex-row lg:items-end lg:justify-between">
		<div class="flex flex-col gap-1">
			<p class="text-body-sm text-ink-2">{root.name} · {label}</p>
			<h1 class="text-display">Dashboard</h1>
		</div>
		<div class="flex flex-wrap items-end gap-3">
			<div class="flex gap-1" role="group" aria-label="Show figures for">
				<button class="chip" aria-pressed={mode === 'month'} onclick={() => (mode = 'month')}>Month</button>
				<button class="chip" aria-pressed={mode === 'range'} onclick={pickRange}>Date range</button>
			</div>
			{#if mode === 'month'}
				<label class="flex flex-col gap-1 text-caption text-ink-2">
					Month
					<select class="field num text-body-sm" bind:value={ui.periodId}>
						{#each db.periods() as p (p.id)}
							<option value={p.id}>{periodShort(p)}</option>
						{/each}
					</select>
				</label>
			{:else}
				<label class="flex flex-col gap-1 text-caption text-ink-2">
					From
					<input type="date" class="field num text-body-sm" bind:value={from} min={bounds?.from} max={bounds?.to} />
				</label>
				<label class="flex flex-col gap-1 text-caption text-ink-2">
					To
					<input type="date" class="field num text-body-sm" bind:value={to} min={bounds?.from} max={bounds?.to} />
				</label>
			{/if}
		</div>
	</header>

	<CloseCard {period} />

	{#if !s}
		<p class="card mt-6 p-5 text-body-sm text-ink-2">Pick both a start and an end date to see the figures.</p>
	{:else}
		<section aria-label="Key figures for {label}" class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<KpiCard label="Revenue" value={money(s.revenue)} delta={moneyDelta('revenue', true)} spark={spark((m) => m.revenue)} href={link(drill({ type: ['revenue'], company }, span))} hint={toBig(s.intercompany) ? `From customers. ${money(s.intercompany)} of fees from other group companies left out` : 'From customers, deferrals applied'} />
			<KpiCard label="Expenses" value={money(s.expenses)} delta={moneyDelta('expenses', false)} spark={spark((m) => m.expenses)} href={link(drill({ type: ['expense'], company }, span))} hint="{money(s.costOfRevenue)} to deliver the product, the rest to run the business" />
			<KpiCard label="Net income" value={money(s.netIncome)} delta={moneyDelta('netIncome', true)} spark={spark((m) => m.netIncome)} href={link(drill({ type: ['revenue', 'expense'], company }, span))} hint="{pct(s.netMarginBp)} of revenue, before intercompany fees" />
			<KpiCard label="Gross margin" value={pct(s.grossMarginBp)} delta={marginDelta(s.grossMarginBp, prev?.grossMarginBp)} hint="Revenue left after hosting and support" />
			<KpiCard label="Book cash" value={money(s.cash)} delta={moneyDelta('cash', true)} spark={spark((m) => m.cash)} href={link(drill({ account: '1000' }, through))} hint={runway} />
			<KpiCard label="Receivables" value={money(s.receivables)} delta={moneyDelta('receivables', null)} href={link(drill({ account: '1100' }, through))} hint="{money(s.allowance)} set aside for bad debt · {s.dsoDays === null ? 'no revenue to measure collection days' : `${s.dsoDays} days of sales outstanding`}" />
			<KpiCard label="Payables" value={money(s.payables)} delta={moneyDelta('payables', null)} href={link(drill({ account: ['2000', '2100'] }, through))} hint="Bills and accrued costs not yet paid" />
			<KpiCard label="ARR" value={money(s.arr)} delta={moneyDelta('arr', true)} spark={spark((m) => m.arr)} href="/reports" hint="Annual recurring revenue, from the contracts" />
		</section>

		<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
			<section aria-labelledby="trend-h" class="card flex flex-col gap-4 p-5">
				<h2 id="trend-h" class="text-subtitle">Revenue and expenses by month</h2>
				<MonthlyChart points={series} {selected} />
			</section>
			<section aria-labelledby="cash-h" class="card flex flex-col gap-4 p-5">
				<h2 id="cash-h" class="text-subtitle">Book cash at month end</h2>
				<CashChart points={series} {selected} />
			</section>
			<section aria-labelledby="spend-h" class="card flex flex-col gap-4 p-5">
				<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
					<h2 id="spend-h" class="text-subtitle">Where the money went</h2>
					<span class="text-caption text-ink-3">{label}</span>
				</div>
				<BarList rows={expenseRows} empty="No expenses posted in this range." />
			</section>
			<section aria-labelledby="aging-h" class="card flex flex-col gap-4 p-5">
				<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
					<h2 id="aging-h" class="text-subtitle">Open invoices by age</h2>
					<span class="text-caption text-ink-3">As of today</span>
				</div>
				<BarList rows={agingRows} empty="No open invoices." />
			</section>
		</div>
	{/if}

	<div class="mt-10 grid gap-10 lg:grid-cols-3">
		<section aria-labelledby="queue-h" class="lg:col-span-2">
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<h2 id="queue-h" class="text-title">Needs your OK</h2>
				<div class="flex items-center gap-3">
					<ConfirmAll proposals={awaiting} />
					<a href="/proposals" class="drill text-body-sm text-ink-2">All Proposals</a>
				</div>
			</div>
			<ProposalList
				proposals={queue}
				empty={gate.started ? 'Nothing needs you right now.' : 'Nothing needs you yet. Start the close and the agents will bring you anything above your threshold.'}
			/>
		</section>

		<aside aria-labelledby="feed-h">
			<div class="mb-4 flex items-baseline justify-between">
				<h2 id="feed-h" class="text-subtitle">Live from the agents</h2>
				<a href="/agents" class="drill text-body-sm text-ink-2">Full Debate</a>
			</div>
			<ul class="flex flex-col gap-4" aria-live="polite">
				{#each feed as m (m.id)}
					<li in:arrive><DebateMessage {m} /></li>
				{:else}
					<li class="text-ink-3">Quiet for now. Messages appear here the moment an agent posts.</li>
				{/each}
			</ul>
		</aside>
	</div>
{/if}
