<script lang="ts">
	// One Proposal in both views: the sentence the CFO reads and the lines a controller checks.
	// The toggle is local to this card; it does not change the app's own Simple/Expert mode.
	import Pill from '#lib/components/Pill.svelte';
	import RoleAvatar from '#lib/components/RoleAvatar.svelte';

	let expert = $state(false);

	const lines = [
		{ code: '6150', name: 'Contractors', debit: '8,750.00', credit: '' },
		{ code: '2100', name: 'Accrued expenses', debit: '', credit: '8,750.00' }
	];
	const payload = `{ "kind": "accrual", "period": "2026-09", "invoice": "BRX-1182",
  "invoice_date": "2026-10-03", "service": ["2026-09-01", "2026-09-30"],
  "amount": "8750.00", "reverse_on": "2026-10-01" }`;
</script>

<div class="card flex flex-col">
	<div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
		<div class="flex items-center gap-2">
			<Pill tone="neutral">Accrual</Pill>
			<Pill tone="pos">Approved</Pill>
		</div>
		<div class="inline-flex rounded-btn border border-line-strong p-0.5" role="group" aria-label="View">
			{#each [{ v: false, label: 'Simple' }, { v: true, label: 'Expert' }] as o (o.label)}
				<button
					class="min-h-[40px] rounded-[3px] px-3 text-sm font-medium transition-colors duration-150 {expert === o.v ? 'bg-ink text-canvas' : 'text-ink-2 hover:text-ink'}"
					aria-pressed={expert === o.v}
					onclick={() => (expert = o.v)}>{o.label}</button
				>
			{/each}
		</div>
	</div>

	<div class="flex flex-1 flex-col gap-4 p-4">
		<div class="flex items-start gap-3">
			<RoleAvatar role="bookkeeper" />
			<div class="min-w-0">
				<p class="font-medium">Accrue the September contractor bill</p>
				<p class="text-sm text-ink-3">Proposed by the Bookkeeper</p>
			</div>
		</div>

		{#if expert}
			<table class="num w-full text-[13px]">
				<caption class="sr-only">Journal Lines</caption>
				<thead>
					<tr class="border-b border-line text-left text-ink-3">
						<th class="py-1.5 font-medium">Account</th>
						<th class="py-1.5 text-right font-medium">Debit</th>
						<th class="py-1.5 text-right font-medium">Credit</th>
					</tr>
				</thead>
				<tbody>
					{#each lines as l (l.code)}
						<tr class="border-b border-line">
							<td class="py-1.5"><span class="text-ink-3">{l.code}</span> {l.name}</td>
							<td class="py-1.5 text-right">{l.debit}</td>
							<td class="py-1.5 text-right">{l.credit}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<dl class="flex flex-col gap-2 text-sm">
				<div><dt class="inline font-medium">Rationale.</dt> <dd class="inline text-ink-2">Invoice BRX-1182 is dated 3 Oct and covers 1–30 Sep. September is open, so accrue at the invoice amount and reverse on 1 Oct.</dd></div>
				<div><dt class="inline font-medium">Red Team.</dt> <dd class="inline text-ink-2">No critique: the dates and amount agree with the statement of work.</dd></div>
				<div><dt class="inline font-medium">Advisor.</dt> <dd class="inline text-ink-2">Approved, below the $10,000.00 Materiality threshold.</dd></div>
			</dl>
			<pre class="overflow-x-auto rounded-btn bg-subtle p-3 font-mono text-xs leading-5 text-ink-2">{payload}</pre>
		{:else}
			<p class="text-lg text-ink">The contractor did September's work but billed in October. I recorded the $8,750 cost in September so the month is right.</p>
			<p class="mt-auto rounded-btn bg-accent-soft px-3 py-2 text-[15px]">
				<span class="font-medium">Advisor:</span> approved. It is under your $10,000 threshold, so it posted without you.
			</p>
		{/if}
	</div>
</div>
