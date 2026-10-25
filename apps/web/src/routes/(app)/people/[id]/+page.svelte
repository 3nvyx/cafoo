<script lang="ts">
	// One person: pay and where it lands, time off, payslips, and who they work with.
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { toBig } from '#lib/data/money.js';
	import Icon from '#lib/components/Icon.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { accrualPerYear, maskedAccount, monthlyLoadedCost, payDatesLeftInYear, projectPto, regionOf, splitDeposit } from '#lib/payroll.js';
	import TimeOffList from '../TimeOffList.svelte';
	import { rootOf } from '#lib/data/group.js';
	import { DEPARTMENT, EMPLOYEE_STATUS, EMPLOYMENT, RUN_STATUS, companyName, dayLabel, money, payText, scheduleText } from '../people.js';

	/** The strike price of grants since October 2025: the 409A fair value of a common share. */
	const STRIKE_MINOR = '115';

	const e = $derived(db.employees().find((x) => x.id === page.params.id));
	const subs = $derived(db.subsidiaries());
	const now = $derived(db.now());
	const manager = $derived(e?.managerId ? db.employees().find((x) => x.id === e.managerId) : undefined);
	const reports = $derived(e ? db.employees().filter((x) => x.managerId === e.id) : []);
	const runs = $derived(db.payRuns());
	const slips = $derived(
		e
			? db
					.payslips()
					.filter((p) => p.employeeId === e.id)
					.map((p) => ({ p, run: runs.find((r) => r.id === p.payRunId) }))
					.sort((a, b) => (b.run?.payDate ?? '').localeCompare(a.run?.payDate ?? ''))
			: []
	);
	const latest = $derived(slips.find((s) => toBig(s.p.netMinor) > 0n));
	const deposits = $derived(e ? splitDeposit(latest?.p.netMinor ?? '0', e.deposit) : []);
	const requests = $derived(e ? db.ptoRequests().filter((r) => r.employeeId === e.id).sort((a, b) => b.startAt.localeCompare(a.startAt)) : []);
	const booked = $derived(requests.filter((r) => (r.status === 'approved' || r.status === 'pending') && r.kind === 'vacation' && r.endAt.slice(0, 10) > now.slice(0, 10)).reduce((h, r) => h + r.hours, 0));
	const projection = $derived(e ? projectPto(e.pto, payDatesLeftInYear(regionOf(e), now).length, booked) : null);
	const days = (h: number) => {
		const d = Math.round((h / 8) * 10) / 10;
		return `${d} day${d === 1 ? '' : 's'}`;
	};
	const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
	const leave = $derived(e?.status === 'on_leave' ? requests.find((r) => r.kind === 'parental' || r.kind === 'unpaid') : undefined);
	const policy = $derived(
		!e
			? ''
			: e.type === 'contractor'
				? 'Contractors take no paid time off.'
				: e.pto.unlimited
					? 'Flexible time off: no balance, taken with the manager’s OK.'
					: `${days(accrualPerYear(e.pto, e.payFrequency))} a year, ${e.pto.accrualHoursPerRun} hours each pay run${e.pto.carryoverCapHours !== undefined ? `; up to ${days(e.pto.carryoverCapHours)} ${e.ccy === 'GBP' ? 'carry over into next year' : 'can be held at once'}` : ''}.`
	);
	const benefits = $derived(
		!e
			? ''
			: e.type === 'contractor' || e.type === 'intern'
				? 'No benefits.'
				: e.ccy === 'GBP'
					? `Pension: Cafoo pays ${e.retirementBp / 100}% of salary, ${e.name.split(' ')[0]} pays 5%. Private medical ${money(e.benefitsMonthlyMinor, e.ccy, false)} a month.`
					: `${e.retirementBp ? `401(k): Cafoo matches up to ${e.retirementBp / 100}% of pay.` : 'Not in the 401(k).'} Health: Cafoo pays ${money(e.benefitsMonthlyMinor, e.ccy, false)} a month of the premium.`
	);
</script>

<svelte:head><title>{e?.name ?? 'Person'} · Cafoo</title></svelte:head>

