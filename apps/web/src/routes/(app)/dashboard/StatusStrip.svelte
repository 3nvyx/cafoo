<script lang="ts">
	// Where things stand, in five counts. Each opens the page behind it. A count that needs the CFO takes a status fill;
	// everything else stays neutral.
	import { db } from '#lib/data/index.js';
	import { periodShort } from '#lib/data/derive.js';
	import type { Period } from '#lib/data/types.js';
	import { lockGate } from '#lib/close.js';

	let { period }: { period: Period } = $props();

	const proposals = $derived(db.proposals());
	const needs = $derived(proposals.filter((p) => p.status === 'awaiting_cfo').length);
	const debating = $derived(proposals.filter((p) => p.status === 'open').length);
	const gate = $derived(lockGate(db, period.id));
	const bank = $derived(gate.bankExceptions.rows.length);
	// Same rule as the Close card: unmatched lines are the CFO's call only once the close runs, and until accepted.
	const bankDecision = $derived(gate.started && period.status !== 'closed' && bank > 0 && !gate.bankExceptions.acceptance.accepted);
	const tasks = $derived(db.closeTasks().filter((t) => t.periodId === period.id));
	const done = $derived(tasks.filter((t) => t.status === 'done').length);

	const conn = $derived(db.connection());
	const run = $derived(conn.closes.find((c) => c.periodYm === period.id));
	const agents = $derived.by(() => {
		if (run?.status === 'error') return { value: 'Stopped', note: 'The close run hit an error', tone: 'neg' as const };
		if (conn.agents === 'offline') return { value: 'Offline', note: 'The agent gateway is unreachable', tone: 'neg' as const };
		if (db.liveActivity() || run?.status === 'running') return { value: 'Working', note: `Closing ${periodShort(period)}`, tone: null };
		return { value: 'Idle', note: run?.status === 'done' ? 'The close run finished' : 'Waiting for a close to start', tone: null };
	});

	type Tone = 'warn' | 'neg' | null;
	const FILL: Record<'warn' | 'neg', string> = { warn: 'bg-warn-soft text-on-warn-soft', neg: 'bg-neg-soft text-on-neg-soft' };

	const items = $derived<{ label: string; value: string; note: string; href: string; tone: Tone; num?: boolean }[]>([
		{ label: 'Needs your OK', value: `${needs}`, note: needs ? 'Above your threshold' : 'Nothing waiting', href: '/proposals?status=awaiting_cfo', tone: needs ? 'warn' : null, num: true },
		{ label: 'In debate', value: `${debating}`, note: 'Red Team and Advisor', href: '/proposals?status=open', tone: null, num: true },
		{ label: 'Unmatched bank lines', value: `${bank}`, note: !bank ? 'All matched' : bankDecision ? 'Decide before the lock' : gate.started || period.status === 'closed' ? 'Accepted as open' : 'The close matches what it can', href: '/close#bank-exceptions', tone: bankDecision ? 'warn' : null, num: true },
		{ label: 'Close checklist', value: tasks.length ? `${done} of ${tasks.length}` : '–', note: period.status === 'closed' ? 'Locked' : done === tasks.length && tasks.length ? 'Ready to lock' : 'Tasks done', href: '/close', tone: null, num: true },
		{ label: 'Agents', value: agents.value, note: agents.note, href: '/agents', tone: agents.tone }
	]);
</script>

<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Status">
	{#each items as it (it.label)}
		<li class={it.label === 'Agents' ? 'col-span-2 sm:col-span-1' : ''}>
			<a href={it.href} class="card flex h-full flex-col gap-1 p-4 transition-colors {it.tone ? FILL[it.tone] : 'hover:bg-subtle'}">
				<span class="text-body-sm {it.tone ? '' : 'text-ink-2'}">{it.label}</span>
				<span class="text-title font-medium {it.num ? 'num' : ''} {it.tone ? '' : 'text-ink'}">{it.value}</span>
				<span class="text-caption {it.tone ? '' : 'text-ink-3'}">{it.note}</span>
			</a>
		</li>
	{/each}
</ul>
