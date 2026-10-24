<script lang="ts">
	// A Revenue Schedule as the CFO reads it: per customer and contract item, the amount earned each month.
	import { db } from '#lib/data/index.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import { ymShort } from '#lib/data/derive.js';
	import type { ScheduleLine } from '#lib/proposals.js';

	let { lines, periodId }: { lines: ScheduleLine[]; periodId?: string } = $props();

	const customers = $derived(new Map(db.customers().map((c) => [c.id, c])));
	const groups = $derived.by(() => {
		const m = new Map<string, { customerId?: string; contractItemId?: string; rows: ScheduleLine[] }>();
		for (const l of lines) {
			const key = `${l.customerId ?? ''}|${l.contractItemId ?? ''}`;
			let g = m.get(key);
			if (!g) m.set(key, (g = { customerId: l.customerId, contractItemId: l.contractItemId, rows: [] }));
			g.rows.push(l);
		}
		return [...m.entries()].map(([key, g]) => ({
			key,
			...g,
			rows: g.rows.slice().sort((a, b) => a.ym.localeCompare(b.ym)),
			total: g.rows.reduce((t, r) => t + toBig(r.amountMinor), 0n).toString()
		}));
	});
</script>

<div class="flex flex-col gap-4">
	{#each groups as g (g.key)}
		{@const c = g.customerId ? customers.get(g.customerId) : undefined}
		<div>
			<p class="mb-2 text-sm text-ink-2">
				{#if c}<a class="drill font-medium text-ink" href="/customers/{c.id}">{c.name}</a>{:else if g.customerId}Customer <span class="num">{g.customerId}</span>{/if}
				{#if g.contractItemId}<span class="text-ink-3"> · contract item <span class="num">{g.contractItemId}</span></span>{/if}
				<span class="text-ink-3"> · {g.rows.length} month{g.rows.length === 1 ? '' : 's'}</span>
			</p>
			<div class="overflow-hidden rounded-btn border border-line">
				<table class="w-full text-sm">
					<thead class="bg-subtle text-left text-ink-3">
						<tr>
							<th scope="col" class="py-2 pl-3 font-medium">Month</th>
							<th scope="col" class="py-2 pr-3 text-right font-medium">Revenue</th>
						</tr>
					</thead>
					<tbody>
						{#each g.rows as r, i (`${r.ym}-${i}`)}
							<tr class="border-t border-line {r.ym === periodId ? 'bg-accent-soft' : ''}">
								<td class="num py-2 pl-3">{ymShort(r.ym)}{#if r.ym === periodId}<span class="ml-2 font-sans text-xs text-ink-3">this close</span>{/if}</td>
								<td class="num py-2 pr-3 text-right">{formatMoney(r.amountMinor)}</td>
							</tr>
						{/each}
						<tr class="border-t border-line-strong font-medium">
							<td class="py-2 pl-3">Total</td>
							<td class="num py-2 pr-3 text-right">{formatMoney(g.total)}</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	{/each}
</div>
