<script lang="ts">
	// The public landing page: what Cafoo does, how the gate works, and two small demos on
	// sample data. It never touches the data source; the work happens in /dashboard.
	import { PUBLIC_DATA_SOURCE } from '$app/env/public';
	import Icon from '#lib/components/Icon.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import Wordmark from '#lib/components/Wordmark.svelte';
	import DrillDemo from './DrillDemo.svelte';
	import FlowDiagram from './FlowDiagram.svelte';
	import GateStack from './GateStack.svelte';
	import ModeDemo from './ModeDemo.svelte';
	import PaintedSky from './PaintedSky.svelte';
	import River from './River.svelte';
	import Swirls from './Swirls.svelte';

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

	// There is no sign-in yet: both entry points open the dashboard, in its own tab so the
	// landing page stays where the visitor left it.
	const newTab = { target: '_blank', rel: 'noopener' } as const;
	const corners = ['-top-2 -left-2', '-top-2 -right-2', '-bottom-2 -left-2', '-bottom-2 -right-2'];

	// The header slides away while scrolling down and returns on any scroll up. It always shows
	// near the top of the page and while focus is inside it, so keyboard users never tab into
	// a hidden link. Small jitters (under 6px) are ignored.
	let navHidden = $state(false);
	let navFocused = $state(false);
	let lastY = 0;
	function onScroll() {
		const y = window.scrollY;
		if (Math.abs(y - lastY) < 6) return;
		navHidden = y > 80 && y > lastY;
		lastY = y;
	}
</script>

