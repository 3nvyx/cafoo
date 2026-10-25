<script lang="ts">
	// Simple / Expert as a Material 3 segmented button. Press E anywhere to switch.
	import { ui, type Mode } from '#lib/ui.svelte.js';
	import Icon from './Icon.svelte';

	const opts: { id: Mode; label: string }[] = [
		{ id: 'simple', label: 'Simple' },
		{ id: 'expert', label: 'Expert' }
	];
</script>

<div class="segmented" role="group" aria-label="View mode">
	{#each opts as o (o.id)}
		<button type="button" aria-pressed={ui.mode === o.id} onclick={() => ui.setMode(o.id)}>
			{#if ui.mode === o.id}<Icon name="check" size={16} class="hidden sm:block" />{/if}{o.label}
		</button>
	{/each}
</div>
