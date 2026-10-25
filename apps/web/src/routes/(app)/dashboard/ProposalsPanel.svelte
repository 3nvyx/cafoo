<script lang="ts">
	// Proposals by status: one stacked bar for the share, then a bar per status that opens that tab of the Proposals
	// page. Approved includes amended; sent back and superseded are counted below the chart.
	import { db } from '#lib/data/index.js';
	import { STATUS } from '#lib/labels.js';
	import Pill from '#lib/components/Pill.svelte';
	import { PROPOSAL_BUCKETS, PROPOSAL_BUCKET_LABEL, barPct, proposalCounts, type ProposalBucket } from './insights.js';

	const c = $derived(proposalCounts(db.proposals()));
	const shown = $derived(PROPOSAL_BUCKETS.reduce((s, b) => s + c[b], 0));
	const max = $derived(Math.max(...PROPOSAL_BUCKETS.map((b) => c[b]), 0));
	const TAB: Record<ProposalBucket, keyof typeof STATUS> = { approved: 'approved', awaiting: 'awaiting_cfo', debate: 'open', rejected: 'rejected' };
	const FILL: Record<ProposalBucket, string> = { approved: 'bg-pos', awaiting: 'bg-warn', debate: 'bg-info', rejected: 'bg-neg' };
</script>

<section aria-labelledby="props-h" class="card flex flex-col gap-4 p-5">
	<div class="flex flex-wrap items-baseline justify-between gap-3">
		<h2 id="props-h" class="text-subtitle">Proposals by status</h2>
		<a href="/proposals?status=all" class="drill text-body-sm text-ink-2">All Proposals</a>
	</div>

	{#if !c.total}
		<p class="text-body-sm text-ink-2">No Proposals yet. Starting the close sets the agents proposing.</p>
	{:else}
		<div class="flex h-3 overflow-hidden rounded-sm bg-subtle" aria-hidden="true">
			{#each PROPOSAL_BUCKETS as b (b)}
				{#if c[b]}<span class="h-full {FILL[b]}" style="width:{(c[b] / shown) * 100}%" title="{PROPOSAL_BUCKET_LABEL[b]}: {c[b]}"></span>{/if}
			{/each}
		</div>
		<ul class="flex flex-col gap-2" aria-label="Proposals by status">
			{#each PROPOSAL_BUCKETS as b (b)}
				<li>
					<a href="/proposals?status={TAB[b]}" class="group flex items-center gap-3 text-body-sm" aria-label="{PROPOSAL_BUCKET_LABEL[b]}: {c[b]}">
						<span class="w-32 shrink-0"><Pill tone={STATUS[TAB[b]].tone}>{PROPOSAL_BUCKET_LABEL[b]}</Pill></span>
						<span class="h-3 flex-1 overflow-hidden rounded-sm bg-subtle"><span class="block h-full rounded-sm bg-ink-3 transition-[width] duration-500 group-hover:bg-ink-2" style="width:{barPct(c[b], max)}%"></span></span>
						<span class="num w-10 shrink-0 text-right text-ink">{c[b]}</span>
					</a>
				</li>
			{/each}
		</ul>
		<p class="text-caption text-ink-3">{c.total} in all{c.other ? `; ${c.other} sent back or superseded` : ''}</p>
	{/if}
</section>