{#snippet tabNote()}<span class="sr-only"> (opens in a new tab)</span>{/snippet}

<!-- Drafting-sheet crosshairs on a panel's corners; the panel must be relative. -->
{#snippet marks()}
	{#each corners as pos (pos)}
		<span class="pointer-events-none absolute {pos} grid size-4 place-items-center font-mono text-sm leading-none text-ink-3" aria-hidden="true">+</span>
	{/each}
{/snippet}

<svelte:head>
	<title>Cafoo · The agentic finance ERP</title>
	<meta name="description" content="Agents close your books. A Red Team critiques, an Advisor rules, and the CFO confirms anything material. Every number drills down." />
</svelte:head>

<svelte:window onscroll={onScroll} />

<a href="#main" class="sr-only z-50 rounded-full bg-surface px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3">Skip to content</a>

<div class="relative isolate min-h-dvh bg-canvas">
	<!-- Rises out of the hero's brushwork and winds down behind the page as you scroll. -->
	<River from="#hero" to="footer" />

	<header
		class="sticky top-0 z-30 px-4 pt-3 transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] sm:px-8 {navHidden && !navFocused ? '-translate-y-[120%]' : ''}"
		onfocusin={() => (navFocused = true)}
		onfocusout={() => (navFocused = false)}
	>
		<div class="mx-auto flex h-14 max-w-[1120px] items-center justify-between gap-3 rounded-full border border-line bg-canvas/85 pr-1.5 pl-4 backdrop-blur">
			<a href="/" class="flex min-h-11 items-center px-1" aria-label="Cafoo home"><Wordmark size={24} /></a>
			<nav aria-label="Page" class="hidden items-center md:flex">
				{#each anchors as a (a.href)}
					<a href={a.href} class="flex min-h-11 items-center rounded-full px-3.5 text-[15px] text-ink-2 transition-colors duration-150 hover:text-ink">{a.label}</a>
				{/each}
			</nav>
			<div class="flex items-center gap-1">
				<a href="/dashboard" {...newTab} class="pill pill-quiet hidden sm:inline-flex">Sign in{@render tabNote()}</a>
				<a href="/dashboard" {...newTab} class="pill pill-primary">Get started{@render tabNote()}</a>
			</div>
		</div>
	</header>

	<main id="main">
		<!-- The brushwork runs up behind the floating header (68px) and clears away under the headline. -->
		<div id="hero" class="relative isolate -mt-[68px] overflow-hidden pt-[68px]">
			<div class="sky absolute inset-0 -z-10"><PaintedSky seed={11} /></div>
		<!-- A split hero: the heading on the left, the pitch and one action on the right, set to its baseline. -->
		<section class="mx-auto grid max-w-[1120px] grid-cols-2 gap-x-[14px] px-4 pt-32 pb-28 sm:px-8 sm:pt-56 sm:pb-44 md:grid-cols-6 md:gap-x-4 lg:grid-cols-12 lg:gap-x-[18px]">
			<h1 class="col-span-full text-[52px] leading-[0.95] font-medium text-balance sm:text-[88px] md:col-span-4 lg:col-span-7" style="letter-spacing:-0.035em">Agents close your books</h1>
			<div class="col-span-full mt-8 flex flex-col gap-6 md:col-span-2 md:col-start-5 md:mt-0 md:mb-2 md:self-end lg:col-span-4 lg:col-start-9">
				<p class="max-w-[46ch] text-lg text-pretty text-ink-2 md:max-w-none">
					Agents do the month-end close. A Red Team on a second model attacks every Proposal, an Advisor rules on it, and anything at or above your threshold waits for your one click.
				</p>
				<a href="/dashboard" {...newTab} class="cta">{live ? 'Get started' : 'Try the live demo'}{@render tabNote()}</a>
			</div>
		</section>
		</div>

		<section aria-label="By the numbers" class="mx-auto max-w-[1120px] px-4 sm:px-8">
			<div class="relative">
				{@render marks()}
				<ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					{#each stats as s (s.value)}
						<li class="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5">
							<span class="num text-[32px] leading-10 font-medium">{s.value}</span>
							<span class="text-sm text-ink-2">{s.label}</span>
						</li>
					{/each}
				</ul>
			</div>
		</section>

		<section id="how" class="mx-auto max-w-[1120px] scroll-mt-24 px-4 pt-32 sm:px-8" aria-labelledby="how-h">
			<div class="calm relative isolate flex flex-col items-center text-center">
				<h2 id="how-h" class="max-w-[18ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">Propose, critique, rule, confirm</h2>
				<p class="mt-5 max-w-[56ch] text-lg text-ink-2">Finance cannot let a model write straight to the books. So Cafoo was built approval gate first, agents second.</p>
			</div>
			<div class="relative mt-14 rounded-3xl border border-line bg-surface p-4 sm:p-8">
				{@render marks()}
				<FlowDiagram />
			</div>
		</section>

		<section id="demo" class="mx-auto max-w-[1120px] scroll-mt-24 px-4 pt-32 sm:px-8" aria-labelledby="demo-h">
			<div class="calm relative isolate flex flex-col items-center text-center">
				<h2 id="demo-h" class="max-w-[20ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">One sentence for you. Every line for your controller.</h2>
				<p class="mt-5 max-w-[56ch] text-lg text-ink-2">Both run on sample numbers. Switch the view, then follow a Board Pack figure down to its entries.</p>
			</div>
			<div class="mt-14 grid gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
				<ModeDemo />
				<DrillDemo />
			</div>
		</section>

		<section id="gate" class="mx-auto max-w-[1120px] scroll-mt-24 px-4 pt-32 sm:px-8" aria-labelledby="gate-h">
			<div class="calm relative isolate flex flex-col items-center text-center">
				<h2 id="gate-h" class="max-w-[20ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">Enforced in the database, not in a prompt</h2>
				<p class="mt-5 max-w-[56ch] text-lg text-ink-2">Everything an agent does passes the Red Team, the Advisor and the gate before it touches the ledger. The feeds can only add raw bank lines and invoices.</p>
			</div>
			<div class="relative mt-14 rounded-3xl border border-line bg-surface p-4 sm:p-8">
				{@render marks()}
				<GateStack />
			</div>
		</section>

		<section class="mx-auto max-w-[1120px] px-4 pt-32 sm:px-8" aria-labelledby="credit-h">
			<div class="calm relative isolate flex flex-col items-center text-center">
				<h2 id="credit-h" class="max-w-[20ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">A small business is only as good as its owner</h2>
				<p class="mt-5 max-w-[56ch] text-lg text-ink-2">Cafoo checks the owner behind each customer, sets payment terms from the Risk Tier and proposes the Allowance. Vendors are checked before their first payment.</p>
			</div>
			<ul class="mt-14 grid gap-2 sm:grid-cols-2">
				<li class="flex items-start gap-4 rounded-2xl border border-line bg-surface p-5">
					<RoleAvatar role="credit" />
					<div>
						<p class="num text-2xl font-medium">$48,000</p>
						<p class="text-ink-2">reserved in full for a customer whose owner is in an active bankruptcy plan</p>
					</div>
				</li>
				<li class="flex items-start gap-4 rounded-2xl border border-line bg-surface p-5">
					<RoleAvatar role="credit" />
					<div>
						<p class="num text-2xl font-medium">2 vendors</p>
						<p class="text-ink-2">blocked before their first payment: one owner is a synthetic identity, the other is deceased</p>
					</div>
				</li>
			</ul>
		</section>

		<section class="mx-auto max-w-[1120px] px-4 pt-32 pb-8 sm:px-8" aria-labelledby="cta-h">
			<div class="relative isolate flex flex-col items-center overflow-hidden rounded-3xl bg-accent px-6 py-20 text-center text-on-accent sm:py-24">
				<div class="sky-panel absolute inset-0 -z-10"><Swirls seed={3} sep={18} line="--on-accent" glint="--canvas" lineAlpha={0.16} glintAlpha={0.45} /></div>
				<h2 id="cta-h" class="max-w-[16ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">Close your next month with us</h2>
				<p class="mt-5 max-w-[46ch] text-lg opacity-80">Close September on sample data, confirm what matters, and lock the month yourself.</p>
				<div class="mt-10 flex flex-col gap-3 sm:flex-row">
					<a href="/dashboard" {...newTab} class="pill pill-lg bg-on-accent text-accent hover:opacity-90">Get started{@render tabNote()} <Icon name="arrowRight" size={16} /></a>
					<a href="/pitch" class="pill pill-lg border border-on-accent/30 text-on-accent hover:bg-on-accent/10">Watch the pitch</a>
				</div>
			</div>
		</section>
	</main>

	<footer class="mx-auto flex max-w-[1120px] flex-col gap-2 px-4 pb-10 text-sm text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:px-8">
		<Wordmark size={18} class="self-start sm:self-auto" />
		<nav aria-label="Footer" class="flex flex-wrap gap-x-1">
			<a href="/dashboard" {...newTab} class="flex min-h-11 items-center px-2 hover:text-ink">Sign in{@render tabNote()}</a>
			<a href="/pitch" class="flex min-h-11 items-center px-2 hover:text-ink">Pitch</a>
		</nav>
	</footer>
</div>

<style>
	/* The painted sky frames the hero: it clears under the headline and buttons and fades out
	   toward the bottom, so the copy sits on plain paper. */
	.sky {
		mask-image: radial-gradient(ellipse 62% 56% at 50% 50%, transparent 0%, transparent 30%, rgb(0 0 0 / 0.45) 70%, black 100%),
			linear-gradient(to bottom, black 70%, transparent);
		mask-composite: intersect;
	}
	/* Behind a section's heading the river's hairlines go soft: a blur that feathers out to
	   nothing, so there is no panel, edge or border, only quieter lines under the words. */
	.calm::before {
		content: '';
		position: absolute;
		inset: -48px -96px;
		z-index: -1;
		pointer-events: none;
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		background: radial-gradient(closest-side, color-mix(in srgb, var(--canvas) 55%, transparent), transparent);
		mask-image: radial-gradient(closest-side, black 45%, transparent);
	}
	.sky-panel {
		mask-image: radial-gradient(ellipse 50% 50% at 50% 50%, transparent 0%, rgb(0 0 0 / 0.25) 50%, black 100%);
	}

	/* In the components layer so Tailwind utilities (hidden, border, text color) still win. */
	@layer components {
		/* Pill buttons in mono type. Press scales slightly; colors ease, nothing else moves. */
		.pill {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 0.5rem;
			min-height: 44px;
			padding: 0 1.125rem;
			border-radius: 9999px;
			font-family: var(--font-mono);
			font-size: 0.8125rem;
			font-weight: 500;
			white-space: nowrap;
			transition:
				background-color 150ms cubic-bezier(0.23, 1, 0.32, 1),
				border-color 150ms cubic-bezier(0.23, 1, 0.32, 1),
				transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
		}
		.pill:active {
			transform: scale(0.97);
		}
		.pill-lg {
			min-height: 52px;
			padding: 0 1.5rem;
			font-size: 0.875rem;
		}
		.pill-primary {
			background: var(--accent);
			color: var(--on-accent);
		}
		.pill-primary:hover {
			background: color-mix(in srgb, var(--accent) 85%, var(--canvas));
		}
		.pill-outline {
			border: 1px solid var(--line);
			background: var(--surface);
			color: var(--ink);
		}
		.pill-outline:hover {
			background: var(--subtle);
		}
		/* The hero's one action: a squared, inverted button that sits under the pitch. */
		.cta {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: max-content;
			height: 48px;
			padding: 0 1.25rem;
			border-radius: 6px;
			background: var(--ink);
			color: var(--canvas);
			font-weight: 500;
			white-space: nowrap;
			transition: background-color 300ms ease-out;
		}
		.cta:hover {
			background: color-mix(in srgb, var(--ink) 72%, var(--canvas));
		}
		.pill-quiet {
			color: var(--ink-2);
		}
		.pill-quiet:hover {
			color: var(--ink);
			background: var(--subtle);
		}
	}
</style>
