<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { monthName, periodLabel } from '#lib/data/derive.js';
	import type { CloseTaskStatus } from '#lib/data/types.js';
	import CloseProgress from '#lib/components/CloseProgress.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import LiveActivity from '#lib/components/LiveActivity.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import { STATUS, TASK_STATUS, dateTime, roleName } from '#lib/labels.js';
	import { arrive } from '#lib/motion.js';
	import { attempt } from '#lib/toast.svelte.js';
	import { ui } from '#lib/ui.svelte.js';
	import { lockGate, nextOpenPeriod } from '#lib/close.js';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const tasks = $derived(db.closeTasks().filter((t) => t.periodId === ui.periodId).sort((a, b) => a.order - b.order));
	const proposals = $derived(new Map(db.proposals().map((p) => [p.id, p])));
	const gate = $derived(lockGate(db, ui.periodId));
	const canLock = $derived(gate.canLock);
	const month = $derived(period ? monthName(period.month) : '');

	// What reversing one of this month's entries does once it is locked, from the months that exist (the module posts a
	// correction in the earliest open month after a locked one, and refuses to undo a locked month's bank reconciliation).
	const after = $derived(period ? nextOpenPeriod(db.periods(), period.id) : undefined);
	const afterMonth = $derived(after ? periodLabel(after) : '');
	const reversalNote = $derived(
		after
			? `A reversal of a ${month} entry posts in ${afterMonth} instead, except for entries tied to a ${month} bank line: those need ${month} unlocked first.`
			: `No later month is open, so to reverse a ${month} entry, unlock ${month} first.`
	);

	let confirmOpen = $state(false);
	let unlockOpen = $state(false);
	let expanded = $state<Record<string, boolean>>({});
	const SHOW = 4;

	const STATUSES: CloseTaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
</script>

<svelte:head><title>Close · Cafoo</title></svelte:head>

{#if period}
	<div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
		<div>
			<p class="eyebrow">Month-end close</p>
			<h1 class="text-[34px] sm:text-[42px]">{periodLabel(period)}</h1>
			<div class="mt-2"><LiveActivity periodId={period.id} /></div>
		</div>
		<div class="w-full lg:w-[320px]"><CloseProgress periodId={period.id} /></div>
	</div>

	{#if !tasks.length}
		<p class="card mt-8 px-5 py-10 text-center text-ink-3">There is no close checklist for {periodLabel(period)}.</p>
	{:else}
		<ol class="mt-8 flex flex-col divide-y divide-line border-y border-line">
			{#each tasks as t (t.id)}
				<li class="grid gap-3 py-4 sm:grid-cols-[32px_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
					<span class="num hidden pt-0.5 text-ink-3 sm:block">{t.order}</span>
					<div class="min-w-0">
						<p class="font-medium">{t.title}</p>
						<p class="mt-1 flex items-center gap-2 text-sm text-ink-2">
							<RoleAvatar role={t.ownerRole} size={22} />
							{roleName(t.ownerRole)}
						</p>
						{#if t.proposalIds.length}
							<ul class="mt-3 flex flex-col gap-2" aria-label="Evidence">
								{#each expanded[t.id] ? t.proposalIds : t.proposalIds.slice(0, SHOW) as id (id)}
									{@const p = proposals.get(id)}
									{#if p}
										<li in:arrive>
											<a href="/proposals?status=all#proposal-{p.id}" class="group flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
												<Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>
												<span class="drill text-ink-2 group-hover:text-ink">{p.summaryPlain}</span>
											</a>
										</li>
									{/if}
								{/each}
								{#if t.proposalIds.length > SHOW}
									<li>
										<button class="min-h-[44px] text-sm font-medium text-ink-2 hover:text-ink" aria-expanded={!!expanded[t.id]} onclick={() => (expanded[t.id] = !expanded[t.id])}>
											{expanded[t.id] ? 'Show fewer' : `Show ${t.proposalIds.length - SHOW} more`}
										</button>
									</li>
								{/if}
							</ul>
						{/if}
					</div>
					<div class="flex items-center gap-2 sm:justify-end">
						{#if ui.expert && t.ownerRole !== 'cfo'}
							<label class="sr-only" for="st-{t.id}">Status of {t.title}</label>
							<select
								id="st-{t.id}"
								class="field text-sm"
								value={t.status}
								onchange={(e) => attempt(() => db.setCloseTaskStatus(t.id, (e.currentTarget as HTMLSelectElement).value as CloseTaskStatus))}
							>
								{#each STATUSES as s (s)}<option value={s}>{TASK_STATUS[s].label}</option>{/each}
							</select>
						{:else}
							{#key t.status}
								<span in:arrive={{ y: -6 }}><Pill tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Pill></span>
							{/key}
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	{/if}

	<section id="lock" class="card mt-8 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="lock-h">
		<div class="flex gap-4">
			<span class="grid size-11 shrink-0 place-items-center rounded-full bg-subtle text-ink-2"><Icon name="lock" /></span>
			<div>
				<h2 id="lock-h" class="text-xl">{period.status === 'closed' ? `${month} is locked` : `Lock ${month}`}</h2>
				<p class="mt-1 text-ink-2">
					{#if period.status === 'closed'}
						Locked {period.lockedAt ? dateTime(period.lockedAt) : ''}. Nothing can post to {month} anymore. The Board Pack is final. {reversalNote}
					{:else if canLock}
						{#if gate.request}<span class="mb-1 block text-ink"><span class="font-medium">Advisor:</span> {ui.expert ? gate.request.body : gate.request.summaryPlain}</span>{/if}
						Locking stops anyone, including the agents, from posting to {month}. Any tasks still open are marked done.
					{:else}
						{gate.blocker}
					{/if}
				</p>
			</div>
		</div>
		{#if period.status !== 'closed'}
			<button class="btn btn-primary btn-lg w-full sm:w-auto" disabled={!canLock} onclick={() => (confirmOpen = true)}>
				<Icon name="lock" size={18} />Lock {month}
			</button>
		{:else}
			<div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
				<button class="btn btn-lg w-full sm:w-auto" onclick={() => (unlockOpen = true)}>Unlock {month}</button>
				<a href="/reports" class="btn btn-lg w-full sm:w-auto">Open the Board Pack <Icon name="arrowRight" size={18} /></a>
			</div>
		{/if}
	</section>

	<ConfirmDialog
		bind:open={confirmOpen}
		title="Lock {periodLabel(period)}?"
		body="After this, nothing can be posted to {month}, by you or by any agent, and the Board Pack becomes final. {reversalNote} You can unlock {month} again if you need to."
		confirmLabel="Lock {month}"
		onconfirm={async () => {
			await attempt(() => db.lockPeriod(period.id), `${month} is locked. The Board Pack is final.`);
		}}
	/>

	<ConfirmDialog
		bind:open={unlockOpen}
		title="Unlock {periodLabel(period)}?"
		body="{month} opens again: you and the agents can post to it, and the Board Pack goes back to a draft until you lock {month} again. Your reason is kept in the audit log."
		confirmLabel="Unlock {month}"
		danger
		inputLabel="Why? One line for the audit log"
		inputPlaceholder="e.g. A vendor credit note arrived late"
		inputRequired
		onconfirm={async (reason) => {
			await attempt(() => db.unlockPeriod(period.id, reason), `${month} is unlocked. Lock it again when the corrections are in.`);
		}}
	/>
{/if}
