<script lang="ts">
	// Cap table tools: who owns the company fully diluted (by holder and by class), and a round modeler that prices a
	// round, converts SAFEs and tops up the option pool. All maths is in `#lib/cap-table.js`; this file only reads the
	// form and lays out the result. A model, never the books.
	import { db } from '#lib/data/index.js';
	import { formatMoney } from '#lib/data/money.js';
	import { HOLDING_CLASS_LABEL, holdingsFromCapTable, modelRound, ownership, parseDollars, parsePercentPpm, safesFromInstruments, type HoldingClass, type Safe, type SafeKind } from '#lib/cap-table.js';
	import { formatPpm, formatPriceE4 } from '#lib/financing.js';

	const CLASS_FILL: Record<HoldingClass, string> = { common: 'bg-ink', preferred: 'bg-ink-2', options: 'bg-ink-3', pool: 'bg-line-strong', warrant: 'bg-subtle' };
	const SHOWN = 10;

	const n = (v: bigint) => v.toLocaleString('en-US');
	const pct = (ppm: bigint) => Number(ppm) / 10_000;
	const usd = (minor: bigint) => formatMoney(minor.toString(), { whole: true });
	const dollarsText = (minor: bigint | string | undefined) => (minor ? (BigInt(minor) / 100n).toLocaleString('en-US') : '');

	const entries = $derived(db.capTable());
	const holdings = $derived(holdingsFromCapTable(entries));
	const own = $derived(ownership(holdings));
	let view = $state<'holder' | 'class'>('holder');
	let showAll = $state(false);
	const holderLines = $derived(showAll ? own.byHolder : own.byHolder.slice(0, SHOWN));
	const holderMax = $derived(own.byHolder[0]?.ppm ?? 1n);
	const holderClass = $derived(new Map(holdings.map((h) => [h.holder, h.class])));

	const investors = $derived(new Map(db.investors().map((i) => [i.id, i.name])));
	const registerSafes = $derived(safesFromInstruments(db.instruments(), (id) => investors.get(id) ?? id));

	// The form starts from the next planned round when its term sheet is in, otherwise from a sample Series B.
	const planned = db.fundingRounds().find((r) => r.status === 'planned' && r.preMoneyMinor);
	let newMoney = $state(planned ? dollarsText(planned.targetMinor) : '30,000,000');
	let preMoney = $state(planned ? dollarsText(planned.preMoneyMinor) : '120,000,000');
	let poolTarget = $state('10');
	let investor = $state(planned?.leadInvestorId ? (db.investors().find((i) => i.id === planned.leadInvestorId)?.name ?? 'New lead') : 'New lead');
	let excluded = $state<string[]>([]);
	interface Draft {
		id: string;
		holder: string;
		kind: SafeKind;
		amount: string;
		cap: string;
		discount: string;
	}
	let drafts = $state<Draft[]>([]);
	let seq = 0;
	const addSafe = () => drafts.push({ id: `what-if-${++seq}`, holder: `What-if SAFE ${seq}`, kind: 'post_money', amount: '1,000,000', cap: '20,000,000', discount: '' });
	const removeSafe = (id: string) => (drafts = drafts.filter((d) => d.id !== id));
	const toggle = (id: string) => (excluded = excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id]);

	const model = $derived.by(() => {
		const V = parseDollars(preMoney);
		const M = parseDollars(newMoney);
		if (V === null || V <= 0n) return { error: 'Enter a pre-money valuation in dollars.' };
		if (M === null) return { error: 'Enter the new money in dollars.' };
		const t = poolTarget.trim() === '' ? 0n : parsePercentPpm(poolTarget);
		if (t === null) return { error: 'Enter the pool target as a percent from 0 to 100, or leave it blank.' };
		const safes: Safe[] = registerSafes.filter((s) => !excluded.includes(s.id));
		for (const d of drafts) {
			const amount = parseDollars(d.amount);
			const cap = d.cap.trim() === '' ? undefined : parseDollars(d.cap);
			const disc = d.discount.trim() === '' ? 0n : parsePercentPpm(d.discount);
			if (amount === null || amount <= 0n) return { error: `${d.holder}: enter the purchase amount.` };
			if (cap === null) return { error: `${d.holder}: the cap must be in dollars, or blank.` };
			if (disc === null) return { error: `${d.holder}: the discount must be a percent, or blank.` };
			safes.push({ id: d.id, holder: d.holder || 'What-if SAFE', kind: d.kind, amountMinor: amount, capMinor: cap, discountBp: Number(disc / 100n) || undefined });
		}
		try {
			return { result: modelRound({ holdings, preMoneyMinor: V, newMoneyMinor: M, investor: investor.trim() || 'New investors', poolTargetPpm: t || undefined, safes }) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	});
	const r = $derived('result' in model ? model.result : null);
</script>

<section aria-labelledby="own-h" class="flex flex-col gap-4">
	<div class="flex flex-col gap-1">
		<h2 id="own-h" class="text-title">Ownership, fully diluted</h2>
		<p class="max-w-prose text-body-sm text-ink-2">Every share, option granted and the unallocated pool. SAFEs and notes own nothing until they convert; model that below.</p>
	</div>

	{#if own.total === 0n}
		<div class="card flex flex-col gap-1 p-5">
			<p class="font-medium">No cap table yet</p>
			<p class="max-w-prose text-body-sm text-ink-2">Upload a cap table export or connect Carta or Pulley below. Ownership, round modeling and SAFE conversion appear here once the shares are in.</p>
		</div>
	{:else}
		<div class="flex flex-wrap gap-2" role="group" aria-label="Group ownership by">
			<button class="chip" aria-pressed={view === 'holder'} onclick={() => (view = 'holder')}>By holder</button>
			<button class="chip" aria-pressed={view === 'class'} onclick={() => (view = 'class')}>By class</button>
		</div>

		<div class="flex h-4 w-full overflow-hidden rounded-sm bg-subtle" role="img" aria-label="Fully diluted ownership by class: {own.byClass.map((c) => `${HOLDING_CLASS_LABEL[c.key]} ${formatPpm(c.ppm)}`).join(', ')}">
			{#each own.byClass as c (c.key)}
				<span class="h-full {CLASS_FILL[c.key]}" style="width: {pct(c.ppm)}%"></span>
			{/each}
		</div>
		<ul class="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-2">
			{#each own.byClass as c (c.key)}
				<li class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-sm border border-line {CLASS_FILL[c.key]}" aria-hidden="true"></span>{HOLDING_CLASS_LABEL[c.key]} <span class="num">{formatPpm(c.ppm)}</span></li>
			{/each}
		</ul>

		{#if view === 'holder'}
			<ul class="border-t border-line">
				{#each holderLines as h (h.key)}
					<li class="flex flex-col gap-1 border-b border-line py-2">
						<div class="flex items-baseline gap-3">
							<span class="min-w-0 flex-1 truncate font-medium">{h.key}</span>
							<span class="num text-caption text-ink-3">{n(h.shares)}</span>
							<span class="num w-16 text-right text-body-sm">{formatPpm(h.ppm)}</span>
						</div>
						<div class="h-1.5 w-full rounded-sm bg-subtle" aria-hidden="true">
							<div class="h-1.5 rounded-sm {CLASS_FILL[holderClass.get(h.key) ?? 'common']}" style="width: {(Number(h.ppm) / Number(holderMax)) * 100}%"></div>
						</div>
					</li>
				{/each}
			</ul>
			{#if own.byHolder.length > SHOWN}
				<button class="btn btn-quiet self-start" onclick={() => (showAll = !showAll)}>{showAll ? 'Show the top holders' : `Show all ${own.byHolder.length} holders`}</button>
			{/if}
		{:else}
			<table class="w-full text-body-sm">
				<thead class="text-left text-caption text-ink-3">
					<tr class="border-b border-line">
						<th class="py-2 pr-3 font-medium">Class</th>
						<th class="py-2 pr-3 text-right font-medium">Shares</th>
						<th class="py-2 text-right font-medium">Fully diluted</th>
					</tr>
				</thead>
				<tbody>
					{#each own.byClass as c (c.key)}
						<tr class="border-b border-line">
							<td class="py-2 pr-3 font-medium">{HOLDING_CLASS_LABEL[c.key]}</td>
							<td class="num py-2 pr-3 text-right">{n(c.shares)}</td>
							<td class="num py-2 text-right">{formatPpm(c.ppm)}</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<td class="py-2 pr-3 text-caption text-ink-3">Total</td>
						<td class="num py-2 pr-3 text-right text-caption text-ink-3">{n(own.total)}</td>
						<td class="num py-2 text-right text-caption text-ink-3">100.00%</td>
					</tr>
				</tfoot>
			</table>
		{/if}
	{/if}
</section>

{#if own.total > 0n}
	<section aria-labelledby="model-h" class="mt-10 flex flex-col gap-4">
		<div class="flex flex-col gap-1">
			<h2 id="model-h" class="text-title">Model a round</h2>
			<p class="max-w-prose text-body-sm text-ink-2">
				Type the new money and the pre-money valuation. The pre-money includes the shares the SAFEs convert into and any pool top-up, as term sheets usually read. Each SAFE converts at the lower of its cap price and its discounted price. Shares are whole: conversions and new money round down, the pool top-up rounds up.
			</p>
		</div>

		<div class="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
			<label class="flex flex-col gap-1 text-caption text-ink-2">New money ($)<input class="field num text-body" inputmode="decimal" bind:value={newMoney} /></label>
			<label class="flex flex-col gap-1 text-caption text-ink-2">Pre-money valuation ($)<input class="field num text-body" inputmode="decimal" bind:value={preMoney} /></label>
			<label class="flex flex-col gap-1 text-caption text-ink-2">Pool target, % of post-money<input class="field num text-body" inputmode="decimal" placeholder="No top-up" bind:value={poolTarget} /></label>
			<label class="flex flex-col gap-1 text-caption text-ink-2">New investor<input class="field text-body" bind:value={investor} /></label>
		</div>

		<div class="flex flex-col gap-2">
			<h3 class="text-subtitle">SAFEs that convert</h3>
			{#if registerSafes.length === 0 && drafts.length === 0}
				<p class="text-body-sm text-ink-3">No outstanding SAFEs in the register. Add a what-if SAFE to see how it converts.</p>
			{/if}
			<ul class="flex flex-col gap-2">
				{#each registerSafes as s (s.id)}
					<li class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2">
						<label class="flex min-w-0 flex-1 items-center gap-2">
							<input type="checkbox" checked={!excluded.includes(s.id)} onchange={() => toggle(s.id)} />
							<span class="font-medium">{s.holder}</span>
						</label>
						<span class="text-caption text-ink-3">{s.kind === 'post_money' ? 'Post-money' : 'Pre-money'} SAFE{s.capMinor ? ` · ${usd(s.capMinor)} cap` : ''}{s.discountBp ? ` · ${s.discountBp / 100}% discount` : ''}</span>
						<span class="num text-body-sm">{usd(s.amountMinor)}</span>
					</li>
				{/each}
				{#each drafts as d (d.id)}
					<li class="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
						<label class="flex flex-col gap-1 text-caption text-ink-2 lg:col-span-2">Holder<input class="field text-body" bind:value={d.holder} /></label>
						<label class="flex flex-col gap-1 text-caption text-ink-2"
							>Type<select class="field text-body" bind:value={d.kind}><option value="post_money">Post-money</option><option value="pre_money">Pre-money</option></select></label
						>
						<label class="flex flex-col gap-1 text-caption text-ink-2">Amount ($)<input class="field num text-body" inputmode="decimal" bind:value={d.amount} /></label>
						<label class="flex flex-col gap-1 text-caption text-ink-2">Cap ($)<input class="field num text-body" inputmode="decimal" placeholder="No cap" bind:value={d.cap} /></label>
						<div class="flex items-end gap-2">
							<label class="flex flex-1 flex-col gap-1 text-caption text-ink-2">Discount %<input class="field num text-body" inputmode="decimal" placeholder="None" bind:value={d.discount} /></label>
							<button class="btn btn-quiet" onclick={() => removeSafe(d.id)} aria-label="Remove {d.holder}">Remove</button>
						</div>
					</li>
				{/each}
			</ul>
			<button class="btn self-start" onclick={addSafe}>Add a what-if SAFE</button>
		</div>

		{#if 'error' in model}
			<p class="rounded-md bg-warn-soft p-3 text-body-sm text-on-warn-soft" role="status">{model.error}</p>
		{:else if r}
			<dl class="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-live="polite">
				{#each [{ k: 'Price per share', v: formatPriceE4(r.priceE4) }, { k: 'New shares', v: n(r.newShares) }, { k: 'Pool top-up', v: r.poolIncrease > 0n ? n(r.poolIncrease) : 'None' }, { k: 'Post-money', v: usd(r.postMoneyMinor) }] as t (t.k)}
					<div class="card flex flex-col gap-1 p-4">
						<dt class="text-caption text-ink-2">{t.k}</dt>
						<dd class="num text-title">{t.v}</dd>
					</div>
				{/each}
			</dl>
			<p class="text-caption text-ink-3">
				Priced on {n(r.capitalization)} pre-money shares: {n(r.preRoundShares)} today{r.poolIncrease ? `, ${n(r.poolIncrease)} added to the pool` : ''}{r.convertedShares ? `, ${n(r.convertedShares)} from SAFEs` : ''}. {n(r.postShares)} shares after the round.
			</p>

			{#if r.conversions.length}
				<div class="overflow-x-auto">
					<table class="w-full text-body-sm">
						<caption class="pb-2 text-left text-subtitle">SAFE conversion</caption>
						<thead class="text-left text-caption text-ink-3">
							<tr class="border-b border-line">
								<th class="py-2 pr-3 font-medium">SAFE</th>
								<th class="py-2 pr-3 text-right font-medium">Amount</th>
								<th class="py-2 pr-3 text-right font-medium">Cap price</th>
								<th class="py-2 pr-3 text-right font-medium">Discount price</th>
								<th class="py-2 text-right font-medium">Shares</th>
							</tr>
						</thead>
						<tbody>
							{#each r.conversions as c (c.id)}
								<tr class="border-b border-line align-top">
									<td class="py-2 pr-3">
										<span class="font-medium">{c.holder}</span>
										<span class="block text-caption text-ink-3">{c.kind === 'post_money' ? 'Post-money' : 'Pre-money'} · {c.basis === 'cap' ? 'at the cap' : c.basis === 'discount' ? 'at the discount' : 'at the round price'}</span>
									</td>
									<td class="num py-2 pr-3 text-right">{usd(c.amountMinor)}</td>
									<td class="num py-2 pr-3 text-right {c.basis === 'cap' ? 'text-ink' : 'text-ink-3'}">{c.capPriceE4 === undefined ? '–' : formatPriceE4(c.capPriceE4)}</td>
									<td class="num py-2 pr-3 text-right {c.basis === 'cap' ? 'text-ink-3' : 'text-ink'}">{formatPriceE4(c.discountPriceE4)}</td>
									<td class="num py-2 text-right">{n(c.shares)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			<div class="overflow-x-auto">
				<table class="w-full text-body-sm">
					<caption class="pb-2 text-left text-subtitle">Ownership after the round</caption>
					<thead class="text-left text-caption text-ink-3">
						<tr class="border-b border-line">
							<th class="py-2 pr-3 font-medium">Holder</th>
							<th class="py-2 pr-3 text-right font-medium">Shares after</th>
							<th class="py-2 pr-3 text-right font-medium">Today</th>
							<th class="py-2 text-right font-medium">After</th>
						</tr>
					</thead>
					<tbody>
						{#each r.rows as h (`${h.class}|${h.holder}`)}
							<tr class="border-b border-line align-top">
								<td class="py-2 pr-3"><span class="font-medium">{h.holder}</span><span class="block text-caption text-ink-3">{HOLDING_CLASS_LABEL[h.class]}</span></td>
								<td class="num py-2 pr-3 text-right">{n(h.after)}</td>
								<td class="num py-2 pr-3 text-right text-ink-2">{h.before > 0n ? formatPpm(h.beforePpm) : '–'}</td>
								<td class="num py-2 text-right">{formatPpm(h.afterPpm)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<div class="flex flex-col gap-2">
				<h3 class="text-subtitle">By class, today and after</h3>
				{#each [{ k: 'Today', key: 'beforePpm' as const }, { k: 'After', key: 'afterPpm' as const }] as bar (bar.k)}
					<div class="flex items-center gap-3">
						<span class="w-12 text-caption text-ink-3">{bar.k}</span>
						<div class="flex h-3 flex-1 overflow-hidden rounded-sm bg-subtle" role="img" aria-label="{bar.k}: {r.byClass.map((c) => `${HOLDING_CLASS_LABEL[c.class]} ${formatPpm(c[bar.key])}`).join(', ')}">
							{#each r.byClass as c (c.class)}
								<span class="h-full {CLASS_FILL[c.class]}" style="width: {pct(c[bar.key])}%"></span>
							{/each}
						</div>
					</div>
				{/each}
				<ul class="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-2">
					{#each r.byClass as c (c.class)}
						<li class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-sm border border-line {CLASS_FILL[c.class]}" aria-hidden="true"></span>{HOLDING_CLASS_LABEL[c.class]} <span class="num">{formatPpm(c.beforePpm)} to {formatPpm(c.afterPpm)}</span></li>
					{/each}
				</ul>
			</div>
			<p class="max-w-prose text-caption text-ink-3">A model, not the books. Notes are left out here; the projection above converts them with interest. Pre-money SAFEs convert on today's shares, without the pool top-up or other SAFEs.</p>
		{/if}
	</section>
{/if}
