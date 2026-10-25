<script lang="ts">
	import type { Tone } from '#lib/labels.js';
	import type { Snippet } from 'svelte';

	let { tone = 'neutral', children, class: cls = '' }: { tone?: Tone; children: Snippet; class?: string } = $props();

	// Status colours travel as a pair: the soft fill and the text made for it. The accent pair is for action and
	// selection only; a neutral pill sits on info-soft so it stays visible on a hovered row.
	const TONES: Record<Tone, string> = {
		neutral: 'bg-info-soft text-on-info-soft border-transparent',
		muted: 'bg-transparent text-ink-3 border-line',
		accent: 'bg-accent-soft text-on-accent-soft border-transparent',
		pos: 'bg-pos-soft text-on-pos-soft border-transparent',
		neg: 'bg-neg-soft text-on-neg-soft border-transparent',
		warn: 'bg-warn-soft text-on-warn-soft border-transparent'
	};
</script>

<span class="inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-caption font-semibold whitespace-nowrap {TONES[tone]} {cls}">
	{@render children()}
</span>
