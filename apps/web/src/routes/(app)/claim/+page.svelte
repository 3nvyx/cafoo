<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { db } from '#lib/data/index.js';
	import { toasts } from '#lib/toast.svelte.js';

	let phase = $state<'idle' | 'claiming' | 'done' | 'error' | 'demo'>('idle');
	let error = $state('');
	let secret = $state('');

	function readSecret(): string {
		const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
		const fromHash = new URLSearchParams(hash).get('secret');
		const fromQuery = new URLSearchParams(location.search).get('secret');
		return (fromHash ?? fromQuery ?? '').trim();
	}

	async function claim(value: string) {
		if (!db.claimCfo) {
			phase = 'demo';
			return;
		}
		phase = 'claiming';
		try {
			await db.claimCfo(value);
			phase = 'done';
			history.replaceState(null, '', '/claim');
			toasts.push('You are the CFO for this database.', 'success');
			setTimeout(() => void goto('/dashboard'), 900);
		} catch (err) {
			phase = 'error';
			error = err instanceof Error ? err.message : String(err);
		}
	}

	onMount(() => {
		const s = readSecret();
		if (s) void claim(s);
		else if (!db.claimCfo) phase = 'demo';
	});
</script>

<svelte:head><title>Claim the CFO seat · Cafoo</title></svelte:head>

<section class="mx-auto max-w-xl py-10">
	<p class="text-sm text-ink-3">Setup</p>
	<h1 class="mt-1 text-3xl font-medium tracking-tight">Claim the CFO seat</h1>

	{#if phase === 'demo'}
		<p class="mt-4 text-ink-2">Demo mode has no seat to claim: this browser already acts as the CFO. <a class="text-accent-ink underline" href="/dashboard">Back to the Launchpad</a>.</p>
	{:else if phase === 'claiming'}
		<p class="mt-4 text-ink-2">Claiming…</p>
	{:else if phase === 'done'}
		<p class="mt-4 text-ink-2">Done. This browser is the CFO. Taking you to the Launchpad.</p>
	{:else}
		{#if phase === 'error'}
			<p class="mt-4 rounded-card border border-neg/40 bg-neg-soft px-4 py-3 text-neg">{error}</p>
		{/if}
		<p class="mt-4 text-ink-2">
			Nobody becomes the CFO by asking. The seed loader printed a one-time claim link and saved it in
			<code class="num text-sm">.secrets/cfo-bootstrap.&lt;db&gt;.txt</code>. Open that link in this browser, or paste its secret here.
			<code class="num text-sm">pnpm cfo:bootstrap</code> prints a new link while the seat is empty.
		</p>
		<form class="mt-6 flex flex-col gap-3 sm:flex-row" onsubmit={(e) => { e.preventDefault(); if (secret.trim()) void claim(secret); }}>
			<input class="input flex-1" type="password" placeholder="Claim secret" bind:value={secret} autocomplete="off" />
			<button class="btn btn-primary" type="submit" disabled={!secret.trim()}>Claim</button>
		</form>
	{/if}
</section>
