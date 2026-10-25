<script lang="ts">
	// The public landing page: what Luyten does, how the gate works, and two small demos on
	// sample data. It never touches the data source; the work happens in /dashboard.
	import Icon from '#lib/components/Icon.svelte';
	import Wordmark from '#lib/components/Wordmark.svelte';
	import AgentWorkflows from './AgentWorkflows.svelte';
	import FeatureCards from './FeatureCards.svelte';
	import LogoWall from './LogoWall.svelte';
	import PaintedFrame from './PaintedFrame.svelte';
	import River from './River.svelte';


	const anchors = [
		{ href: '#how', label: 'Agents' },
		{ href: '#gate', label: 'Security' },
		{ href: '#growth', label: 'Your 10x' }
	];

	// Shown in the stats strip, which is commented out in the markup for now.
	const stats = [
		{ value: '10 days', label: 'a typical month-end close, mostly matching and chasing by hand' },
		{ value: '52', label: 'Proposals in one sample September close, across two companies' },
		{ value: '$10,000', label: 'default Materiality threshold: anything at or above it waits for the CFO' },
		{ value: '0', label: 'ledger writes a worker agent can make. Only a ruling or your OK posts' }
	];

	// The growth story from plan.md, "How Luyten grows with a startup". `now` marks what ships
	// today; the last stage is on the roadmap (docs/roadmap.md).
	const stages = [
		{
			range: '$10M to $50M',
			round: 'Seed to Series A',
			changes: 'One or two entities, a few hundred customers, and the founder still approves spend.',
			luyten: 'Agents propose, the Advisor rules, and the CFO confirms anything material. Close in days, not weeks. Cap table and round modeling.',
			now: true,
			quillmesh: ''
		},
		{
			range: '$50M to $250M',
			round: 'Series A to Series B',
			changes: 'A second country and currency, usage pricing, enterprise contracts, and a first controller.',
			luyten: 'Multi-currency consolidation, revaluation and eliminations as Proposals. Revenue schedules rebuilt automatically. Credit checks on customers and vendors. Custom Charters that only tighten the gate.',
			now: true,
			quillmesh: 'a UK subsidiary in GBP, per-page usage pricing, about 15 enterprise contracts and a finance team of three.'
		},
		{
			range: '$250M to $1B',
			round: 'Series B to growth',
			changes: 'Many entities, tens of thousands of transactions a month, audit and SOC 2.',
			luyten: 'Continuous bookkeeping between closes, per-subsidiary locks, a dedicated evaluator identity, real bank and billing feeds, hosted deployment and SOC 2 controls.',
			now: false,
			quillmesh: ''
		}
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
	<title>Luyten · Automated finance for 10x growth startups</title>
	<meta name="description" content="Automated finance for 10x growth startups. Luyten's agents run the books. A second AI checks every entry, and anything material waits for your OK." />
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
		<div class="content flex h-14 items-center justify-between gap-3 rounded-lg bg-canvas/85 px-1.5 backdrop-blur">
			<!-- Equal-width sides keep the page links on the bar's true centre. -->
			<div class="flex flex-1">
				<a href="/" class="flex min-h-11 items-center px-3.5" aria-label="Luyten home"><Wordmark size={24} /></a>
			</div>
			<nav aria-label="Page" class="hidden items-center md:flex">
				{#each anchors as a (a.href)}
					<a href={a.href} class="flex min-h-11 items-center rounded-full px-3.5 text-[15px] text-ink-2 transition-colors duration-150 hover:text-ink">{a.label}</a>
				{/each}
			</nav>
			<div class="flex flex-1 items-center justify-end gap-1">
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
				<h1 class="col-span-full text-[48px] leading-[0.98] font-medium text-balance sm:text-[64px] lg:col-span-6 xl:text-[72px]" style="letter-spacing:-0.035em">Automated finance for 10x growth startups</h1>
				<div class="col-span-full mt-6 flex flex-col gap-6 md:col-span-4 lg:col-span-4 lg:col-start-7 lg:mt-0 lg:self-end">
					<p class="text-lg text-pretty text-ink-2">
						Luyten’s agents run the books. A second AI checks every entry, and anything material waits for your OK.
					</p>
					<a href="/dashboard" {...newTab} class="pill pill-primary pill-lg self-start">Get started now{@render tabNote()} <Icon name="arrowRight" size={16} /></a>
				</div>
			</div>
		</section>
		<!-- The product itself, set into the painted sky and cut off by the frame's bottom edge. -->
		<div id="hero-art" class="wide pb-16 sm:pb-24">
			<PaintedFrame seed={11} class="aspect-[16/9] pt-[7%] lg:aspect-21/10">
				<!-- Back on the content column, so the product lines up with the headline above. -->
				<div class="wide-content">
				<img
					src="/product/launchpad.webp"
					width="2000"
					height="1050"
					fetchpriority="high"
					alt="The Luyten Dashboard for September 2026: cash, income and spend, one proposal in debate, the KPIs, proposals by status, close progress, agent status and customer credit."
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
				<h2 id="how-h" class="section-h max-w-[18ch]">Our automated agent workflow</h2>
			</div>
			<div class="relative mt-14 rounded-3xl border border-line bg-surface p-4 sm:p-8">
				{@render marks()}
				<AgentWorkflows />
			</div>
		</section>

		<!-- The gate and the sponsors' APIs behind Luyten, as two rows of two cards that widen on hover,
		     set into the hero's painted sky. -->
		<section id="gate" class="content scroll-mt-24 pt-32" aria-labelledby="gate-h">
			<h2 id="gate-h" class="sr-only">Agent security, and the APIs behind Luyten</h2>
			<PaintedFrame seed={23} class="p-3 sm:p-6 lg:p-8">
				<FeatureCards />
			</PaintedFrame>
		</section>

		<section id="growth" class="content scroll-mt-24 pt-32" aria-labelledby="growth-h">
			<div class="calm relative isolate flex flex-col items-center text-center">
				<h2 id="growth-h" class="section-h max-w-[20ch]">Built for your 10x</h2>
				<p class="mt-5 max-w-[56ch] text-subtitle text-ink-2">A startup that grows 10x outgrows its finance stack on the way. Luyten grows with you from a $10M seed to a $1B growth round, and the gate never loosens as the volume climbs.</p>
			</div>
			<div class="mt-14 flex flex-col gap-1 rounded-lg border border-line bg-subtle p-5 sm:flex-row sm:items-baseline sm:gap-4">
				<p class="shrink-0 font-medium">Worked example: Quillmesh</p>
				<p class="text-ink-2">Our sample company sells a document-automation API. Series A at $50M post-money, about $4.8M ARR growing about 3x a year, a US parent and a UK subsidiary. It has just entered stage 2.</p>
			</div>
			<ol class="mt-2 grid gap-2 md:grid-cols-3">
				{#each stages as st, i (st.range)}
					<li class="flex flex-col gap-5 rounded-lg border border-line bg-surface p-5">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="num text-body-sm text-ink-3">Stage {i + 1}</span>
							{#if st.now}
								<span class="rounded-md bg-pos-soft px-2 py-0.5 text-caption font-medium text-on-pos-soft">Available now</span>
							{:else}
								<span class="rounded-md bg-info-soft px-2 py-0.5 text-caption font-medium text-on-info-soft">On the roadmap</span>
							{/if}
						</div>
						<div>
							<h3 class="num text-title font-medium">{st.range}</h3>
							<p class="text-body-sm text-ink-3">{st.round}</p>
						</div>
						<div class="flex flex-col gap-1">
							<p class="eyebrow">What changes for finance</p>
							<p class="text-ink-2">{st.changes}</p>
						</div>
						<div class="flex flex-col gap-1">
							<p class="eyebrow">What Luyten does</p>
							<p>{st.luyten}</p>
						</div>
						{#if st.quillmesh}
							<p class="mt-auto rounded-md bg-subtle px-3 py-2 text-body-sm text-ink-2"><span class="font-medium text-ink">Quillmesh is here:</span> {st.quillmesh}</p>
						{/if}
					</li>
				{/each}
			</ol>
			<p class="mx-auto mt-6 max-w-[64ch] text-center text-ink-2">The gate does not loosen as volume grows: the Materiality threshold and Charters scale with the company, and every number still drills down to its journal lines.</p>
		</section>

		<!-- A short accent band inside the page width closes the page: the heading on the left, one action on the right.
		     The river runs down to its top edge. -->
		<section id="cta" class="content mt-32" aria-labelledby="cta-h">
			<div class="flex flex-col items-start gap-6 rounded-xl bg-accent px-6 py-10 text-on-accent sm:flex-row sm:items-center sm:justify-between sm:px-10 sm:py-12">
				<h2 id="cta-h" class="max-w-[18ch] text-display-sm font-medium sm:text-display">Run your finance with us</h2>
				<a href="/dashboard" {...newTab} class="pill pill-lg shrink-0 bg-on-accent text-accent hover:opacity-90">Get started{@render tabNote()} <Icon name="arrowRight" size={16} /></a>
			</div>
		</section>
	</main>

	<!-- A standard site footer: brand and one line on the left, link columns on the right, then a legal row. -->
	<footer class="content mt-24 border-t border-line pt-12 pb-8 text-body-sm">
		<div class="flex flex-col gap-10 md:flex-row md:justify-between">
			<div class="flex max-w-xs flex-col gap-3">
				<a href="/" class="self-start" aria-label="Luyten home"><Wordmark size={20} /></a>
				<p class="text-ink-3">Automated finance for 10x growth startups. Agents propose, an Advisor rules, and you confirm anything material.</p>
			</div>
			<div class="grid grid-cols-2 gap-10 sm:gap-16">
				<nav aria-labelledby="footer-product" class="flex flex-col gap-1">
					<p id="footer-product" class="eyebrow mb-1">Product</p>
					{#each anchors as a (a.href)}
						<a href={a.href} class="flex min-h-9 items-center text-ink-2 hover:text-ink">{a.label}</a>
					{/each}
				</nav>
				<nav aria-labelledby="footer-start" class="flex flex-col gap-1">
					<p id="footer-start" class="eyebrow mb-1">Get started</p>
					<a href="/dashboard" {...newTab} class="flex min-h-9 items-center text-ink-2 hover:text-ink">Sign in{@render tabNote()}</a>
					<a href="/dashboard" {...newTab} class="flex min-h-9 items-center text-ink-2 hover:text-ink">Open the app{@render tabNote()}</a>
					<a href="/pitch" class="flex min-h-9 items-center text-ink-2 hover:text-ink">Watch the pitch</a>
				</nav>
			</div>
		</div>
		<div class="mt-12 border-t border-line pt-6 text-ink-3">
			<p>© {new Date().getFullYear()} Luyten</p>
		</div>
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

	/* Every section heading: 36px on phones, 56px from sm up, set tight. */
	.section-h {
		font-size: 36px;
		line-height: 1.02;
		letter-spacing: -0.03em;
	}
	@media (min-width: 640px) {
		.section-h {
			font-size: 56px;
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
