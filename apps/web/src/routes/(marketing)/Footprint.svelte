<script lang="ts">
	// The Bright Data slide: the public-footprint panel from a customer and a vendor page, with the
	// recorded rows from the demo seed (lib/data/mock/seed/footprint.json). Rows come in one after
	// another each time the slide opens; under reduced motion they are all there at once.
	import Icon from '#lib/components/Icon.svelte';

	let { active = false }: { active?: boolean } = $props();

	const rows = [
		{
			subject: 'Bansho Ramen',
			kind: 'Customer',
			source: 'Yelp listing',
			via: 'Web Unlocker',
			text: 'Open on Yelp with 4.1 stars from 196 reviews, and the owner has claimed the page.',
			change: '7 more reviews since the last run'
		},
		{
			subject: 'Stripe',
			kind: 'Vendor',
			source: 'LinkedIn company page',
			via: 'Web Scraper API',
			text: 'Lists 16,694 employees on LinkedIn and has about 1.8 million followers. Founded in 2010.',
			change: ''
		}
	];
</script>

<div class="mx-auto w-full max-w-2xl rounded-xl border border-line bg-canvas">
	<div class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
		<div class="flex items-center gap-2">
			<Icon name="globe" size={16} />
			<span class="font-medium">Signals for a person, not a decision</span>
		</div>
		<span class="text-caption text-ink-3">What a logged-out visitor can see</span>
	</div>
	{#key active}
		<ul class="list flex flex-col divide-y divide-line" class:run={active}>
			{#each rows as r, i (r.subject)}
				<li class="row flex flex-col gap-2 px-4 py-4" style="--i:{i}">
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<p><span class="font-medium">{r.subject}</span> <span class="text-body-sm text-ink-3">· {r.kind}</span></p>
						<span class="rounded-md bg-subtle px-2 py-0.5 text-caption text-ink-2">{r.source} · {r.via}</span>
					</div>
					<p class="text-ink-2">{r.text}</p>
					{#if r.change}
						<p class="self-start rounded-md bg-info-soft px-2 py-0.5 text-caption text-on-info-soft">{r.change}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/key}
</div>
<p class="mt-4 text-center text-body-sm text-ink-3">Every run is stored, so you see what changed. Credit & Risk cites these in its reasons, never in a tier by themselves, and no owner, reviewer or poster names are kept.</p>

<style>
	@media (prefers-reduced-motion: no-preference) {
		.run .row {
			animation: rise 400ms calc(var(--i) * 500ms + 150ms) cubic-bezier(0.23, 1, 0.32, 1) both;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
</style>
