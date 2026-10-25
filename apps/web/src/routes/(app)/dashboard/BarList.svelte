<script lang="ts">
	// A ranked list with a bar per row: label, bar and exact value. Rows with an href drill to the ledger lines behind them.
	import { formatMoney } from '#lib/data/money.js';
	import type { Minor } from '#lib/data/types.js';

	interface Row {
		key: string;
		label: string;
		minor: Minor;
		href?: string;
	}

	let { rows, empty }: { rows: Row[]; empty: string } = $props();
	const max = $derived(Math.max(1, ...rows.map((r) => Math.abs(Number(r.minor)))));
</script>

{#if rows.length}
	<ul class="flex flex-col gap-3">
		{#each rows as r (r.key)}
			{@const pct = (Math.abs(Number(r.minor)) / max) * 100}
			<li>
				<svelte:element this={r.href ? 'a' : 'div'} href={r.href} class="group flex flex-col gap-1.5">
					<span class="flex items-baseline justify-between gap-3 text-body-sm">
						<span class="truncate text-ink-2 {r.href ? 'group-hover:text-accent-ink' : ''}">{r.label}</span>
						<span class="num text-ink">{formatMoney(r.minor, { whole: true })}</span>
					</span>
					<span class="block h-2 rounded-sm bg-subtle">
						<span class="block h-full rounded-sm bg-ink-3" style="width:{Math.max(pct, 1)}%"></span>
					</span>
				</svelte:element>
			</li>
		{/each}
	</ul>
{:else}
	<p class="text-body-sm text-ink-3">{empty}</p>
{/if}
