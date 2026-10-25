<script lang="ts">
	// The September close in eight messages, replayed on a loop. It only plays while on
	// screen, stops on request, and shows the whole thread at once under reduced motion.
	// Rows are always in Simple mode: the app's own Simple/Expert setting does not reach here.
	import { prefersReducedMotion } from 'svelte/motion';
	import type { AgentRole, MessageKind } from '#lib/data/types.js';
	import Icon from '#lib/components/Icon.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import { MESSAGE_KIND, roleName, timeOnly } from '#lib/labels.js';
	import { arrive } from '#lib/motion.js';

	const STAGES = ['Propose', 'Critique', 'Rule', 'Confirm'] as const;
	type Stage = (typeof STAGES)[number];

	interface Line {
		id: string;
		stage: Stage;
		role: AgentRole;
		kind: MessageKind;
		text: string;
		at: string;
	}

	const line = (n: number, stage: Stage, role: AgentRole, kind: MessageKind, text: string): Line => ({
		id: `demo-${n}`,
		stage,
		role,
		kind,
		text,
		at: new Date(Date.UTC(2026, 8, 30, 15, 2 + n * 3)).toISOString()
	});

	const script = [
		line(1, 'Propose', 'cfo', 'statement', 'Close September.'),
		line(2, 'Propose', 'bookkeeper', 'statement', 'I matched 9 vendor payments to their bills in one Proposal. Each match is at least 80% confident.'),
		line(3, 'Propose', 'bookkeeper', 'statement', 'Northwind Cloud was paid twice for one bill. I booked the extra payment as money they owe us back.'),
		line(4, 'Propose', 'revenue', 'statement', 'A $26,400 contract was never on a revenue schedule. I built a 12-month one.'),
		line(5, 'Critique', 'redteam', 'critique', 'Two other matches came in under 75% confident and the amounts do not line up. They should not post.'),
		line(6, 'Rule', 'advisor', 'ruling', 'The Red Team is right: both weak matches are rejected. Everything else is under $10,000 and posts now.'),
		line(7, 'Rule', 'advisor', 'statement', 'Removing the $245,000 the two companies owe each other is over your threshold. It waits for you.'),
		line(8, 'Confirm', 'cfo', 'statement', 'Confirmed. September is locked and the Board Pack is final.')
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

<div use:watch class="card flex flex-col overflow-hidden" role="group" aria-label="Example: agents closing September">
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
			<li in:arrive class="flex gap-3">
				<RoleAvatar role={m.role} />
				<div
					class="min-w-0 flex-1 {m.kind === 'critique' ? 'border-l-4 bg-neg-soft/60 py-1 pl-3' : m.kind === 'ruling' ? 'rounded-btn bg-accent-soft px-3 py-2' : ''}"
					style={m.kind === 'critique' ? `border-color: var(--role-${m.role})` : ''}
				>
					<div class="flex flex-wrap items-baseline gap-x-2 text-sm">
						<span class="font-medium">{roleName(m.role)}</span>
						{#if m.kind !== 'statement'}
							<span class="text-[13px] font-semibold tracking-wider uppercase {m.kind === 'critique' ? 'text-neg' : 'text-accent-ink'}">{MESSAGE_KIND[m.kind]}</span>
						{/if}
						<time class="num text-xs text-ink-3" datetime={m.at}>{timeOnly(m.at)}</time>
					</div>
					<p class="mt-0.5 text-[15px] text-ink">{m.text}</p>
				</div>
			</li>
		{/each}
	</ul>
</div>

<style>
	/* Older messages fade out under the header instead of being cut off. */
	.feed {
		mask-image: linear-gradient(to bottom, transparent, black 72px);
	}
</style>
