<script lang="ts">
	import { toasts } from '#lib/toast.svelte.js';
	import { arrive } from '#lib/motion.js';
	import Icon from './Icon.svelte';
</script>

<div class="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:w-[380px]" aria-live="polite" role="status">
	{#each toasts.items as t (t.id)}
		<div
			in:arrive
			class="pointer-events-auto flex w-full items-start gap-3 rounded-card border bg-surface px-4 py-3 text-[15px] {t.tone === 'error'
				? 'border-neg text-ink'
				: 'border-line-strong text-ink'}"
		>
			<span class="mt-0.5 {t.tone === 'error' ? 'text-neg' : t.tone === 'success' ? 'text-pos' : 'text-ink-3'}">
				<Icon name={t.tone === 'error' ? 'alert' : 'check'} size={18} />
			</span>
			<p class="flex-1">{t.text}</p>
			<button class="-m-2 grid size-11 shrink-0 place-items-center text-ink-3 hover:text-ink" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}>
				<Icon name="x" size={16} />
			</button>
		</div>
	{/each}
</div>
