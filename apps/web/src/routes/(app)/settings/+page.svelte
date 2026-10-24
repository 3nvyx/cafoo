<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { formatMoney, toNumber } from '#lib/data/money.js';
	import ModeToggle from '#lib/components/ModeToggle.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { attempt, toasts } from '#lib/toast.svelte.js';

	const current = $derived(toNumber(db.settings().materialityThresholdMinor));
	let draft = $state<number | null>(null);
	const shown = $derived(draft ?? current);
	const waiting = $derived(db.proposals().filter((p) => p.status === 'awaiting_cfo').length);
	let resetOpen = $state(false);

	async function commit() {
		if (draft === null || draft === current) return;
		const value = draft;
		const ok = await attempt(() => db.setMateriality(String(Math.round(value * 100))), `Threshold set to ${formatMoney(String(value * 100), { whole: true })}.`);
		if (ok) draft = null;
	}
</script>

<svelte:head><title>Settings · Cafoo</title></svelte:head>

<h1 class="text-[32px]">Settings</h1>

<div class="mt-8 flex max-w-[720px] flex-col gap-10">
	<section aria-labelledby="mat-h" class="flex flex-col gap-4">
		<div>
			<h2 id="mat-h" class="text-2xl">Materiality threshold</h2>
			<p class="mt-1 text-ink-2">The Advisor can post anything up to this amount on its own. Anything above it waits for your one-click OK.</p>
		</div>
		<div class="card flex flex-col gap-4 p-5">
			<div class="flex items-baseline justify-between">
				<label for="mat" class="font-medium">Ask me above</label>
				<output for="mat" class="num text-2xl font-medium">{formatMoney(String(shown * 100), { whole: true })}</output>
			</div>
			<input
				id="mat"
				type="range"
				min="1000"
				max="100000"
				step="1000"
				value={shown}
				oninput={(e) => (draft = Number((e.currentTarget as HTMLInputElement).value))}
				onchange={commit}
				class="h-11 w-full accent-[var(--accent)]"
				aria-valuetext={formatMoney(String(shown * 100), { whole: true })}
			/>
			<div class="flex justify-between text-sm text-ink-3"><span class="num">$1,000</span><span class="num">$100,000</span></div>
			<p class="text-sm text-ink-3">Changes apply to new rulings. {waiting ? `${waiting} item${waiting === 1 ? ' is' : 's are'} already waiting for you.` : ''}</p>
		</div>
	</section>

	<section aria-labelledby="mode-h" class="flex flex-col gap-3">
		<h2 id="mode-h" class="text-2xl">View</h2>
		<p class="text-ink-2">
			<strong class="font-medium text-ink">Simple</strong> shows plain summaries and two buttons. <strong class="font-medium text-ink">Expert</strong> adds journal lines with account
			codes, Red Team critiques verbatim, raw payloads, agent transcripts and keyboard shortcuts. Press <kbd class="rounded border border-line px-1 font-mono text-xs">E</kbd> anywhere to switch.
		</p>
		<div><ModeToggle /></div>
	</section>

	<section aria-labelledby="prov-h" class="flex flex-col gap-3">
		<h2 id="prov-h" class="text-2xl">Connections</h2>
		<p class="text-ink-2">
			{db.kind === 'mock' ? 'Demo mode: no API keys, every outside call replays recorded fixtures.' : 'Live: connected to the ledger database.'}
		</p>
		<ul class="divide-y divide-line border-y border-line">
			{#each db.providers() as p (p.id)}
				<li class="flex items-start justify-between gap-4 py-3">
					<div class="min-w-0">
						<p class="font-medium">{p.name}</p>
						<p class="text-sm text-ink-2">{p.purpose}</p>
						<p class="truncate text-sm text-ink-3">{p.detail}</p>
					</div>
					<Pill tone={p.mode === 'live' ? 'pos' : 'neutral'}>{p.mode === 'live' ? 'Live' : 'Demo mode'}</Pill>
				</li>
			{/each}
		</ul>
	</section>

	{#if db.resetDemo}
		<section aria-labelledby="reset-h" class="flex flex-col gap-3">
			<h2 id="reset-h" class="text-2xl">Demo</h2>
			<p class="text-ink-2">Put every table back to the starting data so you can run the September close again.</p>
			<div><button class="btn" onclick={() => (resetOpen = true)}>Reset demo data</button></div>
		</section>
		<ConfirmDialog
			bind:open={resetOpen}
			title="Reset the demo?"
			body="Every Proposal, ruling and entry made in this session goes away, and the books return to the starting data."
			confirmLabel="Reset"
			onconfirm={() => {
				db.resetDemo?.();
				toasts.push('Demo data reset.', 'success');
			}}
		/>
	{/if}
</div>
