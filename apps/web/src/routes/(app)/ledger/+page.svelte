<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { db } from '#lib/data/index.js';
	import { isDebitNormal, monthName, periodLabel, periodShort, ymShort } from '#lib/data/derive.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { JournalEntry, Period } from '#lib/data/types.js';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import JournalLines, { type LineView } from '#lib/components/JournalLines.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { correctionPeriod } from '#lib/close.js';
	import { inPeriod, parseDrill, parsePeriod, periodFilterLabel } from '#lib/drill.js';
	import { dateTime, drill, roleName, shortDate } from '#lib/labels.js';
	import { arrive, reveal } from '#lib/motion.js';
	import { attempt } from '#lib/toast.svelte.js';
	import { ui } from '#lib/ui.svelte.js';

	const params = $derived(page.url.searchParams);
	const parsed = $derived(parseDrill(params.get('drill') ?? ''));
	const drillKind = $derived(parsed.kind);
	const drillValue = $derived(parsed.values[0] ?? '');
	const periodParam = $derived(params.get('period'));
	let q = $state('');

	const accounts = $derived(db.accounts());
	const byId = $derived(new Map(accounts.map((a) => [a.id, a])));
	const periods = $derived(db.periods());
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
	const periodValue = $derived(drillJe ? drillJe.periodId : (periodParam ?? ui.periodId));
	const periodFilter = $derived(parsePeriod(periodValue));
	/** A range (e.g. quarter to date) or a month with no Period row gets its own option in the picker. */
	const customPeriod = $derived(periodValue !== 'all' && !periods.some((p) => p.id === periodValue));

	/** The accounts an account drill (one or several codes) or a type drill (e.g. revenue,expense) covers. */
	const drillAccounts = $derived(
		drillKind === 'account'
			? accounts.filter((a) => parsed.values.includes(a.code))
			: drillKind === 'type'
				? accounts.filter((a) => parsed.values.includes(a.type))
				: []
	);
	const drillAccountIds = $derived(new Set(drillAccounts.map((a) => a.id)));

	const matchesLine = (l: { accountId: string; customerId?: string; vendorId?: string }) => {
		if (drillKind === 'account' || drillKind === 'type') return drillAccountIds.has(l.accountId);
		if (drillKind === 'customer') return l.customerId === drillValue;
		if (drillKind === 'vendor') return l.vendorId === drillValue;
		return false;
	};

	const entries = $derived.by(() => {
		const s = q.trim().toLowerCase();
		return db
			.journalEntries()
			.filter((j) => inPeriod(j.periodId, periodFilter))
			.filter((j) => (drillKind && drillKind !== 'je' ? (linesByJe.get(j.id) ?? []).some(matchesLine) : true))
			.filter((j) => !s || j.memo.toLowerCase().includes(s) || j.id.toLowerCase().includes(s))
			.sort((a, b) => b.periodId.localeCompare(a.periodId) || b.postedAt.localeCompare(a.postedAt));
	});

	const names = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

	const drillLabel = $derived.by(() => {
		if (drillKind === 'account') {
			if (!drillAccounts.length) return parsed.values.join(', ');
			return names(drillAccounts.map((a) => (ui.expert ? `${a.code} ${a.name}` : a.name)));
		}
		if (drillKind === 'type') {
			const t = new Set(parsed.values);
			if (t.size === 2 && t.has('revenue') && t.has('expense')) return 'the income statement accounts (revenue and expenses)';
			return `the ${names(parsed.values)} accounts`;
		}
		if (drillKind === 'customer') return db.customers().find((c) => c.id === drillValue)?.name ?? drillValue;
		if (drillKind === 'vendor') return db.vendors().find((v) => v.id === drillValue)?.name ?? drillValue;
		if (drillKind === 'je') return drillJe?.memo ?? drillValue;
		return '';
	});

	/**
	 * Net movement on the drilled accounts across the rows shown. Accounts on one side keep their natural sign; the
	 * income statement nets to income (revenue less expenses), the way the Board Pack figure that linked here does.
	 */
	const drillTotal = $derived.by(() => {
		if (!drillAccounts.length) return null;
		let t = 0n;
		for (const j of entries) for (const l of linesByJe.get(j.id) ?? []) if (drillAccountIds.has(l.accountId)) t += toBig(l.debitMinor) - toBig(l.creditMinor);
		if (drillAccounts.every((a) => isDebitNormal(a.type))) return { label: 'net', amount: t.toString() };
		if (drillAccounts.every((a) => !isDebitNormal(a.type))) return { label: 'net', amount: (-t).toString() };
		if (drillAccounts.every((a) => a.type === 'revenue' || a.type === 'expense')) return { label: 'net income', amount: (-t).toString() };
		return { label: 'net debit', amount: t.toString() };
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

	/**
	 * The entry's accounting date: the day it was posted when that falls in its own month, otherwise the month itself
	 * (a September close adjustment posted in October, or opening data imported later, belongs to September).
	 */
	const entryDate = (j: JournalEntry) => (j.postedAt.slice(0, 7) === j.periodId ? shortDate(j.postedAt) : ymShort(j.periodId));
	const SOURCE = { seed: 'Imported', agent: 'Agent', manual: 'Manual' } as const;

	// Reversal rules, as the ledger module's cfoReverse applies them. The CFO (this seat) may reverse an entry unless it
	// is itself a CFO reversal, or a reversal other than an accrual's automatic next-month one already reversed it. The
	// reversal posts in the entry's own month if that month is open, otherwise in the earliest open month after it, and
	// reversing an accrual also reverses its automatic reversal, placed the same way. Reversing also undoes the bank
	// reconciliation the entry carries (a match straight at it, or the payment entry a match posted), which the module
	// refuses while that bank line's month is locked.
	const reversalsOf = $derived.by(() => {
		const m = new Map<string, JournalEntry[]>();
		for (const j of db.journalEntries()) {
			if (!j.reversesJeId) continue;
			let list = m.get(j.reversesJeId);
			if (!list) m.set(j.reversesJeId, (list = []));
			list.push(j);
		}
		return m;
	});
	const accrualProposals = $derived(new Set(db.proposals().filter((p) => p.kind === 'accrual').map((p) => p.id)));
	const isAutoReversal = (r: JournalEntry, of: JournalEntry) =>
		r.source === 'agent' && !!r.proposalId && r.proposalId === of.proposalId && accrualProposals.has(r.proposalId);
	const bankLineMonth = $derived(new Map(db.bankTransactions().map((t) => [t.id, t.ym])));
	/** Bank lines each entry reconciles: matches that target it, and matches whose payment entry it is. */
	const bankLinesOf = $derived.by(() => {
		const m = new Map<string, string[]>();
		const add = (jeId: string, txId: string) => {
			let list = m.get(jeId);
			if (!list) m.set(jeId, (list = []));
			list.push(txId);
		};
		for (const bm of db.bankMatches()) {
			if (bm.targetKind === 'journal_entry') add(bm.targetId, bm.bankTransactionId);
			if (bm.paymentJeId) add(bm.paymentJeId, bm.bankTransactionId);
		}
		return m;
	});

	type Reversal =
		| { state: 'ok'; into: Period; autos: { entry: JournalEntry; into: Period }[] }
		| { state: 'reconciled'; month: Period }
		| { state: 'reversed' | 'is_reversal' | 'locked' };
	function reversal(j: JournalEntry): Reversal {
		if (j.source === 'manual' && j.reversesJeId) return { state: 'is_reversal' };
		const rs = reversalsOf.get(j.id) ?? [];
		if (rs.some((r) => !isAutoReversal(r, j))) return { state: 'reversed' };
		const into = correctionPeriod(periods, j.periodId);
		if (!into) return { state: 'locked' };
		const autos: { entry: JournalEntry; into: Period }[] = [];
		for (const r of rs.filter((r) => !reversalsOf.get(r.id)?.length)) {
			const at = correctionPeriod(periods, r.periodId);
			if (!at) return { state: 'locked' };
			autos.push({ entry: r, into: at });
		}
		for (const tx of bankLinesOf.get(j.id) ?? []) {
			const month = periods.find((p) => p.id === bankLineMonth.get(tx));
			if (month?.status === 'closed') return { state: 'reconciled', month };
		}
		return { state: 'ok', into, autos };
	}
	const monthOf = (periodId: string) => {
		const p = periods.find((x) => x.id === periodId);
		return p ? periodLabel(p) : ymShort(periodId);
	};

	let reversing = $state<JournalEntry | null>(null);
	let reverseOpen = $state(false);
	const reverseBody = $derived.by(() => {
		if (!reversing) return '';
		const r = reversal(reversing);
		const what = `This posts an equal and opposite entry for “${reversing.memo}” (${formatMoney(total(reversing))})`;
		if (r.state !== 'ok') return `${what}, but it cannot be posted right now.`;
		const own = monthOf(reversing.periodId);
		const where =
			r.into.id === reversing.periodId
				? ` in ${own}, the entry's own month, because ${own} is open.`
				: ` in ${periodLabel(r.into)}: ${own} is locked, so it goes in the earliest open month after it.`;
		const autos = r.autos.map((a) => ` Its automatic reversal in ${monthOf(a.entry.periodId)} is reversed too, in ${periodLabel(a.into)}.`).join('');
		return `${what}${where}${autos} The original stays on the record.`;
	});

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
			<select class="field text-ink" value={periodValue} onchange={(e) => setPeriod((e.currentTarget as HTMLSelectElement).value)}>
				<option value="all">All periods</option>
				{#if customPeriod}<option value={periodValue}>{periodFilterLabel(periodFilter)}</option>{/if}
				{#each periods as p (p.id)}<option value={p.id}>{periodShort(p)}</option>{/each}
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
			{#if periodFilter.kind === 'range'}<span class="text-ink-2">· {periodFilterLabel(periodFilter)}</span>{/if}
			{#if drillTotal !== null}
				<span class="text-ink-2">· {drillTotal.label}</span> <span class="num font-medium">{formatMoney(drillTotal.amount)}</span>
			{/if}
		</p>
		<a href="/ledger?period={encodeURIComponent(periodValue)}" class="btn btn-quiet -my-2 self-start text-sm sm:self-auto"><Icon name="x" size={16} />Clear drill-down</a>
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
					<span class="num order-3 text-sm text-ink-3 md:order-none" title="Posted {dateTime(j.postedAt)}">{entryDate(j)}</span>
					<span class="order-1 min-w-0 md:order-none">
						<span class="block truncate">{j.memo}</span>
						{#if ui.expert}<span class="num block truncate text-xs text-ink-3">{j.id} · posted {dateTime(j.postedAt)}</span>{/if}
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
					{@const r = reversal(j)}
					<div id="je-lines-{j.id}" class="flex flex-col gap-3 pb-4 md:pl-[104px]" transition:reveal>
						<JournalLines lines={view(j)} showCodes={ui.expert} periodId={j.periodId} />
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-2">
							<span>{j.source === 'seed' ? 'Imported' : `Posted by ${roleName(j.postedByRole)}`}</span>
							{#if j.proposalId}<a class="drill" href="/proposals?status=all#proposal-{j.proposalId}">From a Proposal</a>{/if}
							{#if j.reversesJeId}<a class="drill" href={drill({ je: j.reversesJeId })}>Reverses an earlier entry</a>{/if}
							<span class="flex-1"></span>
							{#if r.state === 'ok'}
								<button
									class="btn text-sm"
									onclick={() => {
										reversing = j;
										reverseOpen = true;
									}}><Icon name="undo" size={16} />Reverse</button
								>
							{:else if r.state === 'reversed'}
								<Pill tone="warn">Reversed</Pill>
							{:else if r.state === 'locked'}
								<span class="text-ink-3">{monthOf(j.periodId)} and every month after it are locked. Unlock {monthOf(j.periodId)} to reverse this.</span>
							{:else if r.state === 'reconciled'}
								{@const m = monthName(r.month.month)}
								<span class="text-ink-3">Its bank line in {m} is reconciled and {m} is locked. Unlock {m} to reverse it, or post a correcting entry.</span>
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
		body={reverseBody}
		confirmLabel="Reverse entry"
		danger
		inputLabel="Why? One line for the audit log"
		inputPlaceholder="e.g. Booked to the wrong customer"
		inputRequired
		onconfirm={async (reason) => {
			const target = reversing;
			if (!target) return;
			const r = reversal(target);
			const done =
				r.state === 'ok'
					? `Reversal posted in ${periodLabel(r.into)}.${r.autos.map((a) => ` Its automatic reversal in ${monthOf(a.entry.periodId)} is reversed too, in ${periodLabel(a.into)}.`).join('')}`
					: 'Reversal posted.';
			await attempt(() => db.cfoReverse(target.id, reason), done);
		}}
	/>
{/if}
