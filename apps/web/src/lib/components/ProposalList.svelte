<script lang="ts">
	// A list of Proposal cards with Expert shortcuts: J/K move, A approve, S send back.
	import { flip } from 'svelte/animate';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { Proposal } from '#lib/data/types.js';
	import { arrive, appear } from '#lib/motion.js';
	import { isTyping, ui } from '#lib/ui.svelte.js';
	import ProposalCard from './ProposalCard.svelte';

	let { proposals, empty = 'Nothing here.' }: { proposals: Proposal[]; empty?: string } = $props();

	let focus = $state(0);
	const cards: Record<string, ProposalCard> = $state({});

	$effect(() => {
		if (focus >= proposals.length) focus = Math.max(0, proposals.length - 1);
	});

	function move(d: number) {
		if (!proposals.length) return;
		focus = Math.min(proposals.length - 1, Math.max(0, focus + d));
		const el = document.getElementById(`proposal-${proposals[focus].id}`);
		el?.focus({ preventScroll: true });
		el?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion.current ? 'auto' : 'smooth' });
	}

	function onkey(e: KeyboardEvent) {
		if (!ui.expert || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
		const current = proposals[focus];
		const k = e.key.toLowerCase();
		if (k === 'j') {
			e.preventDefault();
			move(1);
		} else if (k === 'k') {
			e.preventDefault();
			move(-1);
		} else if (k === 'a' && current) {
			e.preventDefault();
			cards[current.id]?.confirm();
		} else if (k === 's' && current) {
			e.preventDefault();
			cards[current.id]?.startSendBack();
		}
	}
</script>

<svelte:window onkeydown={onkey} />

{#if ui.expert && proposals.length}
	<p class="mb-3 text-sm text-ink-3">
		<kbd class="rounded border border-line px-1 font-mono text-xs">J</kbd>/<kbd class="rounded border border-line px-1 font-mono text-xs">K</kbd> move,
		<kbd class="rounded border border-line px-1 font-mono text-xs">A</kbd> confirm,
		<kbd class="rounded border border-line px-1 font-mono text-xs">S</kbd> send back,
		<kbd class="rounded border border-line px-1 font-mono text-xs">E</kbd> Simple mode
	</p>
{/if}

<ul class="flex flex-col gap-4">
	{#each proposals as p, i (p.id)}
		<li in:arrive out:appear animate:flip={{ duration: prefersReducedMotion.current ? 0 : 220 }}>
			<ProposalCard bind:this={cards[p.id]} proposal={p} focused={i === focus} onfocus={() => (focus = i)} />
		</li>
	{:else}
		<li class="card px-5 py-10 text-center text-ink-3">{empty}</li>
	{/each}
</ul>
