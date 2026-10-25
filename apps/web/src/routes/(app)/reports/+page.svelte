<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { AGING_BUCKETS, AGING_LABEL, aging, arrWaterfall, nrrBp, periodEnd, periodLabel } from '#lib/data/derive.js';
	import { atClosingRate, boardPack, rateText, rootOf, type BsRow, type Cells, type PackColumn, type PnlRow } from '#lib/data/group.js';
	import type { AccountType, Contract, Invoice } from '#lib/data/types.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import CountUp from '#lib/components/CountUp.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { dateTime, drill } from '#lib/labels.js';
	import type { DrillPeriod } from '#lib/drill.js';
	import { ui } from '#lib/ui.svelte.js';
	import ArrWaterfall from './ArrWaterfall.svelte';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const subsidiaries = $derived(db.subsidiaries());
	const root = $derived(rootOf(subsidiaries));
	const isGroup = $derived(subsidiaries.length > 1);

	// The company switcher: Consolidated (the group in the Reporting currency) or one company in its own currency.
	// The choice lives in the address (?company=UK), so a link to one company's pack is shareable.
	const companyParam = $derived(page.url.searchParams.get('company'));
	const selected = $derived(subsidiaries.find((s) => s.code === companyParam));
	const scope = $derived(selected ? selected.id : isGroup ? 'group' : (root?.id ?? 'group'));
	function choose(code: string | null) {
		const q = new URLSearchParams(page.url.search);
		if (code) q.set('company', code);
		else q.delete('company');
		const search = q.toString();
		void goto(search ? `?${search}` : page.url.pathname, { replace: true, reset: false });
	}

	const reportingCcy = $derived(db.settings().reportingCcy || 'USD');
	const books = $derived({ subsidiaries, accounts: db.accounts(), entries: db.journalEntries(), lines: db.journalLines(), rates: db.fxRates(), reportingCcy });
	/** The pack, or the engine's plain-English reason it cannot be drawn (a missing rate). */
	const result = $derived.by(() => {
		if (!period || !subsidiaries.length) return null;
		try {
			return { pack: boardPack(books, scope, period.id) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	});
	const pack = $derived(result && 'pack' in result ? result.pack : null);
	const ccy = $derived(pack?.ccy ?? reportingCcy);
	const tk = $derived(pack?.totalKey ?? 'total');
	const consolidated = $derived(pack?.scope === 'group');
	const scopeName = $derived(consolidated ? 'Consolidated group' : (selected?.name ?? root?.name ?? ''));

	// Receivables and ARR come from invoices and contracts, not the ledger. One company: its own customers in its own
	// currency. The group: every company's, translated at the month's closing rate.
	const customerSub = $derived(new Map(db.customers().map((c) => [c.id, c.subsidiaryId ?? root?.id ?? ''])));
	const subCcy = $derived(new Map(subsidiaries.map((s) => [s.id, s.baseCurrency])));
	function inScope<T>(rows: T[], customerOf: (r: T) => string, amountOf: (r: T) => string, withAmount: (r: T, a: string) => T): T[] {
		if (!period) return [];
		return rows.flatMap((r) => {
			const sub = customerSub.get(customerOf(r)) ?? root?.id ?? '';
			if (!consolidated) return sub === scope ? [r] : [];
			const from = subCcy.get(sub) ?? reportingCcy;
			if (from === reportingCcy) return [r];
			try {
				return [withAmount(r, atClosingRate(toBig(amountOf(r)), db.fxRates(), from, reportingCcy, period.id).toString())];
			} catch {
				return [];
			}
		});
	}
	const invoices = $derived(inScope<Invoice>(db.invoices(), (i) => i.customerId, (i) => i.amountMinor, (i, a) => ({ ...i, amountMinor: a })));
	const contracts = $derived(
		inScope<Contract>(db.contracts(), (c) => c.customerId, (c) => c.arrMinor, (c, a) => ({ ...c, arrMinor: a, priorArrMinor: c.priorArrMinor && period ? atClosingRate(toBig(c.priorArrMinor), db.fxRates(), subCcy.get(customerSub.get(c.customerId) ?? '') ?? reportingCcy, reportingCcy, period.id).toString() : c.priorArrMinor }))
	);

	const asOf = $derived(period ? periodEnd(period) : '');
	const quarterStart = $derived.by(() => {
		if (!period) return '';
		const qm = Math.floor((period.month - 1) / 3) * 3;
		return new Date(Date.UTC(period.year, qm, 0)).toISOString().slice(0, 10);
	});
	const arr = $derived(period ? arrWaterfall(contracts, quarterStart, asOf) : null);
	const nrr = $derived(arr ? nrrBp(arr) : null);
	const ag = $derived(aging(invoices, asOf));
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

	/** Whole units in Simple mode; Expert mode shows the cents. */
	const fmt = (m: string | undefined, currency = ccy) => formatMoney(m ?? '0', { whole: !ui.expert, currency });
	const pid = $derived(period?.id ?? '');

	// Every ledger figure drills to exactly the lines it sums, in the company it belongs to: the month, the year to date,
	// or the books through this month. ARR (from contracts) and aging (from invoices) are not ledger sums: aging links to
	// the customers whose invoices make it up, and ARR links nowhere. The CTA is computed and never posted, so it has no
	// journal lines; Expert mode shows the rates behind it.
	const ytd = $derived<DrillPeriod>({ from: pack?.ytdFrom, to: pid });
	const through = $derived<DrillPeriod>({ to: pid });
	const PL: AccountType[] = ['revenue', 'expense'];
	/** The company code a column narrows a type drill to (none for the consolidated total). */
	const companyOf = (col: PackColumn) => col.subsidiary?.code;
	const accountHref = (codes: string[] | undefined, range: DrillPeriod) => (codes?.length ? drill({ account: codes }, range) : undefined);
	const typeHref = (types: AccountType[], col: PackColumn, range: DrillPeriod) => drill({ type: types, company: companyOf(col) }, range);

	// The consolidated P&L shows one measure at a time across the company columns, so it fits a phone.
	let measure = $state<'month' | 'ytd'>('month');
	const monthShort = $derived(period ? periodLabel(period).split(' ')[0]!.slice(0, 3) : '');
	const neg = (m: string | undefined) => (m ? toBig(m) < 0n : false);
</script>

<svelte:head><title>Board Pack · Cafoo</title></svelte:head>

{#snippet cell(value: string | undefined, href: string | undefined, strong = false)}
	{#if value === undefined || (value === '0' && !strong)}
		<span class="text-ink-3">-</span>
	{:else if href}
		<a class="drill {neg(value) ? 'text-neg' : ''}" {href}>{fmt(value)}</a>
	{:else}
		<span class={neg(value) ? 'text-neg' : ''}>{fmt(value)}</span>
	{/if}
{/snippet}

{#snippet pnlCells(cells: Cells, codes: Record<string, string[]> | undefined, types: AccountType[] | null, range: DrillPeriod, strong = false)}
	{#each pack?.columns ?? [] as col (col.key)}
		<td class="num py-2 pl-3 text-right whitespace-nowrap {col.kind === 'total' ? 'font-medium' : ''}">
			{@render cell(cells[col.key], codes ? accountHref(codes[col.key], range) : types ? typeHref(types, col, range) : undefined, strong || col.kind === 'total')}
		</td>
	{/each}
{/snippet}

{#if period}
	<div class="flex flex-col gap-3 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
		<div>
			<p class="eyebrow">Board Pack · {scopeName} · {ccy}</p>
			<h1 class="text-[34px] sm:text-[42px]">{periodLabel(period)}</h1>
			<p class="mt-1 text-sm text-ink-3">Rendered {dateTime(renderedAt)} from {db.journalEntries().length} Journal Entries</p>
		</div>
		{#if period.status === 'closed'}
			<Pill tone="pos">Final · locked {period.lockedAt ? dateTime(period.lockedAt) : ''}</Pill>
		{:else}
			<Pill tone="warn">Draft · {period.status === 'closing' ? 'close in progress' : 'period open'}</Pill>
		{/if}
	</div>

	{#if isGroup}
		<div class="mt-5 flex flex-wrap gap-2" role="group" aria-label="Company">
			<button type="button" class="chip" aria-pressed={consolidated} onclick={() => choose(null)}>Consolidated · {reportingCcy}</button>
			{#each subsidiaries as s (s.id)}
				<button type="button" class="chip" aria-pressed={scope === s.id} onclick={() => choose(s.code)}>{s.isElimination ? 'Eliminations' : s.name} · {s.baseCurrency}</button>
			{/each}
		</div>
		<p class="mt-2 text-sm text-ink-3">
			{#if consolidated}
				Every company translated into {reportingCcy}: balances at the month's closing rate, income and expenses at each month's average rate. What the companies owe and charge each other is removed in the Eliminations column.
			{:else if selected?.isElimination}
				The bookkeeping-only company that holds every Elimination, in {selected.baseCurrency}.
			{:else}
				{scopeName}'s own books, in {ccy}.
			{/if}
		</p>
	{/if}

	{#if result && 'error' in result}
		<div class="mt-6 rounded-card bg-error-container px-4 py-3 text-on-error-container" role="alert">
			<p class="font-medium">This Board Pack cannot be drawn yet.</p>
			<p class="mt-1 text-[15px]">{result.error}</p>
		</div>
	{/if}

	{#if pack && arr}
		{@const totalCol = pack.columns.find((c) => c.key === tk)!}
		<section class="mt-6 grid grid-cols-1 divide-y divide-line border-b border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0" aria-label="Headline numbers">
			<a href={typeHref(['revenue'], totalCol, pid)} class="group flex flex-col gap-1 py-5 sm:pr-6">
				<span class="eyebrow">Revenue this month</span>
				<span class="text-[28px] font-medium group-hover:text-accent-ink"><CountUp minor={pack.pnl.totalRevenue.month[tk] ?? '0'} currency={ccy} /></span>
			</a>
			<a href={typeHref(PL, totalCol, pid)} class="group flex flex-col gap-1 py-5 sm:px-6">
				<span class="eyebrow">Net income this month</span>
				<span class="text-[28px] font-medium group-hover:text-accent-ink {neg(pack.pnl.netIncome.month[tk]) ? 'text-neg' : ''}"><CountUp minor={pack.pnl.netIncome.month[tk] ?? '0'} currency={ccy} /></span>
			</a>
			<!-- ARR comes from the contracts, not the ledger, so there are no journal lines to drill to. -->
			<div class="flex flex-col gap-1 py-5 sm:pl-6">
				<span class="eyebrow">ARR at month end</span>
				<span class="text-[28px] font-medium"><CountUp minor={arr.end} currency={ccy} /></span>
				<span class="text-sm text-ink-3">from the active contracts</span>
			</div>
		</section>

		<div class="mt-10 grid gap-12 {consolidated ? '' : 'xl:grid-cols-2'}">
			<section aria-labelledby="pnl-h" class="min-w-0">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<h2 id="pnl-h" class="text-2xl">Profit and loss</h2>
					{#if consolidated}
						<div class="segmented" role="group" aria-label="Period shown">
							<button type="button" aria-pressed={measure === 'month'} onclick={() => (measure = 'month')}>{monthShort}</button>
							<button type="button" aria-pressed={measure === 'ytd'} onclick={() => (measure = 'ytd')}>Year to date</button>
						</div>
					{/if}
				</div>
				<div class="mt-4 overflow-x-auto">
					<table class="w-full text-[15px] {consolidated ? 'min-w-[620px]' : ''}">
						<thead class="text-left text-sm text-ink-3">
							<tr class="border-b border-line">
								<th class="py-2 font-medium">Account</th>
								{#if consolidated}
									{#each pack.columns as col (col.key)}<th class="py-2 pl-3 text-right font-medium">{col.label}</th>{/each}
								{:else}
									<th class="w-[34%] py-2 pl-3 text-right font-medium">{monthShort}</th>
									<th class="w-[30%] py-2 pl-3 text-right font-medium">Year to date</th>
								{/if}
							</tr>
						</thead>
						<tbody>
							{#each [{ title: 'Revenue', type: 'revenue' as const, rows: pack.pnl.revenue, total: pack.pnl.totalRevenue }, { title: 'Expenses', type: 'expense' as const, rows: pack.pnl.expenses, total: pack.pnl.totalExpenses }] as g (g.title)}
								<tr><th colspan={pack.columns.length + 2} class="pt-4 pb-1 text-left text-sm font-medium text-ink-2">{g.title}</th></tr>
								{#each g.rows as r (r.key)}
									{@render pnlRow(r)}
								{/each}
								<tr class="border-b border-line-strong font-medium">
									<td class="py-2">Total {g.title.toLowerCase()}</td>
									{#if consolidated}
										{@render pnlCells(g.total[measure], undefined, [g.type], measure === 'month' ? pid : ytd, true)}
									{:else}
										<td class="num py-2 pl-3 text-right">{@render cell(g.total.month[tk], typeHref([g.type], totalCol, pid), true)}</td>
										<td class="num py-2 pl-3 text-right">{@render cell(g.total.ytd[tk], typeHref([g.type], totalCol, ytd), true)}</td>
									{/if}
								</tr>
							{/each}
							<tr class="font-medium">
								<td class="pt-3">Net income</td>
								{#if consolidated}
									{@render pnlCells(pack.pnl.netIncome[measure], undefined, PL, measure === 'month' ? pid : ytd, true)}
								{:else}
									<td class="num pt-3 pl-3 text-right">{@render cell(pack.pnl.netIncome.month[tk], typeHref(PL, totalCol, pid), true)}</td>
									<td class="num pt-3 pl-3 text-right">{@render cell(pack.pnl.netIncome.ytd[tk], typeHref(PL, totalCol, ytd), true)}</td>
								{/if}
							</tr>
						</tbody>
					</table>
				</div>
			</section>

			{#snippet pnlRow(r: PnlRow)}
				<tr class="border-b border-line">
					<td class="py-2 pr-2">{#if ui.expert}<span class="num mr-2 whitespace-nowrap text-ink-3">{consolidated ? r.groupCode : r.key}</span>{/if}{r.label}</td>
					{#if consolidated}
						{@render pnlCells(r[measure], r.codes, null, measure === 'month' ? pid : ytd)}
					{:else}
						<td class="num py-2 pl-3 text-right">{@render cell(r.month[tk], accountHref(r.codes?.[tk], pid), true)}</td>
						<td class="num py-2 pl-3 text-right">{@render cell(r.ytd[tk], accountHref(r.codes?.[tk], ytd), true)}</td>
					{/if}
				</tr>
			{/snippet}

			{#snippet bsRow(r: BsRow)}
				<tr class="border-b border-line">
					<td class="py-2 pr-2">
						{#if ui.expert && r.groupCode}<span class="num mr-2 whitespace-nowrap text-ink-3">{consolidated ? r.groupCode : r.key}</span>{/if}{r.label}
						{#if r.computed}<span class="block text-xs text-ink-3">Computed when the books are translated, never posted</span>{/if}
					</td>
					{#each consolidated ? pack!.columns : pack!.columns.filter((c) => c.key === tk) as col (col.key)}
						<td class="num py-2 pl-3 text-right whitespace-nowrap {col.kind === 'total' ? 'font-medium' : ''}">
							{@render cell(
								r.amount[col.key],
								r.computed ? undefined : r.codes ? accountHref(r.codes[col.key], through) : typeHref(PL, col, r.months ?? through),
								!consolidated || col.kind === 'total'
							)}
						</td>
					{/each}
				</tr>
			{/snippet}

			<section aria-labelledby="bs-h" class="min-w-0">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h2 id="bs-h" class="text-2xl">Balance sheet</h2>
					<p class="text-sm text-ink-3">as of {asOf}{#if ui.expert} · {pack.bs.balanced ? 'balances' : 'DOES NOT BALANCE'}{/if}</p>
				</div>
				<div class="mt-4 overflow-x-auto">
					<table class="w-full text-[15px] {consolidated ? 'min-w-[620px]' : ''}">
						{#if consolidated}
							<thead class="text-left text-sm text-ink-3">
								<tr class="border-b border-line">
									<th class="py-2 font-medium">Account</th>
									{#each pack.columns as col (col.key)}<th class="py-2 pl-3 text-right font-medium">{col.label}</th>{/each}
								</tr>
							</thead>
						{/if}
						<tbody>
							{#each [{ title: 'Assets', type: 'asset' as const, rows: pack.bs.assets, total: pack.bs.totalAssets }, { title: 'Liabilities', type: 'liability' as const, rows: pack.bs.liabilities, total: pack.bs.totalLiabilities }, { title: 'Equity', type: 'equity' as const, rows: pack.bs.equity, total: pack.bs.totalEquity }] as g (g.title)}
								<tr><th colspan={pack.columns.length + 1} class="pt-4 pb-1 text-left text-sm font-medium text-ink-2">{g.title}</th></tr>
								{#each g.rows as r (r.key)}
									{@render bsRow(r)}
								{/each}
								<tr class="border-b border-line-strong font-medium">
									<td class="py-2">Total {g.title.toLowerCase()}</td>
									{#each consolidated ? pack.columns : pack.columns.filter((c) => c.key === tk) as col (col.key)}
										<td class="num py-2 pl-3 text-right whitespace-nowrap">{@render cell(g.total[col.key], undefined, true)}</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if consolidated}
					<p class="mt-3 text-sm text-ink-3">
						The currency translation adjustment ({fmt(pack.bs.ctaMinor)}) is what makes the translated balance sheet balance: {root?.name ?? 'the parent'} reports in {reportingCcy}, and pound balances move with the rate. It is computed each time, never posted.
					</p>
				{/if}
				{#if ui.expert && pack.rates.length}
					<h3 class="mt-6 text-lg">Rates used</h3>
					<div class="mt-2 overflow-x-auto">
						<table class="w-full text-sm">
							<thead class="text-left text-ink-3">
								<tr class="border-b border-line"><th class="py-2 font-medium">Company</th><th class="py-2 font-medium">Rate</th><th class="py-2 font-medium">Month</th><th class="py-2 text-right font-medium">1 {pack.rates[0]!.fromCcy} =</th><th class="py-2 pl-3 font-medium">Translates</th></tr>
							</thead>
							<tbody>
								{#each pack.rates as r (`${r.subsidiary.id}-${r.kind}-${r.ym}`)}
									<tr class="border-b border-line">
										<td class="py-2 pr-2">{r.subsidiary.name}</td>
										<td class="py-2 pr-2">{r.kind === 'closing' ? 'Closing' : 'Average'}</td>
										<td class="num py-2 pr-2">{r.ym}</td>
										<td class="num py-2 text-right whitespace-nowrap">{rateText(r.rateE6)} {r.toCcy}</td>
										<td class="py-2 pl-3 text-ink-2">{r.usedFor}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>

			<section aria-labelledby="arr-h" class="min-w-0">
				<h2 id="arr-h" class="text-2xl">ARR this quarter</h2>
				<p class="mt-1 text-sm text-ink-3">
					From {quarterStart} to {asOf}, from the active contracts{consolidated ? ` of every company, at the month's closing rate` : ''}. ARR is not a ledger figure, so it has no journal lines.
				</p>
				<div class="mt-4"><ArrWaterfall w={arr} currency={ccy} /></div>
				<p class="mt-3 text-sm text-ink-2">
					Net revenue retention:
					<span class="num font-medium text-ink">{nrr === null ? 'n/a (no customer had ARR at the start).' : `${(nrr / 100).toFixed(1)}%.`}</span>
					<span class="text-ink-3">The customers we had on {quarterStart}, at what they are worth now; new customers are left out.</span>
				</p>
			</section>

			<section aria-labelledby="aging-h" class="min-w-0">
				<h2 id="aging-h" class="text-2xl">Receivables aging</h2>
				<p class="mt-1 text-sm text-ink-3">
					Unpaid invoices as of {asOf}, {fmt(ag.total.toString())} in total{consolidated ? `, every company's at the month's closing rate` : ''}. Each customer's page lists the invoices behind their amounts.
				</p>
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
				{#if agingRows.length}
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
				{/if}
			</section>
		</div>
	{/if}
{/if}
