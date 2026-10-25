<script lang="ts">
	// Ten keyboard-driven slides. Left/Right (or Space) to move, Home/End to jump.
	import { fade } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import Icon from '#lib/components/Icon.svelte';
	import Wordmark from '#lib/components/Wordmark.svelte';

	interface Slide {
		kicker: string;
		title: string;
		body?: string;
		kind?: 'title' | 'stat' | 'flow' | 'drill' | 'cols' | 'demo';
		stat?: string;
		items?: { head: string; text: string }[];
	}

	const slides: Slide[] = [
		{ kind: 'title', kicker: 'Cafoo', title: 'Cafoo, the agentic finance ERP', body: 'Agents propose. An Advisor rules. The CFO confirms. Every number drills down.' },
		{ kind: 'stat', kicker: 'The problem', title: 'The close still takes 10 days', stat: '10 days', body: 'Most of it is matching deposits, accruing bills and chasing receipts by hand, every single month.' },
		{ kicker: 'The insight', title: 'Everyone has agents. Nobody trusts them to post.', body: 'Finance cannot accept a model writing straight to the books. So we built the approval gate first and the agents second.' },
		{
			kind: 'flow',
			kicker: 'How it works',
			title: 'Propose, critique, rule, confirm',
			items: [
				{ head: 'Propose', text: 'Bookkeeper, Revenue and Credit & Risk agents draft Proposals. They can never post.' },
				{ head: 'Critique', text: 'A Red Team on a second model attacks every Proposal before it is ruled on.' },
				{ head: 'Rule', text: 'The Advisor approves, rejects or amends, always with a plain-English reason.' },
				{ head: 'Confirm', text: 'Anything over the Materiality threshold waits for one click from the CFO.' }
			]
		},
		{ kind: 'demo', kicker: 'Live demo', title: 'Close September in front of you', body: 'Worker agents propose, a Red Team pushes back on the weak ones, and the Advisor posts the small items. The CFO confirms the material ones, locks the month, and the Board Pack re-renders.' },
		{ kind: 'drill', kicker: 'Trust', title: 'Every number drills down', body: 'Click any figure in the Board Pack and land on the Journal Lines behind it, with the Proposal and the debate that produced them.' },
		{ kicker: 'Built in', title: 'Credit and risk, built in', body: 'Most SaaS customers are small businesses. Cafoo checks the owner behind each one, sets payment terms from the Risk Tier and proposes the Allowance.' },
		{
			kind: 'cols',
			kicker: 'Why now',
			title: 'Why now',
			items: [
				{ head: 'Models can reason', text: 'Current models read a ledger and argue about it well enough to be checked, not trusted.' },
				{ head: 'Real-time ledgers', text: 'A database that is also the message bus makes every agent action auditable by default.' },
				{ head: 'Lean finance teams', text: 'CFOs are asked to close faster with the same headcount.' }
			]
		},
		{
			kind: 'cols',
			kicker: 'Roadmap',
			title: 'Where this goes',
			items: [
				{ head: 'Now', text: 'The single-company close: bank matching, accruals, revenue schedules, owner credit checks, Board Pack.' },
				{ head: 'Next 90 days', text: 'Multi-entity and FX with consolidation, live bank and billing feeds, customer-site enrichment, Charters the finance team writes, hosted deployment, SOC 2 readiness.' },
				{ head: '2027', text: 'An agentic credit exchange that negotiates working-capital terms from live, audited books, plus a marketplace of audited agent Charters.' }
			]
		},
		{ kicker: 'The ask', title: 'Help us close the books for good', body: 'Raising [amount] to take [number] design partners live. Placeholder: refine before presenting.' }
	];

	let i = $state(0);
	const s = $derived(slides[i]);
	const go = (n: number) => (i = Math.max(0, Math.min(slides.length - 1, n)));

	function onkey(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
			e.preventDefault();
			go(i + 1);
		} else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
			e.preventDefault();
			go(i - 1);
		} else if (e.key === 'Home') go(0);
		else if (e.key === 'End') go(slides.length - 1);
	}