<a href="/people" class="drill inline-flex min-h-11 items-center gap-1 text-body-sm text-ink-2"><Icon name="chevronLeft" size={16} />People</a>

{#if !e}
	<p class="card mt-4 px-5 py-10 text-center text-ink-3">We could not find that person.</p>
{:else}
	<header class="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
		<div class="flex min-w-0 flex-col gap-1">
			<h1 class="text-display">{e.name}</h1>
			<p class="text-body text-ink-2">{e.title} · {DEPARTMENT[e.department]} · {companyName(subs, e.subsidiaryId)}</p>
			<p class="text-body-sm text-ink-3">{e.location} · <a class="drill" href="mailto:{e.email}">{e.email}</a></p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Pill tone="neutral">{EMPLOYMENT[e.type]}</Pill>
			{#if e.startAt.slice(0, 10) > now.slice(0, 10)}<Pill tone="neutral">Starts {fmtDate(e.startAt)}</Pill>{:else}<Pill tone={EMPLOYEE_STATUS[e.status].tone}>{EMPLOYEE_STATUS[e.status].label}</Pill>{/if}
		</div>
	</header>

	{#if leave}
		<Notice class="mt-4" tone="warn" title="On {leave.kind === 'parental' ? 'parental' : 'unpaid'} leave until {fmtDate(leave.endAt)}">
			State disability and paid family leave pay {e.name.split(' ')[0]} while away; Cafoo keeps paying the health premium. Payroll resumes on return.
		</Notice>
	{/if}

	<dl class="mt-6 grid grid-cols-2 gap-x-4 border-y border-line sm:grid-cols-4">
		<div class="py-4"><dt class="text-body-sm text-ink-3">Pay</dt><dd class="num mt-1 text-subtitle">{payText(e)}</dd></div>
		<div class="py-4"><dt class="text-body-sm text-ink-3">Cost a month</dt><dd class="num mt-1 text-subtitle">{money(monthlyLoadedCost(e), e.ccy)}</dd><dd class="text-caption text-ink-3">With employer taxes and benefits</dd></div>
		<div class="py-4"><dt class="text-body-sm text-ink-3">Started</dt><dd class="num mt-1 text-subtitle">{fmtDate(e.startAt)}</dd>{#if e.endAt}<dd class="text-caption text-ink-3">Ends {fmtDate(e.endAt)}</dd>{/if}</div>
		<div class="py-4">
			<dt class="text-body-sm text-ink-3">Stock options</dt>
			<dd class="num mt-1 text-subtitle">{e.optionsGranted ? e.optionsGranted.toLocaleString('en-US') : 'None'}</dd>
			{#if e.optionsGranted}<dd class="text-caption text-ink-3">Over {rootOf(subs)?.name ?? 'the company'} common, strike {money(STRIKE_MINOR, 'USD', false)}</dd>{/if}
		</div>
	</dl>

	<div class="mt-10 grid gap-10 lg:grid-cols-2 lg:items-start">
		<div class="flex min-w-0 flex-col gap-10">
			<section aria-labelledby="pay-h" class="flex flex-col gap-3">
				<h2 id="pay-h" class="text-title">Pay and deposits</h2>
				<dl class="flex flex-col divide-y divide-line border-y border-line text-body-sm">
					<div class="flex justify-between gap-4 py-2.5"><dt class="text-ink-2">Schedule</dt><dd class="text-right">{scheduleText(e)}</dd></div>
					<div class="flex justify-between gap-4 py-2.5"><dt class="text-ink-2">Benefits</dt><dd class="text-right">{benefits}</dd></div>
					{#if manager}<div class="flex justify-between gap-4 py-2.5"><dt class="text-ink-2">Manager</dt><dd class="text-right"><a class="drill" href="/people/{manager.id}">{manager.name}</a></dd></div>{/if}
					{#if reports.length}
						<div class="flex justify-between gap-4 py-2.5">
							<dt class="text-ink-2">Reports</dt>
							<dd class="text-right">{#each reports as r, i (r.id)}{i ? ', ' : ''}<a class="drill" href="/people/{r.id}">{r.name}</a>{/each}</dd>
						</div>
					{/if}
				</dl>
				<h3 class="mt-2 text-subtitle">{e.type === 'contractor' ? 'Paid on invoice to' : 'Direct deposit'}</h3>
				<ul class="flex flex-col divide-y divide-line border-y border-line">
					{#each deposits as d (d.split.accountLast4)}
						<li class="flex items-baseline justify-between gap-3 py-2.5 text-body-sm">
							<span>{maskedAccount(d.split)} <span class="text-ink-3">· {d.split.remainder ? 'the rest' : `${money(d.split.amountMinor ?? '0', e.ccy)} each run`}</span></span>
							{#if latest}<span class="num">{money(d.amountMinor, e.ccy, false)}</span>{/if}
						</li>
					{/each}
				</ul>
				{#if latest?.run}<p class="text-caption text-ink-3">Amounts from the {dayLabel(latest.run.payDate)} payslip. Only the last four digits of each account are kept.</p>{/if}
			</section>

			<section aria-labelledby="slip-h" class="flex flex-col gap-3">
				<h2 id="slip-h" class="text-title">Payslips</h2>
				<ul class="flex flex-col divide-y divide-line border-y border-line">
					{#each slips as { p, run } (p.id)}
						<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-3">
							<span class="flex flex-col">
								<span class="flex flex-wrap items-center gap-2">
									<span class="font-medium">{run ? dayLabel(run.payDate) : p.payRunId}</span>
									{#if run && run.status !== 'paid'}<Pill tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</Pill>{/if}
								</span>
								<span class="text-caption text-ink-3">
									Gross {money(p.grossMinor, p.ccy, false)} · taxes {money(p.employeeTaxMinor, p.ccy, false)} · deductions {money(p.deductionsMinor, p.ccy, false)}{p.hours !== undefined ? ` · ${p.hours} hours` : ''}{p.ptoHoursUsed ? ` · ${days(p.ptoHoursUsed)} off` : ''}
								</span>
							</span>
							<span class="text-right">
								<span class="num block">{money(p.netMinor, p.ccy, false)}</span>
								<span class="block text-caption text-ink-3">net</span>
							</span>
						</li>
					{:else}
						<li class="py-4 text-body-sm text-ink-3">No payslips yet. The first arrives with the next pay run.</li>
					{/each}
				</ul>
				{#if slips.length}<p class="text-caption text-ink-3">Taxes are Gusto's figures as of each run; the register is what posts to the books.</p>{/if}
			</section>
		</div>

		<section aria-labelledby="pto-h" class="flex min-w-0 flex-col gap-3">
			<h2 id="pto-h" class="text-title">Time off</h2>
			<p class="text-body-sm text-ink-2">{policy}</p>
			{#if e.type !== 'contractor'}
				<dl class="grid grid-cols-2 gap-x-4 border-y border-line sm:grid-cols-3">
					{#if !e.pto.unlimited}
						<div class="py-3"><dt class="text-caption text-ink-3">Balance</dt><dd class="num text-subtitle">{days(e.pto.balanceHours)}</dd><dd class="text-caption text-ink-3">{e.pto.balanceHours} hours</dd></div>
						{#if projection}<div class="py-3"><dt class="text-caption text-ink-3">At year end</dt><dd class="num text-subtitle">{days(projection.projectedHours)}</dd><dd class="text-caption text-ink-3">After booked time</dd></div>{/if}
					{/if}
					<div class="py-3"><dt class="text-caption text-ink-3">Taken this year</dt><dd class="num text-subtitle">{days(e.pto.usedHoursYtd)}</dd></div>
					<div class="py-3"><dt class="text-caption text-ink-3">Sick time left</dt><dd class="num text-subtitle">{days(e.pto.sickBalanceHours)}</dd></div>
				</dl>
				{#if projection && projection.overCapHours > 0}
					<Notice tone="warn">On course to end the year {days(projection.overCapHours)} over the {days(e.pto.carryoverCapHours ?? 0)} that carry over. Worth a nudge to book the time.</Notice>
				{/if}
			{/if}
			<h3 class="mt-2 text-subtitle">Requests</h3>
			<TimeOffList {requests} showName={false} empty="No time off requested this year." />
		</section>
	</div>
{/if}
