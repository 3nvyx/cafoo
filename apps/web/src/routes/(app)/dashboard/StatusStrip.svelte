<script lang="ts">
	// This month at a glance: the cash it started with, what came in and went out, what waits on the CFO, and where the
	// close stands. Each tile opens the page behind it. A tile that needs the CFO takes a status fill; the rest stay
	// neutral.
	import { db } from '#lib/data/index.js';
	import { addDays, monthRange, type Summary } from '#lib/data/dashboard.js';
	import { monthName } from '#lib/data/derive.js';
	import { formatMoney } from '#lib/data/money.js';
	import type { Period } from '#lib/data/types.js';
	import { lockGate } from '#lib/close.js';
	import { drill } from '#lib/labels.js';

	/** `month` is the selected Period's own summary, whatever range the figures below show. */
	let { period, month }: { period: Period; month: Summary } = $props();

	const money = (m: string) => formatMoney(m, { whole: true });
	const mon = $derived(monthName(period.month).slice(0, 3));
	const before = $derived(addDays(monthRange(period.id).from, -1).slice(0, 7));

	const proposals = $derived(db.proposals());
	const needs = $derived(proposals.filter((p) => p.status === 'awaiting_cfo').length);
	const debating = $derived(proposals.filter((p) => p.status === 'open').length);

	const gate = $derived(lockGate(db, period.id));
	const bank = $derived(gate.bankExceptions.rows.length);
	// Same rule as the Close card: unmatched lines are the CFO's call only once the close runs, and until accepted.
	const bankDecision = $derived(gate.started && period.status !== 'closed' && bank > 0 && !gate.bankExceptions.acceptance.accepted);
	const tasks = $derived(db.closeTasks().filter((t) => t.periodId === period.id));
	const done = $derived(tasks.filter((t) => t.status === 'done').length);
	const progress = $derived(tasks.length ? `${done} of ${tasks.length}` : 'Started');
	const conn = $derived(db.connection());
	const run = $derived(conn.closes.find((c) => c.periodYm === period.id));

	type Tone = 'warn' | 'neg' | null;
	const FILL: Record<'warn' | 'neg', string> = { warn: 'bg-warn-soft text-on-warn-soft', neg: 'bg-neg-soft text-on-neg-soft' };

	// The close, from most to least urgent: a stopped run, then a decision the CFO owes, then progress.
	const close = $derived.by<{ value: string; tone: Tone; num?: boolean }>(() => {
		if (period.status === 'closed') return { value: 'Locked', tone: null };
		if (run?.status === 'error') return { value: 'Stopped on an error', tone: 'neg' };
		// Locking needs the CFO, not the agents, so a lockable month says so even with the agents offline.
		if (gate.canLock) return { value: 'Ready to lock', tone: 'warn' };
		if (gate.started && conn.agents === 'offline') return { value: 'Agents offline', tone: 'neg' };
		if (bankDecision) return { value: `${bank} bank line${bank === 1 ? '' : 's'} to decide`, tone: 'warn', num: true };
		if (gate.started) return { value: `${progress} done`, tone: null, num: true };
		return { value: 'Not started', tone: null };
	});

	type Item = { label: string; value: string; href: string; tone: Tone; num?: boolean };
	const cash = $derived<Item[]>([
		{ label: `Cash on ${mon} 1`, value: money(month.openingCash), href: drill({ account: '1000' }, { to: before }), tone: null },
		// Money raised is not income: SAFEs, notes and shares never count in Income.
		{ label: `Income in ${mon}`, value: money(month.cashIn), href: drill({ account: '1000' }, period.id), tone: null },
		{ label: `Spent in ${mon}`, value: money(month.cashOut), href: drill({ account: '1000' }, period.id), tone: null }
	]);
	// The Proposals page and the sidebar badge count every month, so these two do as well.
	const work = $derived<Item[]>([
		{ label: 'Needs your OK', value: `${needs}`, href: '/proposals?status=awaiting_cfo', tone: needs ? 'warn' : null, num: true },
		{ label: 'In debate', value: `${debating}`, href: '/proposals?status=open', tone: null, num: true },
		{ label: `${mon} close`, ...close, href: '/close' }
	]);
</script>

<!-- Two groups of three, money then work: stacked, then side by side only where six tiles have room for the amounts.
     On phones each group's third tile spans the row, so a row never mixes the two. -->
<div class="grid gap-3 2xl:grid-cols-2">
	{@render group(cash, `${monthName(period.month)} cash`)}
	{@render group(work, `${monthName(period.month)} work`)}
</div>

{#snippet group(items: Item[], label: string)}
	<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label={label}>
		{#each items as it, i (it.label)}
			<li class={i === 2 ? 'col-span-2 sm:col-span-1' : ''}>
				<a href={it.href} class="group card flex h-full min-w-0 flex-col gap-1 p-4 transition-colors {it.tone ? FILL[it.tone] : 'hover:bg-subtle'}">
					<span class="text-body-sm {it.tone ? 'group-hover:underline' : 'text-ink-2'}">{it.label}</span>
					<span class="text-title font-medium break-words {it.num ? 'num' : ''} {it.tone ? '' : 'text-ink'}">{it.value}</span>
				</a>
			</li>
		{/each}
	</ul>
{/snippet}
