<script lang="ts">
	// The CRS Credit API slide: the four checks the Credit & Risk agent runs on a person, in order,
	// and the Risk Tier the books derive from them. While the slide is showing, a highlight walks the
	// cascade step by step; under reduced motion it stays still.
	import Icon from '#lib/components/Icon.svelte';

	let { active = false }: { active?: boolean } = $props();

	// The CRS products behind each step (fixtures/crs/ has a sandbox answer per product).
	const steps = [
		{ title: 'Identity', product: 'tu_identity_verification', text: 'A real, living person who matches the name on file. A deceased or mismatched identity stops the cascade here.' },
		{ title: 'Fraud', product: 'fraud_finder', text: 'A fraud score on the email, phone and address they gave you.' },
		{ title: 'Three bureaus', product: 'credit_report', text: 'TransUnion, Equifax and Experian, all three, or the check is refused.' },
		{ title: 'Public records', product: 'pitchpoint_blj · eviction · criminal', text: 'Bankruptcies, liens, judgments, evictions and criminal records.' }
	];
	// Payment terms each tier allows (packages/crs-mcp/src/tiers.ts).
	const tiers = [
		{ tier: 'A', terms: '45 days' },
		{ tier: 'B', terms: '30 days' },
		{ tier: 'C', terms: '15 days' },
		{ tier: 'D', terms: 'No credit' },
		{ tier: 'BLOCK', terms: 'No credit' }
	];
</script>

<div class="cascade grid gap-2 lg:grid-cols-5" class:run={active}>
	{#each steps as s, i (s.title)}
		<div class="step flex flex-col gap-2 rounded-lg border border-line bg-canvas p-4" style="--i:{i}">
			<div class="flex items-center gap-2">
				<span class="num text-caption text-ink-3">0{i + 1}</span>
				<span class="font-medium">{s.title}</span>
			</div>
			<p class="font-mono text-caption break-words text-ink-3">{s.product}</p>
			<p class="text-body-sm text-ink-2">{s.text}</p>
		</div>
	{/each}
	<div class="step flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4" style="--i:4">
		<div class="flex items-center gap-2">
			<Icon name="lock" size={16} />
			<span class="font-medium">The books set the tier</span>
		</div>
		<p class="text-body-sm text-ink-2">The database derives it from the recorded facts, so the agent cannot claim a friendlier one.</p>
		<ul class="mt-auto flex flex-col gap-1">
			{#each tiers as t (t.tier)}
				<li class="flex items-center justify-between gap-2 text-body-sm">
					<span class="num font-medium">{t.tier}</span>
					<span class="text-ink-3">{t.terms}</span>
				</li>
			{/each}
		</ul>
	</div>
</div>
<p class="mt-4 text-center text-body-sm text-ink-3">The result becomes a Proposal, so the Advisor rules on it and the CFO confirms it before credit is extended, reserved or blocked.</p>

<style>
	/* One step lights at a time, left to right, then the tier; the loop rests briefly before it starts again. */
	.step {
		transition: background-color 300ms cubic-bezier(0.23, 1, 0.32, 1);
	}
	@media (prefers-reduced-motion: no-preference) {
		.run .step {
			animation: walk 7.5s calc(var(--i) * 1.2s) infinite both;
		}
	}
	@keyframes walk {
		0%,
		18%,
		100% {
			background-color: var(--canvas);
		}
		3%,
		14% {
			background-color: var(--accent-soft);
		}
	}
</style>
