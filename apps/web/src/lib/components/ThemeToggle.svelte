<script lang="ts">
	// System / Light / Dark. `segmented` for Settings; `icon` for the sidebar header, a one-click switch to the
	// other look that pins it (Settings is where you go back to following the device).
	import { ui, type Theme } from '#lib/ui.svelte.js';
	import Icon, { type IconName } from './Icon.svelte';

	let { variant = 'segmented', class: cls = '' }: { variant?: 'segmented' | 'icon'; class?: string } = $props();

	const opts: { id: Theme; label: string; icon: IconName }[] = [
		{ id: 'system', label: 'System', icon: 'monitor' },
		{ id: 'light', label: 'Light', icon: 'sun' },
		{ id: 'dark', label: 'Dark', icon: 'moon' }
	];
	// The icon shows where a click takes you: a sun on the dark theme, a moon on the light one.
	const other = $derived(ui.resolvedTheme === 'dark' ? opts[1] : opts[2]);
</script>

{#if variant === 'icon'}
	<button type="button" class="btn btn-quiet {cls}" aria-label="Switch to {other.label.toLowerCase()} theme" title="{other.label} theme" onclick={() => ui.setTheme(other.id)}>
		<Icon name={other.icon} size={18} />
	</button>
{:else}
	<div class="segmented" role="group" aria-label="Theme">
		{#each opts as o (o.id)}
			<button type="button" aria-pressed={ui.theme === o.id} onclick={() => ui.setTheme(o.id)}><Icon name={o.icon} size={16} />{o.label}</button>
		{/each}
	</div>
{/if}
