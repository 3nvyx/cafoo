<script lang="ts">
	// Material 3 snackbars for action results: inverse surface, one line of plain English, a dismiss button.
	// On phones they sit above the bottom navigation bar.
	import { toasts } from '#lib/toast.svelte.js';
	import { arrive } from '#lib/motion.js';
	import Icon from './Icon.svelte';
</script>

<div
	class="pointer-events-none fixed inset-x-4 bottom-[calc(88px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 md:right-6 md:bottom-6 md:left-auto md:w-[400px] md:items-end"
	aria-live="polite"
	role="status"
>
	{#each toasts.items as t (t.id)}
		<div in:arrive class="pointer-events-auto flex w-full items-start gap-3 rounded-[12px] bg-inverse-surface py-3 pr-2 pl-4 text-[15px] text-inverse-on-surface shadow-[var(--elevation-2)]">
			<span class="mt-0.5 shrink-0" style="color: {t.tone === 'error' ? 'var(--inverse-error)' : t.tone === 'success' ? 'var(--inverse-success)' : 'var(--inverse-primary)'}">
				<Icon name={t.tone === 'error' ? 'alert' : 'check'} size={18} />
			</span>
			<p class="flex-1 py-px">{t.text}</p>
			<button class="state -my-2 grid size-11 shrink-0 place-items-center rounded-full" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}>
				<Icon name="x" size={16} />
			</button>
		</div>
	{/each}
</div>
