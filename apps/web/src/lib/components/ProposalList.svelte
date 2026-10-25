<script lang="ts">
	// A list of Proposal cards.
	import { flip } from 'svelte/animate';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { Proposal } from '#lib/data/types.js';
	import { arrive, appear } from '#lib/motion.js';
	import ProposalCard from './ProposalCard.svelte';

	let { proposals, empty = 'Nothing here.' }: { proposals: Proposal[]; empty?: string } = $props();
</script>

<ul class="flex flex-col gap-4">
	{#each proposals as p (p.id)}
		<li in:arrive out:appear animate:flip={{ duration: prefersReducedMotion.current ? 0 : 220 }}>
			<ProposalCard proposal={p} />
		</li>
	{:else}
		<li class="card px-5 py-10 text-center text-ink-3">{empty}</li>
	{/each}
</ul>
