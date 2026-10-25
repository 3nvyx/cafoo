<script lang="ts">
	// The bank lines that match nothing in the books through this Period, and the CFO's explicit decision to lock
	// with them open. Accepting never matches them: the lines stay unmatched and the reconciliation task stays open,
	// and any later bank or ledger change voids the acceptance (the ledger module re-checks the exact snapshot).
	import { db } from '#lib/data/index.js';
	import { lockGate } from '#lib/close.js';
	import { periodLabel, ymShort } from '#lib/data/derive.js';
	import { formatMoney, sumMinor, toBig } from '#lib/data/money.js';
	import { dateTime, shortDate } from '#lib/labels.js';
	import { attempt } from '#lib/toast.svelte.js';
	import { tick } from 'svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Notice from './Notice.svelte';
	import Pill from './Pill.svelte';

	let { periodId }: { periodId: string } = $props();

	const gate = $derived(lockGate(db, periodId));
	const period = $derived(gate.period);
	const ex = $derived(gate.bankExceptions);
	const rows = $derived([...ex.rows].sort((a, b) => a.ym.localeCompare(b.ym) || a.bookedAt.localeCompare(b.bookedAt) || a.id.localeCompare(b.id)));
	const n = $derived(rows.length);
	const lines = $derived(`${n} unmatched bank line${n === 1 ? '' : 's'}`);
	const closed = $derived(period?.status === 'closed');
	const acceptance = $derived(ex.acceptance);
	const label = $derived(period ? periodLabel(period) : '');
	const seatIsYou = $derived(db.cfoSeat().status === 'you');

	const companies = $derived(db.subsidiaries());
	const companyName = $derived(new Map(companies.map((s) => [s.id, s.name])));
	const showCompany = $derived(companies.length > 1);

	// Money in and out, per currency: the group can hold accounts in more than one.
	const totals = $derived.by(() => {
		const by = new Map<string, { inN: number; inSum: string[]; outN: number; outSum: string[] }>();
		for (const r of rows) {
			const t = by.get(r.ccy) ?? { inN: 0, inSum: [], outN: 0, outSum: [] };
			if (toBig(r.amountMinor) < 0n) {
				t.outN++;
				t.outSum.push(r.amountMinor);
			} else {
				t.inN++;
				t.inSum.push(r.amountMinor);
			}
			by.set(r.ccy, t);
		}
		// Money out is shown as a positive figure next to the word "out".
		return [...by].map(([ccy, t]) => ({ ccy, inN: t.inN, inSum: sumMinor(t.inSum), outN: t.outN, outSum: sumMinor(t.outSum).replace(/^-/, '') }));
	});
	const totalsText = $derived(
		totals
			.flatMap((t) => [t.inN ? `${t.inN} in ${formatMoney(t.inSum, { currency: t.ccy })}` : '', t.outN ? `${t.outN} out ${formatMoney(t.outSum, { currency: t.ccy })}` : ''])
			.filter(Boolean)
			.join(', ')
	);

	// Earlier months show under their own heading, marked as carried forward.
	const groups = $derived.by(() => {
		const by = new Map<string, typeof rows>();
		for (const r of rows) by.set(r.ym, [...(by.get(r.ym) ?? []), r]);
		return [...by].map(([ym, items]) => ({ ym, items }));
	});

	// The latest acceptance for this month in the audit log when it no longer matches the live lines: its reason is
	// shown so the CFO can tell whether it still holds.
	const voided = $derived.by(() => {
		if (acceptance.accepted) return undefined;
		const events = db
			.auditEvents()
			.filter((e) => e.action === 'accept_bank_exceptions' && e.actorRole === 'cfo')
			.map((e) => {
				try {
					const d = JSON.parse(e.detailJson) as { periodYm?: unknown; reasonPlain?: unknown };
					return d.periodYm === periodId ? { at: e.at, reason: typeof d.reasonPlain === 'string' ? d.reasonPlain : '' } : undefined;
				} catch {
					return e.detailJson.includes(`"periodYm":"${periodId}"`) ? { at: e.at, reason: '' } : undefined;
				}
			})
			.filter((e): e is { at: string; reason: string } => !!e)
			.sort((a, b) => b.at.localeCompare(a.at));
		return events[0];
	});

	// The bank feed writes "Unknown" when it cannot name the other side; the description says more then.
	const main = (r: (typeof rows)[number]) => {
		const who = r.counterparty.trim();
		return (who && !/^unknown$/i.test(who) ? who : '') || r.description.trim() || who || 'Bank line';
	};
	function detail(r: (typeof rows)[number]): string {
		const bits = [shortDate(r.bookedAt)];
		if (r.description.trim() && r.description.trim() !== main(r)) bits.push(r.description.trim());
		if (showCompany) bits.push(companyName.get(r.subsidiaryId) ?? r.subsidiaryId);
		return bits.join(' · ');
	}

	let dialogOpen = $state(false);
	let reviewedSnapshot = $state('');

	function review() {
		reviewedSnapshot = ex.snapshot;
		dialogOpen = true;
	}

	// The CFO accepts the exact lines they reviewed. If the lines change underneath the open dialog, it stays open
	// with the typed reason but cannot confirm: the module would refuse the old snapshot anyway.
	const stale = $derived(dialogOpen && !!reviewedSnapshot && ex.snapshot !== reviewedSnapshot);

	async function accept(reason: string) {
		const ok = await attempt(() => db.acceptBankExceptions(periodId, reviewedSnapshot, reason), 'Bank exceptions accepted. They stay unmatched.');
		if (!ok) return;
		// The button that had focus disappears with the acceptance; keep focus in the card.
		await tick();
		document.getElementById('bank-exceptions-h')?.focus();
	}
