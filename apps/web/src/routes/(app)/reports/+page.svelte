<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { AGING_BUCKETS, AGING_LABEL, aging, arrWaterfall, balanceSheet, periodEnd, periodLabel, profitAndLoss, quarterRange } from '#lib/data/derive.js';
	import type { AccountType } from '#lib/data/types.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import CountUp from '#lib/components/CountUp.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { dateTime, drill } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import ArrWaterfall from './ArrWaterfall.svelte';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const books = $derived({ accounts: db.accounts(), entries: db.journalEntries(), lines: db.journalLines() });
	const pnl = $derived(period ? profitAndLoss(books, db.periods(), period.id) : null);
	const bs = $derived(period ? balanceSheet(books, db.periods(), period.id) : null);
	const asOf = $derived(period ? periodEnd(period) : '');
	const quarterStart = $derived.by(() => {
		if (!period) return '';
		const qm = Math.floor((period.month - 1) / 3) * 3;
		return new Date(Date.UTC(period.year, qm, 0)).toISOString().slice(0, 10);
	});
	const arr = $derived(period ? arrWaterfall(db.contracts(), quarterStart, asOf) : null);
	const ag = $derived(aging(db.invoices(), asOf));
	const customers = $derived(new Map(db.customers().map((c) => [c.id, c])));
	const agingRows = $derived(
		[...ag.byCustomer.entries()]
			.map(([id, r]) => ({ id, name: customers.get(id)?.name ?? id, r, total: AGING_BUCKETS.reduce((t, b) => t + r[b], 0n), late: AGING_BUCKETS.slice(1).reduce((t, b) => t + r[b], 0n) }))
			.sort((a, b) => (b.late > a.late ? 1 : b.late < a.late ? -1 : 0))
			.slice(0, 8)
	);
	const maxBucket = $derived(AGING_BUCKETS.reduce((m, b) => (ag.totals[b] > m ? ag.totals[b] : m), 1n));
	// The page re-renders whenever a row lands; show when that last happened.
	const renderedAt = $derived.by(() => {
		void db.journalEntries().length;
		void db.periods().map((p) => p.status).join();
		return db.now();
	});

	const fmt = (m: string) => formatMoney(m, { whole: true });
	const pid = $derived(period?.id ?? '');

	// Every ledger figure drills to exactly the lines it sums: the month, the quarter's months, or the books through this
	// month. ARR (from contracts) and aging (from invoices) are not ledger sums: aging links to the customers whose
	// invoices make it up, and ARR links nowhere.
	const qtd = $derived(quarterRange(db.periods(), pid));
	const through = $derived({ to: pid });
	/** A group of accounts by type: named one by one when there are a few (Subscription and Usage Revenue), else by type. */
	const group = (t: AccountType) => {
		const codes = db.accounts().filter((a) => a.type === t).map((a) => a.code);
		return codes.length <= 3 ? { account: codes } : { type: [t] };
	};
	const PL: AccountType[] = ['revenue', 'expense'];
</script>

<svelte:head><title>Board Pack · Cafoo</title></svelte:head>