</script>

<svelte:window onkeydown={onkey} />
<svelte:head><title>Pitch · Cafoo</title></svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas">
	<header class="flex h-16 items-center justify-between px-4 sm:px-8">
		<a href="/" class="flex min-h-[44px] items-center" aria-label="Back to Cafoo"><Wordmark size={22} /></a>
		<span class="num text-sm text-ink-3" aria-live="polite">{i + 1} / {slides.length}</span>
	</header>

	<main class="relative flex flex-1 items-center px-4 sm:px-8">
		{#key i}
			<section class="mx-auto w-full max-w-[1040px] py-10" in:fade={{ duration: prefersReducedMotion.current ? 0 : 180 }} aria-roledescription="slide" aria-label="{i + 1} of {slides.length}: {s.title}">
				<p class="eyebrow mb-4 text-accent-ink">{s.kicker}</p>
				<h1 class="max-w-[18ch] text-[40px] sm:text-[64px] {s.kind === 'title' ? 'sm:text-[80px]' : ''}" style="letter-spacing:-0.035em">{s.title}</h1>
				{#if s.kind === 'stat'}
					<p class="num mt-8 text-[72px] leading-none font-medium text-accent sm:text-[120px]">{s.stat}</p>
				{/if}
				{#if s.body}<p class="mt-6 max-w-[52ch] text-lg text-ink-2 sm:text-xl">{s.body}</p>{/if}
				{#if s.kind === 'flow' && s.items}
					<ol class="mt-10 grid gap-4 sm:grid-cols-4">
						{#each s.items as it, n (it.head)}
							<li class="flex flex-col gap-2 border-t-2 pt-4" style="border-color: {n === 3 ? 'var(--accent)' : 'var(--line-strong)'}">
								<span class="num text-sm text-ink-3">0{n + 1}</span>
								<span class="font-display text-2xl font-medium">{it.head}</span>
								<span class="text-ink-2">{it.text}</span>
							</li>
						{/each}
					</ol>
				{/if}
				{#if s.kind === 'cols' && s.items}
					<div class="mt-10 grid gap-8 sm:grid-cols-3">
						{#each s.items as it (it.head)}
							<div class="flex flex-col gap-2"><span class="font-display text-2xl font-medium">{it.head}</span><span class="text-ink-2">{it.text}</span></div>
						{/each}
					</div>
				{/if}
				{#if s.kind === 'drill'}
					<div class="num mt-10 flex flex-col gap-3 text-lg sm:flex-row sm:items-center sm:gap-4">
						<span class="rounded-btn border border-line px-4 py-3">Revenue $70,950</span>
						<Icon name="arrowRight" class="hidden text-ink-3 sm:block" />
						<span class="rounded-btn border border-line px-4 py-3">5 Journal Entries</span>
						<Icon name="arrowRight" class="hidden text-ink-3 sm:block" />
						<span class="rounded-btn border border-accent bg-accent-soft px-4 py-3">10 Journal Lines</span>
					</div>
				{/if}
				{#if s.kind === 'demo'}
					<a href="/dashboard" class="btn btn-primary btn-lg mt-10">Open the Dashboard <Icon name="arrowRight" size={18} /></a>
				{/if}
			</section>
		{/key}
	</main>

	<footer class="flex items-center justify-between gap-4 px-4 pb-6 sm:px-8">
		<div class="flex flex-1 gap-1" aria-hidden="true">
			{#each slides as _, n (n)}
				<span class="h-1 flex-1 rounded-full transition-colors duration-200 {n <= i ? 'bg-accent' : 'bg-line'}"></span>
			{/each}
		</div>
		<div class="flex gap-2">
			<button class="btn w-11 px-0" aria-label="Previous slide" disabled={i === 0} onclick={() => go(i - 1)}><Icon name="chevronLeft" /></button>
			<button class="btn w-11 px-0" aria-label="Next slide" disabled={i === slides.length - 1} onclick={() => go(i + 1)}><Icon name="chevronRight" /></button>
		</div>
	</footer>
</div>
