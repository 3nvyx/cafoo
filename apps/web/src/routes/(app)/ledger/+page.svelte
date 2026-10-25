<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { db } from '#lib/data/index.js';
	import { isDebitNormal, monthName, periodLabel, periodShort, ymShort } from '#lib/data/derive.js';
	import { formatMoney } from '#lib/data/money.js';
	import { functionalNet } from '#lib/data/group.js';
	import type { JournalEntry, Period } from '#lib/data/types.js';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import JournalLines, { type LineView } from '#lib/components/JournalLines.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { correctionPeriod } from '#lib/close.js';
	import { inPeriod, parseDrill, parsePeriod, periodFilterLabel } from '#lib/drill.js';
	import { dateTime, drill, roleName, shortDate } from '#lib/labels.js';
	import { arrive, reveal } from '#lib/motion.js';
	import { attempt } from '#lib/toast.svelte.js';
	import { ui } from '#lib/ui.svelte.js';
	import UploadDemo from '#lib/components/UploadDemo.svelte';
	import DebateMessage from '#lib/components/DebateMessage.svelte';
	import ExportMenu from '#lib/components/ExportMenu.svelte';
	import { ROLE, STATUS, KIND } from '#lib/labels.js';
	import { accountTree, beforePeriod, natural, runningBalances, trialBalance, type TbCompany } from '#lib/ledger.js';
	import { decimal, money, type ExportTable } from '#lib/export.js';
	import type { JournalLine, PostedByRole } from '#lib/data/types.js';

	const params = $derived(page.url.searchParams);
	const parsed = $derived(parseDrill(params.get('drill') ?? ''));
	const drillKind = $derived(parsed.kind);
	const drillValue = $derived(parsed.values[0] ?? '');
	const periodParam = $derived(params.get('period'));
	/** An account or type drill narrowed to one company (its Subsidiary code), as the Board Pack links per company. */
	const company = $derived(db.subsidiaries().find((s) => s.code === params.get('company')));
	const subById = $derived(new Map(db.subsidiaries().map((s) => [s.id, s])));
	/** The currency an account's company keeps its books in. */
	const ccyOf = (accountId: string) => subById.get(byId.get(accountId)?.subsidiaryId ?? '')?.baseCurrency ?? 'USD';
	let q = $state('');

	const accounts = $derived(db.accounts());
	const byId = $derived(new Map(accounts.map((a) => [a.id, a])));
	const periods = $derived(db.periods());
	const linesByJe = $derived.by(() => {
		const m = new Map<string, ReturnType<typeof db.journalLines>>();
		for (const l of db.journalLines()) {
			let list = m.get(l.jeId);
			if (!list) m.set(l.jeId, (list = []));
			list.push(l);
		}
		return m;
	});

	const drillJe = $derived(drillKind === 'je' ? db.journalEntries().find((j) => j.id === drillValue) : undefined);
	const periodValue = $derived(drillJe ? drillJe.periodId : (periodParam ?? ui.periodId));
	const periodFilter = $derived(parsePeriod(periodValue));
	/** A range (e.g. quarter to date) or a month with no Period row gets its own option in the picker. */
	const customPeriod = $derived(periodValue !== 'all' && !periods.some((p) => p.id === periodValue));

	/** The accounts an account drill (one or several codes) or a type drill (e.g. revenue,expense) covers. */
	const drillAccounts = $derived(
		(drillKind === 'account'
			? accounts.filter((a) => parsed.values.includes(a.code))
			: drillKind === 'type'
				? accounts.filter((a) => parsed.values.includes(a.type))
				: []
		).filter((a) => !company || a.subsidiaryId === company.id)
	);
	const drillAccountIds = $derived(new Set(drillAccounts.map((a) => a.id)));

	const matchesLine = (l: { accountId: string; customerId?: string; vendorId?: string }) => {
		if (drillKind === 'account' || drillKind === 'type') return drillAccountIds.has(l.accountId);
		if (drillKind === 'customer') return l.customerId === drillValue;
		if (drillKind === 'vendor') return l.vendorId === drillValue;
		return false;
	};

	// The view (?view=journal|trial|accounts) and the filters live in the URL, so a link lands on the same screen.
	type View = 'journal' | 'trial' | 'accounts';
	const VIEWS: { id: View; label: string }[] = [
		{ id: 'journal', label: 'Journal' },
		{ id: 'trial', label: 'Trial balance' },
		{ id: 'accounts', label: 'Chart of accounts' }
	];
	const viewId = $derived<View>(VIEWS.find((v) => v.id === params.get('view'))?.id ?? 'journal');
	const byParam = $derived(params.get('by') ?? '');
	type EntryStatus = 'posted' | 'reversed' | 'reversal';
	const ENTRY_STATUS: Record<EntryStatus, string> = { posted: 'Posted', reversed: 'Reversed', reversal: 'Reversal' };
	const statusParam = $derived((params.get('status') ?? '') as EntryStatus | '');

	/** The company's accounts when a company is chosen (without an account drill, the entries touching any of them). */
	const companyAccountIds = $derived(company ? new Set(accounts.filter((a) => a.subsidiaryId === company.id).map((a) => a.id)) : null);
	const companyAccounts = $derived(company ? accounts.filter((a) => a.subsidiaryId === company.id) : accounts);
	const sortedAccounts = $derived([...companyAccounts].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })));
	/** Who posted: the roles that appear in the books, imported data first. */
	const posters = $derived([...new Set(db.journalEntries().map((j) => j.postedByRole))].sort((a, b) => (a === 'seed' ? -1 : b === 'seed' ? 1 : a.localeCompare(b))));
	const posterName = (r: PostedByRole) => (r === 'seed' ? 'Imported' : (ROLE[r]?.name ?? r));

	const statusOf = (j: JournalEntry): EntryStatus =>
		j.reversesJeId ? 'reversal' : (reversalsOf.get(j.id) ?? []).some((r) => !isAutoReversal(r, j)) ? 'reversed' : 'posted';

	const proposalById = $derived(new Map(db.proposals().map((p) => [p.id, p])));
	const debateOf = $derived.by(() => {
		const m = new Map<string, ReturnType<typeof db.agentMessages>>();
		for (const msg of db.agentMessages()) {
			if (!msg.proposalId) continue;
			let list = m.get(msg.proposalId);
			if (!list) m.set(msg.proposalId, (list = []));
			list.push(msg);
		}
		for (const list of m.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return m;
	});
	let debateOpen = $state<Record<string, boolean>>({});

	/** The entries the period, the drill-down and the company keep; the base for running balances. */
	const scoped = $derived(
		db
			.journalEntries()
			.filter((j) => inPeriod(j.periodId, periodFilter))
			.filter((j) => (drillKind && drillKind !== 'je' ? (linesByJe.get(j.id) ?? []).some(matchesLine) : true))
			.filter((j) => !companyAccountIds || drillKind === 'account' || drillKind === 'type' || (linesByJe.get(j.id) ?? []).some((l) => companyAccountIds.has(l.accountId)))
	);

	const entries = $derived.by(() => {
		const s = q.trim().toLowerCase();
		return scoped
			.filter((j) => !byParam || j.postedByRole === byParam)
			.filter((j) => !statusParam || statusOf(j) === statusParam)
			.filter((j) => !s || j.memo.toLowerCase().includes(s) || j.id.toLowerCase().includes(s) || (j.proposalId ?? '').toLowerCase() === s)
			.sort((a, b) => b.periodId.localeCompare(a.periodId) || b.postedAt.localeCompare(a.postedAt));
	});

	/**
	 * Running balance of the drilled accounts after each entry, when they are all one company's (one currency): from the
	 * balance before the period, through every entry in the period in posting order (search and filters only hide rows).
	 */
	const running = $derived.by(() => {
		if (drillKind !== 'account' || !drillAccounts.length || new Set(drillAccounts.map((a) => a.subsidiaryId)).size !== 1) return null;
		let opening = 0n;
		for (const j of db.journalEntries())
			if (beforePeriod(j.periodId, periodFilter)) for (const l of linesByJe.get(j.id) ?? []) if (drillAccountIds.has(l.accountId)) opening += functionalNet(l);
		const type = drillAccounts[0].type;
		const sameSide = drillAccounts.every((a) => isDebitNormal(a.type) === isDebitNormal(type));
		const balances = runningBalances(scoped, linesByJe as Map<string, JournalLine[]>, drillAccountIds, opening);
		const ccy = subById.get(drillAccounts[0].subsidiaryId)?.baseCurrency ?? 'USD';
		return { at: (id: string) => balances.get(id), show: (b: bigint) => formatMoney((sameSide ? natural(type, b) : b).toString(), { currency: ccy }), opening: sameSide ? natural(type, opening) : opening, ccy };
	});

	// Trial balance and chart of accounts, for the chosen period and company.
	const tb = $derived(
		viewId === 'journal' ? [] : trialBalance({ subsidiaries: db.subsidiaries(), accounts, entries: db.journalEntries(), lines: db.journalLines() }, periodFilter, {
			subsidiaryId: company?.id,
			includeZero: viewId === 'accounts'
		})
	);
	const periodText = $derived(periodFilterLabel(periodFilter));
	const fmt = (minor: bigint, ccy: string) => (minor === 0n ? '' : formatMoney(minor.toString(), { currency: ccy }));
	const tbExport = (): ExportTable[] =>
		tb.map((c) => ({
			title: `${c.subsidiary.name} (${c.subsidiary.baseCurrency})`,
			header: ['Code', 'Account', 'Type', 'Opening (net debit)', 'Debits', 'Credits', 'Closing debit', 'Closing credit'],
			rows: [
				...c.rows.map((r) => [r.account.code, r.account.name, r.account.type, money(r.opening), money(r.debits), money(r.credits), money(r.closing > 0n ? r.closing : 0n), money(r.closing < 0n ? -r.closing : 0n)]),
				['', 'Total', '', money(c.totals.opening), money(c.totals.debits), money(c.totals.credits), money(c.totals.closingDebit), money(c.totals.closingCredit)]
			]
		}));
	const outBy = (c: TbCompany) => decimal(c.totals.debits - c.totals.credits);

	const names = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

	const drillLabel = $derived.by(() => {
		const at = company ? ` at ${company.name}` : '';
		const multi = new Set(drillAccounts.map((a) => a.subsidiaryId)).size > 1;
		const accountName = (a: (typeof drillAccounts)[number]) => (multi ? `${a.name} (${subById.get(a.subsidiaryId)?.name ?? a.subsidiaryId})` : a.name);
		if (drillKind === 'account') {
			if (!drillAccounts.length) return parsed.values.join(', ');
			return names(drillAccounts.map(accountName)) + at;
		}
		if (drillKind === 'type') {
			const t = new Set(parsed.values);
			if (t.size === 2 && t.has('revenue') && t.has('expense')) return `the income statement accounts (revenue and expenses)${at}`;
			return `the ${names(parsed.values)} accounts${at}`;
		}
		if (drillKind === 'customer') return db.customers().find((c) => c.id === drillValue)?.name ?? drillValue;
		if (drillKind === 'vendor') return db.vendors().find((v) => v.id === drillValue)?.name ?? drillValue;
		if (drillKind === 'je') return drillJe?.memo ?? drillValue;
		return '';
	});

	/**
	 * Net movement on the drilled accounts across the rows shown, in each company's own currency (lines in another
	 * currency at their recorded rate), one figure per company. Accounts on one side keep their natural sign; the income
	 * statement nets to income (revenue less expenses), the way the Board Pack figure that linked here does.
	 */
	const drillTotal = $derived.by(() => {
		if (!drillAccounts.length) return null;
		const bySub = new Map<string, bigint>();
		for (const a of drillAccounts) bySub.set(a.subsidiaryId, 0n);
		for (const j of entries)
			for (const l of linesByJe.get(j.id) ?? []) {
				if (!drillAccountIds.has(l.accountId)) continue;
				const sub = byId.get(l.accountId)!.subsidiaryId;
				bySub.set(sub, (bySub.get(sub) ?? 0n) + functionalNet(l));
			}
		const allDebit = drillAccounts.every((a) => isDebitNormal(a.type));
		const allCredit = drillAccounts.every((a) => !isDebitNormal(a.type));
		const label = allDebit || allCredit ? 'net' : drillAccounts.every((a) => a.type === 'revenue' || a.type === 'expense') ? 'net income' : 'net debit';
		const k = allDebit || label === 'net debit' ? 1n : -1n;
		const multi = bySub.size > 1;
		const amounts = [...bySub].map(([sub, t]) => {
			const s = subById.get(sub);
			return { key: sub, prefix: multi ? `${s?.name ?? sub} ` : '', text: formatMoney((k * t).toString(), { currency: s?.baseCurrency ?? 'USD' }) };
		});
		return { label, amounts };
	});

	let open = $state<Record<string, boolean>>({});
	$effect(() => {
		if (drillJe) {
			open[drillJe.id] = true;
			tick().then(() => document.getElementById(`je-${drillJe.id}`)?.scrollIntoView({ block: 'center' }));
		}
	});

	/** An entry's size: its debits in its company's own currency (lines in another currency at their recorded rate). */
	const total = (j: JournalEntry) => {
		const ls = linesByJe.get(j.id) ?? [];
		const debits = ls.reduce((t, l) => t + functionalNet({ debitMinor: l.debitMinor, creditMinor: '0', fxRateE6: l.fxRateE6 }), 0n);
		return formatMoney(debits.toString(), { currency: ls[0] ? ccyOf(ls[0].accountId) : 'USD' });
	};
	const view = (j: JournalEntry): LineView[] =>
		(linesByJe.get(j.id) ?? []).map((l) => {
			const a = byId.get(l.accountId);
			return { key: l.id, code: a?.code ?? '', name: a?.name ?? l.accountId, debitMinor: l.debitMinor, creditMinor: l.creditMinor, ccy: l.ccy || ccyOf(l.accountId), highlight: matchesLine(l) };
		});

	/**
	 * The entry's accounting date: the day it was posted when that falls in its own month, otherwise the month itself
	 * (a September close adjustment posted in October, or opening data imported later, belongs to September).
	 */
	const entryDate = (j: JournalEntry) => (j.postedAt.slice(0, 7) === j.periodId ? shortDate(j.postedAt) : ymShort(j.periodId));
	const SOURCE = { seed: 'Imported', agent: 'Agent', manual: 'Manual' } as const;

	// Reversal rules, as the ledger module's cfoReverse applies them. The CFO (this seat) may reverse an entry unless it
	// is itself a CFO reversal, or a reversal other than an accrual's automatic next-month one already reversed it. The
	// reversal posts in the entry's own month if that month is open, otherwise in the earliest open month after it, and
	// reversing an accrual also reverses its automatic reversal, placed the same way. Reversing also undoes the bank
	// reconciliation the entry carries (a match straight at it, or the payment entry a match posted), which the module
	// refuses while that bank line's month is locked.
	const reversalsOf = $derived.by(() => {
		const m = new Map<string, JournalEntry[]>();
		for (const j of db.journalEntries()) {
			if (!j.reversesJeId) continue;
			let list = m.get(j.reversesJeId);
			if (!list) m.set(j.reversesJeId, (list = []));
			list.push(j);
		}
		return m;
	});
	const accrualProposals = $derived(new Set(db.proposals().filter((p) => p.kind === 'accrual').map((p) => p.id)));
	const isAutoReversal = (r: JournalEntry, of: JournalEntry) =>
		r.source === 'agent' && !!r.proposalId && r.proposalId === of.proposalId && accrualProposals.has(r.proposalId);
	const bankLineMonth = $derived(new Map(db.bankTransactions().map((t) => [t.id, t.ym])));
	/** Bank lines each entry reconciles: matches that target it, and matches whose payment entry it is. */
	const bankLinesOf = $derived.by(() => {
		const m = new Map<string, string[]>();
		const add = (jeId: string, txId: string) => {
			let list = m.get(jeId);
			if (!list) m.set(jeId, (list = []));
			list.push(txId);
		};
		for (const bm of db.bankMatches()) {
			if (bm.targetKind === 'journal_entry') add(bm.targetId, bm.bankTransactionId);
			if (bm.paymentJeId) add(bm.paymentJeId, bm.bankTransactionId);
		}
		return m;
	});

	type Reversal =
		| { state: 'ok'; into: Period; autos: { entry: JournalEntry; into: Period }[] }
		| { state: 'reconciled'; month: Period }
		| { state: 'reversed' | 'is_reversal' | 'locked' };
	function reversal(j: JournalEntry): Reversal {
		if (j.source === 'manual' && j.reversesJeId) return { state: 'is_reversal' };
		const rs = reversalsOf.get(j.id) ?? [];
		if (rs.some((r) => !isAutoReversal(r, j))) return { state: 'reversed' };
		const into = correctionPeriod(periods, j.periodId);
		if (!into) return { state: 'locked' };
		const autos: { entry: JournalEntry; into: Period }[] = [];
		for (const r of rs.filter((r) => !reversalsOf.get(r.id)?.length)) {
			const at = correctionPeriod(periods, r.periodId);
			if (!at) return { state: 'locked' };
			autos.push({ entry: r, into: at });
		}
		for (const tx of bankLinesOf.get(j.id) ?? []) {
			const month = periods.find((p) => p.id === bankLineMonth.get(tx));
			if (month?.status === 'closed') return { state: 'reconciled', month };
		}
		return { state: 'ok', into, autos };
	}
	const monthOf = (periodId: string) => {
		const p = periods.find((x) => x.id === periodId);
		return p ? periodLabel(p) : ymShort(periodId);
	};

	let reversing = $state<JournalEntry | null>(null);
	let reverseOpen = $state(false);
	const reverseBody = $derived.by(() => {
		if (!reversing) return '';
		const r = reversal(reversing);
		const what = `This posts an equal and opposite entry for “${reversing.memo}” (${total(reversing)})`;
		if (r.state !== 'ok') return `${what}, but it cannot be posted right now.`;
		const own = monthOf(reversing.periodId);
		const where =
			r.into.id === reversing.periodId
				? ` in ${own}, the entry's own month, because ${own} is open.`
				: ` in ${periodLabel(r.into)}: ${own} is locked, so it goes in the earliest open month after it.`;
		const autos = r.autos.map((a) => ` Its automatic reversal in ${monthOf(a.entry.periodId)} is reversed too, in ${periodLabel(a.into)}.`).join('');
		return `${what}${where}${autos} The original stays on the record.`;
	});

	function setPeriod(v: string) {
		const u = new URL(page.url.href);
		u.searchParams.set('period', v);
		if (drillKind === 'je') u.searchParams.delete('drill');
		goto(u, { replace: true, reset: false });
	}
	/** Set or clear one URL filter. Choosing a company drops an account drill that is not that company's. */
	function setParam(key: string, v: string) {
		const u = new URL(page.url.href);
		if (v) u.searchParams.set(key, v);
		else u.searchParams.delete(key);
		if (key === 'company' && drillKind === 'account' && v) {
			const sub = db.subsidiaries().find((s) => s.code === v);
			if (sub && drillAccounts.some((a) => a.subsidiaryId !== sub.id)) u.searchParams.delete('drill');
		}
		if (key === 'view' && v === 'journal') u.searchParams.delete('view');
		goto(u, { replace: true, reset: false });
	}
	function setAccount(code: string) {
		const u = new URL(page.url.href);
		if (code) u.searchParams.set('drill', `account:${code}`);
		else u.searchParams.delete('drill');
		goto(u, { replace: true, reset: false });
	}
	const accountValue = $derived(drillKind === 'account' && parsed.values.length === 1 ? parsed.values[0] : '');
</script>

<svelte:head><title>Ledger · Cafoo</title></svelte:head>

<div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
	<div>
		<h1 class="text-[34px] sm:text-[42px]">Ledger</h1>
		<p class="mt-2 text-ink-2">Every Journal Entry, line by line, the trial balance and the chart of accounts. Click any amount to see what is behind it.</p>
	</div>
	{#if viewId === 'trial'}<ExportMenu tables={tbExport} title="Trial balance {company?.code ?? 'group'} {periodText}" />{/if}
</div>

<div class="mt-6 flex gap-1 overflow-x-auto border-b border-line" role="tablist" aria-label="Ledger view">
	{#each VIEWS as v (v.id)}
		<button
			role="tab"
			aria-selected={viewId === v.id}
			class="-mb-px flex min-h-11 items-center border-b-2 px-3 text-body transition-colors duration-150 {viewId === v.id ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'}"
			onclick={() => setParam('view', v.id)}>{v.label}</button
		>
	{/each}
</div>

<div class="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
	<label class="flex flex-col gap-1 text-caption text-ink-2">
		Company
		<select class="field text-ink" value={company?.code ?? ''} onchange={(e) => setParam('company', (e.currentTarget as HTMLSelectElement).value)}>
			<option value="">Every company</option>
			{#each db.subsidiaries() as s (s.id)}<option value={s.code}>{s.name} ({s.baseCurrency})</option>{/each}
		</select>
	</label>
	<label class="flex flex-col gap-1 text-caption text-ink-2">
		Period
		<select class="field text-ink" value={periodValue} onchange={(e) => setPeriod((e.currentTarget as HTMLSelectElement).value)}>
			<option value="all">All periods</option>
			{#if customPeriod}<option value={periodValue}>{periodFilterLabel(periodFilter)}</option>{/if}
			{#each periods as p (p.id)}<option value={p.id}>{periodShort(p)}</option>{/each}
		</select>
	</label>
	{#if viewId === 'journal'}
		<label class="flex flex-col gap-1 text-caption text-ink-2">
			Account
			<select class="field text-ink" value={accountValue} onchange={(e) => setAccount((e.currentTarget as HTMLSelectElement).value)}>
				<option value="">Every account</option>
				{#if drillKind === 'account' && !accountValue}<option value="" disabled>{parsed.values.join(', ')}</option>{/if}
				{#each sortedAccounts as a (a.id)}<option value={a.code}>{a.code} {a.name}</option>{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1 text-caption text-ink-2">
			Posted by
			<select class="field text-ink" value={byParam} onchange={(e) => setParam('by', (e.currentTarget as HTMLSelectElement).value)}>
				<option value="">Anyone</option>
				{#each posters as r (r)}<option value={r}>{posterName(r)}</option>{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1 text-caption text-ink-2">
			Status
			<select class="field text-ink" value={statusParam} onchange={(e) => setParam('status', (e.currentTarget as HTMLSelectElement).value)}>
				<option value="">Any status</option>
				{#each Object.entries(ENTRY_STATUS) as [k, label] (k)}<option value={k}>{label}</option>{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1 text-caption text-ink-2">
			Search
			<input class="field text-ink" type="search" bind:value={q} placeholder="Memo, entry or Proposal id" />
		</label>
	{/if}
</div>

{#if viewId === 'journal'}
{#if drillKind}
	<div class="mt-6 flex flex-col gap-3 rounded-card bg-secondary-container px-4 py-3 text-on-secondary-container sm:flex-row sm:items-center sm:justify-between">
		<p class="text-[15px]">
			{drillKind === 'je' ? 'Showing the entry' : 'Showing entries that touch'} <span class="font-medium">{drillLabel}</span>
			{#if periodFilter.kind === 'range'}<span class="opacity-80">· {periodFilterLabel(periodFilter)}</span>{/if}
			{#if drillTotal !== null}
				<span class="opacity-80">· {drillTotal.label}</span>
				{#each drillTotal.amounts as a, i (a.key)}{#if i > 0}<span class="opacity-80"> · </span>{/if}<span class="opacity-80">{a.prefix}</span><span class="num font-medium">{a.text}</span>{/each}
			{/if}
		</p>
		<a href="/ledger?period={encodeURIComponent(periodValue)}" class="btn btn-quiet -my-2 self-start text-sm text-on-secondary-container sm:self-auto"><Icon name="x" size={16} />Clear drill-down</a>
	</div>
{/if}

<div class="mt-6 border-t border-line">
	<div class="hidden grid-cols-[88px_minmax(0,1fr)_120px_160px] gap-4 border-b border-line py-2 text-sm text-ink-3 md:grid">
		<span>Date</span><span>Memo</span><span>Source</span><span class="text-right">{running ? 'Amount · balance' : 'Amount'}</span>
	</div>
	<ul>
		{#each entries as j (j.id)}
			<li id="je-{j.id}" class="border-b border-line" in:arrive>
				<button
					class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 state py-3 text-left md:grid-cols-[88px_minmax(0,1fr)_120px_160px] md:py-2.5"
					aria-expanded={!!open[j.id]}
					aria-controls="je-lines-{j.id}"
					onclick={() => (open[j.id] = !open[j.id])}
				>
					<span class="num order-3 text-sm text-ink-3 md:order-none" title="Posted {dateTime(j.postedAt)}">{entryDate(j)}</span>
					<span class="order-1 min-w-0 md:order-none">
						<span class="block truncate">{j.memo}</span>
						{#if statusOf(j) !== 'posted'}<span class="text-caption text-ink-3">{ENTRY_STATUS[statusOf(j)]}</span>{/if}
					</span>
					<span class="order-4 justify-self-end md:order-none md:justify-self-start">
						<Pill tone={j.source === 'agent' ? 'accent' : j.source === 'manual' ? 'warn' : 'muted'}>{SOURCE[j.source]}</Pill>
					</span>
					<span class="num order-2 flex items-center justify-end gap-2 md:order-none">
						{#if running}{@const b = running.at(j.id)}{#if b !== undefined}<span class="text-caption text-ink-3" title="Running balance after this entry">{running.show(b)}</span>{/if}{/if}
						{total(j)}
						<Icon name="chevronDown" size={16} class="text-ink-3 transition-transform duration-200 {open[j.id] ? 'rotate-180' : ''}" />
					</span>
				</button>
				{#if open[j.id]}
					{@const r = reversal(j)}
					<div id="je-lines-{j.id}" class="flex flex-col gap-3 pb-4 md:pl-[104px]" transition:reveal>
						<JournalLines lines={view(j)} periodId={j.periodId} />
						{#if j.proposalId && proposalById.get(j.proposalId)}
							{@const p = proposalById.get(j.proposalId)!}
							{@const debate = debateOf.get(p.id) ?? []}
							<div class="flex flex-col gap-2 rounded-md bg-subtle px-3 py-2">
								<div class="flex flex-wrap items-center gap-2 text-body-sm">
									<span class="text-ink-3">From the Proposal</span>
									<a class="drill font-medium" href="/proposals?status=all#proposal-{p.id}">{KIND[p.kind] ?? p.kind} by {roleName(p.proposerRole)}</a>
									<Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>
									<span class="flex-1"></span>
									{#if debate.length}
										<button class="drill text-body-sm" aria-expanded={!!debateOpen[j.id]} onclick={() => (debateOpen[j.id] = !debateOpen[j.id])}
											>{debateOpen[j.id] ? 'Hide' : 'Show'} the agents' debate ({debate.length})</button
										>
									{:else}
										<span class="text-caption text-ink-3">No debate recorded</span>
									{/if}
								</div>
								<p class="text-body-sm text-ink-2">{p.summaryPlain}</p>
								{#if debateOpen[j.id]}
									<div class="flex flex-col gap-3 pt-1" transition:reveal>
										{#each debate as m (m.id)}<DebateMessage {m} />{/each}
									</div>
								{/if}
							</div>
						{/if}
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-2">
							<span>{j.source === 'seed' ? 'Imported' : `Posted by ${roleName(j.postedByRole)}`}</span>
							{#if j.proposalId && !proposalById.has(j.proposalId)}<a class="drill" href="/proposals?status=all#proposal-{j.proposalId}">From a Proposal</a>{/if}
							{#if j.reversesJeId}<a class="drill" href={drill({ je: j.reversesJeId })}>Reverses an earlier entry</a>{/if}
							<span class="flex-1"></span>
							{#if r.state === 'ok'}
								<button
									class="btn text-sm"
									onclick={() => {
										reversing = j;
										reverseOpen = true;
									}}><Icon name="undo" size={16} />Reverse</button
								>
							{:else if r.state === 'reversed'}
								<Pill tone="warn">Reversed</Pill>
							{:else if r.state === 'locked'}
								<span class="text-ink-3">{monthOf(j.periodId)} and every month after it are locked. Unlock {monthOf(j.periodId)} to reverse this.</span>
							{:else if r.state === 'reconciled'}
								{@const m = monthName(r.month.month)}
								<span class="text-ink-3">Its bank line in {m} is reconciled and {m} is locked. Unlock {m} to reverse it, or post a correcting entry.</span>
							{/if}
						</div>
					</div>
				{/if}
			</li>
		{:else}
			<li class="py-10 text-center text-ink-3">No entries match.</li>
		{/each}
	</ul>
</div>

{#if running}
	<p class="mt-3 text-caption text-ink-3">Balance before {periodText === 'All periods' ? 'the first entry' : periodText}: <span class="num">{formatMoney(running.opening.toString(), { currency: running.ccy })}</span>. Balances run in posting order; filters only hide rows.</p>
{/if}
{:else if viewId === 'trial'}
	<p class="mt-4 text-body-sm text-ink-2">
		{periodText}, each company in its own currency. Opening is everything before the period, closing is opening plus the period's debits less its credits. Click a figure for the lines behind it.
	</p>
	{#each tb as c (c.subsidiary.id)}
		{@const ccy = c.subsidiary.baseCurrency}
		<section class="card mt-4 overflow-x-auto" in:arrive>
			<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 class="text-title">{c.subsidiary.name}</h2>
				<span class="text-caption text-ink-3">{ccy} · {c.rows.length} accounts</span>
				<span class="flex-1"></span>
				{#if c.ties}<Pill tone="pos"><Icon name="check" size={12} />Ties out</Pill>{:else}<Pill tone="neg">Out of balance by {outBy(c)} {ccy}</Pill>{/if}
			</div>
			<table class="mt-3 w-full min-w-max text-body-sm">
				<thead class="text-left text-ink-3">
					<tr class="border-b border-line">
						<th scope="col" class="py-2 pr-3 font-medium">Account</th>
						<th scope="col" class="py-2 pr-3 text-right font-medium">Opening</th>
						<th scope="col" class="py-2 pr-3 text-right font-medium">Debits</th>
						<th scope="col" class="py-2 pr-3 text-right font-medium">Credits</th>
						<th scope="col" class="py-2 pr-3 text-right font-medium">Closing debit</th>
						<th scope="col" class="py-2 text-right font-medium">Closing credit</th>
					</tr>
				</thead>
				{#each accountTree(c.rows) as t (t.type)}
					<tbody>
						<tr><th scope="rowgroup" colspan="6" class="pt-4 pb-1 text-left text-caption font-medium text-ink-3">{t.label}</th></tr>
						{#each t.rows as r (r.account.id)}
							{@const link = drill({ account: r.account.code }, periodValue)}
							<tr class="border-t border-line">
								<td class="py-1.5 pr-3"><a class="drill" href={drill({ account: r.account.code }, 'all')}><span class="num text-ink-3">{r.account.code}</span> {r.account.name}</a></td>
								<td class="num py-1.5 pr-3 text-right text-ink-2">{r.opening === 0n ? '' : formatMoney(r.opening.toString(), { currency: ccy })}</td>
								<td class="num py-1.5 pr-3 text-right">{#if r.debits}<a class="drill" href={link}>{fmt(r.debits, ccy)}</a>{/if}</td>
								<td class="num py-1.5 pr-3 text-right">{#if r.credits}<a class="drill" href={link}>{fmt(r.credits, ccy)}</a>{/if}</td>
								<td class="num py-1.5 pr-3 text-right">{fmt(r.closing > 0n ? r.closing : 0n, ccy)}</td>
								<td class="num py-1.5 text-right">{fmt(r.closing < 0n ? -r.closing : 0n, ccy)}</td>
							</tr>
						{/each}
					</tbody>
				{/each}
				<tfoot>
					<tr class="border-t border-line font-medium">
						<th scope="row" class="py-2 pr-3 text-left">Total</th>
						<td class="num py-2 pr-3 text-right">{formatMoney(c.totals.opening.toString(), { currency: ccy })}</td>
						<td class="num py-2 pr-3 text-right">{formatMoney(c.totals.debits.toString(), { currency: ccy })}</td>
						<td class="num py-2 pr-3 text-right">{formatMoney(c.totals.credits.toString(), { currency: ccy })}</td>
						<td class="num py-2 pr-3 text-right">{formatMoney(c.totals.closingDebit.toString(), { currency: ccy })}</td>
						<td class="num py-2 text-right">{formatMoney(c.totals.closingCredit.toString(), { currency: ccy })}</td>
					</tr>
				</tfoot>
			</table>
		</section>
	{:else}
		<p class="py-10 text-center text-ink-3">No balances for {periodText}.</p>
	{/each}
{:else}
	<p class="mt-4 text-body-sm text-ink-2">
		The chart of accounts by type and group code, with each account's closing balance for {periodText} in its natural sign (debit for assets and expenses, credit for the rest).
	</p>
	{#each tb as c (c.subsidiary.id)}
		{@const ccy = c.subsidiary.baseCurrency}
		<section class="card mt-4" in:arrive>
			<div class="flex flex-wrap items-baseline gap-x-3">
				<h2 class="text-title">{c.subsidiary.name}</h2>
				<span class="text-caption text-ink-3">{ccy}{c.subsidiary.isElimination ? ' · eliminations only' : ''}</span>
			</div>
			{#each accountTree(c.rows) as t (t.type)}
				{@const sub = t.rows.reduce((x, r) => x + natural(t.type, r.closing), 0n)}
				<details class="mt-3 border-t border-line pt-2" open>
					<summary class="flex cursor-pointer items-baseline gap-2 py-1 text-body font-medium">
						<span class="flex-1">{t.label}</span>
						<a class="drill num" href={drill({ type: [t.type], company: c.subsidiary.code }, periodValue)}>{formatMoney(sub.toString(), { currency: ccy })}</a>
					</summary>
					{#each t.groups as g (g.code)}
						{@const gsub = g.rows.reduce((x, r) => x + natural(t.type, r.closing), 0n)}
						<div class="mt-1 pl-3">
							<p class="flex items-baseline gap-2 py-1 text-body-sm text-ink-2">
								<span class="num text-ink-3">{g.code}</span><span class="flex-1">{g.label}</span>
								<a class="drill num" href={drill({ account: g.rows.map((r) => r.account.code) }, periodValue)}>{formatMoney(gsub.toString(), { currency: ccy })}</a>
							</p>
							<ul class="pl-4">
								{#each g.rows as r (r.account.id)}
									<li class="flex items-baseline gap-2 border-t border-line py-1 text-body-sm">
										<span class="num text-ink-3">{r.account.code}</span>
										<span class="min-w-0 flex-1 truncate">{r.account.name}{#if r.account.isIntercompany}<span class="text-caption text-ink-3"> · intercompany</span>{/if}</span>
										<a class="drill num" href={drill({ account: r.account.code }, periodValue)}>{formatMoney(natural(t.type, r.closing).toString(), { currency: ccy })}</a>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				</details>
			{/each}
		</section>
	{/each}
{/if}

<div class="mt-8"><UploadDemo kinds={['bank_statement']} title="Upload a bank statement" /></div>

{#if reversing}
	<ConfirmDialog
		bind:open={reverseOpen}
		title="Reverse this entry?"
		body={reverseBody}
		confirmLabel="Reverse entry"
		danger
		inputLabel="Why? One line for the audit log"
		inputPlaceholder="e.g. Booked to the wrong customer"
		inputRequired
		onconfirm={async (reason) => {
			const target = reversing;
			if (!target) return;
			const r = reversal(target);
			const done =
				r.state === 'ok'
					? `Reversal posted in ${periodLabel(r.into)}.${r.autos.map((a) => ` Its automatic reversal in ${monthOf(a.entry.periodId)} is reversed too, in ${periodLabel(a.into)}.`).join('')}`
					: 'Reversal posted.';
			await attempt(() => db.cfoReverse(target.id, reason), done);
		}}
	/>
{/if}
