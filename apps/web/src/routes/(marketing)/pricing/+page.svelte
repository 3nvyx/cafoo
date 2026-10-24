<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	const tiers = [
		{
			name: 'Starter',
			price: '$490',
			per: 'per month',
			for: 'One Subsidiary, up to $2M ARR',
			features: ['Month-end close with agents', 'Bank Matches and accruals', 'Board Pack every month', 'Simple and Expert mode'],
			cta: 'Start a trial'
		},
		{
			name: 'Growth',
			price: '$1,490',
			per: 'per month',
			for: 'Up to three Subsidiaries, up to $20M ARR',
			features: ['Everything in Starter', 'Revenue Schedules and Deferred Revenue', 'Custom Materiality thresholds', 'Audit log export'],
			cta: 'Start a trial',
			featured: true
		},
		{
			name: 'Scale',
			price: 'Custom',
			per: 'annual contract',
			for: 'Many Subsidiaries, any size',
			features: ['Everything in Growth', 'Agent Charters you can edit', 'Dedicated close specialist', 'Uptime commitment'],
			cta: 'Talk to us'
		}
	];

	const modules = [
		{ name: 'Revenue', price: '+$300/mo', text: 'Contracts, Revenue Schedules, ARR waterfall.' },
		{ name: 'Credit & Risk', price: '+$400/mo', text: 'Owner Credit Checks, Risk Tiers, Allowance. Checks billed at cost.' },
		{ name: 'Multi-subsidiary & FX', price: '+$500/mo', text: 'Consolidation, intercompany, FX rates.' },
		{ name: 'Vendor verification', price: '+$200/mo', text: 'Bank detail changes checked before anyone gets paid.' }
	];
</script>

<svelte:head><title>Pricing · Cafoo</title></svelte:head>

<div class="min-h-dvh bg-canvas">
	<header class="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-4 sm:px-8">
		<a href="/" class="flex min-h-[44px] items-center gap-2.5" aria-label="Cafoo home">
			<span class="grid size-7 place-items-center rounded-btn bg-accent font-display text-[15px] font-medium text-on-accent">C</span>
			<span class="font-display text-lg font-medium tracking-tight">Cafoo</span>
		</a>
		<a href="/" class="btn">Open the app</a>
	</header>

	<main class="mx-auto max-w-[1120px] px-4 pt-10 pb-20 sm:px-8 sm:pt-16">
		<h1 class="max-w-[16ch] text-[40px] sm:text-[56px]" style="letter-spacing:-0.03em">Pricing that does not count seats</h1>
		<p class="mt-4 max-w-[56ch] text-lg text-ink-2">Every plan includes unlimited seats and the AI agents. You pay for the size of your books and the modules you turn on.</p>

		<div class="mt-12 grid gap-4 md:grid-cols-3">
			{#each tiers as t (t.name)}
				<section class="card flex flex-col gap-6 p-6 {t.featured ? 'border-accent' : ''}" aria-labelledby="tier-{t.name}">
					<div>
						<div class="flex items-center justify-between">
							<h2 id="tier-{t.name}" class="text-2xl">{t.name}</h2>
							{#if t.featured}<span class="rounded-full bg-accent-soft px-2 text-[13px] leading-6 font-medium text-accent-ink">Most teams</span>{/if}
						</div>
						<p class="mt-1 text-sm text-ink-3">{t.for}</p>
					</div>
					<p><span class="num text-[40px] leading-none font-medium">{t.price}</span> <span class="text-ink-3">{t.per}</span></p>
					<ul class="flex flex-1 flex-col gap-2.5">
						<li class="flex gap-2"><Icon name="check" size={20} class="shrink-0 text-accent" />Unlimited seats</li>
						<li class="flex gap-2"><Icon name="check" size={20} class="shrink-0 text-accent" />AI agents included</li>
						{#each t.features as f (f)}
							<li class="flex gap-2 text-ink-2"><Icon name="check" size={20} class="shrink-0 text-ink-3" />{f}</li>
						{/each}
					</ul>
					<a href="/" class="btn {t.featured ? 'btn-primary' : ''} w-full">{t.cta}</a>
				</section>
			{/each}
		</div>

		<section class="mt-16" aria-labelledby="mods-h">
			<h2 id="mods-h" class="text-[28px]">Modules</h2>
			<p class="mt-2 text-ink-2">Add them to any plan. Turn them off any month.</p>
			<ul class="mt-6 divide-y divide-line border-y border-line">
				{#each modules as m (m.name)}
					<li class="grid gap-1 py-4 sm:grid-cols-[220px_minmax(0,1fr)_auto] sm:items-baseline sm:gap-6">
						<span class="font-medium">{m.name}</span>
						<span class="text-ink-2">{m.text}</span>
						<span class="num text-ink">{m.price}</span>
					</li>
				{/each}
			</ul>
		</section>
	</main>
</div>
