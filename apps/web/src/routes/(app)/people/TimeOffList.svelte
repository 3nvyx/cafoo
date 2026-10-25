<script lang="ts">
	// Time-off requests, newest dates first, with Approve and Decline on the ones waiting for the CFO.
	import { db } from '#lib/data/index.js';
	import type { PtoRequest } from '#lib/data/types.js';
	import Pill from '#lib/components/Pill.svelte';
	import { attempt } from '#lib/toast.svelte.js';
	import { PTO_KIND, PTO_STATUS, range } from './people.js';

	let { requests, showName = true, empty = 'No time off requested.' }: { requests: PtoRequest[]; showName?: boolean; empty?: string } = $props();

	const name = (id: string) => db.employees().find((e) => e.id === id)?.name ?? id;
	let busy = $state<string | null>(null);

	async function decide(r: PtoRequest, decision: 'approved' | 'declined') {
		busy = r.id;
		const who = name(r.employeeId);
		await attempt(() => db.decidePtoRequest(r.id, decision), decision === 'approved' ? `Approved ${who}'s time off.` : `Declined ${who}'s time off.`);
		busy = null;
	}
	const days = (h: number) => {
		const d = Math.round((h / 8) * 10) / 10;
		return `${d} day${d === 1 ? '' : 's'}`;
	};
</script>

<ul class="flex flex-col divide-y divide-line" aria-live="polite">
	{#each requests as r (r.id)}
		<li class="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<p class="flex flex-wrap items-center gap-x-2 gap-y-1">
					{#if showName}<a class="drill font-medium" href="/people/{r.employeeId}">{name(r.employeeId)}</a>{/if}
					<span class={showName ? 'text-body-sm text-ink-2' : 'font-medium'}>{PTO_KIND[r.kind]}</span>
					{#if r.status !== 'pending'}<Pill tone={PTO_STATUS[r.status].tone}>{PTO_STATUS[r.status].label}</Pill>{/if}
				</p>
				<p class="text-body-sm text-ink-2"><span class="num">{range(r.startAt, r.endAt)}</span> · {days(r.hours)}{r.notePlain ? ` · ${r.notePlain}` : ''}</p>
			</div>
			{#if r.status === 'pending'}
				<div class="flex gap-2">
					<button class="btn btn-quiet" disabled={busy === r.id} onclick={() => decide(r, 'declined')}>Decline</button>
					<button class="btn btn-primary" disabled={busy === r.id} onclick={() => decide(r, 'approved')}>Approve</button>
				</div>
			{/if}
		</li>
	{:else}
		<li class="py-4 text-body-sm text-ink-3">{empty}</li>
	{/each}
</ul>
