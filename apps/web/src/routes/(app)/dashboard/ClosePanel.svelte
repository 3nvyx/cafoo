<script lang="ts">
	// Close progress: the Period's checklist as a progress bar, counts per state, and each step with its owner, so the
	// Dashboard shows where the close stands without opening the Close page.
	import { db } from '#lib/data/index.js';
	import { monthName } from '#lib/data/derive.js';
	import type { Period } from '#lib/data/types.js';
	import { TASK_STATUS, roleName } from '#lib/labels.js';
	import Pill from '#lib/components/Pill.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import { bankExceptionState } from '#lib/close.js';
	import { checklistProgress } from '#lib/close-steps.js';
	import { closeProgress, proposalCounts } from './insights.js';

	let { period }: { period: Period } = $props();

	const steps = $derived(closeProgress(db.closeTasks(), period.id));
	// The bank task stays open once the CFO accepts the bank lines as exceptions; the count says so, as on Close.
	const exceptions = $derived(bankExceptionState(db, period.id));
	const settled = $derived(checklistProgress(db.closeTasks(), period.id, exceptions.rows.length > 0 && exceptions.acceptance.accepted));
	const p = $derived({ ...steps, pct: settled.pct, accepted: settled.accepted });
	const counts = $derived(proposalCounts(db.proposals(), period.id));
	const resolved = $derived(counts.approved + counts.rejected);
	const SEG: Record<string, string> = { done: 'bg-pos', blocked: 'bg-warn', in_progress: 'bg-accent', todo: 'bg-line' };
</script>

<section aria-labelledby="closep-h" class="card flex flex-col gap-4 p-5">
	<div class="flex flex-wrap items-baseline justify-between gap-3">
		<h2 id="closep-h" class="text-subtitle">Close progress · {monthName(period.month)}</h2>
		<a href="/close" class="drill text-body-sm text-ink-2">Open the close</a>
	</div>

	{#if !p.total}
		<p class="text-body-sm text-ink-2">The checklist for {monthName(period.month)} is empty. Starting the close builds it.</p>
	{:else}
		<div class="flex flex-col gap-2">
			<div class="flex items-baseline justify-between text-body-sm">
				<span class="text-ink-2">Checklist</span>
				<span class="num text-ink"><span class="font-medium">{p.done} of {p.total}</span> done{#if p.accepted}{' '}· bank lines accepted as exceptions{/if} · {p.pct}%</span>
			</div>
			<div class="h-2 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={p.pct} aria-label="Close checklist {p.pct}% done">
				<div class="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style="width:{p.pct}%"></div>
			</div>
			<ol class="flex gap-1" aria-hidden="true">
				{#each p.steps as t (t.id)}
					<li class="h-1 flex-1 rounded-full {SEG[t.status]}" title="{t.title}: {TASK_STATUS[t.status].label}"></li>
				{/each}
			</ol>
		</div>

		<dl class="grid grid-cols-2 gap-3">
			{#each [['Done', p.done], ['In progress', p.inProgress], ['Waiting', p.blocked], ['To do', p.todo]] as [k, v] (k)}
				<div class="flex flex-col rounded-md bg-subtle px-3 py-2">
					<dt class="text-caption text-ink-2">{k}</dt>
					<dd class="num text-title">{v}</dd>
				</div>
			{/each}
		</dl>

		<ol class="flex max-h-64 flex-col overflow-y-auto" aria-label="Close steps">
			{#each p.steps as t (t.id)}
				<li class="flex items-center gap-3 border-t border-line py-2 first:border-t-0">
					<RoleAvatar role={t.ownerRole} size={24} />
					<span class="min-w-0 flex-1 text-body-sm" title="{t.title} · {roleName(t.ownerRole)}">{t.title}</span>
					<Pill tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Pill>
				</li>
			{/each}
		</ol>
	{/if}

	<p class="text-caption text-ink-2">
		<a href="/proposals" class="drill num">{counts.total} Proposal{counts.total === 1 ? '' : 's'}</a> this month: {resolved} resolved, {counts.awaiting} awaiting you, {counts.debate} in debate.
	</p>
</section>
