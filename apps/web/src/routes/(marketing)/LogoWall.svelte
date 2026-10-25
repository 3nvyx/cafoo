<script lang="ts">
	// What Cafoo runs on and who it is for, as a monochrome logo wall. Logos are masks filled
	// with the text color, so every brand reads as one quiet tone in both themes.
	import Icon, { type IconName } from '#lib/components/Icon.svelte';

	// A logo is a wordmark file; a mark is a square symbol set next to the brand name; a tile is
	// an icon and a phrase, for groups that are not companies.
	type Item =
		| { kind: 'logo'; name: string; file: string; ratio: number }
		| { kind: 'mark'; name: string; file: string }
		| { kind: 'tile'; name: string; icon: IconName };

	const logo = (name: string, file: string, ratio: number): Item => ({ kind: 'logo', name, file, ratio });
	const mark = (name: string, file: string): Item => ({ kind: 'mark', name, file });
	const tile = (name: string, icon: IconName): Item => ({ kind: 'tile', name, icon });

	const groups: { id: string; label: string; note: string; items: Item[] }[] = [
		{
			id: 'data',
			label: 'Data sets',
			note: 'Bureau, identity and public-footprint data behind every credit check',
			items: [
				logo('TransUnion', 'transunion', 3.78),
				logo('Equifax', 'equifax', 5.07),
				logo('Experian', 'experian', 3.01),
				logo('CRS Credit API', 'crs', 2.9),
				logo('Bright Data', 'brightdata', 4.48),
				mark('LinkedIn', 'linkedin')
			]
		},
		{
			id: 'clients',
			label: 'Company types',
			note: 'The finance teams Cafoo is built for',
			items: [
				tile('SaaS companies', 'monitor'),
				tile('Selling to small businesses', 'home'),
				tile('Groups of companies', 'panel'),
				tile('Multi-currency books', 'globe'),
				tile('Solo controllers', 'checklist'),
				tile('CFOs with a small team', 'users')
			]
		},
		{
			id: 'tech',
			label: 'Technologies',
			note: 'The models and infrastructure under the hood',
			items: [
				logo('Anthropic', 'anthropic', 8.91),
				logo('OpenAI', 'openai', 3.72),
				mark('xAI', 'xai'),
				logo('Gemini', 'gemini', 4.43),
				mark('AI SDK', 'vercel'),
				logo('Fetch.ai', 'fetch-ai', 6.1),
				mark('SpacetimeDB', 'spacetimedb'),
				mark('Svelte', 'svelte'),
				mark('TypeScript', 'typescript'),
				logo('Tailwind CSS', 'tailwindcss', 7.94),
				mark('Node.js', 'nodedotjs'),
				mark('Vite', 'vite')
			]
		},
		{
			id: 'solutions',
			label: 'Solutions',
			note: 'What the agents take off your plate at month end',
			items: [
				tile('Bank reconciliation', 'database'),
				tile('Revenue recognition', 'chart'),
				tile('Accruals and payables', 'book'),
				tile('Consolidation and FX', 'globe'),
				tile('Credit and risk', 'shield'),
				tile('Board Pack', 'slides')
			]
		}
	];

	// Wide wordmarks get shorter and square ones taller, so each logo covers about the same area.
	const logoHeight = (ratio: number) => Math.round(Math.min(40, Math.max(16, 48 / Math.sqrt(ratio))));
</script>

<div class="flex flex-col items-center text-center">
	<h2 id="stack-h" class="title">Built on real data, made for lean finance teams</h2>
</div>

<div class="mt-14 flex flex-col gap-12">
	{#each groups as g (g.id)}
		<section aria-labelledby="stack-{g.id}">
			<div class="flex flex-col gap-1 border-t border-line pt-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
				<h3 id="stack-{g.id}" class="font-sans text-body font-medium text-ink">{g.label}</h3>
				<p class="text-body-sm text-ink-3 sm:text-right">{g.note}</p>
			</div>
			<!-- role="list" keeps list semantics in Safari, which drops them when list-style is none. -->
			<ul role="list" class="mt-2 grid grid-cols-3 md:grid-cols-6">
				{#each g.items as item (item.name)}
					<li class="cell flex min-h-20 items-center justify-center px-2 py-3 text-ink-3 md:min-h-24">
						{#if item.kind === 'logo'}
							<span
								class="logo"
								role="img"
								aria-label={item.name}
								style="--logo: url(/logos/{item.file}.svg); width: {Math.round(logoHeight(item.ratio) * item.ratio)}px; aspect-ratio: {item.ratio}"
							></span>
						{:else if item.kind === 'mark'}
							<span class="flex flex-col items-center gap-2 md:flex-row">
								<span class="logo mark" aria-hidden="true" style="--logo: url(/logos/{item.file}.svg)"></span>
								<span class="text-body-sm font-medium md:text-subtitle">{item.name}</span>
							</span>
						{:else}
							<span class="flex flex-col items-center gap-2 text-center">
								<Icon name={item.icon} size={20} />
								<span class="text-body-sm text-balance">{item.name}</span>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>

<p class="mt-10 text-center text-caption text-ink-3">Logos are trademarks of their owners and show the data and tools Cafoo uses, not endorsements.</p>

<style>
	/* The page's section headings, matched size for size. */
	.title {
		max-width: 20ch;
		font-size: 36px;
		line-height: 1.02;
		letter-spacing: -0.03em;
	}
	@media (min-width: 640px) {
		.title {
			font-size: 56px;
		}
	}

	/* The width is set inline; on a narrow cell it gives way and the height follows the ratio. */
	.logo {
		display: block;
		max-width: 100%;
		background-color: currentColor;
		mask: var(--logo) center / contain no-repeat;
		-webkit-mask: var(--logo) center / contain no-repeat;
	}
	.mark {
		max-width: none;
		width: 18px;
		height: 18px;
		flex: none;
	}
	@media (min-width: 768px) {
		.mark {
			width: 22px;
			height: 22px;
		}
	}

	/* Logos sit back in the dust tone and come forward to ink on hover, like a quiet roll call. */
	.cell {
		transition: color 200ms cubic-bezier(0.23, 1, 0.32, 1);
	}
	@media (hover: hover) {
		.cell:hover {
			color: var(--ink);
		}
	}
</style>
