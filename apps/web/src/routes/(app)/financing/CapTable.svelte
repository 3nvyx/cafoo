<script lang="ts">
	// Who owns Cafoo Inc today on a fully diluted basis, and, once a priced round's term sheet is in, who would own it
	// after the round with every SAFE and note converted.
	import { db } from '#lib/data/index.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { CapTableEntry, SecurityClass } from '#lib/data/types.js';
	import { formatPpm, formatPriceE4, fullyDilutedPpm, fullyDilutedShares, fundedDates, rollForward, roundPlan } from '#lib/financing.js';
	import { shortDate } from '#lib/labels.js';
	import Notice from '#lib/components/Notice.svelte';
	import { rootOf } from '#lib/data/group.js';

	const company = $derived(rootOf(db.subsidiaries())?.name ?? 'the company');

	const SECURITY: Record<SecurityClass, string> = {
		common: 'Common',
		preferred: 'Preferred',
		options_granted: 'Options granted',
		option_pool: 'Unallocated pool',
		safe: 'SAFE',
		note: 'Convertible note',
		warrant: 'Warrant'
	};
	const ORDER: SecurityClass[] = ['common', 'preferred', 'options_granted', 'option_pool', 'warrant', 'safe', 'note'];
	const money = (minor: bigint | string) => formatMoney(minor.toString(), { whole: true, compact: toBig(minor.toString()) >= 100_000_000n });

	const entries = $derived(db.capTable());
	const total = $derived(fullyDilutedShares(entries));
	const byInvested = (a: CapTableEntry, b: CapTableEntry) => {
		const d = toBig(b.investedMinor) - toBig(a.investedMinor);
		return d > 0n ? 1 : d < 0n ? -1 : 0;
	};
	const sorted = $derived([...entries].sort((a, b) => ORDER.indexOf(a.security) - ORDER.indexOf(b.security) || b.shares - a.shares || byInvested(a, b)));
	const converting = (e: CapTableEntry) => e.security === 'safe' || e.security === 'note';
	const founders = $derived(entries.filter((e) => e.security === 'common' && e.employeeId).reduce((t, e) => t + BigInt(e.shares), 0n));

	// The next priced round, once its term sheet is in.
	const next = $derived(db.fundingRounds().find((r) => r.status === 'planned' && r.preMoneyMinor));
	const investors = $derived(new Map(db.investors().map((i) => [i.id, i.name])));
	const projection = $derived.by(() => {
		if (!next) return null;
		const lead = db.commitments().find((c) => c.roundId === next.id && c.investorId === next.leadInvestorId);
		const closeAt = lead?.expectedBy ?? db.now();
		const instruments = db.instruments();
		const toConvert = instruments.filter((i) => i.roundId !== next.id && (i.kind === 'safe_post_money' || i.kind === 'safe_pre_money' || i.kind === 'convertible_note') && (i.status === 'outstanding' || i.status === 'draft'));
		const funded = fundedDates(db.proposals());
		const name = (id: string) => investors.get(id) ?? id;
		let plan: ReturnType<typeof roundPlan>;
		try {
			plan = roundPlan({
				capTable: entries,
				converting: toConvert,
				holderName: name,
				fundedAt: (id) => funded.get(id),
				preMoneyMinor: toBig(next.preMoneyMinor),
				newMoneyMinor: toBig(next.targetMinor),
				closeAt
			});
		} catch (err) {
			return { next, error: err instanceof Error ? err.message : String(err) };
		}
		const byId = new Map(toConvert.map((i) => [i.id, i]));
		const after = rollForward(
			entries,
			plan.rows.map((r) => ({ instrumentInvestorId: byId.get(r.id)?.investorId, holderName: r.holderName, shares: r.shares })),
			[{ holderName: next.leadInvestorId ? name(next.leadInvestorId) : next.name, investorId: next.leadInvestorId, shares: plan.newMoneyShares, investedMinor: toBig(next.targetMinor) }],
			closeAt
		);
		const afterTotal = fullyDilutedShares(after);
		// One line per holder: today's and post-round ownership.
		const holders = new Map<string, { name: string; today: bigint; after: bigint }>();
		const key = (e: CapTableEntry) => (e.security === 'option_pool' ? 'pool' : e.security === 'options_granted' ? 'options' : (e.investorId ?? e.employeeId ?? e.holderName));
		const label = (e: CapTableEntry) => (e.security === 'option_pool' ? 'Unallocated pool' : e.security === 'options_granted' ? 'Options granted to the team' : e.holderName);
		for (const e of entries) if (!converting(e)) holders.set(key(e), { name: label(e), today: (holders.get(key(e))?.today ?? 0n) + BigInt(e.shares), after: 0n });
		for (const e of after) {
			if (converting(e)) continue;
			const h = holders.get(key(e)) ?? { name: label(e), today: 0n, after: 0n };
			h.after += BigInt(e.shares);
			holders.set(key(e), h);
		}
		const rows = [...holders.values()].sort((a, b) => (b.after > a.after ? 1 : b.after < a.after ? -1 : 0));
		return { next, plan, closeAt, afterTotal, rows, waiting: toConvert.filter((i) => i.status === 'draft').length };
	});
</script>

