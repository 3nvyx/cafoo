<script lang="ts">
	// The public landing page: what Cafoo does, how the gate works, and three small demos on
	// sample data. It never touches the data source; the work happens in /dashboard.
	import { PUBLIC_DATA_SOURCE } from '$app/env/public';
	import Icon from '#lib/components/Icon.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import type { PostedByRole } from '#lib/data/types.js';
	import DebateDemo from './DebateDemo.svelte';
	import DrillDemo from './DrillDemo.svelte';
	import FlowDiagram from './FlowDiagram.svelte';
	import GateStack from './GateStack.svelte';
	import ModeDemo from './ModeDemo.svelte';

	const live = PUBLIC_DATA_SOURCE === 'spacetime';

	const anchors = [
		{ href: '#how', label: 'How it works' },
		{ href: '#demo', label: 'Demo' },
		{ href: '#gate', label: 'The gate' }
	];

	const stats = [
		{ value: '10 days', label: 'a typical month-end close, mostly matching and chasing by hand' },
		{ value: '52', label: 'Proposals in one sample September close, across two companies' },
		{ value: '$10,000', label: 'default Materiality threshold: anything at or above it waits for the CFO' },
		{ value: '0', label: 'ledger writes a worker agent can make. Only a ruling or your OK posts' }
	];

	const steps: { head: string; roles: PostedByRole[]; text: string }[] = [
		{ head: 'Propose', roles: ['bookkeeper', 'revenue', 'credit'], text: 'Bookkeeper, Revenue and Credit & Risk agents match payments, accrue bills, build revenue schedules and set credit terms. They can only propose.' },
		{ head: 'Critique', roles: ['redteam'], text: 'A Red Team on a second model attacks every Proposal before anyone rules on it, and says when a match is too weak to post.' },
		{ head: 'Rule', roles: ['advisor'], text: 'The Advisor approves, rejects or amends each Proposal and writes down why, in one plain sentence and in full.' },
		{ head: 'Confirm', roles: ['cfo'], text: 'Anything at or above your Materiality threshold waits for one click from you. You lock the month, not an agent.' }
	];

	// The dashboard opens in its own tab so the landing page stays where the visitor left it.
	const newTab = { target: '_blank', rel: 'noopener' } as const;
</script>

