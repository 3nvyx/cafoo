<script lang="ts">
	// A Bank Match's links, one row each: the bank line, what it pays, the amount and the agent's confidence.
	import { db } from '#lib/data/index.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import { drill, shortDate } from '#lib/labels.js';
	import type { MatchLine } from '#lib/proposals.js';

	let { matches }: { matches: MatchLine[] } = $props();

	const txs = $derived(new Map(db.bankTransactions().map((t) => [t.id, t])));
	const invoices = $derived(new Map(db.invoices().map((i) => [i.id, i])));
	const bills = $derived(new Map(db.bills().map((b) => [b.id, b])));
	const entries = $derived(new Map(db.journalEntries().map((j) => [j.id, j])));
	const customers = $derived(new Map(db.customers().map((c) => [c.id, c])));
	const vendors = $derived(new Map(db.vendors().map((v) => [v.id, v])));

	const rows = $derived(
		matches.map((m, i) => {
			const tx = txs.get(m.bankTxId);
			const abs = tx ? (toBig(tx.amountMinor) < 0n ? -toBig(tx.amountMinor) : toBig(tx.amountMinor)).toString() : undefined;
			let target: { kind: string; label: string; party?: string; href?: string };
			if (m.targetKind === 'invoice') {
				const inv = invoices.get(m.targetId);
				const c = inv ? customers.get(inv.customerId) : undefined;
				target = { kind: 'Invoice', label: inv?.number ?? m.targetId, party: c?.name, href: c ? `/customers/${c.id}` : undefined };
			} else if (m.targetKind === 'bill') {
				const b = bills.get(m.targetId);
				const v = b ? vendors.get(b.vendorId) : undefined;
				target = { kind: 'Bill', label: b?.number ?? m.targetId, party: v?.name, href: v ? `/vendors/${v.id}` : undefined };
			} else {
				const j = entries.get(m.targetId);
				target = { kind: 'Journal Entry', label: j?.memo ?? m.targetId, href: j ? drill({ je: j.id }, j.periodId) : undefined };
			}
			const bp = m.scoreBp;
			const confidence = bp === undefined ? '' : `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}% · ${bp >= 9500 ? 'exact' : bp >= 8000 ? 'strong' : 'weak'}`;
			return { key: `${m.bankTxId}-${i}`, m, tx, abs, target, confidence, weak: bp !== undefined && bp < 8000 };
		})
	);
</script>

<div class="overflow-hidden rounded-btn border border-line text-sm">
	<div class="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_110px_100px] gap-3 bg-subtle px-3 py-2 text-ink-3 sm:grid">
		<span>Bank line</span><span>Pays</span><span class="text-right">Amount</span><span class="text-right">Confidence</span>
	</div>
	<ul>
		{#each rows as r (r.key)}
			<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t border-line px-3 py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_110px_100px] sm:first:border-t">
				<span class="min-w-0">
					{#if r.tx}
						<span class="block truncate">{r.tx.counterparty || r.tx.description}</span>
						<span class="block truncate text-xs text-ink-3"><span class="num">{shortDate(r.tx.bookedAt)}</span> · {r.tx.description} · <span class="num">{r.m.bankTxId}</span></span>
					{:else}
						<span class="block">Bank line <span class="num">{r.m.bankTxId}</span></span>
					{/if}
				</span>
				<span class="num text-right sm:order-3">{r.abs ? formatMoney(r.abs) : ''}</span>
				<span class="min-w-0 sm:order-2">
					<span class="block truncate">
						<span class="text-ink-3">{r.target.kind}</span>
						{#if r.target.href}<a class="drill {r.target.kind === 'Journal Entry' ? '' : 'num'}" href={r.target.href}>{r.target.label}</a>{:else}<span class="num">{r.target.label}</span>{/if}
					</span>
					{#if r.target.party}<span class="block truncate text-xs text-ink-3">{r.target.party}</span>{/if}
				</span>
				<span class="num self-start text-right text-xs sm:order-4 sm:text-sm {r.weak ? 'text-warn' : 'text-ink-2'}">{r.confidence}</span>
			</li>
		{/each}
	</ul>
</div>