</script>

{#if period && n}
	<section id="bank-exceptions" class="card scroll-mt-24 p-5" aria-labelledby="bank-exceptions-h">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<p class="eyebrow">Bank reconciliation</p>
			{#if closed}
				<Pill tone="neutral">Locked with exceptions</Pill>
			{:else if acceptance.accepted}
				<!-- Not pos: accepting records a decision; the lines are still unmatched. -->
				<Pill tone="neutral">Accepted by the CFO</Pill>
			{:else}
				<Pill tone="warn">Needs your decision</Pill>
			{/if}
		</div>
		<h2 id="bank-exceptions-h" class="mt-1 text-title outline-none" tabindex="-1">{lines}</h2>
		<p class="mt-1 text-body-sm text-ink-2">
			{n === 1 ? 'This line' : 'These lines'} came in from the bank but match nothing in the books yet, including any carried forward from earlier months.
		</p>

		<dl class="num mt-4 flex flex-wrap gap-x-6 gap-y-1 text-body-sm text-ink-2">
			{#each totals as t (t.ccy)}
				{#if t.inN}
					<div class="flex gap-1.5">
						<dt>{t.inN} in</dt>
						<dd class="text-ink">{formatMoney(t.inSum, { currency: t.ccy })}</dd>
					</div>
				{/if}
				{#if t.outN}
					<div class="flex gap-1.5">
						<dt>{t.outN} out</dt>
						<dd class="text-ink">{formatMoney(t.outSum, { currency: t.ccy })}</dd>
					</div>
				{/if}
			{/each}
		</dl>

		<div class="mt-4 border-t border-line">
			{#each groups as g (g.ym)}
				{#if groups.length > 1}
					<h3 class="pt-4 pb-1 text-caption font-medium text-ink-3">
						{ymShort(g.ym)}{g.ym < periodId ? ' · carried forward' : ''}
					</h3>
				{/if}
				<ul class="flex flex-col divide-y divide-line" aria-label={groups.length > 1 ? `Unmatched bank lines, ${ymShort(g.ym)}` : 'Unmatched bank lines'}>
					{#each g.items as r (r.id)}
						<li class="flex items-start justify-between gap-4 py-3">
							<div class="min-w-0">
								<p class="text-body-sm font-medium break-words">{main(r)}</p>
								<p class="mt-0.5 text-caption break-words text-ink-3">{detail(r)}</p>
							</div>
							<span class="num shrink-0 text-body-sm {toBig(r.amountMinor) < 0n ? 'text-neg' : 'text-ink'}">
								{formatMoney(r.amountMinor, { currency: r.ccy })}
							</span>
						</li>
					{/each}
				</ul>
			{/each}
		</div>

		<div class="mt-4 flex flex-col gap-3 border-t border-line pt-4">
			{#if acceptance.accepted}
				<Notice tone="info">
					The CFO accepted this exact set on {dateTime(acceptance.at)}. Reason: “{acceptance.reasonPlain}”. The lines stay unmatched and the reconciliation task stays open.
				</Notice>
			{/if}
			{#if closed}
				<p class="text-body-sm text-ink-2">
					{label} locked with {n === 1 ? 'this line' : 'these lines'} unmatched. Unlocking the month lets {n === 1 ? 'it' : 'them'} be matched.
				</p>
			{:else if !acceptance.accepted}
				{#if voided}
					<Notice tone="warn" title="The earlier acceptance no longer applies">
						The bank or ledger evidence changed after the CFO accepted on {dateTime(voided.at)}{voided.reason ? ` (“${voided.reason}”)` : ''}, so these lines need a fresh review.
					</Notice>
				{/if}
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
					<button class="btn btn-primary w-full sm:w-auto" disabled={!seatIsYou} aria-describedby={seatIsYou ? undefined : 'bank-exceptions-seat'} onclick={review}>
						Accept {n === 1 ? 'this line' : `these ${n} lines`}
					</button>
					{#if seatIsYou}
						<p class="text-caption text-ink-3">Your reason goes in the audit log. The {n === 1 ? 'line stays' : 'lines stay'} unmatched.</p>
					{:else}
						<p id="bank-exceptions-seat" class="text-caption text-ink-3">Only the CFO's browser can accept bank exceptions.</p>
					{/if}
				</div>
			{/if}
		</div>
	</section>

	<ConfirmDialog
		bind:open={dialogOpen}
		title="Accept {lines}?"
		body="That is {totalsText}. {n === 1 ? 'The line stays' : 'The lines stay'} unmatched and the reconciliation task stays open, so {label} can lock with {n === 1 ? 'it' : 'them'} on record. Any later bank or ledger change needs a fresh acceptance. Your reason is kept in the audit log."
		confirmLabel="Accept {n === 1 ? 'the line' : `${n} lines`}"
		inputLabel="Why can {label} close with {n === 1 ? 'this line' : 'these lines'} open?"
		inputPlaceholder="e.g. Remittance details are still pending"
		inputRequired
		notice={stale ? 'The bank lines changed while you were reviewing them. Cancel, look at the current lines, and accept again.' : undefined}
		blocked={stale}
		onconfirm={accept}
	/>
{/if}
