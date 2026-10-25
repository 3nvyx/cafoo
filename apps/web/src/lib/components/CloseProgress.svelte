<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { bankExceptionState } from '#lib/close.js';
	import { checklistProgress } from '#lib/close-steps.js';

	let { periodId }: { periodId: string } = $props();
	const tasks = $derived(db.closeTasks().filter((t) => t.periodId === periodId));
	const exceptions = $derived(bankExceptionState(db, periodId));
	const progress = $derived(checklistProgress(tasks, periodId, exceptions.rows.length > 0 && exceptions.acceptance.accepted));
	const pct = $derived(progress.pct);
</script>

{#if tasks.length}
	<div class="flex flex-col gap-2">
		<div class="flex items-baseline justify-between gap-2 text-sm">
			<span class="text-ink-2">Close checklist</span>
			<a href="/close" class="drill num text-right text-ink"
				>{progress.done} of {progress.total} done{#if progress.accepted}{' '}· bank lines accepted as exceptions{/if}</a
			>
		</div>
		<div class="h-2 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct} aria-label="Close progress">
			<div class="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style="width:{pct}%"></div>
		</div>
		<ol class="flex gap-1" aria-hidden="true">
			{#each tasks as t (t.id)}
				<li
					class="h-1 flex-1 rounded-full transition-colors duration-300 {t.status === 'done'
						? 'bg-pos'
						: t.status === 'blocked'
							? 'bg-warn'
							: t.status === 'in_progress'
								? 'bg-accent/50'
								: 'bg-line'}"
				></li>
			{/each}
		</ol>
	</div>
{/if}
