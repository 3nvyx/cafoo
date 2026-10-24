<script lang="ts">
	import { db } from '#lib/data/index.js';
	import { accountBalance, arrAt, monthName, periodEnd, periodLabel } from '#lib/data/derive.js';
	import type { Proposal } from '#lib/data/types.js';
	import { lockGate } from '#lib/close.js';
	import CloseProgress from '#lib/components/CloseProgress.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import CountUp from '#lib/components/CountUp.svelte';
	import DebateMessage from '#lib/components/DebateMessage.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import LiveActivity from '#lib/components/LiveActivity.svelte';
	import ProposalList from '#lib/components/ProposalList.svelte';
	import { drill } from '#lib/labels.js';
	import { arrive } from '#lib/motion.js';
	import { attempt, toasts } from '#lib/toast.svelte.js';
	import { ui } from '#lib/ui.svelte.js';

	const period = $derived(db.periods().find((p) => p.id === ui.periodId) ?? db.periods().at(-1));
	const month = $derived(period ? monthName(period.month) : '');
	const books = $derived({ accounts: db.accounts(), entries: db.journalEntries(), lines: db.journalLines() });
	const gate = $derived(lockGate(db, period?.id ?? ''));

	const cash = $derived(period ? accountBalance(books, db.periods(), period.id, '1000') : '0');
	const openAr = $derived(period ? accountBalance(books, db.periods(), period.id, '1100') : '0');
	const arr = $derived(period ? arrAt(db.contracts(), periodEnd(period)) : '0');

	// Keep a just-confirmed card on screen briefly so the state flip is visible.
	const awaiting = $derived(db.proposals().filter((p) => p.status === 'awaiting_cfo'));
	let lingering = $state<string[]>([]);
	let prev: string[] = [];
	$effect(() => {
		const ids = awaiting.map((p) => p.id);
		const gone = prev.filter((id) => !ids.includes(id));
		prev = ids;
		if (!gone.length) return;
		lingering = [...lingering, ...gone];
		setTimeout(() => (lingering = lingering.filter((id) => !gone.includes(id))), 900);
	});
	const queue = $derived<Proposal[]>(db.proposals().filter((p) => p.status === 'awaiting_cfo' || lingering.includes(p.id)));

	// Every message, including close-thread narration that has no Proposal.
	const feed = $derived(db.agentMessages().slice(-6).reverse());

	let starting = $state(false);
	async function startClose() {
		if (!period) return;
		starting = true;
		await attempt(() => db.startClose(period.id));
		starting = false;
	}

	let confirmAllOpen = $state(false);
	let confirmingAll = $state(false);
	async function confirmAll() {
		const ids = awaiting.map((p) => p.id);
		if (!ids.length) return;
		confirmingAll = true;
		const tid = toasts.push(`Confirming 0 of ${ids.length}…`, 'info', 0);
		let done = 0;
		const failed: string[] = [];
		for (const id of ids) {
			try {
				await db.cfoConfirm(id);
				done++;
			} catch (err) {
				failed.push(err instanceof Error ? err.message : String(err));
			}
			toasts.update(tid, `Confirming ${done + failed.length} of ${ids.length}…`);
		}
		confirmingAll = false;
		if (failed.length) toasts.update(tid, `Confirmed ${done} of ${ids.length}. ${failed.length} failed: ${failed[0]}`, 'error', 8000);
		else toasts.update(tid, `Confirmed all ${done}. The entries are posted.`, 'success', 4200);
	}

	const headline = $derived.by(() => {
		if (!period) return '';
		if (period.status === 'closed') return `${month} is locked. The Board Pack is final.`;
		if (gate.canLock) return `Every item is resolved. You can lock ${month}.`;
		if (gate.started) {
			const n = gate.awaiting;
			return n ? `The agents are closing ${month}. ${n} item${n === 1 ? ' needs' : 's need'} your OK.` : `The agents are closing ${month}.`;
		}
		return `${month} is open. When you are ready, the agents will close it for you.`;
	});
</script>

<svelte:head><title>Launchpad · Cafoo</title></svelte:head>

