<script lang="ts">
	// List cell: the most telling public signal on file ("Yelp 4.1 · 196", "Open roles 723"), or nothing.
	import { db } from '#lib/data/index.js';
	import type { FootprintSubject } from '#lib/data/types.js';
	import { chipFor, rowsFor } from '#lib/footprint.js';

	let { kind, id, class: cls = '' }: { kind: FootprintSubject; id: string; class?: string } = $props();

	const chip = $derived(chipFor(rowsFor(db.publicFootprints(), kind, id)));
	const DOT = { pos: 'bg-pos', neg: 'bg-neg', neutral: 'bg-ink-3' } as const;
</script>

{#if chip}
	<span class="inline-flex min-w-0 items-center gap-1.5 text-sm text-ink-2 {cls}" title={chip.title}>
		<span class="size-1.5 shrink-0 rounded-full {DOT[chip.tone]}" aria-hidden="true"></span>
		<span class="sr-only">Public footprint: </span>
		<span class="num truncate">{chip.text}</span>
	</span>
{/if}
