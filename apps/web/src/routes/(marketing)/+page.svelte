<script lang="ts">
	// The public landing page: what Cafoo does, how the gate works, and two small demos on
	// sample data. It never touches the data source; the work happens in /dashboard.
	import Icon from '#lib/components/Icon.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';
	import Wordmark from '#lib/components/Wordmark.svelte';
	import DrillDemo from './DrillDemo.svelte';
	import AgentWorkflows from './AgentWorkflows.svelte';
	import GateStack from './GateStack.svelte';
	import LogoWall from './LogoWall.svelte';
	import PaintedFrame from './PaintedFrame.svelte';
	import River from './River.svelte';

	const anchors = [
		{ href: '#how', label: 'Agents' },
		{ href: '#demo', label: 'Demo' },
		{ href: '#gate', label: 'Security' }
	];

	// Shown in the stats strip, which is commented out in the markup for now.
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
	<meta name="description" content="AI agents do your month-end close: matching, accruals and revenue schedules. They only suggest changes; a second AI challenges each one, a reviewing agent rules, and you confirm anything material." />
</svelte:head>

<svelte:window onscroll={onScroll} />

<a href="#main" class="sr-only z-50 rounded-full bg-surface px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3">Skip to content</a>

<div class="page relative isolate min-h-dvh bg-canvas">
	<!-- Rises out of the painted product frame and winds down behind the page as you scroll. -->
	<River from="#hero-art" to="#cta" />

	<header
		class="sticky top-0 z-30 pt-3 transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] {navHidden && !navFocused ? '-translate-y-[120%]' : ''}"
		onfocusin={() => (navFocused = true)}
		onfocusout={() => (navFocused = false)}
	>
		<div class="content flex h-14 items-center justify-between gap-3 rounded-lg bg-canvas/85 pr-1.5 pl-4 backdrop-blur">
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
		<div id="hero">
		<!-- A split hero on Harvey's grid: columns 2–11 from lg up, the heading over six columns and
		     the pitch and one action over four, set to the heading's last line. Stacked below lg. -->
		<section class="wide grid grid-cols-2 gap-[14px] pt-16 pb-12 sm:pt-24 sm:pb-16 md:grid-cols-6 md:gap-4 lg:grid-cols-12 lg:gap-[18px] xl:gap-5">
			<div class="col-span-2 grid grid-cols-subgrid md:col-span-6 lg:col-start-2 lg:col-end-12">
				<h1 class="col-span-full text-[48px] leading-[0.98] font-medium text-balance sm:text-[64px] lg:col-span-6 xl:text-[72px]" style="letter-spacing:-0.035em">Let expert agents do your <span class="whitespace-nowrap">month-end</span> close</h1>
				<div class="col-span-full mt-6 flex flex-col gap-6 md:col-span-4 lg:col-span-4 lg:col-start-7 lg:mt-0 lg:self-end">
					<p class="text-lg text-pretty text-ink-2">
						Cafoo’s agents match payments, book accruals and consolidate your books. A second AI checks every entry, and anything big waits for your OK.
					</p>
					<a href="/dashboard" {...newTab} class="pill pill-primary pill-lg self-start">Get started now{@render tabNote()} <Icon name="arrowRight" size={16} /></a>
				</div>
			</div>
		</section>
		<!-- The product itself, set into the painted sky and cut off by the frame's bottom edge. -->
		<div id="hero-art" class="wide pb-16 sm:pb-24">
			<PaintedFrame seed={11} class="aspect-[16/9] pt-[7%]">
				<!-- Back on the content column, so the product lines up with the headline above. -->
				<div class="wide-content">
				<img
					src="/product/launchpad.webp"
					width="2400"
					height="1500"
					fetchpriority="high"
					alt="The Cafoo Launchpad for September 2026: cash, ARR and open receivables, the close checklist, and live notes from the agents."
					class="block w-full rounded-t-xl border border-line shadow-[0_24px_64px_rgb(0_0_0/0.35)]"
				/>
				</div>
			</PaintedFrame>
		</div>
		</div>

		<!-- Stats strip, hidden for now. To bring it back, remove this comment wrapper.
		<section aria-label="By the numbers" class="content">
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
		-->

		<section id="stack" class="calm-section content relative isolate scroll-mt-24 pt-16" aria-labelledby="stack-h">
			<LogoWall />
		</section>

		<section id="how" class="calm-section content relative isolate scroll-mt-24 pt-32" aria-labelledby="how-h">
			<div class="relative flex flex-col items-center text-center">
				<h2 id="how-h" class="max-w-[18ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">Our agent workflows</h2>
			</div>
			<div class="relative mt-14 rounded-3xl border border-line bg-surface p-4 sm:p-8">
				{@render marks()}
				<AgentWorkflows />
			</div>
		</section>

		<section id="demo" class="content scroll-mt-24 pt-32" aria-labelledby="demo-h">
			<div class="calm relative isolate flex flex-col items-center text-center">
				<h2 id="demo-h" class="max-w-[20ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">Every figure, down to its entries</h2>
				<p class="mt-5 max-w-[56ch] text-lg text-ink-2">On sample numbers: follow a Board Pack figure down to the journal lines and the agent that wrote them.</p>
			</div>
			<div class="mt-14">
				<DrillDemo />
			</div>
		</section>

		<section id="gate" class="content scroll-mt-24 pt-32" aria-labelledby="gate-h">
			<div class="calm relative isolate flex flex-col items-center text-center">
				<h2 id="gate-h" class="max-w-[20ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">Multi-layer agent security starts in the database</h2>
				<p class="mt-5 max-w-[56ch] text-lg text-ink-2">A worker agent proposes. The Red Team critiques, Grok first and then Gemini. The Advisor rules and writes down why. The CFO confirms anything at or above Materiality. Under all of it, SpacetimeDB reducers check every caller’s identity, so no prompt can talk its way into the ledger. The feeds can only add raw bank lines and invoices.</p>
			</div>
			<PaintedFrame seed={37} class="mt-14 p-2 sm:p-6">
				<div class="relative rounded-2xl border border-line bg-surface p-4 sm:p-8">
					{@render marks()}
					<GateStack />
				</div>
			</PaintedFrame>
		</section>

		<section class="content pt-32" aria-labelledby="credit-h">
			<div class="calm relative isolate flex flex-col items-center text-center">
				<h2 id="credit-h" class="max-w-[20ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">A startup is only as good as its founder</h2>
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

		<!-- A rounded accent block inside the page width closes the page; the river runs down to its top edge. -->
		<section id="cta" class="content mt-32" aria-labelledby="cta-h">
			<div class="flex flex-col items-center rounded-xl bg-accent px-6 py-20 text-center text-on-accent sm:py-24">
				<h2 id="cta-h" class="max-w-[16ch] text-[36px] leading-[1.02] sm:text-[56px]" style="letter-spacing:-0.03em">Close your next month with us</h2>
				<div class="mt-10 flex flex-col gap-3 sm:flex-row">
					<a href="/dashboard" {...newTab} class="pill pill-lg bg-on-accent text-accent hover:opacity-90">Get started{@render tabNote()} <Icon name="arrowRight" size={16} /></a>
					<a href="/pitch" class="pill pill-lg border border-on-accent/30 text-on-accent hover:bg-on-accent/10">Watch the pitch</a>
				</div>
			</div>
		</section>
	</main>

	<footer class="content flex flex-col gap-2 py-8 text-sm text-ink-3 sm:flex-row sm:items-center sm:justify-between">
		<Wordmark size={18} class="self-start sm:self-auto" />
		<nav aria-label="Footer" class="flex flex-wrap gap-x-1">
			<a href="/dashboard" {...newTab} class="flex min-h-11 items-center px-2 hover:text-ink">Sign in{@render tabNote()}</a>
			<a href="/pitch" class="flex min-h-11 items-center px-2 hover:text-ink">Pitch</a>
		</nav>
	</footer>