<section aria-labelledby="cap-h" class="flex flex-col gap-3">
	<div class="flex flex-col gap-1">
		<h2 id="cap-h" class="text-title">Cap table</h2>
		<p class="max-w-prose text-body-sm text-ink-2">
			Who owns {company}, fully diluted: shares, options granted and the unallocated pool, {total.toLocaleString('en-US')} in all. The founders hold {formatPpm(fullyDilutedPpm(founders, total), 1)}. SAFEs and notes own nothing yet; they turn into shares at the next priced round.
		</p>
	</div>
	<div class="overflow-x-auto">
		<table class="w-full text-body-sm">
			<thead class="text-left text-caption text-ink-3">
				<tr class="border-b border-line">
					<th class="py-2 pr-3 font-medium">Holder</th>
					<th class="py-2 pr-3 text-right font-medium">Shares</th>
					<th class="py-2 pr-3 text-right font-medium">Fully diluted</th>
					<th class="py-2 text-right font-medium">Paid</th>
				</tr>
			</thead>
			<tbody>
				{#each sorted as e (e.id)}
					<tr class="border-b border-line align-top">
						<td class="py-2 pr-3">
							<span class="font-medium">{e.holderName}</span>
							<span class="block text-caption text-ink-3">{SECURITY[e.security]}{e.security === 'options_granted' ? ` · granted ${shortDate(e.asOf)} ${e.asOf.slice(0, 4)}` : ''}</span>
						</td>
						<td class="num py-2 pr-3 text-right">{converting(e) ? '–' : e.shares.toLocaleString('en-US')}</td>
						<td class="num py-2 pr-3 text-right">{converting(e) ? 'Converts later' : formatPpm(fullyDilutedPpm(e.shares, total))}</td>
						<td class="num py-2 text-right">{toBig(e.investedMinor) > 0n ? money(e.investedMinor) : '–'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

{#if projection && 'error' in projection}
	<div class="mt-10"><Notice tone="warn" title="After the {projection.next.name}">Luyten can't project this round: {projection.error}</Notice></div>
{:else if projection}
	{@const p = projection}
	<section aria-labelledby="after-h" class="mt-10 flex flex-col gap-3">
		<div class="flex flex-col gap-1">
			<h2 id="after-h" class="text-title">After the {p.next.name}</h2>
			<p class="max-w-prose text-body-sm text-ink-2">
				The term sheet's {money(p.next.targetMinor)} at a {money(p.next.preMoneyMinor ?? '0')} pre-money, closing {shortDate(p.closeAt)}. The pre-money includes the shares the SAFEs and notes convert into, so the price is {formatPriceE4(p.plan.roundPriceE4)} a share. Each SAFE and note converts at the lower of its cap price and its discounted price.{p.waiting ? ` ${p.waiting} of them ${p.waiting === 1 ? 'is' : 'are'} still waiting for money and ${p.waiting === 1 ? 'is' : 'are'} assumed to arrive.` : ''}
			</p>
		</div>

		{#if p.plan.rows.length}
			<div class="overflow-x-auto">
				<table class="w-full text-body-sm">
					<thead class="text-left text-caption text-ink-3">
						<tr class="border-b border-line">
							<th class="py-2 pr-3 font-medium">Converting</th>
							<th class="py-2 pr-3 text-right font-medium">Amount</th>
							<th class="py-2 pr-3 text-right font-medium">Price</th>
							<th class="py-2 text-right font-medium">Shares</th>
						</tr>
					</thead>
					<tbody>
						{#each p.plan.rows as r (r.id)}
							<tr class="border-b border-line align-top">
								<td class="py-2 pr-3">
									<span class="font-medium">{r.holderName}</span>
									<span class="block text-caption text-ink-3">{r.basis === 'cap' ? 'At the cap' : r.basis === 'discount' ? 'At the discount' : 'At the round price'}</span>
								</td>
								<td class="num py-2 pr-3 text-right">{formatMoney(r.amountMinor.toString(), { whole: r.amountMinor % 100n === 0n })}</td>
								<td class="num py-2 pr-3 text-right">{formatPriceE4(r.priceE4)}</td>
								<td class="num py-2 text-right">{r.shares.toLocaleString('en-US')}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<div class="overflow-x-auto">
			<table class="w-full text-body-sm">
				<thead class="text-left text-caption text-ink-3">
					<tr class="border-b border-line">
						<th class="py-2 pr-3 font-medium">Holder</th>
						<th class="py-2 pr-3 text-right font-medium">Today</th>
						<th class="py-2 text-right font-medium">After</th>
					</tr>
				</thead>
				<tbody>
					{#each p.rows as h (h.name)}
						<tr class="border-b border-line">
							<td class="py-2 pr-3 font-medium">{h.name}</td>
							<td class="num py-2 pr-3 text-right text-ink-2">{h.today > 0n ? formatPpm(fullyDilutedPpm(h.today, total)) : '–'}</td>
							<td class="num py-2 text-right">{formatPpm(fullyDilutedPpm(h.after, p.afterTotal))}</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<td class="py-2 pr-3 text-caption text-ink-3">Fully diluted shares</td>
						<td class="num py-2 pr-3 text-right text-caption text-ink-3">{total.toLocaleString('en-US')}</td>
						<td class="num py-2 text-right text-caption text-ink-3">{p.afterTotal.toLocaleString('en-US')}</td>
					</tr>
				</tfoot>
			</table>
		</div>
		<p class="max-w-prose text-caption text-ink-3">A projection, not the books. It leaves out the option pool top-up the term sheet asks for until a person agrees its size.</p>
	</section>
{/if}
