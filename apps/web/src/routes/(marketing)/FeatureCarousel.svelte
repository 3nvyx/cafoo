<script lang="ts">
	// The security card as a carousel: the first slide is the gate itself, the others show what a
	// sponsor's API does inside Cafoo. It moves only when the visitor asks (the tabs, the arrows, or
	// arrow keys on the tabs); nothing advances on its own, so there is nothing to pause.
	// From lg up every slide shares one grid cell, so the card keeps the tallest slide's height and
	// does not jump; below lg only the open slide is laid out.
	import Icon from '#lib/components/Icon.svelte';
	import GateStack from './GateStack.svelte';
	import CreditCascade from './CreditCascade.svelte';
	import AdvisorChat from './AdvisorChat.svelte';
	import Footprint from './Footprint.svelte';

	type Brand = { kind: 'logo'; name: string; file: string; ratio: number } | { kind: 'mark'; name: string; file: string };
	interface Slide {
		id: string;
		topic: string;
		brand: Brand;
		title: string;
		body: string;
	}

	const slides: Slide[] = [
		{
			id: 'security',
			topic: 'Agent security',
			brand: { kind: 'mark', name: 'SpacetimeDB', file: 'spacetimedb' },
			title: 'Multi-layer agent security starts in the database',
			body: 'A worker agent proposes. The Red Team critiques, Grok first and then Gemini. The Advisor rules and writes down why. The CFO confirms anything at or above Materiality. Under all of it, SpacetimeDB reducers check every caller’s identity, so no prompt can talk its way into the ledger. The feeds can only add raw bank lines and invoices.'
		},
		{
			id: 'credit',
			topic: 'Credit checks',
			brand: { kind: 'logo', name: 'CRS Credit API', file: 'crs', ratio: 2.9 },
			title: 'Know the people behind every customer and vendor',
			body: 'Before money moves, the Credit & Risk agent runs a cascade on the CRS Credit API: identity, fraud, all three credit bureaus and public records. The books derive the Risk Tier from what it finds, and the tier sets the payment terms.'
		},
		{
			id: 'advisor',
			topic: 'Advisor chat',
			brand: { kind: 'logo', name: 'Fetch.ai', file: 'fetch-ai', ratio: 6.1 },
			title: 'Ask your Advisor how the business is doing',
			body: 'The Cafoo Advisor lives on Fetch.ai’s Agentverse, so you can chat with it in ASI:One. It asks four specialist agents at once and answers with one interactive card, built from the live books.'
		},
		{
			id: 'footprint',
			topic: 'Public footprint',
			brand: { kind: 'logo', name: 'Bright Data', file: 'brightdata', ratio: 4.48 },
			title: 'See what anyone can see, before you extend credit',
			body: 'For each customer and vendor, Bright Data collects what a logged-out visitor can see: a Yelp listing through Web Unlocker and a LinkedIn company page through the Web Scraper API.'
		}
	];

	let current = $state(0);
	const tabs: HTMLButtonElement[] = [];

	function go(i: number, focus = false) {
		current = (i + slides.length) % slides.length;
		if (focus) tabs[current]?.focus();
	}
	// Arrow keys, Home and End move between tabs and open the one they land on.
	function onKey(e: KeyboardEvent) {
		const to = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: slides.length - 1 }[e.key];
		if (to === undefined) return;
		e.preventDefault();
		go(to, true);
	}
</script>

