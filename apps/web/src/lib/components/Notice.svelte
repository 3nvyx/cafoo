<script lang="ts">
	// A status callout: one tone, an optional short title, a sentence or two, and at most one link.
	// Status colours carry meaning here (a warning, a failure, a confirmation); `info` is the neutral note.
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	type NoticeTone = 'info' | 'pos' | 'warn' | 'neg';

	let {
		tone = 'info',
		title,
		href,
		action,
		role,
		children,
		class: cls = ''
	}: {
		tone?: NoticeTone;
		title?: string;
		/** Where the one action link goes; shown only together with `action`. */
		href?: string;
		/** The link's text, a verb phrase in sentence case ("Review the bank lines"). */
		action?: string;
		/** Defaults to 'alert' for `neg`, 'status' otherwise. */
		role?: 'status' | 'alert' | 'note';
		children: Snippet;
		class?: string;
	} = $props();

	const TONES: Record<NoticeTone, string> = {
		info: 'bg-info-soft text-on-info-soft',
		pos: 'bg-pos-soft text-on-pos-soft',
		warn: 'bg-warn-soft text-on-warn-soft',
		neg: 'bg-neg-soft text-on-neg-soft'
	};
</script>

<div class="flex gap-3 rounded-md border border-line px-4 py-3 text-body-sm {TONES[tone]} {cls}" role={role ?? (tone === 'neg' ? 'alert' : 'status')}>
	{#if tone !== 'info'}
		<span class="mt-0.5 shrink-0" aria-hidden="true"><Icon name={tone === 'pos' ? 'check' : 'alert'} size={16} /></span>
	{/if}
	<div class="min-w-0 flex-1">
		{#if title}<p class="font-medium">{title}</p>{/if}
		<div class={title ? 'mt-0.5' : ''}>{@render children()}</div>
		{#if href && action}<a class="drill -mb-2 inline-flex min-h-11 items-center font-medium" {href}>{action}</a>{/if}
	</div>
</div>