</div>

<style>
	/* Blur the river behind headings, or across the whole workflow section, with feathered edges. */
	/* One 12-column grid, after Harvey's: a frame padded 28 / 32 / 36 / 40px (by breakpoint) with
	   14 / 16 / 18 / 20px gaps. Wide things (the painted hero panel) use the whole
	   frame; the header, copy and sections sit on columns 2–11 from lg up, so they line up with the hero. */
	.page {
		--pad: 28px;
		--gap: 14px;
		--frame: calc(min(100%, 1920px) - 2 * var(--pad));
		/* The headings' soft glow reaches past the column; never let it scroll the page sideways. */
		overflow-x: clip;
	}
	@media (min-width: 768px) {
		.page {
			--pad: 32px;
			--gap: 16px;
		}
	}
	@media (min-width: 1024px) {
		.page {
			--pad: 36px;
			--gap: 18px;
		}
	}
	@media (min-width: 1280px) {
		.page {
			--pad: 40px;
			--gap: 20px;
		}
	}
	.wide,
	.content {
		width: var(--frame);
		margin-inline: auto;
	}
	/* Inside a wide frame, the same inset as .content: 10 of 12 columns, centred. */
	.wide-content {
		width: 100%;
		margin-inline: auto;
	}
	@media (min-width: 1024px) {
		.content {
			width: calc(var(--frame) * 10 / 12 - var(--gap) / 6);
		}
		.wide-content {
			width: calc(100% * 10 / 12 - var(--gap) / 6);
		}
	}

	.calm::before,
	.calm-section::before {
		content: '';
		position: absolute;
		inset: -48px -96px;
		z-index: -1;
		pointer-events: none;
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		background: color-mix(in srgb, var(--canvas) 60%, transparent);
		/* A rectangular falloff: a horizontal and a vertical fade multiplied together, strongest in
		   the middle and easing out evenly toward all four edges. */
		mask-image:
			linear-gradient(to right, transparent, black 35%, black 65%, transparent),
			linear-gradient(to bottom, transparent, black 30%, black 70%, transparent);
		-webkit-mask-composite: source-in;
		mask-composite: intersect;
	}
	.calm-section::before {
		inset: 0 calc(50% - 50vw) -64px;
		background: color-mix(in srgb, var(--canvas) 30%, transparent);
		/* Strongest in the middle of the section, easing out toward all four edges. */
		mask-image:
			linear-gradient(to right, transparent, black 30%, black 70%, transparent),
			linear-gradient(to bottom, transparent, black 96px, black calc(100% - 64px), transparent);
	}

	/* In the components layer so Tailwind utilities (hidden, border, text color) still win. */
	@layer components {
		/* The page's buttons, softly squared. Press scales slightly; colors ease, nothing else moves. */
		.pill {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 0.5rem;
			min-height: 44px;
			padding: 0 1.125rem;
			border-radius: 8px;
			font-family: var(--font-sans);
			font-size: 0.9375rem;
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
			font-size: 1rem;
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
		.pill-quiet {
			color: var(--ink-2);
		}
		.pill-quiet:hover {
			color: var(--ink);
			background: var(--subtle);
		}
	}
</style>
