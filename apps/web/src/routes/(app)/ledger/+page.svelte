<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { db } from '#lib/data/index.js';
	import { isDebitNormal, periodShort } from '#lib/data/derive.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { JournalEntry } from '#lib/data/types.js';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import JournalLines, { type LineView } from '#lib/components/JournalLines.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { drill, roleName, shortDate } from '#lib/labels.js';
	import { arrive, reveal } from '#lib/motion.js';
	import { attempt } from '#lib/toast.svelte.js';
	import { ui } from '#lib/ui.svelte.js';

	const params = $derived(page.url.searchParams);
	const drillRaw = $derived(params.get('drill') ?? '');
	const [drillKind, drillValue] = $derived(drillRaw.includes(':') ? (drillRaw.split(/:(.*)/s, 2) as [string, string]) : ['', '']);
	const periodParam = $derived(params.get('period'));
	let q = $state('');

	const accounts = $derived(db.accounts());
	const byId = $derived(new Map(accounts.map((a) => [a.id, a])));
	const byCode = $derived(new Map(accounts.map((a) => [a.code, a])));
	const linesByJe = $derived.by(() => {
		const m = new Map<string, ReturnType<typeof db.journalLines>>();
		for (const l of db.journalLines()) {
			let list = m.get(l.jeId);
			if (!list) m.set(l.jeId, (list = []));
			list.push(l);
		}
		return m;
	});

	const drillJe = $derived(drillKind === 'je' ? db.journalEntries().find((j) => j.id === drillValue) : undefined);
	const periodFilter = $derived(drillJe ? drillJe.periodId : (periodParam ?? ui.periodId));

	const matchesLine = (l: { accountId: string; customerId?: string; vendorId?: string }) => {
		if (drillKind === 'account') return byId.get(l.accountId)?.code === drillValue;
		if (drillKind === 'customer') return l.customerId === drillValue;
		if (drillKind === 'vendor') return l.vendorId === drillValue;
		return false;
	};

	const entries = $derived.by(() => {
		const s = q.trim().toLowerCase();
		return db
			.journalEntries()
			.filter((j) => periodFilter === 'all' || j.periodId === periodFilter)
			.filter((j) => (drillKind && drillKind !== 'je' ? (linesByJe.get(j.id) ?? []).some(matchesLine) : true))
			.filter((j) => !s || j.memo.toLowerCase().includes(s) || j.id.toLowerCase().includes(s))
			.sort((a, b) => b.postedAt.localeCompare(a.postedAt));
	});

	const drillLabel = $derived.by(() => {
		if (drillKind === 'account') {
			const a = byCode.get(drillValue);
			return a ? (ui.expert ? `${a.code} ${a.name}` : a.name) : drillValue;
		}
		if (drillKind === 'customer') return db.customers().find((c) => c.id === drillValue)?.name ?? drillValue;
		if (drillKind === 'vendor') return db.vendors().find((v) => v.id === drillValue)?.name ?? drillValue;
		if (drillKind === 'je') return drillJe?.memo ?? drillValue;
		return '';
	});

	/** Net movement on the drilled account across the rows shown, in its natural sign. */
	const drillTotal = $derived.by(() => {
		if (drillKind !== 'account') return null;
		const a = byCode.get(drillValue);
		if (!a) return null;
		let t = 0n;
		for (const j of entries) for (const l of linesByJe.get(j.id) ?? []) if (l.accountId === a.id) t += toBig(l.debitMinor) - toBig(l.creditMinor);
		return (isDebitNormal(a.type) ? t : -t).toString();
	});

	let open = $state<Record<string, boolean>>({});
	$effect(() => {
		if (drillJe) {
			open[drillJe.id] = true;
			tick().then(() => document.getElementById(`je-${drillJe.id}`)?.scrollIntoView({ block: 'center' }));
		}
	});

	const total = (j: JournalEntry) => (linesByJe.get(j.id) ?? []).reduce((t, l) => t + toBig(l.debitMinor), 0n).toString();
	const view = (j: JournalEntry): LineView[] =>
		(linesByJe.get(j.id) ?? []).map((l) => {
			const a = byId.get(l.accountId);
			return { key: l.id, code: a?.code ?? '', name: a?.name ?? l.accountId, debitMinor: l.debitMinor, creditMinor: l.creditMinor, highlight: matchesLine(l) };
		});

	// An accrual's automatic next-month reversal (source agent) does not count: the CFO can still reverse the accrual.
	const reversed = $derived(new Set(db.journalEntries().flatMap((j) => (j.reversesJeId && j.source !== 'agent' ? [j.reversesJeId] : []))));
	const SOURCE = { seed: 'Imported', agent: 'Agent', manual: 'Manual' } as const;

	let reversing = $state<JournalEntry | null>(null);
	let reverseOpen = $state(false);

	function setPeriod(v: string) {
		const u = new URL(page.url.href);
		u.searchParams.set('period', v);
		if (drillKind === 'je') u.searchParams.delete('drill');
		goto(u, { replace: true, reset: false });
	}
</script>

