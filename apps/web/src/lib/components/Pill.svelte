<script lang="ts">
	import type { Tone } from '#lib/labels.js';
	import type { Snippet } from 'svelte';

	let { tone = 'neutral', children, class: cls = '' }: { tone?: Tone; children: Snippet; class?: string } = $props();

	const TONES: Record<Tone, string> = {
		neutral: 'bg-subtle text-ink-2 border-line',
		muted: 'bg-transparent text-ink-3 border-line',
		accent: 'bg-accent-soft text-accent-ink border-transparent',
		pos: 'bg-pos-soft text-pos border-transparent',
		neg: 'bg-neg-soft text-neg border-transparent',
		warn: 'bg-warn-soft text-warn border-transparent'
	};
</script>

<span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[13px] leading-5 font-medium whitespace-nowrap {TONES[tone]} {cls}">
	{@render children()}
</span>
