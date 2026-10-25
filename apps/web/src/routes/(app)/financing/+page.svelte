<script lang="ts">
	// Fundraising: each round's closing tracker, the instrument register and the cap table, tied to the ledger. Raising
	// money is not income: SAFEs and notes are liabilities until they convert, shares are equity.
	import { db } from '#lib/data/index.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import type { Commitment, Instrument, InvestorKind } from '#lib/data/types.js';
	import { formatPriceE4 } from '#lib/financing.js';
	import Integrations from '#lib/components/Integrations.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import UploadDemo from '#lib/components/UploadDemo.svelte';
	import { KIND, STATUS, shortDate, type Tone } from '#lib/labels.js';
	import CapTable from './CapTable.svelte';
	import CapTableTools from './CapTableTools.svelte';
	import { rootOf } from '#lib/data/group.js';

	/** The company whose round and cap table these are: the books' root company. */
	const company = $derived(rootOf(db.subsidiaries())?.name ?? 'The company');

	const COMMITMENT: Record<Commitment['status'], { label: string; tone: Tone }> = {
		committed: { label: 'Committed', tone: 'muted' },
		signed: { label: 'Signed', tone: 'neutral' },
		funded: { label: 'Received', tone: 'pos' },
		short: { label: 'Short', tone: 'warn' },
		overdue: { label: 'Overdue', tone: 'neg' },
		withdrawn: { label: 'Withdrawn', tone: 'muted' }
	};
	const INSTRUMENT_STATUS: Record<Instrument['status'], { label: string; tone: Tone }> = {
		draft: { label: 'Awaiting money', tone: 'muted' },
		outstanding: { label: 'Outstanding', tone: 'neutral' },
		converted: { label: 'Converted', tone: 'pos' },
		repaid: { label: 'Repaid', tone: 'muted' },
		cancelled: { label: 'Cancelled', tone: 'muted' }
	};
	const INSTRUMENT_KIND: Record<Instrument['kind'], string> = {
		safe_post_money: 'Post-money SAFE',
		safe_pre_money: 'Pre-money SAFE',
		convertible_note: 'Convertible note',
		preferred_shares: 'Preferred shares',
		common_shares: 'Common shares',
		warrant: 'Warrant'
	};
	const CLASS: Record<Instrument['classification'], string> = { liability: 'Liability', equity: 'Equity', temporary_equity: 'Temporary equity' };
	const INVESTOR_KIND: Record<InvestorKind, string> = { fund: 'Fund', angel: 'Angels', spv: 'SPV', family_office: 'Family office', corporate: 'Corporate', accelerator: 'Accelerator' };
	const FINANCING_KINDS = ['funding_receipt', 'instrument_record', 'interest_accrual', 'instrument_conversion'];

	const money = (minor: bigint | string, ccy = 'USD') => formatMoney(minor.toString(), { whole: true, currency: ccy });
	const pctBp = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;

	// Rounds: the open one first, then planned, then closed.
	const ORDER = { open: 0, planned: 1, closed: 2 } as const;
	const rounds = $derived([...db.fundingRounds()].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.openedAt.localeCompare(a.openedAt)));
	let picked = $state<string | null>(null);
	const round = $derived(rounds.find((r) => r.id === picked) ?? rounds[0]);
	const investors = $derived(new Map(db.investors().map((i) => [i.id, i])));
	const investorName = (id: string) => investors.get(id)?.name ?? id;

	// Pounds to dollars at the open month's closing rate.
	const openYm = $derived(db.periods().find((p) => p.status !== 'closed')?.id ?? db.now().slice(0, 7));
	const gbpUsdE6 = $derived(
		toBig((db.fxRates().find((r) => r.fromCcy === 'GBP' && r.toCcy === 'USD' && r.ym === openYm && r.kind === 'closing') ?? db.fxRates().findLast((r) => r.fromCcy === 'GBP' && r.toCcy === 'USD'))?.rateE6 ?? '1000000')
	);
	const usd = (minor: string, ccy: string) => (ccy === 'GBP' ? (toBig(minor) * gbpUsdE6) / 1_000_000n : toBig(minor));

	const commitments = $derived(db.commitments().filter((c) => c.roundId === round?.id));
	const live = $derived(commitments.filter((c) => c.status !== 'withdrawn'));
	const committed = $derived(live.reduce((t, c) => t + usd(c.amountMinor, c.ccy), 0n));
	const received = $derived(live.reduce((t, c) => t + usd(c.receivedMinor, c.ccy), 0n));
	const outstanding = $derived(committed - received);
	const target = $derived(toBig(round?.targetMinor));
	const receivedPct = $derived(target > 0n ? Number((received * 1000n) / target) / 10 : 0);
	const committedPct = $derived(target > 0n ? Number((committed * 1000n) / target) / 10 : 0);
	const needsLook = $derived(live.filter((c) => c.status === 'short' || c.status === 'overdue').length);

	const instruments = $derived(db.instruments().filter((i) => i.roundId === round?.id));

	// The latest valuation report's fair values. Luyten never estimates them itself.
	const valuation = $derived.by(() => {
		const d = db.documents().findLast((x) => x.kind === 'valuation_report' && x.status !== 'rejected' && x.status !== 'parsing');
		if (!d) return null;
		try {
			const j = JSON.parse(d.extractedJson) as { asOf?: string; safeFairValueBp?: number; commonFairValuePerShareE4?: string; preparer?: string };
			return j.safeFairValueBp ? j : null;
		} catch {
			return null;
		}
	});

	// Tied to the ledger: Cafoo Inc's balances on the financing accounts against the register and the cap table.
	const balances = $derived.by(() => {
		const byId = new Map(db.accounts().map((a) => [a.id, a.code]));
		const out = new Map<string, bigint>();
		for (const l of db.journalLines()) {
			const code = byId.get(l.accountId);
			if (code) out.set(code, (out.get(code) ?? 0n) + toBig(l.creditMinor) - toBig(l.debitMinor));
		}
		return out;
	});
	const bal = (code: string) => balances.get(code) ?? 0n;
	const allInstruments = $derived(db.instruments());
	const principalOf = (pred: (i: Instrument) => boolean) => allInstruments.filter((i) => i.status === 'outstanding' && pred(i)).reduce((t, i) => t + toBig(i.principalMinor), 0n);
	const ties = $derived.by(() => {
		const safes = principalOf((i) => i.kind === 'safe_post_money' || i.kind === 'safe_pre_money');
		const notes = principalOf((i) => i.kind === 'convertible_note');
		const equityCap = db
			.capTable()
			.filter((e) => e.security === 'common' || e.security === 'preferred')
			.reduce((t, e) => t + usd(e.investedMinor, e.ccy), 0n);
		const equityBooks = bal('3000') + bal('3200') + bal('3300') + bal('3310');
		const shortBy = db.commitments().reduce((t, c) => (c.status === 'short' ? t + usd(c.amountMinor, c.ccy) - usd(c.receivedMinor, c.ccy) : t), 0n);
		return [
			{ label: 'SAFEs', register: safes, books: bal('2600'), account: '2600', why: 'The books carry SAFEs at fair value from the valuation report; the register shows what was paid.' },
			{ label: 'Convertible notes', register: notes, books: bal('2650'), account: '2650', why: 'Notes are carried at what was lent.' },
			{ label: 'Interest owed on notes', register: null, books: bal('2660'), account: '2660', why: 'Booked monthly as an expense; paid or converted at the end.' },
			{ label: 'Shares, at what was paid', register: equityCap, books: equityBooks, account: '3000–3310', why: 'Interest, fair-value changes and issuance costs move into equity when SAFEs and notes convert, so the books differ from cash paid by those amounts.' },
			{ label: 'Still owed by investors', register: shortBy, books: -bal('1060'), account: '1060', why: 'Investors who sent less than they signed for, usually a bank fee.' }
		];
	});

	// Every round in order, oldest first, with what arrived and the instruments it used.
	const timeline = $derived(
		[...db.fundingRounds()]
			.sort((a, b) => a.openedAt.localeCompare(b.openedAt))
			.map((r) => {
				const cs = db.commitments().filter((c) => c.roundId === r.id && c.status !== 'withdrawn');
				const kinds = [...new Set(db.instruments().filter((i) => i.roundId === r.id).map((i) => INSTRUMENT_KIND[i.kind]))];
				return {
					r,
					received: cs.reduce((t, c) => t + usd(c.receivedMinor, c.ccy), 0n),
					investorCount: new Set(cs.map((c) => c.investorId)).size,
					kinds,
					postMinor: r.preMoneyMinor ? toBig(r.preMoneyMinor) + toBig(r.targetMinor) : null
				};
			})
	);

	// Investors across every round: what each committed and what arrived.
	const investorTotals = $derived.by(() => {
		const out = new Map<string, { id: string; committed: bigint; received: bigint; rounds: string[] }>();
		for (const c of db.commitments()) {
			if (c.status === 'withdrawn') continue;
			const t = out.get(c.investorId) ?? { id: c.investorId, committed: 0n, received: 0n, rounds: [] };
			t.committed += usd(c.amountMinor, c.ccy);
			t.received += usd(c.receivedMinor, c.ccy);
			if (!t.rounds.includes(c.roundId)) t.rounds.push(c.roundId);
			out.set(c.investorId, t);
		}
		return [...out.values()].sort((a, b) => (b.committed > a.committed ? 1 : b.committed < a.committed ? -1 : 0));
	});
	const roundName = (id: string) => db.fundingRounds().find((r) => r.id === id)?.name ?? id;

	const proposals = $derived(
		db
			.proposals()
			.filter((p) => FINANCING_KINDS.includes(p.kind) || p.proposerRole === 'capital' || p.proposerRole === 'funding')
			.slice(-6)
			.reverse()
	);
