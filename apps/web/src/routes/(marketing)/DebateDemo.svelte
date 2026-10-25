<script lang="ts">
	// The September close in eight messages, replayed on a loop. It only plays while on
	// screen, stops on request, and shows the whole thread at once under reduced motion.
	import { prefersReducedMotion } from 'svelte/motion';
	import type { AgentMessage } from '#lib/data/types.js';
	import DebateMessage from '#lib/components/DebateMessage.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { arrive } from '#lib/motion.js';

	const STAGES = ['Propose', 'Critique', 'Rule', 'Confirm'] as const;
	type Stage = (typeof STAGES)[number];

	const at = (min: number) => new Date(Date.UTC(2026, 8, 30, 15, min)).toISOString();
	const msg = (n: number, stage: Stage, m: Pick<AgentMessage, 'senderRole' | 'kind' | 'summaryPlain' | 'body'>) => ({
		id: `demo-${n}`,
		threadId: 'demo',
		createdAt: at(2 + n * 3),
		stage,
		...m
	});

	const script = [
		msg(1, 'Propose', { senderRole: 'cfo', kind: 'statement', summaryPlain: 'Close September.', body: 'close.start period=2026-09 agents=6' }),
		msg(2, 'Propose', { senderRole: 'bookkeeper', kind: 'statement', summaryPlain: 'I matched 9 vendor payments to their bills. Every match is at least 80% confident.', body: 'bank_match x9 · min_confidence=0.80' }),
		msg(3, 'Propose', { senderRole: 'bookkeeper', kind: 'statement', summaryPlain: 'Northwind Cloud was paid twice for one bill. I booked the extra payment as a refund they owe us.', body: 'duplicate_payment vendor=northwind-cloud · DR 1250 Vendor refunds receivable / CR 1000 Cash' }),
		msg(4, 'Propose', { senderRole: 'revenue', kind: 'statement', summaryPlain: 'A $26,400 contract was never on a revenue schedule. I built a 12-month one.', body: 'revenue_schedule 12 x 2,200.00 · DR 2400 Deferred revenue / CR 4000 Subscription revenue' }),
		msg(5, 'Critique', { senderRole: 'redteam', kind: 'critique', summaryPlain: 'Two bank matches are under 75% confident and the amounts do not line up. They should not post.', body: 'critique bank_match confidence=0.71,0.68 · amount_delta>2%' }),
		msg(6, 'Rule', { senderRole: 'advisor', kind: 'ruling', summaryPlain: 'The Red Team is right: both weak matches are rejected. Everything else is under $10,000 and posts now.', body: 'ruling reject=2 approve=31 · materiality=10,000.00' }),
		msg(7, 'Rule', { senderRole: 'advisor', kind: 'statement', summaryPlain: 'Removing the $245,000 the two companies owe each other is above your threshold. It waits for you.', body: 'awaiting_cfo consolidation.elimination 245,000.00 > 10,000.00' }),
		msg(8, 'Confirm', { senderRole: 'cfo', kind: 'statement', summaryPlain: 'Confirmed. September is locked and the Board Pack is final.', body: 'cfo.confirm · period.lock 2026-09' })
	];

	let count = $state(1);
	let paused = $state(false);
	let onScreen = $state(false);

	const still = $derived(prefersReducedMotion.current);
	const shown = $derived(still ? script : script.slice(0, count));
	const stage = $derived(STAGES.indexOf(shown[shown.length - 1].stage));

	$effect(() => {
		if (still || paused || !onScreen) return;
		const end = count >= script.length;
		const t = setTimeout(() => (count = end ? 1 : count + 1), end ? 5000 : 1900);
		return () => clearTimeout(t);
	});

	function watch(node: HTMLElement) {
		const io = new IntersectionObserver(([e]) => (onScreen = e.isIntersecting), { threshold: 0.25 });
		io.observe(node);
		return { destroy: () => io.disconnect() };
	}
</script>

<div use:watch class="card flex flex-col overflow-hidden" aria-label="Example: agents closing September">
	<div class="flex items-center justify-between gap-3 border-b border-line py-1 pr-2 pl-4">
		<div class="flex min-w-0 items-center gap-2 text-sm">
			<span class="size-2 shrink-0 rounded-full bg-pos"></span>
			<span class="font-medium">September close</span>
			<span class="truncate text-ink-3">Cafoo Inc · sample data</span>
		</div>
		{#if !still}
			<button class="btn btn-quiet w-11 px-0" aria-label={paused ? 'Play the example' : 'Pause the example'} onclick={() => (paused = !paused)}>
				<Icon name={paused ? 'play' : 'pause'} size={18} />
			</button>
		{/if}
	</div>

	<ol class="grid grid-cols-4 gap-2 px-4 pt-3" aria-label="Stage">
		{#each STAGES as s, n (s)}
			<li class="flex flex-col gap-1.5" aria-current={n === stage ? 'step' : undefined}>
				<span class="h-1 rounded-full transition-colors duration-300 {n <= stage ? 'bg-accent' : 'bg-line'}"></span>
				<span class="text-xs {n === stage ? 'font-medium text-ink' : 'text-ink-3'}">{s}</span>
			</li>
		{/each}
	</ol>

	<ul class="flex flex-col gap-4 p-4 {still ? '' : 'feed h-[420px] justify-end overflow-hidden'}">
		{#each shown as m (m.id)}
			<li in:arrive><DebateMessage {m} /></li>
		{/each}
	</ul>
</div>

<style>
	/* Older messages fade out under the header instead of being cut off. */
	.feed {
		mask-image: linear-gradient(to bottom, transparent, black 72px);
	}
</style>
