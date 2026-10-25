<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { monthName, periodLabel } from '#lib/data/derive.js';
	import CloseProgress from '#lib/components/CloseProgress.svelte';
	import CloseStatusBar from '#lib/components/CloseStatusBar.svelte';
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
	import { closeRunNotes } from '#lib/close-run.js';
	import BankExceptions from '#lib/components/BankExceptions.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import { isBankReconciliationTask } from '@cafoo/ledger-core';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId));
	const tasks = $derived(db.closeTasks().filter((t) => t.periodId === ui.periodId).sort((a, b) => a.order - b.order));
	const proposals = $derived(new Map(db.proposals().map((p) => [p.id, p])));
	const gate = $derived(lockGate(db, ui.periodId));
	const canLock = $derived(gate.canLock);
	const month = $derived(period ? monthName(period.month) : '');

	// Bank lines that match nothing through this month (see BankExceptions). Accepting them lets the month lock, but
	// they stay unmatched, so the reconciliation task stays open.
	const bank = $derived(gate.bankExceptions);
	const bankN = $derived(bank.rows.length);
	const bankLines = $derived(`${bankN} unmatched bank line${bankN === 1 ? '' : 's'}`);
	const bankBlocks = $derived(!!period && period.status !== 'closed' && bankN > 0 && !bank.acceptance.accepted);
	const bankAccepted = $derived(bankN > 0 && bank.acceptance.accepted);
	// The link on the bank task: what the lines mean for it right now. A locked month whose acceptance was voided by
	// later evidence (the live feed can do that) says "locked", not "accepted", so it agrees with the Board Pack.
	const bankTaskNote = $derived(
		bankAccepted
			? `${bankN} line${bankN === 1 ? '' : 's'} accepted unmatched, so this task stays open`
			: period?.status === 'closed'
				? `${bankN} line${bankN === 1 ? '' : 's'} locked unmatched, so this task stays open`
				: `${bankLines} · review below`
	);
	const bankHeldNote = $derived(`The ${bankN} accepted bank line${bankN === 1 ? ' stays' : 's stay'} unmatched and ${bankN === 1 ? 'its' : 'their'} task stays open.`);

	// What the agent gateway reported for this month's close run (live mode only).
	const run = $derived(db.connection().closes.find((c) => c.periodYm === ui.periodId));
	const notes = $derived(closeRunNotes(run));

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
</script>

<svelte:head><title>Close · Cafoo</title></svelte:head>

{#if period}
	<div class="mb-6"><CloseStatusBar periodId={period.id} /></div>

	<div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
		<div>
			<p class="eyebrow">Month-end close</p>
			<h1 class="text-[34px] sm:text-[42px]">{periodLabel(period)}</h1>
			<div class="mt-2"><LiveActivity periodId={period.id} /></div>
		</div>
		<div class="w-full lg:w-[320px]"><CloseProgress periodId={period.id} /></div>
	</div>

	{#if notes.length}
		<div class="mt-6 flex flex-col gap-3">
			{#each notes as n (n.title)}
				<Notice tone={n.tone} title={n.title} href={n.href} action={n.action}>{n.body}</Notice>
			{/each}
		</div>
	{/if}

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
						{#if bankN && isBankReconciliationTask({ ownerRole: t.ownerRole, sortOrder: t.order, title: t.title })}
							<p class="mt-2 text-caption text-ink-2">
								<a class="drill" href="#bank-exceptions">
									{bankTaskNote}
								</a>
							</p>
						{/if}
					</div>
					<div class="flex items-center gap-2 sm:justify-end">
						{#key t.status}
							<span in:arrive={{ y: -6 }}><Pill tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Pill></span>
						{/key}
					</div>
				</li>
			{/each}
		</ol>
	{/if}

	<div class="mt-8"><BankExceptions periodId={period.id} /></div>

	<section id="lock" class="card mt-8 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="lock-h">
		<div class="flex gap-4">
			<span class="grid size-11 shrink-0 place-items-center rounded-full bg-subtle text-ink-2"><Icon name="lock" /></span>
			<div>
				<h2 id="lock-h" class="text-xl">{period.status === 'closed' ? `${month} is locked` : `Lock ${month}`}</h2>
				<p class="mt-1 text-ink-2">
					{#if period.status === 'closed'}
						Locked {period.lockedAt ? dateTime(period.lockedAt) : ''}{bankN ? ` with ${bankLines} on record` : ''}. Nothing can post to {month} anymore. The Board Pack is final. {reversalNote}
					{:else if canLock}
						{#if gate.request}<span class="mb-1 block text-ink"><span class="font-medium">Advisor:</span> {gate.request.summaryPlain}</span>{/if}
						Locking stops anyone, including the agents, from posting to {month}.
						{#if bankN && bank.acceptance.accepted}{bankHeldNote}{:else}Any tasks still open are marked done.{/if}
					{:else}
						{gate.blocker}
					{/if}
				</p>
			</div>
		</div>
		{#if period.status !== 'closed'}
			<div class="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
				<!-- One primary action per view: while the bank lines hold the lock, reviewing them is the live action. -->
				<button class="btn btn-lg w-full sm:w-auto {bankBlocks && gate.started ? '' : 'btn-primary'}" disabled={!canLock} onclick={() => (confirmOpen = true)}>
					<Icon name="lock" size={18} />Lock {month}
				</button>
				{#if bankBlocks && gate.started}
					<a class="btn btn-primary btn-lg w-full sm:w-auto" href="#bank-exceptions">Review the bank lines</a>
				{/if}
			</div>
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
		body="After this, nothing can be posted to {month}, by you or by any agent, and the Board Pack becomes final.{bankN && bank.acceptance.accepted ? ` ${bankHeldNote}` : ''} {reversalNote} You can unlock {month} again if you need to."
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
