<script lang="ts">
	// System / Light / Dark. `segmented` for Settings; `icon` cycles through the three from the top bar.
	import { ui, type Theme } from '#lib/ui.svelte.js';
	import Icon, { type IconName } from './Icon.svelte';

	let { variant = 'segmented' }: { variant?: 'segmented' | 'icon' } = $props();

	const opts: { id: Theme; label: string; icon: IconName }[] = [
		{ id: 'system', label: 'System', icon: 'monitor' },
		{ id: 'light', label: 'Light', icon: 'sun' },
		{ id: 'dark', label: 'Dark', icon: 'moon' }
	];
	const current = $derived(opts.find((o) => o.id === ui.theme) ?? opts[0]);
	const next = $derived(opts[(opts.indexOf(current) + 1) % opts.length]);
</script>

{#if variant === 'icon'}
	<button class="btn btn-quiet btn-icon" title="Theme: {current.label}" aria-label="Theme: {current.label}. Switch to {next.label}." onclick={() => ui.setTheme(next.id)}>
		<Icon name={current.icon} />
	</button>
{:else}
	<div class="segmented" role="group" aria-label="Theme">
		{#each opts as o (o.id)}
			<button type="button" aria-pressed={ui.theme === o.id} onclick={() => ui.setTheme(o.id)}><Icon name={o.icon} size={16} />{o.label}</button>
		{/each}
	</div>
{/if}