{#snippet brand(b: Brand)}
	{#if b.kind === 'logo'}
		<span class="logo" role="img" aria-label={b.name} style="--logo: url(/logos/{b.file}.svg); aspect-ratio: {b.ratio}"></span>
	{:else}
		<span class="flex items-center gap-1.5">
			<span class="logo mark" aria-hidden="true" style="--logo: url(/logos/{b.file}.svg)"></span>
			<span class="text-body-sm font-medium">{b.name}</span>
		</span>
	{/if}
{/snippet}

<div>
	<div role="tablist" aria-label="Features" tabindex="-1" class="grid grid-cols-2 gap-1 rounded-lg bg-subtle p-1 lg:grid-cols-4" onkeydown={onKey}>
		{#each slides as s, i (s.id)}
			<button
				bind:this={tabs[i]}
				role="tab"
				id="tab-{s.id}"
				aria-selected={i === current}
				aria-controls="slide-{s.id}"
				tabindex={i === current ? 0 : -1}
				class="tab flex min-h-16 flex-col items-start justify-center gap-1.5 rounded-md px-3 py-2 text-left {i === current ? 'bg-accent-soft text-on-accent-soft' : 'text-ink-3 hover:bg-surface hover:text-ink'}"
				onclick={() => go(i)}
			>
				<span class="text-body-sm font-medium {i === current ? '' : 'text-ink-2'}">{s.topic}</span>
				{@render brand(s.brand)}
			</button>
		{/each}
	</div>

	<div class="slides mt-8 sm:mt-10">
		{#each slides as s, i (s.id)}
			<div
				role="tabpanel"
				id="slide-{s.id}"
				aria-labelledby="tab-{s.id}"
				class="slide flex flex-col"
				class:on={i === current}
				inert={i !== current}
			>
				<div class="flex flex-col items-center text-center">
					<h3 class="slide-h max-w-[24ch]">{s.title}</h3>
					<p class="mt-4 max-w-[64ch] text-ink-2">{s.body}</p>
				</div>
				<div class="mt-10 flex flex-1 flex-col justify-center">
					{#if s.id === 'security'}
						<GateStack />
					{:else if s.id === 'credit'}
						<CreditCascade active={i === current} />
					{:else if s.id === 'advisor'}
						<AdvisorChat active={i === current} />
					{:else}
						<Footprint active={i === current} />
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<div class="mt-8 flex items-center justify-between gap-3 border-t border-line pt-4">
		<p class="num text-body-sm text-ink-3" aria-live="polite">{current + 1} of {slides.length} · {slides[current].topic}</p>
		<div class="flex gap-1">
			<button class="btn btn-quiet px-2.5" aria-label="Previous feature" onclick={() => go(current - 1)}><Icon name="chevronLeft" size={18} /></button>
			<button class="btn btn-quiet px-2.5" aria-label="Next feature" onclick={() => go(current + 1)}><Icon name="chevronRight" size={18} /></button>
		</div>
	</div>
</div>

<style>
	.slide-h {
		font-size: 28px;
		line-height: 1.08;
		letter-spacing: -0.025em;
		font-weight: 500;
		text-wrap: balance;
	}
	@media (min-width: 640px) {
		.slide-h {
			font-size: 40px;
		}
	}

	.tab {
		transition:
			background-color 150ms cubic-bezier(0.23, 1, 0.32, 1),
			color 150ms cubic-bezier(0.23, 1, 0.32, 1);
	}

	/* Wordmarks are masks filled with the text colour, as on the logo wall. */
	.logo {
		display: block;
		height: 14px;
		max-width: 100%;
		background-color: currentColor;
		mask: var(--logo) left center / contain no-repeat;
		-webkit-mask: var(--logo) left center / contain no-repeat;
	}
	.mark {
		width: 14px;
		flex: none;
	}

	/* Below lg only the open slide is laid out. */
	.slide:not(.on) {
		display: none;
	}
	@media (min-width: 1024px) {
		.slides {
			display: grid;
		}
		.slide {
			grid-area: 1 / 1;
			transition:
				opacity 250ms cubic-bezier(0.23, 1, 0.32, 1),
				visibility 0s linear 250ms;
		}
		.slide:not(.on) {
			display: flex;
			opacity: 0;
			visibility: hidden;
		}
		.slide.on {
			transition-delay: 0s;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.slide {
			transition: none;
		}
	}
</style>
