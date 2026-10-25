<script lang="ts">
	// The Fetch.ai slide: a chat with the Cafoo Advisor in ASI:One. The question, the four specialists
	// it asks at once and its answer card come in one after another each time the slide opens; under
	// reduced motion they are all there at once. What the card holds follows apps/asi-advisor/README.md.
	import Icon from '#lib/components/Icon.svelte';

	let { active = false }: { active?: boolean } = $props();

	// Consolidation has no role colour of its own; it uses the neutral one, as in the app.
	const desks = [
		{ name: 'Bookkeeper', tone: 'bookkeeper' },
		{ name: 'Revenue', tone: 'revenue' },
		{ name: 'Credit & Risk', tone: 'credit' },
		{ name: 'Consolidation', tone: 'system' }
	];
	const rows = [
		{ label: 'Cash and the bank', text: 'Cash per company in its own currency, and unexplained bank lines' },
		{ label: 'Revenue and receivables', text: 'Revenue recognized this month, what customers owe, what is overdue' },
		{ label: 'Credit risk', text: 'Customers by risk tier, the bad-debt reserve, vendors blocked before payment' },
		{ label: 'The group and FX', text: 'The month’s exchange rates, revaluation and elimination entries' }
	];
</script>

<div class="mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-canvas">
	<div class="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
		<div class="flex items-center gap-2">
			<Icon name="chat" size={16} />
			<span class="font-medium">Cafoo Advisor</span>
		</div>
		<span class="text-caption text-ink-3">ASI:One · Agent Chat Protocol 0.3.0</span>
	</div>
	{#key active}
		<div class="chat flex flex-col gap-3 p-4" class:run={active}>
			<p class="msg self-end rounded-lg bg-inverse px-3 py-2 text-on-inverse" style="--i:0">How are we doing?</p>
			<div class="msg flex flex-wrap items-center gap-2 text-body-sm text-ink-3" style="--i:1">
				<span>Asking four specialists at once:</span>
				{#each desks as d (d.name)}
					<span class="inline-flex items-center gap-1.5 rounded-md bg-subtle px-2 py-0.5 text-caption text-ink-2">
						<span class="size-2 rounded-full" style="background:var(--role-{d.tone})"></span>{d.name}
					</span>
				{/each}
			</div>
			<div class="msg flex flex-col rounded-lg border border-line bg-surface" style="--i:2">
				<p class="border-b border-line px-4 py-3 font-medium">Financial health check</p>
				<ul class="flex flex-col divide-y divide-line">
					{#each rows as r (r.label)}
						<li class="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
							<span class="shrink-0 text-body-sm font-medium">{r.label}</span>
							<span class="text-body-sm text-ink-3 sm:text-right">{r.text}</span>
						</li>
					{/each}
				</ul>
				<div class="flex flex-wrap gap-2 border-t border-line px-4 py-3">
					<span class="rounded-md bg-subtle px-2.5 py-1 text-caption text-ink-2">What needs the CFO’s OK?</span>
					<span class="rounded-md bg-subtle px-2.5 py-1 text-caption text-ink-2">Why?</span>
					<span class="rounded-md bg-subtle px-2.5 py-1 text-caption text-ink-2">Start the close</span>
				</div>
			</div>
		</div>
	{/key}
</div>
<p class="mt-4 text-body-sm text-ink-3">It reads the books and explains them. It never confirms or posts anything: the CFO does that in the Cafoo app.</p>

<style>
	/* Each part rises in after the one before it. */
	@media (prefers-reduced-motion: no-preference) {
		.run .msg {
			animation: rise 400ms calc(var(--i) * 600ms + 150ms) cubic-bezier(0.23, 1, 0.32, 1) both;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
</style>
