<script lang="ts">
	import { ui, type Mode } from '#lib/ui.svelte.js';

	const opts: { id: Mode; label: string }[] = [
		{ id: 'simple', label: 'Simple' },
		{ id: 'expert', label: 'Expert' }
	];
</script>

<div class="inline-flex rounded-btn border border-line-strong p-0.5" role="group" aria-label="View mode">
	{#each opts as o (o.id)}
		<button
			type="button"
			class="min-h-[40px] rounded-[3px] px-2.5 text-sm sm:px-3 font-medium transition-colors duration-150 {ui.mode === o.id
				? 'bg-ink text-canvas'
				: 'text-ink-2 hover:text-ink'}"
			aria-pressed={ui.mode === o.id}
			onclick={() => ui.setMode(o.id)}>{o.label}</button
		>
	{/each}
</div>