{#if period && pnl && bs && arr}
	<div class="flex flex-col gap-3 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
		<div>
			<p class="eyebrow">Board Pack · Cafoo Inc</p>
			<h1 class="text-[34px] sm:text-[42px]">{periodLabel(period)}</h1>
			<p class="mt-1 text-sm text-ink-3">Rendered {dateTime(renderedAt)} from {db.journalEntries().length} Journal Entries</p>
		</div>
		{#if period.status === 'closed'}
			<Pill tone="pos">Final · locked {period.lockedAt ? dateTime(period.lockedAt) : ''}</Pill>
		{:else}
			<Pill tone="warn">Draft · {period.status === 'closing' ? 'close in progress' : 'period open'}</Pill>
		{/if}
	</div>

	<section class="mt-6 grid grid-cols-1 divide-y divide-line border-b border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0" aria-label="Headline numbers">
		<a href={drill(group('revenue'), pid)} class="group flex flex-col gap-1 py-5 sm:pr-6">
			<span class="eyebrow">Revenue this month</span>
			<span class="text-[28px] font-medium group-hover:text-accent-ink"><CountUp minor={pnl.totalRevenue.month} /></span>
		</a>
		<a href={drill({ type: PL }, pid)} class="group flex flex-col gap-1 py-5 sm:px-6">
			<span class="eyebrow">Net income this month</span>
			<span class="text-[28px] font-medium group-hover:text-accent-ink {toBig(pnl.netIncome.month) < 0n ? 'text-neg' : ''}"><CountUp minor={pnl.netIncome.month} /></span>
		</a>
		<!-- ARR comes from the contracts, not the ledger, so there are no journal lines to drill to. -->
		<div class="flex flex-col gap-1 py-5 sm:pl-6">
			<span class="eyebrow">ARR at month end</span>
			<span class="text-[28px] font-medium"><CountUp minor={arr.end} /></span>
			<span class="text-sm text-ink-3">from the active contracts</span>
		</div>
	</section>

	<div class="mt-10 grid gap-12 xl:grid-cols-2">
		<section aria-labelledby="pnl-h">
			<h2 id="pnl-h" class="text-2xl">Profit and loss</h2>
			<table class="mt-4 w-full text-[15px]">
				<thead class="text-left text-sm text-ink-3">
					<tr class="border-b border-line">
						<th class="py-2 font-medium">Account</th>
						<th class="w-[34%] py-2 pl-3 text-right font-medium">{periodLabel(period).split(' ')[0].slice(0, 3)}</th>
						<th class="w-[30%] py-2 pl-3 text-right font-medium">Quarter to date</th>
					</tr>
				</thead>
				<tbody>
					{#each [{ title: 'Revenue', type: 'revenue' as const, rows: pnl.revenue, total: pnl.totalRevenue }, { title: 'Expenses', type: 'expense' as const, rows: pnl.expenses, total: pnl.totalExpenses }] as g (g.title)}
						<tr><th colspan="3" class="pt-4 pb-1 text-left text-sm font-medium text-ink-2">{g.title}</th></tr>
						{#each g.rows as r (r.account.id)}
							<tr class="border-b border-line">
								<td class="py-2 pr-2">{#if ui.expert}<span class="num mr-2 whitespace-nowrap text-ink-3">{r.account.code}</span>{/if}{r.account.name}</td>
								<td class="num py-2 pl-3 text-right"><a class="drill" href={drill({ account: r.account.code }, pid)}>{fmt(r.month)}</a></td>
								<td class="num py-2 pl-3 text-right"><a class="drill" href={drill({ account: r.account.code }, qtd)}>{fmt(r.qtd)}</a></td>
							</tr>
						{/each}
						<tr class="border-b border-line-strong font-medium">
							<td class="py-2">Total {g.title.toLowerCase()}</td>
							<td class="num py-2 pl-3 text-right"><a class="drill" href={drill(group(g.type), pid)}>{fmt(g.total.month)}</a></td>
							<td class="num py-2 pl-3 text-right"><a class="drill" href={drill(group(g.type), qtd)}>{fmt(g.total.qtd)}</a></td>
						</tr>
					{/each}
					<tr class="font-medium">
						<td class="pt-3">Net income</td>
						<td class="num pt-3 pl-3 text-right {toBig(pnl.netIncome.month) < 0n ? 'text-neg' : ''}"><a class="drill" href={drill({ type: PL }, pid)}>{fmt(pnl.netIncome.month)}</a></td>
						<td class="num pt-3 pl-3 text-right {toBig(pnl.netIncome.qtd) < 0n ? 'text-neg' : ''}"><a class="drill" href={drill({ type: PL }, qtd)}>{fmt(pnl.netIncome.qtd)}</a></td>
					</tr>
				</tbody>
			</table>
		</section>

		<section aria-labelledby="bs-h">
			<div class="flex items-baseline justify-between">
				<h2 id="bs-h" class="text-2xl">Balance sheet</h2>
				<p class="text-sm text-ink-3">as of {asOf}{#if ui.expert} · {bs.balanced ? 'balances' : 'DOES NOT BALANCE'}{/if}</p>
			</div>
			<table class="mt-4 w-full text-[15px]">
				<tbody>
					{#each [{ title: 'Assets', rows: bs.assets, total: bs.totalAssets }, { title: 'Liabilities', rows: bs.liabilities, total: bs.totalLiabilities }, { title: 'Equity', rows: bs.equity, total: bs.totalEquity }] as g (g.title)}
						<tr><th colspan="2" class="pt-4 pb-1 text-left text-sm font-medium text-ink-2">{g.title}</th></tr>
						{#each g.rows as r (r.account?.id ?? r.label)}
							<tr class="border-b border-line">
								<td class="py-2 pr-2">{#if ui.expert && r.account}<span class="num mr-2 whitespace-nowrap text-ink-3">{r.account.code}</span>{/if}{r.label}</td>
								<td class="num w-[40%] py-2 text-right">
									{#if r.account}<a class="drill" href={drill({ account: r.account.code }, through)}>{fmt(r.amount)}</a>{:else}<a class="drill" href={drill({ type: PL }, r.periods ?? through)}>{fmt(r.amount)}</a>{/if}
								</td>
							</tr>
						{/each}
						<tr class="border-b border-line-strong font-medium">
							<td class="py-2">Total {g.title.toLowerCase()}</td>
							<td class="num py-2 text-right">{fmt(g.total)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section aria-labelledby="arr-h">
			<h2 id="arr-h" class="text-2xl">ARR this quarter</h2>
			<p class="mt-1 text-sm text-ink-3">From {quarterStart} to {asOf}, from the active contracts. ARR is not a ledger figure, so it has no journal lines.</p>
			<div class="mt-4"><ArrWaterfall w={arr} /></div>
		</section>

		<section aria-labelledby="aging-h">
			<h2 id="aging-h" class="text-2xl">Receivables aging</h2>
			<p class="mt-1 text-sm text-ink-3">Unpaid invoices as of {asOf}, {fmt(ag.total.toString())} in total. Each customer's page lists the invoices behind their amounts.</p>
			<ul class="mt-4 flex flex-col gap-3">
				{#each AGING_BUCKETS as b (b)}
					<li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
						<span class="text-[15px]">{AGING_LABEL[b]}</span>
						<span class="num text-right">{fmt(ag.totals[b].toString())}</span>
						<span class="col-span-2 h-2 overflow-hidden rounded-full bg-subtle">
							<span
								class="block h-full rounded-full transition-[width] duration-500"
								style="width:{Number((ag.totals[b] * 1000n) / maxBucket) / 10}%; background:{b === 'current' ? 'var(--accent)' : b === '1-30' ? 'var(--warn)' : 'var(--neg)'}"
							></span>
						</span>
					</li>
				{/each}
			</ul>
			<h3 class="mt-8 text-lg">Most overdue customers</h3>
			<table class="mt-2 w-full text-[15px]">
				<thead class="text-left text-sm text-ink-3">
					<tr class="border-b border-line"><th class="py-2 font-medium">Customer</th><th class="py-2 text-right font-medium">Late</th><th class="py-2 text-right font-medium">Total</th></tr>
				</thead>
				<tbody>
					{#each agingRows as r (r.id)}
						<tr class="border-b border-line">
							<td class="py-2 pr-2"><a class="drill" href="/customers/{r.id}">{r.name}</a></td>
							<td class="num py-2 text-right {r.late > 0n ? 'text-neg' : 'text-ink-3'}"><a class="drill" href="/customers/{r.id}">{fmt(r.late.toString())}</a></td>
							<td class="num py-2 text-right"><a class="drill" href="/customers/{r.id}">{fmt(r.total.toString())}</a></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	</div>
{/if}
