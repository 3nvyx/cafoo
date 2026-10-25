<script lang="ts">
	// One Proposal: plain summary, amount, the Advisor's ruling, Confirm / Send back.
	import { db } from '#lib/data/index.js';
	import { formatMoney } from '#lib/data/money.js';
	import type { Proposal } from '#lib/data/types.js';
	import { KIND, STATUS, drill, dateTime, roleName } from '#lib/labels.js';
	import { arrive, reveal } from '#lib/motion.js';
	import { confirmEffect } from '#lib/proposals.js';
	import { attempt } from '#lib/toast.svelte.js';
	import Pill from './Pill.svelte';
	import RoleAvatar from './RoleAvatar.svelte';

	let { proposal: p }: { proposal: Proposal } = $props();

	let composing = $state(false);
	let note = $state('');
	let busy = $state(false);
	let noteEl: HTMLInputElement | undefined = $state();

	const approval = $derived(db.approvals().find((a) => a.proposalId === p.id));
	const posted = $derived(db.journalEntries().find((j) => j.proposalId === p.id));
	const status = $derived(STATUS[p.status]);

	const amountLabel = $derived(p.kind === 'credit_decision' ? 'Credit at stake' : p.kind === 'vendor_block' ? 'Payments held' : p.kind === 'vendor_verify' ? 'Bills released' : 'Amount');

	/** CFO confirms the Advisor's approval (glossary: the Advisor approves, the CFO confirms). */
	async function confirm() {
		if (p.status !== 'awaiting_cfo' || busy) return;
		busy = true;
		// Say what the confirmation did: only journal entries, accruals and Bank Match payments post an entry.
		const done = confirmEffect(p, db).message;
		await attempt(() => db.cfoConfirm(p.id), done);
		busy = false;
	}

	function startSendBack() {
		if (p.status !== 'awaiting_cfo') return;
		composing = true;
		queueMicrotask(() => noteEl?.focus());
	}

	async function sendBack(e: SubmitEvent) {
		e.preventDefault();
		if (!note.trim()) return;
		busy = true;
		const ok = await attempt(() => db.cfoSendBack(p.id, note.trim()), 'Sent back with your note.');
		busy = false;
		if (ok) {
			composing = false;
			note = '';
		}
	}
</script>

<article
	id="proposal-{p.id}"
	aria-labelledby="proposal-{p.id}-summary"
	class="card flex scroll-mt-24 flex-col gap-4 p-4 transition-[border-color,box-shadow] duration-300 sm:p-5 {p.status === 'awaiting_cfo'
		? 'border-primary shadow-[0_0_0_1px_var(--primary)]'
		: ''}"
>
	<header class="flex flex-wrap items-start gap-x-3 gap-y-2">
		<RoleAvatar role={p.proposerRole} />
		<div class="min-w-0 flex-1 text-sm">
			<p class="font-medium">{roleName(p.proposerRole)}</p>
			<p class="text-ink-3">{KIND[p.kind]} · {dateTime(p.createdAt)}</p>
		</div>
		{#key p.status}
			<span in:arrive={{ y: -6, duration: 260 }}><Pill tone={status.tone}>{status.label}</Pill></span>
		{/key}
	</header>

	<p id="proposal-{p.id}-summary" class="font-display text-[22px] leading-[1.3] font-normal text-ink">{p.summaryPlain}</p>

	<div>
		<p class="eyebrow">{amountLabel}</p>
		<p class="num text-3xl font-semibold">{formatMoney(p.amountMinor)}</p>
	</div>

	{#if approval}
		<p class="rounded-[12px] bg-surface-container px-3 py-2 text-sm text-ink-2"><span class="font-semibold text-primary">Advisor:</span> {approval.summaryPlain}</p>
	{/if}

	{#if p.status === 'awaiting_cfo'}
		{#if composing}
			<form class="flex flex-col gap-2 sm:flex-row" onsubmit={sendBack} transition:reveal>
				<label class="sr-only" for="note-{p.id}">Why are you sending this back?</label>
				<input
					id="note-{p.id}"
					bind:this={noteEl}
					bind:value={note}
					class="field flex-1"
					placeholder="One line for the agent, e.g. Check with the vendor first"
					maxlength="160"
					onkeydown={(e) => e.key === 'Escape' && (composing = false)}
				/>
				<div class="flex gap-2">
					<button type="button" class="btn btn-text flex-1 sm:flex-none" onclick={() => (composing = false)}>Cancel</button>
					<button class="btn btn-primary flex-1 sm:flex-none" disabled={busy || !note.trim()}>Send back</button>
				</div>
			</form>
		{:else}
			<div class="grid grid-cols-2 gap-3 sm:flex">
				<button class="btn btn-primary btn-lg sm:min-w-[160px]" disabled={busy} onclick={confirm}>
					{busy ? 'Confirming…' : 'Confirm'}
				</button>
				<button class="btn btn-lg sm:min-w-[160px]" disabled={busy} onclick={startSendBack}>
					Send back
				</button>
			</div>
		{/if}
	{:else if posted}
		<p class="text-sm text-ink-2">
			Posted to the books on {dateTime(posted.postedAt)}. <a class="drill font-medium text-ink" href={drill({ je: posted.id }, posted.periodId)}>See the journal lines</a>
		</p>
	{/if}
</article>
