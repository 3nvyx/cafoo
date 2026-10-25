<script lang="ts">
	// The status bar at the top of Close: the six steps of the month-end close with their state and Proposal counts.
	// The derivation is pure and tested (#lib/close-steps.js).
	import { db } from '#lib/data/index.js';
	import { lockGate } from '#lib/close.js';
	import { STEP_STATE, closeSteps } from '#lib/close-steps.js';
	import Icon from '#lib/components/Icon.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';

	let { periodId }: { periodId: string } = $props();
	const gate = $derived(lockGate(db, periodId));
	const status = $derived(closeSteps({ period: gate.period, tasks: db.closeTasks(), proposals: db.proposals(), started: gate.started, canLock: gate.canLock }));
	const totals = $derived(status.steps.find((s) => s.id === 'cfo_review'));
</script>

<section class="card flex flex-col gap-4 p-4 sm:p-5" aria-labelledby="close-status-h">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="close-status-h" class="text-subtitle">Close status</h2>
		<p class="text-body-sm text-ink-2">
			{#if totals}
				<span class="num">{totals.made}</span> Proposals made · <span class="num">{totals.approved}</span> approved ·
				<a href="/proposals?status=awaiting_cfo" class="drill"><span class="num">{totals.waitingCfo}</span> waiting for the CFO</a> ·
			{/if}
			<span class="num font-medium text-ink">{status.percent}%</span> complete
		</p>
	</div>
	<div class="h-2 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={status.percent} aria-label="Close status">
		<div class="h-full rounded-full bg-accent transition-all duration-500 ease-out" style="width:{status.percent}%"></div>
	</div>
	<ol class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
		{#each status.steps as s, i (s.id)}
			<li class="flex flex-col gap-2 rounded-md border border-line p-3 {s.state === 'running' ? 'bg-subtle' : ''}">
				<div class="flex items-center gap-2">
					{#if s.id === 'lock'}
						<span class="grid size-6 shrink-0 place-items-center rounded-full bg-subtle text-ink-2"><Icon name="lock" size={14} /></span>
					{:else}
						<RoleAvatar role={s.id === 'cfo_review' ? 'cfo' : s.id} size={24} />
					{/if}
					<span class="min-w-0 truncate text-body-sm font-medium"><span class="num text-ink-3">{i + 1}.</span> {s.label}</span>
				</div>
				<span><Pill tone={STEP_STATE[s.state].tone}>{STEP_STATE[s.state].label}</Pill></span>
				{#if s.id !== 'lock'}
					<dl class="grid grid-cols-3 gap-1 text-caption text-ink-2">
						<div><dt class="sr-only">Proposals made</dt><dd class="num text-ink">{s.made}</dd><dd aria-hidden="true">made</dd></div>
						<div><dt class="sr-only">Approved</dt><dd class="num text-ink">{s.approved}</dd><dd aria-hidden="true">approved</dd></div>
						<div><dt class="sr-only">Waiting for the CFO</dt><dd class="num text-ink">{s.waitingCfo}</dd><dd aria-hidden="true">for CFO</dd></div>
					</dl>
				{/if}
				<p class="text-caption text-ink-3">{s.note}</p>
			</li>
		{/each}
	</ol>
</section>
