<script lang="ts">
	// The CFO claim link: /claim#secret=... seats this browser as the CFO with the one-time Bootstrap secret.
	// The secret travels in the fragment, so it never reaches a server log. It is read once, removed from the address
	// bar straight away (whatever happens next), kept only in memory, and never rendered.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { PUBLIC_STDB_DATABASE } from '$app/env/public';
	import { db } from '#lib/data/index.js';
	import Icon, { type IconName } from '#lib/components/Icon.svelte';
	import Wordmark from '#lib/components/Wordmark.svelte';

	type Phase = 'reading' | 'demo' | 'no-secret' | 'waiting' | 'claiming' | 'claimed' | 'already' | 'failed';
	let phase = $state<Phase>('reading');
	let error = $state('');
	let secret: string | null = null;
	let busy = false;

	const conn = $derived(db.connection());
	const seat = $derived(db.cfoSeat());
	const secretsFile = `.secrets/cfo-bootstrap.${PUBLIC_STDB_DATABASE}.txt`;

	/** Drop the fragment from the address bar and this history entry. */
	async function scrub() {
		if (!location.hash) return;
		const clean = location.pathname + location.search;
		try {
			await goto(clean, { replace: true, shallow: true, reset: false });
		} catch {
			/* the router refused: fall through */
		}
		if (location.hash) history.replaceState(history.state, '', clean);
	}

	onMount(() => {
		secret = new URLSearchParams(location.hash.slice(1)).get('secret')?.trim() || null;
		void scrub();
		phase = db.kind === 'mock' ? 'demo' : secret ? 'waiting' : 'no-secret';
	});

	// Claim once the ledger is live and the seat is known.
	$effect(() => {
		if (phase !== 'waiting' || conn.ledger !== 'live' || seat.status === 'checking') return;
		if (seat.status === 'you') {
			secret = null;
			phase = 'already';
			return;
		}
		void claim();
	});

	async function claim() {
		if (busy || !secret) return;
		busy = true;
		phase = 'claiming';
		try {
			await db.claimCfo(secret, 'CFO');
			secret = null;
			phase = 'claimed';
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			phase = 'failed';
		} finally {
			busy = false;
		}
	}

	const view = $derived.by((): { icon: IconName; tone: 'pos' | 'neg' | 'neutral'; title: string; body: string } => {
		switch (phase) {
			case 'demo':
				return { icon: 'check', tone: 'pos', title: 'You are already the CFO', body: 'This is Demo mode, which has one viewer: you. Claim links are for the live ledger database.' };
			case 'no-secret':
				return seat.status === 'you'
					? { icon: 'check', tone: 'pos', title: 'You hold the CFO seat', body: 'This browser is the CFO. There is nothing to claim.' }
					: { icon: 'alert', tone: 'neg', title: 'This link has no claim secret', body: `Open the full claim link the seed loader printed. It is also saved in ${secretsFile}. Run pnpm cfo:bootstrap for a new one while the seat is empty.` };
			case 'claimed':
				return { icon: 'check', tone: 'pos', title: 'You are the CFO', body: 'This browser now holds the CFO seat, and keeps it across reloads. The claim link is used up.' };
			case 'already':
				return { icon: 'check', tone: 'pos', title: 'You already hold the CFO seat', body: 'This browser claimed the seat earlier, so the link was not used.' };
			case 'failed':
				return { icon: 'alert', tone: 'neg', title: 'The seat was not claimed', body: error };
			case 'claiming':
				return { icon: 'lock', tone: 'neutral', title: 'Claiming the CFO seat', body: 'Checking the secret with the ledger database.' };
			default:
				return conn.ledger === 'offline'
					? { icon: 'alert', tone: 'neg', title: 'Cannot reach the ledger database', body: `${conn.message ?? 'The connection failed.'} Start it, then open the claim link again. The link has not been used.` }
					: { icon: 'lock', tone: 'neutral', title: 'Connecting to the ledger', body: 'One moment. The seat is claimed as soon as the connection is up.' };
		}
	});
	const done = $derived(phase === 'claimed' || phase === 'already' || phase === 'demo' || (phase === 'no-secret' && seat.status === 'you'));
</script>

<svelte:head><title>Claim the CFO seat · Luyten</title></svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas">
	<header class="mx-auto flex h-16 w-full max-w-[1120px] items-center px-4 sm:px-8">
		<Wordmark />
	</header>
	<main class="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
		<section class="card-elevated flex w-full max-w-[520px] flex-col gap-5 p-6 sm:p-8" aria-live="polite" aria-busy={phase === 'waiting' || phase === 'claiming'}>
			<p class="eyebrow">CFO seat</p>
			<div class="flex items-start gap-4">
				<span
					class="grid size-12 shrink-0 place-items-center rounded-full {view.tone === 'pos'
						? 'bg-pos-soft text-pos'
						: view.tone === 'neg'
							? 'bg-neg-soft text-neg'
							: 'bg-accent-soft text-accent-ink'}"
				>
					<Icon name={view.icon} size={22} />
				</span>
				<div class="min-w-0">
					<h1 class="text-[28px] sm:text-[32px]">{view.title}</h1>
					<p class="mt-2 text-ink-2">{view.body}</p>
				</div>
			</div>
			{#if phase === 'failed'}
				<p class="text-sm text-ink-3">
					A claim link works once and expires after a day. While the seat is empty, <code class="font-mono text-[13px]">pnpm cfo:bootstrap</code> arms a new one and saves it in
					<code class="font-mono text-[13px] break-all">{secretsFile}</code>.
				</p>
			{/if}
			<div class="flex flex-col gap-2 sm:flex-row">
				{#if done}
					<a href="/proposals?status=awaiting_cfo" class="btn btn-primary btn-lg">Review what needs your OK <Icon name="arrowRight" size={18} /></a>
					<a href="/dashboard" class="btn btn-tonal btn-lg">Open the Overview</a>
				{:else if phase === 'failed'}
					<button class="btn btn-tonal btn-lg" onclick={() => void claim()}>Try again</button>
					<a href="/dashboard" class="btn btn-text btn-lg">Continue read-only</a>
				{:else if phase === 'no-secret'}
					<a href="/dashboard" class="btn btn-tonal btn-lg">Continue read-only</a>
				{/if}
			</div>
		</section>
	</main>
</div>
