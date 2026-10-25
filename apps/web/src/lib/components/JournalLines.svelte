<script lang="ts">
	import { formatMoney } from '#lib/data/money.js';
	import { drill } from '#lib/labels.js';
	import type { Minor } from '#lib/data/types.js';

	export interface LineView {
		key: string;
		code: string;
		name: string;
		debitMinor: Minor;
		creditMinor: Minor;
		/** The line's currency (default USD). */
		ccy?: string;
		highlight?: boolean;
	}

	let { lines, periodId }: { lines: LineView[]; periodId?: string } = $props();
	const fmt = (m: Minor, ccy?: string) => (m === '0' ? '' : formatMoney(m, { currency: ccy }));
</script>

<div class="overflow-hidden rounded-btn border border-line">
	<table class="w-full table-fixed text-sm">
		<thead class="bg-subtle text-left text-ink-3">
			<tr>
				<th scope="col" class="py-2 pl-3 font-medium">Account</th>
				<th scope="col" class="w-[30%] py-2 pr-3 text-right font-medium">Debit</th>
				<th scope="col" class="w-[30%] py-2 pr-3 text-right font-medium">Credit</th>
			</tr>
		</thead>
		<tbody>
			{#each lines as l (l.key)}
				<tr class="border-t border-line {l.highlight ? 'bg-accent-soft' : ''}">
					<td class="truncate py-2 pl-3">{l.name}</td>
					<td class="num py-2 pr-3 text-right">
						{#if l.debitMinor !== '0'}<a class="drill" href={drill({ account: l.code }, periodId)}>{fmt(l.debitMinor, l.ccy)}</a>{/if}
					</td>
					<td class="num py-2 pr-3 text-right">
						{#if l.creditMinor !== '0'}<a class="drill" href={drill({ account: l.code }, periodId)}>{fmt(l.creditMinor, l.ccy)}</a>{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
