<script lang="ts">
	// Shortcuts to the jobs a CFO comes back to, each with its live state so the card says whether it needs a visit.
	// Closing the month, the approval queue and the metrics have their own sections above, so they are not repeated here;
	// cards that need the CFO come first.
	import { db } from '#lib/data/index.js';
	import { monthName } from '#lib/data/derive.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { Period } from '#lib/data/types.js';
	import Icon, { type IconName } from '#lib/components/Icon.svelte';
	import { shortDate } from '#lib/labels.js';
	import { usdRate } from '#lib/kpis.js';

	let { period }: { period: Period } = $props();

	const money = (m: bigint | string) => formatMoney(m.toString(), { whole: true, compact: true });
	const mon = $derived(monthName(period.month));
	const today = $derived(db.now().slice(0, 10));

	const unmatched = $derived(db.bankTransactions().filter((b) => !b.matched).length);

	const round = $derived(db.fundingRounds().find((r) => r.status === 'open'));
	// Commitments can be in pounds (an investor wiring into Cafoo Ltd); convert each to dollars before adding them up.
	const toUsd = $derived(usdRate(db.fxRates()));
	const raised = $derived(
		round ? db.commitments().filter((c) => c.roundId === round.id).reduce((t, c) => t + (toBig(c.receivedMinor) * toUsd(c.ccy, today.slice(0, 7))) / 1_000_000n, 0n) : 0n
	);
	const shortWires = $derived(round ? db.commitments().filter((c) => c.roundId === round.id && (c.status === 'short' || c.status === 'overdue')).length : 0);

	const nextRun = $derived(
		db
			.payRuns()
			.filter((r) => r.status !== 'paid' && r.payDate.slice(0, 10) >= today)
			.sort((a, b) => a.payDate.localeCompare(b.payDate))[0]
	);
	const timeOff = $derived(db.ptoRequests().filter((r) => r.status === 'pending').length);

	const thisMonth = $derived(today.slice(0, 7));
	const spend = $derived(db.cloudCosts().filter((c) => c.ym === thisMonth).reduce((t, c) => t + toBig(c.amountMinor), 0n));
	const in30 = $derived.by(() => {
		const d = new Date(`${today}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() + 30);
		return d.toISOString().slice(0, 10);
	});
	const expiring = $derived(db.batches().filter((b) => b.status !== 'expired' && b.status !== 'depleted' && b.expiresAt && b.expiresAt.slice(0, 10) <= in30).length);

	const tickets = $derived(db.supportTickets().filter((t) => t.status === 'new' || t.status === 'open').length);
	const newTickets = $derived(db.supportTickets().filter((t) => t.status === 'new').length);
	const pipeline = $derived(
		db
			.deals()
			.filter((d) => d.stage !== 'won' && d.stage !== 'lost')
			.reduce((t, d) => t + (toBig(d.amountMinor) * BigInt(d.probabilityBp)) / 10000n, 0n)
	);

	const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

	interface Card {
		title: string;
		icon: IconName;
		href: string;
		status: string;
		/** Something here waits on the CFO. */
		needsYou?: boolean;
	}

	const all = $derived<Card[]>([
		{ title: 'Bank and ledger', icon: 'book', href: '/ledger', status: unmatched ? `${plural(unmatched, 'bank line')} not matched yet · upload a statement` : 'Every bank line matched · upload a statement', needsYou: unmatched > 0 },
		{
			title: 'Fundraising',
			icon: 'coins',
			href: '/financing',
			status: round ? `${round.name}: ${money(raised)} of ${money(round.targetMinor)} received${shortWires ? ` · ${plural(shortWires, 'wire')} to chase` : ''}` : 'No round open · upload a SAFE or term sheet',
			needsYou: shortWires > 0
		},
		{
			title: 'Payroll and time off',
			icon: 'person',
			href: '/people',
			status: `${nextRun ? `Next pay ${shortDate(nextRun.payDate)}, ${money(nextRun.netMinor)} net` : 'No pay run scheduled'}${timeOff ? ` · ${plural(timeOff, 'time-off request')} to decide` : ''}`,
			needsYou: timeOff > 0
		},
		{ title: 'Cost of service', icon: 'cloud', href: '/costs', status: spend ? `${money(spend)} of cloud and model spend so far this month` : 'Cloud, model and engineering cost by product' },
		{ title: 'Credits and stock', icon: 'box', href: '/batches', status: expiring ? `${plural(expiring, 'batch', 'batches')} expire in the next 30 days` : 'Nothing expires in the next 30 days', needsYou: expiring > 0 },
		{
			title: 'Customers and support',
			icon: 'users',
			href: '/customers',
			status: `${plural(tickets, 'open ticket')}${newTickets ? `, ${newTickets} unanswered` : ''} · ${money(pipeline)} weighted pipeline`,
			needsYou: newTickets > 0
		},
		{ title: 'Board Pack', icon: 'chart', href: '/reports', status: period.status === 'closed' ? `${mon} is final` : `Final once ${mon} is locked` },
		{ title: 'Agent rules', icon: 'shield', href: '/charters', status: 'What each agent may and may not do' }
	]);
	const cards = $derived([...all.filter((c) => c.needsYou), ...all.filter((c) => !c.needsYou)]);
</script>

<section aria-labelledby="workflows-h" class="mt-12">
	<h2 id="workflows-h" class="pb-4 text-title">Workflows</h2>
	<ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
		{#each cards as c (c.href)}
			<li>
				<a href={c.href} class="group card flex h-full gap-3 p-4 transition-colors hover:bg-subtle">
					<span class="grid size-10 shrink-0 place-items-center rounded-md bg-subtle text-ink-2 group-hover:text-ink"><Icon name={c.icon} size={20} /></span>
					<span class="flex min-w-0 flex-col gap-1">
						<span class="flex flex-wrap items-center gap-2">
							<span class="font-medium text-ink">{c.title}</span>
							{#if c.needsYou}<span class="rounded-sm bg-warn-soft px-1.5 py-0.5 text-caption font-medium text-on-warn-soft">Needs you</span>{/if}
						</span>
						<span class="text-body-sm text-ink-2">{c.status}</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</section>
