<script lang="ts">
	// Board Pack figure -> Journal Entries -> Journal Lines and who produced them, on sample numbers.
	import Icon from '#lib/components/Icon.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import { reveal } from '#lib/motion.js';

	interface Entry {
		id: string;
		memo: string;
		amount: number;
		debit: string;
		credit: string;
	}

	const entries: Entry[] = [
		{ id: 'JE-0931', memo: 'Subscription, Acme Analytics', amount: 18400, debit: '2400 Deferred Revenue', credit: '4000 Subscription Revenue' },
		{ id: 'JE-0932', memo: 'Subscription, Brightline Health', amount: 12250, debit: '2400 Deferred Revenue', credit: '4000 Subscription Revenue' },
		{ id: 'JE-0933', memo: 'Revenue Schedule 1 of 12, Harbor & Pine', amount: 2200, debit: '2400 Deferred Revenue', credit: '4000 Subscription Revenue' },
		{ id: 'JE-0934', memo: 'Usage, September', amount: 31600, debit: '1100 Accounts Receivable', credit: '4100 Usage Revenue' },
		{ id: 'JE-0935', memo: 'Subscription, Northgate', amount: 6500, debit: '2400 Deferred Revenue', credit: '4000 Subscription Revenue' }
	];
	const revenue = entries.reduce((s, e) => s + e.amount, 0);
	const pnl = [
		{ label: 'Cost of revenue', amount: 14320 },
		{ label: 'Operating expenses', amount: 41880 }
	];
	const net = revenue - pnl.reduce((s, r) => s + r.amount, 0);

	const usd = (n: number, cents = false) =>
		n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

	// Opens on Revenue with the first entry picked, so all three columns show real figures on load.
	let open = $state(true);
	let picked = $state<Entry>(entries[0]);
</script>

<div class="card grid grid-cols-[minmax(0,1fr)] divide-y divide-line rounded-2xl lg:grid-cols-3 lg:divide-x lg:divide-y-0">
	<section class="flex flex-col gap-3 p-4" aria-labelledby="drill-pnl">
		<h3 id="drill-pnl" class="eyebrow">Board Pack · September P&L</h3>
		<button
			class="num flex min-h-[44px] items-center justify-between gap-3 rounded-lg border px-3 text-left transition-colors duration-150 border-line {open ? 'bg-accent-soft' : 'hover:bg-subtle'}"
			aria-expanded={open}
			aria-controls="drill-entries"
			onclick={() => (open = !open)}
		>
			<span class="font-sans font-medium">Revenue</span>
			<span class="flex items-center gap-1.5">{usd(revenue)}<Icon name="chevronRight" size={16} class="text-ink-3" /></span>
		</button>
		{#each pnl as r (r.label)}
			<div class="num flex min-h-[36px] items-center justify-between px-3 text-ink-2"><span class="font-sans">{r.label}</span>{usd(-r.amount)}</div>
		{/each}
		<div class="num flex min-h-[36px] items-center justify-between border-t border-line px-3 pt-2 font-medium"><span class="font-sans">Net income</span>{usd(net)}</div>
		<p class="text-sm text-ink-3">{open ? 'Revenue is open. Pick any entry to see its lines.' : 'Click Revenue to show the entries behind it.'}</p>
	</section>

	<section id="drill-entries" class="flex flex-col gap-2 p-4" aria-labelledby="drill-je">
		<h3 id="drill-je" class="eyebrow">{entries.length} Journal Entries</h3>
		{#if open}
			<ul class="flex flex-col gap-1" transition:reveal>
				{#each entries as e (e.id)}
					<li>
						<button
							class="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm transition-colors duration-150 {picked.id === e.id ? 'bg-subtle font-medium' : 'hover:bg-subtle'}"
							aria-pressed={picked.id === e.id}
							onclick={() => (picked = e)}
						>
							<span class="min-w-0 truncate">{e.memo}</span>
							<span class="num shrink-0">{usd(e.amount)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-ink-3">{entries.length} entries make up Revenue, {usd(revenue)} in all. Click Revenue to show them.</p>
		{/if}
	</section>

	<section class="flex flex-col gap-3 p-4" aria-labelledby="drill-jl" aria-live="polite">
		<h3 id="drill-jl" class="eyebrow">Journal Lines and who made them</h3>
		{#key picked.id}
			<div class="flex flex-col gap-3" in:reveal>
				<p class="num text-xs text-ink-3">{picked.id}</p>
				<table class="num w-full text-[13px]">
					<caption class="sr-only">Journal Lines for {picked.id}</caption>
					<tbody>
						<tr class="border-b border-line"><td class="py-1.5">{picked.debit}</td><td class="py-1.5 text-right">{usd(picked.amount, true)}</td><td class="w-4"></td></tr>
						<tr class="border-b border-line"><td class="py-1.5 pl-4">{picked.credit}</td><td></td><td class="py-1.5 text-right">{usd(picked.amount, true)}</td></tr>
					</tbody>
				</table>
				<ul class="flex flex-col gap-2 text-sm">
					<li class="flex items-center gap-2"><RoleAvatar role="revenue" size={24} />Proposed by the Revenue agent</li>
					<li class="flex items-center gap-2"><RoleAvatar role="redteam" size={24} />Checked by the Red Team: no critique</li>
					<li class="flex items-center gap-2">
						{#if picked.amount >= 10000}
							<RoleAvatar role="cfo" size={24} />$10,000 or more, so the CFO confirmed it
						{:else}
							<RoleAvatar role="advisor" size={24} />Approved and posted by the Advisor
						{/if}
					</li>
				</ul>
			</div>
		{/key}
	</section>
</div>