<svelte:head><title>Ledger · Cafoo</title></svelte:head>

<div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
	<div>
		<h1 class="text-[32px]">Ledger</h1>
		<p class="mt-2 text-ink-2">Every Journal Entry, line by line. Click any amount to see what is behind it.</p>
	</div>
	<div class="flex flex-col gap-2 sm:flex-row">
		<label class="flex flex-col gap-1 text-sm text-ink-2">
			Period
			<select class="field text-ink" value={periodFilter} onchange={(e) => setPeriod((e.currentTarget as HTMLSelectElement).value)}>
				<option value="all">All periods</option>
				{#each db.periods() as p (p.id)}<option value={p.id}>{periodShort(p)}</option>{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1 text-sm text-ink-2">
			Search memos
			<input class="field text-ink" type="search" bind:value={q} placeholder="e.g. payroll" />
		</label>
	</div>
</div>

{#if drillKind}
	<div class="mt-6 flex flex-col gap-3 rounded-card border border-accent/40 bg-accent-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
		<p class="text-[15px]">
			{drillKind === 'je' ? 'Showing the entry' : 'Showing entries that touch'} <span class="font-medium">{drillLabel}</span>
			{#if drillTotal !== null}
				<span class="text-ink-2">· net</span> <span class="num font-medium">{formatMoney(drillTotal)}</span>
			{/if}
		</p>
		<a href="/ledger?period={periodFilter}" class="btn btn-quiet -my-2 self-start text-sm sm:self-auto"><Icon name="x" size={16} />Clear drill-down</a>
	</div>
{/if}

<div class="mt-6 border-t border-line">
	<div class="hidden grid-cols-[88px_minmax(0,1fr)_120px_160px] gap-4 border-b border-line py-2 text-sm text-ink-3 md:grid">
		<span>Date</span><span>Memo</span><span>Source</span><span class="text-right">Amount</span>
	</div>
	<ul>
		{#each entries as j (j.id)}
			<li id="je-{j.id}" class="border-b border-line" in:arrive>
				<button
					class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3 text-left hover:bg-subtle/60 md:grid-cols-[88px_minmax(0,1fr)_120px_160px] md:py-2.5"
					aria-expanded={!!open[j.id]}
					aria-controls="je-lines-{j.id}"
					onclick={() => (open[j.id] = !open[j.id])}
				>
					<span class="num order-3 text-sm text-ink-3 md:order-none">{shortDate(j.postedAt)}</span>
					<span class="order-1 min-w-0 md:order-none">
						<span class="block truncate">{j.memo}</span>
						{#if ui.expert}<span class="num block text-xs text-ink-3">{j.id}</span>{/if}
					</span>
					<span class="order-4 justify-self-end md:order-none md:justify-self-start">
						<Pill tone={j.source === 'agent' ? 'accent' : j.source === 'manual' ? 'warn' : 'muted'}>{SOURCE[j.source]}</Pill>
					</span>
					<span class="num order-2 flex items-center justify-end gap-2 md:order-none">
						{formatMoney(total(j))}
						<Icon name="chevronDown" size={16} class="text-ink-3 transition-transform duration-200 {open[j.id] ? 'rotate-180' : ''}" />
					</span>
				</button>
				{#if open[j.id]}
					<div id="je-lines-{j.id}" class="flex flex-col gap-3 pb-4 md:pl-[104px]" transition:reveal>
						<JournalLines lines={view(j)} showCodes={ui.expert} periodId={j.periodId} />
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-2">
							<span>Posted by {roleName(j.postedByRole)}</span>
							{#if j.proposalId}<a class="drill" href="/proposals?status=all#proposal-{j.proposalId}">From a Proposal</a>{/if}
							{#if j.reversesJeId}<a class="drill" href={drill({ je: j.reversesJeId })}>Reverses an earlier entry</a>{/if}
							<span class="flex-1"></span>
							{#if !(j.reversesJeId && j.source !== 'agent') && !reversed.has(j.id)}
								<button
									class="btn text-sm"
									onclick={() => {
										reversing = j;
										reverseOpen = true;
									}}><Icon name="undo" size={16} />Reverse</button
								>
							{:else if reversed.has(j.id)}
								<Pill tone="warn">Reversed</Pill>
							{/if}
						</div>
					</div>
				{/if}
			</li>
		{:else}
			<li class="py-10 text-center text-ink-3">No entries match.</li>
		{/each}
	</ul>
</div>

{#if reversing}
	<ConfirmDialog
		bind:open={reverseOpen}
		title="Reverse this entry?"
		body="This posts an equal and opposite entry for “{reversing.memo}” ({formatMoney(total(reversing))}) in the current open month. The original stays on the record."
		confirmLabel="Reverse entry"
		danger
		inputLabel="Why? One line for the audit log"
		inputPlaceholder="e.g. Booked to the wrong customer"
		inputRequired
		onconfirm={async (reason) => {
			const target = reversing;
			if (target) await attempt(() => db.cfoReverse(target.id, reason), 'Reversal posted.');
		}}
	/>
{/if}