{#if period}
	<section class="flex flex-col gap-6 border-b border-line pb-8 lg:flex-row lg:items-end lg:justify-between">
		<div class="flex flex-col gap-2">
			<p class="eyebrow">Cafoo Inc · {periodLabel(period)}</p>
			<h1 class="max-w-[22ch] text-[32px] sm:text-[40px]">{headline}</h1>
			{#if gate.canLock && gate.request}
				<p class="max-w-[60ch] text-ink-2"><span class="font-medium text-ink">Advisor:</span> {ui.expert ? gate.request.body : gate.request.summaryPlain}</p>
			{/if}
			<LiveActivity periodId={period.id} />
		</div>
		<div class="flex w-full flex-col gap-4 lg:w-[340px]">
			{#if period.status === 'closed'}
				<a href="/reports" class="btn btn-lg w-full">Open the Board Pack <Icon name="arrowRight" size={18} /></a>
			{:else if gate.canLock}
				<a href="/close#lock" class="btn btn-primary btn-lg w-full"><Icon name="lock" size={18} />Lock {month}</a>
			{:else if gate.started}
				<a href="/agents" class="btn btn-lg w-full">Watch the agents <Icon name="arrowRight" size={18} /></a>
			{:else}
				<button class="btn btn-primary btn-lg w-full" onclick={startClose} disabled={starting}>
					<Icon name="play" size={18} />{starting ? 'Starting…' : `Close ${month}`}
				</button>
			{/if}
			<CloseProgress periodId={period.id} />
		</div>
	</section>

	<section aria-label="Key numbers" class="grid grid-cols-1 divide-y divide-line border-b border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
		{#each [{ label: 'Cash', minor: cash, href: drill({ account: '1000' }, 'all'), hint: `in the bank at the end of ${month}` }, { label: 'ARR', minor: arr, href: drill({ account: '4000' }, period.id), hint: 'annual recurring revenue' }, { label: 'Open receivables', minor: openAr, href: drill({ account: '1100' }, 'all'), hint: 'owed to us by customers' }] as k (k.label)}
			<a href={k.href} class="group flex flex-col gap-1 py-5 sm:px-6 sm:first:pl-0">
				<span class="eyebrow">{k.label}</span>
				<span class="text-[28px] leading-9 font-medium group-hover:text-accent-ink sm:text-[32px]"><CountUp minor={k.minor} /></span>
				<span class="text-sm text-ink-3">{k.hint}</span>
			</a>
		{/each}
	</section>

	<div class="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
		<section aria-labelledby="queue-h">
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<h2 id="queue-h" class="text-2xl">Needs your OK</h2>
				<div class="flex items-center gap-3">
					{#if awaiting.length > 1}
						<button class="btn btn-primary" disabled={confirmingAll} onclick={() => (confirmAllOpen = true)}>
							<Icon name="check" size={18} />{confirmingAll ? 'Confirming…' : `Confirm all ${awaiting.length}`}
						</button>
					{/if}
					<a href="/proposals" class="drill text-sm text-ink-2">All Proposals</a>
				</div>
			</div>
			<ProposalList
				proposals={queue}
				empty={gate.started ? 'Nothing needs you right now.' : 'Nothing needs you yet. Start the close and the agents will bring you anything above your threshold.'}
			/>
		</section>

		<aside aria-labelledby="feed-h">
			<div class="mb-4 flex items-baseline justify-between">
				<h2 id="feed-h" class="text-xl">Live from the agents</h2>
				<a href="/agents" class="drill text-sm text-ink-2">Full Debate</a>
			</div>
			<ul class="flex flex-col gap-4" aria-live="polite">
				{#each feed as m (m.id)}
					<li in:arrive><DebateMessage {m} /></li>
				{:else}
					<li class="text-ink-3">Quiet for now. Messages appear here the moment an agent posts.</li>
				{/each}
			</ul>
		</aside>
	</div>

	<ConfirmDialog
		bind:open={confirmAllOpen}
		title="Confirm all {awaiting.length}?"
		body="Confirm all {awaiting.length} items the Advisor already approved?"
		confirmLabel="Confirm all {awaiting.length}"
		onconfirm={() => {
			void confirmAll();
		}}
	/>
{/if}