{#snippet eyebrow(n: string, text: string)}
	<p class="mb-3 font-mono text-xs tracking-[0.14em] text-accent-ink uppercase">{n} / {text}</p>
{/snippet}

{#snippet tabNote()}<span class="sr-only"> (opens in a new tab)</span>{/snippet}

<svelte:head>
	<title>Cafoo · The agentic finance ERP</title>
	<meta name="description" content="Agents close your books. A Red Team critiques, an Advisor rules, and the CFO confirms anything material. Every number drills down." />
</svelte:head>

<a href="#main" class="sr-only z-50 rounded-btn bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">Skip to content</a>

<div class="min-h-dvh bg-canvas">
	<header class="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur">
		<div class="mx-auto flex h-16 max-w-[1120px] items-center justify-between gap-4 px-4 sm:px-8">
			<a href="/" class="flex min-h-[44px] items-center gap-2.5" aria-label="Cafoo home">
				<span class="grid size-7 place-items-center rounded-btn bg-accent font-display text-[15px] font-medium text-on-accent">C</span>
				<span class="font-display text-lg font-medium tracking-tight">Cafoo</span>
			</a>
			<nav aria-label="Page" class="hidden items-center gap-1 md:flex">
				{#each anchors as a (a.href)}
					<a href={a.href} class="flex min-h-[44px] items-center rounded-btn px-3 text-[15px] text-ink-2 hover:bg-subtle hover:text-ink">{a.label}</a>
				{/each}
			</nav>
			<a href="/dashboard" {...newTab} class="btn btn-primary">Open the dashboard{@render tabNote()}</a>
		</div>
	</header>

	<main id="main">
		<div class="dots">
		<section class="mx-auto grid max-w-[1120px] items-center gap-12 px-4 pt-12 pb-16 sm:px-8 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_460px] lg:gap-16">
			<div class="flex flex-col gap-6">
				<p class="font-mono text-xs tracking-[0.14em] text-accent-ink uppercase">The agentic finance ERP</p>
				<h1 class="max-w-[14ch] text-[44px] sm:text-[64px]" style="letter-spacing:-0.035em">Agents close your books. You keep the last word.</h1>
				<p class="max-w-[52ch] text-lg text-ink-2 sm:text-xl">
					Cafoo's agents do the month-end close. A Red Team on a second model attacks every Proposal, an Advisor rules on it, and anything at or above your threshold waits for your one click. Every number drills down to who proposed it and why.
				</p>
				<div class="flex flex-col gap-3 sm:flex-row">
					<a href="/dashboard" {...newTab} class="btn btn-primary btn-lg">{live ? 'Open the dashboard' : 'Try the live demo'}{@render tabNote()} <Icon name="external" size={18} /></a>
					<a href="#how" class="btn btn-lg">See how it works</a>
				</div>
				{#if !live}
					<p class="text-sm text-ink-3">The demo runs in your browser on a sample SaaS group. No sign-up, no data leaves the page.</p>
				{/if}
			</div>
			<DebateDemo />
		</section>
		</div>

		<section aria-label="By the numbers" class="border-y border-line bg-subtle">
			<ul class="mx-auto grid max-w-[1120px] grid-cols-1 px-4 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
				{#each stats as s (s.value)}
					<!-- Borders per tile: a top rule between rows, a left rule between columns on wide screens. -->
					<li class="flex flex-col gap-1 border-line py-6 not-first:border-t sm:pr-6 sm:nth-2:border-t-0 lg:border-t-0 lg:px-6 lg:first:pl-0 lg:not-first:border-l">
						<span class="num text-[32px] leading-10 font-medium">{s.value}</span>
						<span class="text-sm text-ink-2">{s.label}</span>
					</li>
				{/each}
			</ul>
		</section>

		<section id="how" class="dots scroll-mt-16" aria-labelledby="how-h">
		<div class="mx-auto max-w-[1120px] px-4 py-20 sm:px-8">
			{@render eyebrow('01', 'How it works')}
			<h2 id="how-h" class="max-w-[20ch] text-[32px] sm:text-[44px]">Propose, critique, rule, confirm</h2>
			<p class="mt-4 max-w-[60ch] text-lg text-ink-2">Finance cannot let a model write straight to the books. So Cafoo was built approval gate first, agents second.</p>
			<div class="mt-12 rounded-card border border-line bg-canvas/80 p-4 sm:p-6"><FlowDiagram /></div>
			<ol class="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
				{#each steps as st, n (st.head)}
					<li class="flex flex-col gap-3 border-t-2 pt-5" style="border-color: {n === 3 ? 'var(--accent)' : 'var(--line-strong)'}">
						<div class="flex items-center justify-between">
							<span class="num text-sm text-ink-3">0{n + 1}</span>
							<span class="flex -space-x-1.5">
								{#each st.roles as r (r)}<RoleAvatar role={r} size={28} />{/each}
							</span>
						</div>
						<h3 class="text-2xl">{st.head}</h3>
						<p class="text-ink-2">{st.text}</p>
					</li>
				{/each}
			</ol>
		</div>
		</section>

		<section id="demo" class="scroll-mt-16 border-t border-line bg-subtle" aria-labelledby="demo-h">
			<div class="mx-auto max-w-[1120px] px-4 py-20 sm:px-8">
				{@render eyebrow('02', 'Try it here')}
				<h2 id="demo-h" class="max-w-[22ch] text-[32px] sm:text-[44px]">One sentence for you. Every line for your controller.</h2>
				<p class="mt-4 max-w-[60ch] text-lg text-ink-2">Both demos below run on sample numbers. Click around.</p>

				<div class="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-16">
					<div class="flex flex-col gap-3">
						<h3 class="text-2xl">Simple and Expert mode</h3>
						<p class="max-w-[48ch] text-ink-2">
							Every Proposal carries a plain summary and the full workings. Simple mode shows the sentence. Expert mode shows the Journal Lines, account codes, the Red Team's critique, the Advisor's ruling and the raw payload.
						</p>
					</div>
					<ModeDemo />
				</div>

				<div class="mt-16 flex flex-col gap-3">
					<h3 class="text-2xl">Every number drills down</h3>
					<p class="max-w-[60ch] text-ink-2">Click a figure in the Board Pack and land on the Journal Entries behind it, then on each entry's lines and who proposed, checked and approved them.</p>
					<div class="mt-3"><DrillDemo /></div>
				</div>

				<div class="mt-12 flex flex-col items-start gap-4 rounded-card border border-line bg-surface p-6 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<p class="font-display text-xl font-medium">Run a whole close yourself</p>
						<p class="mt-1 text-ink-2">Close September for a US company and its UK subsidiary, confirm the material items and lock the month.</p>
					</div>
					<a href="/dashboard" {...newTab} class="btn btn-primary shrink-0">Open the dashboard{@render tabNote()} <Icon name="external" size={18} /></a>
				</div>
			</div>
		</section>

		<section id="gate" class="mx-auto max-w-[1120px] scroll-mt-20 px-4 py-20 sm:px-8" aria-labelledby="gate-h">
			{@render eyebrow('03', 'The gate')}
			<h2 id="gate-h" class="max-w-[22ch] text-[32px] sm:text-[44px]">Enforced in the database, not in a prompt</h2>
			<p class="mt-4 max-w-[60ch] text-lg text-ink-2">Pull Cafoo apart and the order is the point: everything an agent does passes the Red Team, the Advisor and the gate before it touches the ledger. The feeds can only add raw bank lines and invoices.</p>
			<div class="mt-12"><GateStack /></div>
		</section>

		<section class="border-t border-line" aria-labelledby="credit-h">
			<div class="mx-auto grid max-w-[1120px] gap-10 px-4 py-20 sm:px-8 lg:grid-cols-2 lg:items-center">
				<div>
					{@render eyebrow('04', 'Credit and risk, built in')}
					<h2 id="credit-h" class="max-w-[20ch] text-[32px] sm:text-[44px]">A small business is only as good as its owner</h2>
					<p class="mt-4 max-w-[56ch] text-lg text-ink-2">Most SaaS customers are small businesses. Cafoo checks the owner behind each one, sets payment terms from the Risk Tier and proposes the Allowance. Vendors are checked before their first payment.</p>
				</div>
				<ul class="flex flex-col divide-y divide-line border-y border-line">
					<li class="flex items-start gap-4 py-5">
						<RoleAvatar role="credit" />
						<div>
							<p class="num text-2xl font-medium">$48,000</p>
							<p class="text-ink-2">reserved in full for a customer whose owner is in an active bankruptcy plan</p>
						</div>
					</li>
					<li class="flex items-start gap-4 py-5">
						<RoleAvatar role="credit" />
						<div>
							<p class="num text-2xl font-medium">2 vendors</p>
							<p class="text-ink-2">blocked before their first payment: one owner is a synthetic identity, the other is deceased</p>
						</div>
					</li>
				</ul>
			</div>
		</section>

		<section class="bg-ink text-canvas" aria-labelledby="cta-h">
			<div class="mx-auto flex max-w-[1120px] flex-col gap-8 px-4 py-20 sm:px-8 lg:flex-row lg:items-end lg:justify-between">
				<div>
					<h2 id="cta-h" class="max-w-[18ch] text-[36px] sm:text-[52px]" style="letter-spacing:-0.03em">Close your next month with us</h2>
					<p class="mt-4 max-w-[52ch] text-lg opacity-80">Open the dashboard, close September on sample data, and lock the month yourself.</p>
				</div>
				<div class="flex flex-col gap-3 sm:flex-row">
					<a href="/dashboard" {...newTab} class="btn btn-primary btn-lg">Open the dashboard{@render tabNote()} <Icon name="external" size={18} /></a>
					<a href="/pitch" class="btn btn-lg border-canvas/30 bg-transparent text-canvas hover:bg-canvas/10">Watch the pitch</a>
				</div>
			</div>
		</section>
	</main>

	<footer class="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 py-8 text-sm text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:px-8">
		<span>Cafoo, the agentic finance ERP</span>
		<nav aria-label="Footer" class="flex flex-wrap gap-x-1">
			<a href="/dashboard" {...newTab} class="flex min-h-[44px] items-center px-2 hover:text-ink">Dashboard{@render tabNote()}</a>
			<a href="/pitch" class="flex min-h-[44px] items-center px-2 hover:text-ink">Pitch</a>
		</nav>
	</footer>
</div>

<style>
	/* Engineering-paper dot grid behind the hero and the pipeline. */
	.dots {
		background-image: radial-gradient(color-mix(in srgb, var(--ink) 13%, transparent) 1px, transparent 1px);
		background-size: 22px 22px;
	}
</style>
