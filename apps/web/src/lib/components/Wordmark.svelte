<script lang="ts">
	// Cafoo's mark: an open "C" ring in the primary color beside the serif name.
	let { compact = false, href = '/', label = 'Cafoo home' }: { compact?: boolean; href?: string; label?: string } = $props();
</script>

<a {href} class="inline-flex min-h-[44px] items-center gap-2.5 rounded-sm px-1 text-ink" aria-label={label}>
	<svg class="size-7 shrink-0" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
		<rect width="32" height="32" rx="9" fill="var(--primary)" />
		<path d="M21.5 11.2A7 7 0 1 0 21.5 20.8" fill="none" stroke="var(--on-primary)" stroke-width="3.2" stroke-linecap="round" />
	</svg>
	{#if !compact}<span class="font-display text-[22px] leading-none font-medium tracking-[-0.01em]">Cafoo</span>{/if}
</a>
