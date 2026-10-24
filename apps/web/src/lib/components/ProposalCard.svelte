<script lang="ts">
	// One Proposal. Simple mode: plain summary, amount, Approve / Send back.
	// Expert mode adds what the payload would change (journal lines, a Revenue Schedule's months, a Bank Match's links),
	// the Red Team critique verbatim, the raw payload and the transcript.
	import { db } from '#lib/data/index.js';
	import { formatMoney } from '#lib/data/money.js';
	import type { Proposal } from '#lib/data/types.js';
	import { KIND, STATUS, drill, dateTime, roleName } from '#lib/labels.js';
	import { arrive, reveal } from '#lib/motion.js';
	import { confirmEffect, journalLinesOf, matchesOf, parsePayload, scheduleLinesOf } from '#lib/proposals.js';
	import { attempt } from '#lib/toast.svelte.js';
	import { ui } from '#lib/ui.svelte.js';
	import DebateMessage from './DebateMessage.svelte';
	import JournalLines, { type LineView } from './JournalLines.svelte';
	import MatchTable from './MatchTable.svelte';
	import Pill from './Pill.svelte';
	import RoleAvatar from './RoleAvatar.svelte';
	import ScheduleTable from './ScheduleTable.svelte';

	let { proposal: p, focused = false, onfocus }: { proposal: Proposal; focused?: boolean; onfocus?: () => void } = $props();

	let composing = $state(false);
	let note = $state('');
	let busy = $state(false);
	let noteEl: HTMLInputElement | undefined = $state();

	const messages = $derived(db.agentMessages().filter((m) => m.proposalId === p.id));
	const critiques = $derived(messages.filter((m) => m.senderRole === 'redteam' && m.kind === 'critique'));
	const approval = $derived(db.approvals().find((a) => a.proposalId === p.id));
	const posted = $derived(db.journalEntries().find((j) => j.proposalId === p.id));
	const status = $derived(STATUS[p.status]);
	const accounts = $derived(new Map(db.accounts().map((a) => [a.code, a])));

	const payload = $derived(parsePayload(p.payloadJson));
	// A payload's `lines` are journal lines (debit or credit on an account) or, for a Revenue Schedule, month amounts.
	const lines = $derived<LineView[]>(
		journalLinesOf(payload).map((l, i) => ({
			key: `${i}`,
			code: l.code,
			name: accounts.get(l.code)?.name ?? (l.memo || l.code),
			debitMinor: l.debitMinor,
			creditMinor: l.creditMinor,
			ccy: l.ccy ?? db.subsidiaries().find((s) => s.id === accounts.get(l.code)?.subsidiaryId)?.baseCurrency
		}))
	);
	const schedule = $derived(scheduleLinesOf(payload));
	const matches = $derived(matchesOf(payload));

	const prettyPayload = $derived(payload ? JSON.stringify(payload, null, 2) : p.payloadJson);
	const amountLabel = $derived(p.kind === 'credit_decision' ? 'Credit at stake' : p.kind === 'vendor_block' ? 'Payments held' : p.kind === 'vendor_verify' ? 'Bills released' : 'Amount');

	/** CFO confirms the Advisor's approval (glossary: the Advisor approves, the CFO confirms). */
	export async function confirm() {
		if (p.status !== 'awaiting_cfo' || busy) return;
		busy = true;
		// Say what the confirmation did: only journal entries, accruals and Bank Match payments post an entry.
		const done = confirmEffect(p, db).message;
		await attempt(() => db.cfoConfirm(p.id), done);
		busy = false;
	}

	export function startSendBack() {
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article
	id="proposal-{p.id}"
	tabindex={ui.expert ? 0 : undefined}
	onfocusin={onfocus}
	aria-labelledby="proposal-{p.id}-summary"
	class="card flex scroll-mt-24 flex-col gap-4 p-4 transition-[border-color,box-shadow] duration-300 sm:p-5 {p.status === 'awaiting_cfo'
		? 'border-primary shadow-[0_0_0_1px_var(--primary)]'
		: ''} {focused && ui.expert ? 'ring-2 ring-focus ring-offset-2 ring-offset-canvas' : ''}"
>
	<header class="flex flex-wrap items-start gap-x-3 gap-y-2">
		<RoleAvatar role={p.proposerRole} />
		<div class="min-w-0 flex-1 text-sm">
			<p class="font-medium">{roleName(p.proposerRole)}</p>
			<p class="text-ink-3">{KIND[p.kind]}{#if ui.expert}<span class="num"> · {p.id}</span>{/if} · {dateTime(p.createdAt)}</p>
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
					{#if ui.expert}<kbd class="hidden rounded-[6px] border border-current/40 px-1 font-mono text-xs sm:inline">A</kbd>{/if}
				</button>
				<button class="btn btn-lg sm:min-w-[160px]" disabled={busy} onclick={startSendBack}>
					Send back
					{#if ui.expert}<kbd class="kbd hidden sm:inline-block">S</kbd>{/if}
				</button>
			</div>
		{/if}
	{:else if posted}
		<p class="text-sm text-ink-2">
			Posted to the books on {dateTime(posted.postedAt)}. <a class="drill font-medium text-ink" href={drill({ je: posted.id }, posted.periodId)}>See the journal lines</a>
		</p>
	{/if}

	{#if ui.expert}
		<div class="flex flex-col gap-4 border-t border-line pt-4" transition:reveal>
			{#if matches.length}
				<section aria-label="Bank matches">
					<p class="eyebrow mb-2">{matches.length === 1 ? 'Bank match' : `${matches.length} bank matches`}</p>
					<MatchTable {matches} />
				</section>
			{/if}
			{#if schedule.length}
				<section aria-label="Revenue Schedule">
					<p class="eyebrow mb-2">Revenue Schedule</p>
					<ScheduleTable lines={schedule} periodId={p.periodId || undefined} />
				</section>
			{/if}
			{#if lines.length}
				<section aria-label="Journal lines">
					<p class="eyebrow mb-2">Journal lines</p>
					<JournalLines {lines} showCodes periodId={p.periodId || undefined} />
				</section>
			{/if}
			<section>
				<p class="eyebrow mb-1">Rationale</p>
				<p class="font-mono text-[13px] leading-5 text-ink-2">{p.rationale}</p>
			</section>
			{#each critiques as c (c.id)}
				<section aria-label="Red Team critique">
					<p class="eyebrow mb-1">Red Team critique, verbatim</p>
					<blockquote class="border-l-2 py-1 pl-3 font-mono text-[13px] leading-5 text-ink" style="border-color: var(--role-redteam)">{c.body}</blockquote>
				</section>
			{:else}
				<p class="text-sm text-ink-3">No Red Team critique on this Proposal yet.</p>
			{/each}
			<details class="group">
				<summary class="flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-ink-2 hover:text-ink">Raw payload</summary>
				<pre class="overflow-x-auto rounded-btn bg-subtle p-3 font-mono text-xs leading-5">{prettyPayload}</pre>
			</details>
			<details>
				<summary class="flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-ink-2 hover:text-ink">Agent transcript ({messages.length})</summary>
				<div class="flex flex-col gap-4 pt-2">
					{#each messages as m (m.id)}
						<DebateMessage {m} />
					{/each}
				</div>
			</details>
		</div>
	{/if}
</article>
