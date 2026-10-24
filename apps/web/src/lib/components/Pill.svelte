<script lang="ts">
	import type { Tone } from '#lib/labels.js';
	import type { Snippet } from 'svelte';

	let { tone = 'neutral', children, class: cls = '' }: { tone?: Tone; children: Snippet; class?: string } = $props();

	const TONES: Record<Tone, string> = {
		neutral: 'bg-surface-container text-ink-2 border-transparent',
		muted: 'bg-transparent text-ink-3 border-line',
		accent: 'bg-primary-container text-on-primary-container border-transparent',
		pos: 'bg-success-container text-on-success-container border-transparent',
		neg: 'bg-error-container text-on-error-container border-transparent',
		warn: 'bg-warning-container text-on-warning-container border-transparent'
	};
</script>

<span class="inline-flex items-center gap-1 rounded-[6px] border px-2 py-0.5 text-[12.5px] leading-5 font-semibold whitespace-nowrap {TONES[tone]} {cls}">
	{@render children()}
</span>
