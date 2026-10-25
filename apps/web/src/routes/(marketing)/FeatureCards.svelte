<script lang="ts">
	// The gate and the sponsors' APIs behind Cafoo, as two rows of two cards. Each card has its words
	// on top and its diagram in a panel set into the bottom-right corner. From lg up, where a pointer
	// can hover, hovering a card widens it and dims the card beside it. Both the words and the diagram
	// then have widths set from the row, not the card, so nothing re-wraps and the row's height never
	// changes (the page does not move under the pointer); widening a card only reveals the rest of its
	// diagram, which fades out at the card's edge until then. Without hover (touch screens) and below lg,
	// every diagram fits its card. A diagram animates only while its card is on screen.
	import GateStack from './GateStack.svelte';
	import CreditCascade from './CreditCascade.svelte';
	import AdvisorChat from './AdvisorChat.svelte';
	import Footprint from './Footprint.svelte';

	type Brand = { kind: 'logo'; name: string; file: string; ratio: number } | { kind: 'mark'; name: string; file: string };
	interface Feature {
		id: 'security' | 'credit' | 'advisor' | 'footprint';
		topic: string;
		brand: Brand;
		title: string;
		body: string;
	}

	const features: Feature[] = [
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
	const rows = [features.slice(0, 2), features.slice(2)];

	// Which cards are on screen, so only their diagrams animate (and the chat and footprint replay
	// when their card comes back into view).
	let seen = $state<Record<string, boolean>>({});
	function inView(node: HTMLElement, id: string) {
		// The newest entry wins when a quick scroll batches several.
		const io = new IntersectionObserver((entries) => (seen[id] = entries[entries.length - 1].isIntersecting), { threshold: 0.25 });
		io.observe(node);
		return { destroy: () => io.disconnect() };
	}
</script>

{#snippet brand(b: Brand)}
	{#if b.kind === 'logo'}
		<span class="logo" role="img" aria-label={b.name} style="--logo: url(/logos/{b.file}.svg); aspect-ratio: {b.ratio}"></span>
	{:else}
		<span class="flex items-center gap-1.5">
			<span class="logo mark" aria-hidden="true" style="--logo: url(/logos/{b.file}.svg)"></span>
			<span class="text-caption">{b.name}</span>
		</span>
	{/if}
{/snippet}

<div class="flex flex-col gap-2">
	{#each rows as row, r (r)}
		<div class="row flex flex-col gap-2">
			{#each row as f (f.id)}
				<article class="card flex flex-col overflow-hidden rounded-xl border border-line bg-surface" aria-labelledby="feature-{f.id}" use:inView={f.id}>
					<div class="copy flex flex-col gap-3 p-6 sm:p-8">
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-3">
							<span class="text-body-sm font-medium text-ink-2">{f.topic}</span>
							<span aria-hidden="true">·</span>
							{@render brand(f.brand)}
						</div>
						<h3 id="feature-{f.id}" class="title text-display-sm font-medium text-balance">{f.title}</h3>
						<p class="body text-ink-2">{f.body}</p>
					</div>
					<div class="panel mt-auto ml-6 rounded-tl-lg border-t border-l border-line bg-subtle p-4 sm:ml-8 sm:p-6">
						<div class="visual">
							{#if f.id === 'security'}
								<GateStack active={!!seen[f.id]} compact />
							{:else if f.id === 'credit'}
								<CreditCascade active={!!seen[f.id]} />
							{:else if f.id === 'advisor'}
								<AdvisorChat active={!!seen[f.id]} />
							{:else}
								<Footprint active={!!seen[f.id]} />
							{/if}
						</div>
					</div>
				</article>
			{/each}
		</div>
	{/each}
</div>

<style>
	/* Reading measures for the title and the body. */
	.title {
		max-width: 22ch;
	}
	.body {
		max-width: 60ch;
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

	/* From lg up: two cards side by side. The row is the size container for the widths below. */
	@media (min-width: 1024px) {
		.row {
			flex-direction: row;
			container-type: inline-size;
		}
		.card {
			flex: 1 1 0;
			min-width: 0;
		}
	}
	/* Where a pointer can hover, the card under it widens (flex-grow 1.4 against 1, so 7/12 of the row)
	   and the other dims. Widths come from the row (cqw), so they hold while the cards change size:
	   - the words take the narrowest a card gets (5/12 of the row, less half the 8px gap and the 2px
	     border; the padding is inside the width), so they never re-wrap;
	   - the diagram takes what the widest card leaves inside its panel (7/12 of the row, less half the
	     gap, the card's border, and the panel's 32px margin, 1px border and 48px padding), so a widened
	     card shows all of it. The panel clips the rest and fades it out at the edge until then. */
	@media (min-width: 1024px) and (hover: hover) {
		.copy {
			width: calc(100cqw * 5 / 12 - 6px);
		}
		.visual {
			width: calc(100cqw * 7 / 12 - 88px);
		}
		.panel {
			overflow: hidden;
			mask-image: linear-gradient(to right, black calc(100% - 48px), transparent);
		}
		.card:hover .panel {
			mask-image: none;
		}
		.card {
			transition:
				flex-grow 400ms cubic-bezier(0.65, 0, 0.35, 1),
				opacity 400ms cubic-bezier(0.65, 0, 0.35, 1);
		}
		.row:has(.card:hover) .card {
			opacity: 0.4;
		}
		.row .card:hover {
			flex-grow: 1.4;
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.card {
			transition: none;
		}
	}
</style>