</script>

<svelte:head><title>Financing · Luyten</title></svelte:head>

<header class="flex flex-col gap-1 pb-6">
	<p class="text-body-sm text-ink-2">{company} · Funding desk and Capital accountant</p>
	<h1 class="text-display">Financing</h1>
	<p class="max-w-prose text-body-sm text-ink-2">Each round's money matched to its investors, every SAFE and note with how it sits in the books, and who owns the company.</p>
</header>

<Notice title="Raising money is not income">
	Money from investors never shows up as revenue or profit. SAFEs and notes are money we may owe back, in shares or cash, so
	they sit with liabilities; shares sold sit in equity. Only interest on notes, changes in a SAFE's fair value and the cost of
	issuing SAFEs reach the profit and loss.
</Notice>

{#if timeline.length === 0}
	<div class="card mt-6 flex flex-col gap-1 p-5">
		<p class="font-medium">No rounds yet</p>
		<p class="max-w-prose text-body-sm text-ink-2">Upload a term sheet, SAFE or closing tracker below and the Funding desk builds the round, its investors and the instrument register from it.</p>
	</div>
{:else}
	<section aria-labelledby="timeline-h" class="mt-6 flex flex-col gap-3">
		<h2 id="timeline-h" class="text-title">Rounds</h2>
		<ol class="flex flex-col border-l border-line">
			{#each timeline as t (t.r.id)}
				<li class="relative flex flex-col gap-1 py-2 pl-5">
					<span class="absolute top-4 -left-1 h-2 w-2 rounded-full {t.r.status === 'closed' ? 'bg-ink-2' : t.r.status === 'open' ? 'bg-accent' : 'bg-line-strong'}" aria-hidden="true"></span>
					<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<button class="drill font-medium" onclick={() => (picked = t.r.id)}>{t.r.name}</button>
						<span class="text-caption text-ink-3">{shortDate(t.r.closedAt ?? t.r.openedAt)} {(t.r.closedAt ?? t.r.openedAt).slice(0, 4)}</span>
						<Pill tone={t.r.status === 'open' ? 'neutral' : t.r.status === 'closed' ? 'pos' : 'muted'}>{t.r.status === 'open' ? 'Open' : t.r.status === 'closed' ? 'Closed' : 'Planned'}</Pill>
						<span class="ml-auto num text-body-sm">{money(t.received)} <span class="text-ink-3">of {money(t.r.targetMinor, t.r.ccy)}</span></span>
					</div>
					<p class="text-caption text-ink-3">
						{t.kinds.length ? t.kinds.join(', ') : 'No instruments yet'}{t.investorCount ? ` · ${t.investorCount} investor${t.investorCount === 1 ? '' : 's'}` : ''}{t.r.leadInvestorId ? ` · led by ${investorName(t.r.leadInvestorId)}` : ''}{t.r.preMoneyMinor ? ` · ${money(t.r.preMoneyMinor)} pre-money` : ''}{t.postMinor !== null ? `, ${money(t.postMinor)} post` : ''}{t.r.pricePerShareE4 ? ` · ${formatPriceE4(t.r.pricePerShareE4)} a share` : ''}
					</p>
				</li>
			{/each}
		</ol>
	</section>
{/if}

{#if rounds.length > 1}
	<div class="mt-6 flex flex-wrap gap-2" role="group" aria-label="Round">
		{#each rounds as r (r.id)}
			<button class="chip" aria-pressed={round?.id === r.id} onclick={() => (picked = r.id)}>{r.name}</button>
		{/each}
	</div>
{/if}

{#if round}
	<section aria-labelledby="round-h" class="mt-6 flex flex-col gap-4">
		<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<h2 id="round-h" class="text-title">{round.name}</h2>
			<Pill tone={round.status === 'open' ? 'neutral' : round.status === 'closed' ? 'pos' : 'muted'}>{round.status === 'open' ? 'Open' : round.status === 'closed' ? 'Closed' : 'Planned'}</Pill>
			<span class="text-caption text-ink-3">
				{round.closedAt ? `Opened ${shortDate(round.openedAt)}, closed ${shortDate(round.closedAt)}` : `Opened ${shortDate(round.openedAt)}`}{round.leadInvestorId ? ` · led by ${investorName(round.leadInvestorId)}` : ''}{round.pricePerShareE4 ? ` · ${formatPriceE4(round.pricePerShareE4)} a share` : ''}
			</span>
		</div>

		<dl class="grid grid-cols-2 gap-3 lg:grid-cols-4">
			{#each [{ k: 'Target', v: target }, { k: 'Committed', v: committed }, { k: 'Received', v: received }, { k: 'Still to arrive', v: outstanding }] as t (t.k)}
				<div class="card flex flex-col gap-1 p-4">
					<dt class="text-caption text-ink-2">{t.k}</dt>
					<dd class="num text-title">{money(t.v)}</dd>
				</div>
			{/each}
		</dl>
		<div class="flex flex-col gap-2">
			<div class="relative h-2 overflow-hidden rounded-sm bg-subtle" role="img" aria-label="{receivedPct}% of the target received, {committedPct}% committed">
				<div class="absolute inset-y-0 left-0 bg-line-strong" style="width: {Math.min(100, committedPct)}%"></div>
				<div class="absolute inset-y-0 left-0 bg-ink-2" style="width: {Math.min(100, receivedPct)}%"></div>
			</div>
			<p class="text-caption text-ink-3">
				{receivedPct}% of the target has arrived and {committedPct}% is committed.{gbpUsdE6 !== 1_000_000n && live.some((c) => c.ccy === 'GBP') ? ` Pounds counted at ${(Number(gbpUsdE6) / 1e6).toFixed(4)} dollars.` : ''}
			</p>
		</div>
	</section>

	<section aria-labelledby="tracker-h" class="mt-10 flex flex-col gap-3">
		<div class="flex flex-col gap-1">
			<h2 id="tracker-h" class="text-title">Closing tracker</h2>
			<p class="max-w-prose text-body-sm text-ink-2">
				Who signed up and what has arrived. The Funding desk matches each wire to its investor, even when it comes from a fund's bank or an SPV under another name.{needsLook ? ` ${needsLook} need${needsLook === 1 ? 's' : ''} a look.` : ''}
			</p>
		</div>
		<ul class="border-t border-line">
			{#each commitments as c (c.id)}
				{@const investor = investors.get(c.investorId)}
				{@const ins = c.instrumentId ? db.instruments().find((i) => i.id === c.instrumentId) : undefined}
				<li class="flex flex-col gap-1 border-b border-line py-3">
					<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span class="font-medium">{investor?.name ?? c.investorId}</span>
						<Pill tone={COMMITMENT[c.status].tone}>{COMMITMENT[c.status].label}</Pill>
						<span class="ml-auto num text-body">{money(c.receivedMinor, c.ccy)} <span class="text-ink-3">of {money(c.amountMinor, c.ccy)}</span></span>
					</div>
					<p class="text-caption text-ink-3">
						{investor ? INVESTOR_KIND[investor.kind] : ''}{investor?.country ? ` · ${investor.country}` : ''}{ins ? ` · ${INSTRUMENT_KIND[ins.kind]}` : ''}{c.expectedBy && c.status !== 'funded' ? ` · due ${shortDate(c.expectedBy)}` : ''}{investor && investor.payerNames.length ? ` · pays as ${investor.payerNames.join(', ')}` : ''}
					</p>
					{#if c.notePlain}<p class="text-body-sm {c.status === 'short' || c.status === 'overdue' ? 'text-ink' : 'text-ink-2'}">{c.notePlain}</p>{/if}
				</li>
			{:else}
				<li class="border-b border-line py-3 text-body-sm text-ink-3">No commitments in this round yet.</li>
			{/each}
		</ul>
	</section>

	<section aria-labelledby="register-h" class="mt-10 flex flex-col gap-3">
		<div class="flex flex-col gap-1">
			<h2 id="register-h" class="text-title">Instrument register</h2>
			<p class="max-w-prose text-body-sm text-ink-2">
				Every SAFE, note and share issue in {round.name}, as the Capital accountant read it from the signed documents, with the reason it sits where it does.
				{#if valuation}
					Fair values come from {valuation.preparer ?? 'the valuation report'}{valuation.asOf ? ` as of ${shortDate(valuation.asOf)}` : ''}: SAFEs at {pctBp(valuation.safeFairValueBp ?? 0)} of what was paid{valuation.commonFairValuePerShareE4 ? `, common stock at ${formatPriceE4(valuation.commonFairValuePerShareE4)} a share` : ''}.
				{:else}
					Luyten never estimates fair values; they come from an uploaded valuation report.
				{/if}
			</p>
		</div>
		<ul class="border-t border-line">
			{#each instruments as i (i.id)}
				{@const terms = [
					i.valuationCapMinor ? `${money(i.valuationCapMinor)} cap` : '',
					i.discountBp ? `${pctBp(i.discountBp)} discount` : '',
					i.interestBp ? `${pctBp(i.interestBp)} a year` : '',
					i.maturityAt ? `matures ${shortDate(i.maturityAt)} ${i.maturityAt.slice(0, 4)}` : '',
					i.mfn ? 'most-favoured-nation' : '',
					i.proRata ? 'pro rata' : '',
					i.shares ? `${i.shares.toLocaleString('en-US')} shares` : ''
				].filter(Boolean)}
				<li class="flex flex-col gap-1 border-b border-line py-3">
					<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span class="font-medium">{investorName(i.investorId)}</span>
						<span class="text-body-sm text-ink-2">{INSTRUMENT_KIND[i.kind]}</span>
						<Pill tone="muted">{CLASS[i.classification]}</Pill>
						<Pill tone={INSTRUMENT_STATUS[i.status].tone}>{INSTRUMENT_STATUS[i.status].label}</Pill>
						<span class="ml-auto num text-body">{money(i.principalMinor, i.ccy)}</span>
					</div>
					{#if terms.length}<p class="text-caption text-ink-3">{terms.join(' · ')}{i.signedAt ? ` · signed ${shortDate(i.signedAt)} ${i.signedAt.slice(0, 4)}` : ' · not signed yet'}{i.documentIds.length ? ` · ${i.documentIds.length} document${i.documentIds.length === 1 ? '' : 's'}` : ''}</p>{/if}
					<p class="max-w-prose text-body-sm text-ink-2">{i.classificationPlain}</p>
					{#if i.sideTermsPlain}<p class="max-w-prose text-body-sm text-ink-2"><span class="font-medium text-ink">Extra terms:</span> {i.sideTermsPlain}</p>{/if}
				</li>
			{:else}
				<li class="border-b border-line py-3 text-body-sm text-ink-3">No instruments in this round yet.</li>
			{/each}
		</ul>
	</section>
{/if}

<section aria-labelledby="tie-h" class="mt-10 flex flex-col gap-3">
	<div class="flex flex-col gap-1">
		<h2 id="tie-h" class="text-title">Tied to the ledger</h2>
		<p class="max-w-prose text-body-sm text-ink-2">The register and cap table next to {company}'s books, every round together. A difference always has a reason.</p>
	</div>
	<ul class="border-t border-line">
		{#each ties as t (t.label)}
			{@const diff = t.register === null ? 0n : t.books - t.register}
			<li class="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-line py-3 sm:grid-cols-4 sm:items-baseline">
				<span class="col-span-2 font-medium sm:col-span-1">{t.label} <span class="text-caption font-normal text-ink-3">{t.account}</span></span>
				<span class="text-body-sm text-ink-2 sm:text-right">Register <span class="num text-ink">{t.register === null ? '–' : money(t.register)}</span></span>
				<span class="text-right text-body-sm text-ink-2">Books <span class="num text-ink">{money(t.books)}</span></span>
				<span class="col-span-2 sm:col-span-1 sm:text-right">
					{#if t.register === null}<Pill tone="muted">Books only</Pill>{:else if diff === 0n}<Pill tone="pos">Ties</Pill>{:else}<Pill tone="warn">Differs by {formatMoney(diff.toString(), { whole: true, signed: true })}</Pill>{/if}
				</span>
				{#if t.register !== null && diff !== 0n}<p class="col-span-2 max-w-prose text-body-sm text-ink-2 sm:col-span-4">{t.why}</p>{/if}
			</li>
		{/each}
	</ul>
</section>

{#if investorTotals.length}
	<section aria-labelledby="inv-h" class="mt-10 flex flex-col gap-3">
		<div class="flex flex-col gap-1">
			<h2 id="inv-h" class="text-title">Investors</h2>
			<p class="max-w-prose text-body-sm text-ink-2">Everyone who has committed money, every round together, largest first.</p>
		</div>
		<ul class="border-t border-line">
			{#each investorTotals as t (t.id)}
				{@const inv = investors.get(t.id)}
				<li class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-2">
					<span class="font-medium">{inv?.name ?? t.id}</span>
					<span class="text-caption text-ink-3">{inv ? INVESTOR_KIND[inv.kind] : ''}{inv?.country ? ` · ${inv.country}` : ''} · {t.rounds.map(roundName).join(', ')}</span>
					<span class="ml-auto num text-body-sm">{money(t.received)} <span class="text-ink-3">of {money(t.committed)}</span></span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<div class="mt-10"><CapTable /></div>

<div class="mt-10"><CapTableTools /></div>

{#if proposals.length}
	<section aria-labelledby="props-h" class="mt-10 flex flex-col gap-3">
		<h2 id="props-h" class="text-title">What the agents proposed</h2>
		<ul class="border-t border-line">
			{#each proposals as p (p.id)}
				<li class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3">
					<Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>
					<span class="text-caption text-ink-3">{KIND[p.kind]}</span>
					<a class="drill min-w-0 flex-1 text-body-sm text-ink-2" href="/proposals?status=all#proposal-{p.id}">{p.summaryPlain}</a>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<div class="mt-10 flex flex-col gap-6">
	<UploadDemo kinds={['closing_tracker', 'wire_confirmation', 'safe', 'convertible_note', 'side_letter', 'valuation_report', 'term_sheet', 'cap_table']} title="Upload fundraising documents" />
	<Integrations categories={['cap_table']} title="Cap table tools" />
</div>

