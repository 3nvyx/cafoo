<script lang="ts">
	// Where the month-end close of one Period stands, and the one next step: start it, watch it, lock it, or open the
	// final Board Pack. The Close page has the full checklist.
	import { db } from '#lib/data/index.js';
	import { monthName, periodLabel } from '#lib/data/derive.js';
	import type { Period } from '#lib/data/types.js';
	import { lockGate } from '#lib/close.js';
	import { closeRunNotes } from '#lib/close-run.js';
	import Notice from '#lib/components/Notice.svelte';
	import CloseProgress from '#lib/components/CloseProgress.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import LiveActivity from '#lib/components/LiveActivity.svelte';
	import { attempt } from '#lib/toast.svelte.js';

	let { period }: { period: Period } = $props();

	const month = $derived(monthName(period.month));
	const gate = $derived(lockGate(db, period.id));

	// Unmatched bank lines block the lock until the CFO accepts them on the Close page.
	const bankN = $derived(gate.bankExceptions.rows.length);
	const bankDecision = $derived(gate.started && period.status !== 'closed' && bankN > 0 && !gate.bankExceptions.acceptance.accepted);
	// The first thing the agent gateway flagged about this month's close run (live mode only).
	const runNote = $derived(closeRunNotes(db.connection().closes.find((c) => c.periodYm === period.id))[0]);

	let starting = $state(false);
	async function startClose() {
		starting = true;
		await attempt(() => db.startClose(period.id));
		starting = false;
	}

	const headline = $derived.by(() => {
		const open = bankN ? ` with ${bankN} unmatched bank line${bankN === 1 ? '' : 's'}` : '';
		if (period.status === 'closed') return `${month} is locked${open}. The Board Pack is final.`;
		if (gate.canLock) {
			return bankN && gate.bankExceptions.acceptance.accepted
				? `All proposals are resolved and ${bankN} bank line${bankN === 1 ? ' is' : 's are'} accepted as open. You can lock ${month}.`
				: `Every item is resolved. You can lock ${month}.`;
		}
		if (gate.started) {
			const n = gate.awaiting;
			return n ? `The agents are closing ${month}. ${n} item${n === 1 ? ' needs' : 's need'} your OK.` : `The agents are closing ${month}.`;
		}
		return `${month} is open. When you are ready, the agents will close it for you.`;
	});
</script>

<section aria-labelledby="close-h" class="card flex flex-col gap-5 p-5 lg:flex-row lg:items-start lg:justify-between">
	<div class="flex min-w-0 flex-col gap-2">
		<p class="text-body-sm text-ink-2">Month-end close · {periodLabel(period)}</p>
		<h2 id="close-h" class="text-title">{headline}</h2>
		{#if gate.canLock && gate.request}
			<p class="max-w-prose text-body-sm text-ink-2"><span class="font-medium text-ink">Advisor:</span> {gate.request.summaryPlain}</p>
		{/if}
		<LiveActivity periodId={period.id} />
	</div>
	<div class="flex w-full shrink-0 flex-col gap-4 lg:w-80">
		{#if period.status === 'closed'}
			<a href="/reports" class="btn w-full">Open the Board Pack <Icon name="arrowRight" size={18} /></a>
		{:else if gate.canLock}
			<a href="/close#lock" class="btn btn-primary w-full"><Icon name="lock" size={18} />Lock {month}</a>
		{:else if gate.started}
			<a href="/agents" class="btn w-full">Watch the agents <Icon name="arrowRight" size={18} /></a>
		{:else}
			<button class="btn btn-primary w-full" onclick={startClose} disabled={starting}>
				<Icon name="play" size={18} />{starting ? 'Starting…' : `Close ${month}`}
			</button>
		{/if}
		{#if bankDecision}
			<Notice tone="warn" href="/close#bank-exceptions" action="Review the bank lines">
				{bankN} unmatched bank line{bankN === 1 ? ' needs' : 's need'} your decision before {month} can lock.
			</Notice>
		{/if}
		{#if runNote}
			<Notice tone={runNote.tone} title={runNote.title} href={runNote.href} action={runNote.action}>{runNote.body}</Notice>
		{/if}
		<CloseProgress periodId={period.id} />
	</div>
</section>
