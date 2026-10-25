<script lang="ts">
	// Live mode only: tells a browser that does not hold the CFO seat that it is read-only, and how to fix that.
	import { PUBLIC_STDB_DATABASE } from '$app/env/public';
	import { db } from '#lib/data/index.js';
	import { reveal } from '#lib/motion.js';
	import Icon from './Icon.svelte';

	const seat = $derived(db.cfoSeat());
	const live = $derived(db.connection().ledger === 'live');
	const file = `.secrets/cfo-bootstrap.${PUBLIC_STDB_DATABASE}.txt`;
</script>

{#if db.kind === 'live' && live && (seat.status === 'unclaimed' || seat.status === 'other')}
	<div class="banner mx-4 mt-4 lg:mx-8" role="status" transition:reveal>
		<span class="grid size-10 shrink-0 place-items-center rounded-full bg-warn text-on-warn"><Icon name="lock" size={20} /></span>
		<div class="min-w-0 flex-1">
			{#if seat.status === 'unclaimed'}
				<p class="font-medium text-ink">The CFO seat is unclaimed. You are viewing read-only.</p>
				<p class="mt-0.5 text-sm text-ink-2">
					Open your claim link to become the CFO. The seed loader printed it and saved it in <code class="font-mono text-[13px] break-all">{file}</code>;
					<code class="font-mono text-[13px]">pnpm cfo:bootstrap</code> arms a new one.
				</p>
			{:else}
				<p class="font-medium text-ink">You are viewing read-only.</p>
				<p class="mt-0.5 text-sm text-ink-2">
					{seat.holderName && seat.holderName !== 'CFO' ? `${seat.holderName} holds` : 'Another browser holds'} the CFO seat. Confirming, sending back, reversing and locking work only from the browser that claimed it.
				</p>
			{/if}
		</div>
	</div>
{/if}
