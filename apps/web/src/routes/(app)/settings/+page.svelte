<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { formatMoney, toNumber } from '#lib/data/money.js';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { providerState } from '#lib/providers.js';
	import { toasts } from '#lib/toast.svelte.js';

	const current = $derived(toNumber(db.settings().materialityThresholdMinor));
	/** What the slider shows while the CFO moves it, until the server value catches up (or refuses). */
	let draft = $state<number | null>(null);
	const shown = $derived(draft ?? current);
	const waiting = $derived(db.proposals().filter((p) => p.status === 'awaiting_cfo').length);
	let resetOpen = $state(false);

	const feedOn = $derived(db.settings().feedEnabled);
	const feed = $derived(db.connection().feed);
	const readOnly = $derived(db.cfoSeat().status !== 'you');
	let feedBusy = $state(false);
	async function toggleFeed() {
		feedBusy = true;
		try {
			await db.setFeedEnabled(!feedOn);
			toasts.push(feedOn ? 'The live feed is off.' : 'The live feed is on. New bank lines and invoices will arrive as they happen.', 'success');
		} catch (err) {
			toasts.error(err);
		} finally {
			feedBusy = false;
		}
	}

	// Arrow keys fire `change` on every step, so the change is saved once: on release or blur, or after a pause.
	const SETTLE_MS = 700;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving = false;
	let again = false;

	$effect(() => {
		if (draft !== null && !saving && draft === current) draft = null;
	});
	$effect(() => () => {
		// Leaving the page with a change still waiting saves it.
		if (timer) void commit();
	});

	function settle() {
		clearTimeout(timer);
		timer = setTimeout(() => void commit(), SETTLE_MS);
	}

	async function commit() {
		clearTimeout(timer);
		timer = undefined;
		if (draft === null) return;
		if (saving) {
			again = true;
			return;
		}
		const value = draft;
		if (value === current) {
			draft = null;
			return;
		}
		saving = true;
		try {
			await db.setMateriality(String(Math.round(value * 100)));
			toasts.push(`Threshold set to ${formatMoney(String(Math.round(value * 100)), { whole: true })}.`, 'success');
		} catch (err) {
			// Refused: show the server's value again, and drop any step taken while this one was in flight.
			again = false;
			draft = null;
			toasts.error(err);
		} finally {
			saving = false;
		}
		if (again) {
			again = false;
			await commit();
		} else if (draft === current) draft = null;
	}
</script>

<svelte:head><title>Settings · Cafoo</title></svelte:head>

<h1 class="text-[34px] sm:text-[42px]">Settings</h1>

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
				oninput={(e) => {
					draft = Number((e.currentTarget as HTMLInputElement).value);
					settle();
				}}
				onchange={settle}
				onpointerup={() => void commit()}
				onblur={() => void commit()}
				class="h-11 w-full accent-[var(--accent)]"
				aria-valuetext={formatMoney(String(shown * 100), { whole: true })}
			/>
			<div class="flex justify-between text-sm text-ink-3"><span class="num">$1,000</span><span class="num">$100,000</span></div>
			<p class="text-sm text-ink-3">Changes apply to new rulings. {waiting ? `${waiting} item${waiting === 1 ? ' is' : 's are'} already waiting for you.` : ''}</p>
		</div>
	</section>

	<section aria-labelledby="feed-h" class="flex flex-col gap-4">
		<div>
			<h2 id="feed-h" class="text-2xl">Live feed</h2>
			<p class="mt-1 text-ink-2">
				Once you lock a month, the feed streams the next month's bank lines and invoices as they happen, and the Bookkeeper proposes matches as they land. It
				books only into the open month after one you locked.
			</p>
		</div>
		<div class="card flex flex-col gap-3 p-5">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex items-center gap-2">
					<Pill tone={feedOn ? 'pos' : 'neutral'}>{feedOn ? 'On' : 'Off'}</Pill>
					{#if feed?.ym}<span class="text-sm text-ink-2">Books into {feed.ym}</span>{/if}
				</div>
				<button class="btn {feedOn ? '' : 'btn-primary'}" disabled={feedBusy || readOnly} onclick={toggleFeed}>
					{feedOn ? 'Switch the feed off' : 'Switch the feed on'}
				</button>
			</div>
			{#if feed && (feed.planned || feed.ingested)}
				<p class="num text-sm text-ink-2">{feed.ingested} of {feed.planned} events received</p>
			{/if}
			{#if feed?.blockedReason}<p class="text-sm text-ink-3">{feed.blockedReason}</p>{/if}
			{#if readOnly}<p class="text-sm text-ink-3">Only the browser holding the CFO seat can switch the feed.</p>{/if}
		</div>
	</section>

	<section aria-labelledby="theme-h" class="flex flex-col gap-3">
		<h2 id="theme-h" class="text-2xl">Appearance</h2>
		<p class="text-ink-2">Cream paper by day, warm brown by night. System follows your device.</p>
		<div><ThemeToggle /></div>
	</section>

	<section aria-labelledby="prov-h" class="flex flex-col gap-3">
		<h2 id="prov-h" class="text-2xl">Connections</h2>
		<div>
			<p class="text-ink-2">
				{db.kind === 'mock' ? 'Demo mode: no API keys, every outside call replays recorded fixtures.' : 'Live mode: each connection below says how much this session has confirmed.'}
			</p>
			<p class="mt-2 text-body-sm text-ink-3">
				Connected means this browser has spoken to it in this session. Configured means a key is present and the live path is selected; it does not prove a call succeeded. Demo replays recorded fixtures.
			</p>
		</div>
		<ul class="divide-y divide-line border-y border-line">
			{#each db.providers() as p (p.id)}
				{@const state = providerState(p, db.connection())}
				<li class="flex items-start justify-between gap-4 py-3">
					<div class="min-w-0">
						<p class="font-medium">{p.name}</p>
						<p class="text-body-sm text-ink-2">{p.purpose}</p>
						<p class="text-body-sm break-words text-ink-3">{p.detail}</p>
						{#if state.tone !== 'muted'}<p class="mt-0.5 text-caption text-ink-3">{state.hint}.</p>{/if}
					</div>
					<Pill tone={state.tone}>{state.label}</Pill>
				</li>
			{/each}
		</ul>
	</section>

	{#if db.resetDemo}
		<section aria-labelledby="reset-h" class="flex flex-col gap-3">
			<h2 id="reset-h" class="text-2xl">Demo</h2>
			<p class="text-ink-2">Put every table back to the starting data so you can run the September close again.</p>
			<div><button class="btn btn-tonal" onclick={() => (resetOpen = true)}>Reset demo data</button></div>
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
