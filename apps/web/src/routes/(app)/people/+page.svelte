<script lang="ts">
	// The team across both companies: who is on payroll, what it costs, when people are paid, and time off waiting for
	// the CFO. Everything reads from the live tables, so new requests and Gusto syncs show up as they arrive.
	import { db } from '#lib/data/index.js';
	import type { Department, Employee } from '#lib/data/types.js';
	import { toBig } from '#lib/data/money.js';
	import Integrations from '#lib/components/Integrations.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import UploadDemo from '#lib/components/UploadDemo.svelte';
	import { costByDepartment, isEmployed, loadedCost, monthlyLoadedCost, payDates, type Region } from '#lib/payroll.js';
	import Calendar from '#lib/components/Calendar.svelte';
	import { calendarItems, payrollItems, shiftMonth } from '#lib/calendar.js';
	import TimeOffList from './TimeOffList.svelte';
	import { DEPARTMENT, EMPLOYEE_STATUS, EMPLOYMENT, RUN_STATUS, companyName, convert, dayLabel, latestRate, money, payText, ptoText, range } from './people.js';

	const now = $derived(db.now());
	const subs = $derived(db.subsidiaries());
	const reporting = $derived(db.settings().reportingCcy ?? 'USD');
	const rates = $derived(db.fxRates());
	const toReporting = (minor: string, ccy: string) => convert(minor, latestRate(rates, ccy, reporting));

	const people = $derived(db.employees());
	const onBooks = $derived(people.filter((e) => isEmployed(e, now)));
	const staff = $derived(onBooks.filter((e) => e.type !== 'contractor'));
	const contractors = $derived(onBooks.filter((e) => e.type === 'contractor'));
	const starters = $derived(staff.filter((e) => e.startAt.slice(0, 7) === now.slice(0, 7)));
	const onLeave = $derived(staff.filter((e) => e.status === 'on_leave'));

	/** Companies with people, root first. */
	const companies = $derived(subs.filter((s) => !s.isElimination && people.some((e) => e.subsidiaryId === s.id)).sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId)));
	const monthlyBy = $derived(
		companies.map((c) => {
			// Contractors are paid on invoice, not through payroll.
			const list = staff.filter((e) => e.subsidiaryId === c.id);
			const own = list.reduce((t, e) => t + toBig(monthlyLoadedCost(e)), 0n).toString();
			return { c, own, ccy: c.baseCurrency, reporting: toReporting(own, c.baseCurrency), headcount: list.length };
		})
	);
	const monthlyTotal = $derived(monthlyBy.reduce((t, m) => t + toBig(m.reporting), 0n).toString());

	const runs = $derived([...db.payRuns()].sort((a, b) => a.payDate.localeCompare(b.payDate) || a.subsidiaryId.localeCompare(b.subsidiaryId)));
	const nextRun = $derived(runs.find((r) => r.status === 'scheduled' || r.status === 'processing'));

	const pending = $derived(db.ptoRequests().filter((r) => r.status === 'pending').sort((a, b) => a.startAt.localeCompare(b.startAt)));

	// Roster filters.
	let company = $state<string>('all');
	let department = $state<Department | 'all'>('all');
	const departments = $derived([...new Set(people.map((e) => e.department))].sort((a, b) => DEPARTMENT[a].localeCompare(DEPARTMENT[b])));
	const ORDER: Record<Employee['type'], number> = { full_time: 0, part_time: 1, intern: 2, contractor: 3 };
	const roster = $derived(
		people
			.filter((e) => (company === 'all' || e.subsidiaryId === company) && (department === 'all' || e.department === department))
			.sort((a, b) => ORDER[a.type] - ORDER[b.type] || a.startAt.localeCompare(b.startAt) || a.name.localeCompare(b.name))
	);

	// The calendar leads the page, so the roster and the time-off queue open short and expand on request.
	const ROSTER_ROWS = 6;
	const PENDING_ROWS = 3;
	let allPeople = $state(false);
	let allPending = $state(false);
	const rosterShown = $derived(allPeople ? roster : roster.slice(0, ROSTER_ROWS));

	// The shared calendar: holidays, time off and the pay calendar a year ahead, read live, so an approval below fills
	// its bar in at once and a new Gusto run replaces its estimate.
	const entries = $derived([
		...calendarItems(db.calendarEvents(), db.ptoRequests(), people),
		...payrollItems(
			runs,
			companies.map((c) => ({ id: c.id, name: c.name, region: (c.baseCurrency === 'GBP' ? 'UK' : 'US') as Region })),
			shiftMonth(now.slice(0, 7), 12)
		)
	]);

	// Pay calendar: the runs Gusto has, then the pay dates still to come this year.
	const calendar = $derived(
		companies.map((c) => {
			const region: Region = c.baseCurrency === 'GBP' ? 'UK' : 'US';
			const own = runs.filter((r) => r.subsidiaryId === c.id);
			const known = new Set(own.map((r) => r.payDate.slice(0, 10)));
			const last = own.filter((r) => r.status === 'paid').at(-1);
			const upcoming = own.filter((r) => r.status !== 'paid');
			const year = now.slice(0, 4);
			const later = [10, 11, 12]
				.flatMap((m) => payDates(region, `${year}-${String(m).padStart(2, '0')}`))
				.filter((p) => p.payDate > now.slice(0, 10) && !known.has(p.payDate));
			return { c, region, last, upcoming, later, earlier: own.filter((r) => r.status === 'paid') };
		})
	);

	const byDept = $derived(costByDepartment(people, now, toReporting));
	const deptMax = $derived(byDept.reduce((m, d) => (toBig(d.monthlyMinor) > m ? toBig(d.monthlyMinor) : m), 1n));
	const pctOf = (minor: string) => Number((toBig(minor) * 1000n) / deptMax) / 10;

	const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
</script>

<svelte:head><title>People · Cafoo</title></svelte:head>

<header class="flex flex-col gap-1 pb-6">
	<p class="text-body-sm text-ink-2">{companies.map((c) => c.name).join(' and ')} · payroll through Gusto</p>
	<h1 class="text-display">People</h1>
</header>

<section aria-label="Team at a glance" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
	<div class="card flex flex-col gap-1 p-5">
		<p class="text-body-sm text-ink-2">Headcount</p>
		<p class="num text-display-sm">{staff.length}</p>
		<p class="text-caption text-ink-3">
			{monthlyBy.map((m) => `${m.headcount} at ${m.c.name}`).join(', ')}{contractors.length ? `, plus ${contractors.length} contractor${contractors.length === 1 ? '' : 's'}` : ''}.
			{#if starters.length}{starters.length} started this month.{/if}
			{#if onLeave.length}{onLeave.length} on leave.{/if}
		</p>
	</div>
	<div class="card flex flex-col gap-1 p-5">
		<p class="text-body-sm text-ink-2">Payroll a month, fully loaded</p>
		<p class="num text-display-sm">{money(monthlyTotal, reporting)}</p>
		<p class="text-caption text-ink-3">
			{monthlyBy.map((m) => `${m.c.name} ${money(m.own, m.ccy)}`).join(' · ')}. Pay, employer taxes, retirement and health for today's team; contractors are paid on invoice and left out.
		</p>
	</div>
	<div class="card flex flex-col gap-1 p-5">
		<p class="text-body-sm text-ink-2">Next payday</p>
		{#if nextRun}
			<p class="num text-display-sm">{fmtDay(nextRun.payDate)}</p>
			<p class="text-caption text-ink-3">{companyName(subs, nextRun.subsidiaryId)} · {nextRun.employeeCount} people · {RUN_STATUS[nextRun.status].label.toLowerCase()}</p>
		{:else}
			<p class="text-body text-ink-3">None scheduled</p>
		{/if}
	</div>
	<div class="card flex flex-col gap-1 p-5">
		<p class="text-body-sm text-ink-2">Next payroll debit</p>
		{#if nextRun}
			<p class="num text-display-sm">{money(loadedCost(nextRun), nextRun.ccy)}</p>
			<p class="text-caption text-ink-3">Gusto draws pay, taxes and benefits on {dayLabel(nextRun.debitDate)}, two banking days before payday.</p>
		{:else}
			<p class="text-body text-ink-3">Nothing due</p>
		{/if}
	</div>
</section>

<div class="mt-8">
	<Calendar items={entries} today={now.slice(0, 10)} />
</div>

<div class="mt-8 grid gap-8 lg:grid-cols-3">
	<section aria-labelledby="roster-h" class="flex min-w-0 flex-col gap-4 lg:col-span-2">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<h2 id="roster-h" class="text-title">Team</h2>
			<div class="flex flex-wrap items-end gap-2">
				<div class="flex flex-wrap gap-1" role="group" aria-label="Company">
					<button class="chip" aria-pressed={company === 'all'} onclick={() => (company = 'all')}>All</button>
					{#each companies as c (c.id)}
						<button class="chip" aria-pressed={company === c.id} onclick={() => (company = c.id)}>{c.name}</button>
					{/each}
				</div>
				<label class="flex flex-col gap-1 text-caption text-ink-2">
					<span class="sr-only">Department</span>
					<select class="field text-body-sm" bind:value={department} aria-label="Department">
						<option value="all">All departments</option>
						{#each departments as d (d)}<option value={d}>{DEPARTMENT[d]}</option>{/each}
					</select>
				</label>
			</div>
		</div>

		<div class="card">
			<div class="hidden gap-4 border-b border-line px-5 py-2 text-caption text-ink-3 xl:grid xl:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)]" aria-hidden="true">
				<span>Name</span><span>Department</span><span>Type</span><span class="text-right">Time off</span><span class="text-right">Pay</span>
			</div>
			<ul class="flex flex-col divide-y divide-line">
				{#each rosterShown as e (e.id)}
					{@const future = e.startAt.slice(0, 10) > now.slice(0, 10)}
					{@const badge = future ? { tone: 'neutral' as const, label: `Starts ${fmtDay(e.startAt)}` } : e.status !== 'active' ? EMPLOYEE_STATUS[e.status] : null}
					<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-5 py-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)] xl:items-center">
						<div class="min-w-0">
							<a class="drill font-medium" href="/people/{e.id}">{e.name}</a>
							<p class="truncate text-body-sm text-ink-2">{e.title}</p>
							<!-- Narrow screens: one line of facts instead of columns. -->
							<p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-3 xl:hidden">
								<span>{DEPARTMENT[e.department]} · {companyName(subs, e.subsidiaryId)} · {EMPLOYMENT[e.type]} · {e.type === 'contractor' ? 'no paid time off' : e.pto.unlimited ? 'flexible time off' : `${ptoText(e)} off left`}</span>
								{#if badge}<Pill tone={badge.tone}>{badge.label}</Pill>{/if}
							</p>
						</div>
						<p class="flex flex-col text-right xl:order-last">
							<span class="num text-body-sm">{payText(e).replace(/ (a year|an hour)$/, '')}</span>
							<span class="text-caption text-ink-3">{payText(e).endsWith('an hour') ? 'an hour' : 'a year'}</span>
						</p>
						<p class="hidden text-body-sm text-ink-2 xl:block">
							{DEPARTMENT[e.department]} <span class="text-ink-3">· {companyName(subs, e.subsidiaryId)}</span>
						</p>
						<p class="hidden flex-wrap items-center gap-2 text-body-sm text-ink-2 xl:flex">
							{EMPLOYMENT[e.type]}
							{#if badge}<Pill tone={badge.tone}>{badge.label}</Pill>{/if}
						</p>
						<p class="hidden text-right text-body-sm text-ink-2 xl:block">{ptoText(e)}</p>
					</li>
				{:else}
					<li class="px-5 py-6 text-body-sm text-ink-3">Nobody matches these filters.</li>
				{/each}
			</ul>
			{#if roster.length > ROSTER_ROWS}
				<button type="button" class="w-full border-t border-line px-5 py-3 text-left text-body-sm text-ink-2 hover:bg-subtle hover:text-ink" aria-expanded={allPeople} onclick={() => (allPeople = !allPeople)}>
					{allPeople ? 'Show fewer' : `Show all ${roster.length} people`}
				</button>
			{/if}
		</div>
	</section>

	<div class="flex min-w-0 flex-col gap-8">
		<section aria-labelledby="pto-h" class="card flex flex-col gap-2 p-5">
			<div class="flex items-baseline justify-between gap-3">
				<h2 id="pto-h" class="text-subtitle">Time off waiting for you</h2>
				{#if pending.length}<Pill tone="warn">{pending.length}</Pill>{/if}
			</div>
			<TimeOffList requests={allPending ? pending : pending.slice(0, PENDING_ROWS)} empty="Nothing waiting. New requests from Gusto show up here." />
			{#if pending.length > PENDING_ROWS}
				<button type="button" class="self-start text-body-sm text-ink-2 hover:text-ink" aria-expanded={allPending} onclick={() => (allPending = !allPending)}>
					{allPending ? 'Show fewer' : `Show all ${pending.length}`}
				</button>
			{/if}
		</section>

		<section aria-labelledby="dept-h" class="card flex flex-col gap-3 p-5">
			<h2 id="dept-h" class="text-subtitle">Monthly cost by department</h2>
			<p class="text-caption text-ink-3">In {reporting}, at the latest closing rate. The darker part is time spent running the live service, which counts as cost of revenue.</p>
			<ul class="flex flex-col gap-3">
				{#each byDept as d (d.department)}
					<li class="flex flex-col gap-1">
						<div class="flex items-baseline justify-between gap-3 text-body-sm">
							<span>{DEPARTMENT[d.department]} <span class="text-ink-3">· {d.headcount}</span></span>
							<span class="num">{money(d.monthlyMinor, reporting)}</span>
						</div>
						<div class="flex h-2 overflow-hidden rounded-sm bg-subtle" role="img" aria-label="{DEPARTMENT[d.department]}: {money(d.serviceMinor, reporting)} of {money(d.monthlyMinor, reporting)} runs the service">
							<span class="h-full bg-ink-2" style="width: {pctOf(d.serviceMinor)}%"></span>
							<span class="h-full bg-line-strong" style="width: {pctOf(d.monthlyMinor) - pctOf(d.serviceMinor)}%"></span>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	</div>
</div>

<section aria-labelledby="cal-h" class="mt-12 flex flex-col gap-4">
	<div class="flex flex-col gap-1">
		<h2 id="cal-h" class="text-title">Pay calendar</h2>
		<p class="text-body-sm text-ink-2">Cafoo Inc pays on the 15th and the last day of the month; Cafoo Ltd on the last working day. Either moves earlier when it lands on a weekend or bank holiday.</p>
	</div>
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
		{#each calendar as cal (cal.c.id)}
			<section class="card flex flex-col gap-3 p-5" aria-label="{cal.c.name} pay calendar">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h3 class="text-subtitle">{cal.c.name}</h3>
					<span class="text-caption text-ink-3">{cal.region === 'US' ? 'Semi-monthly' : 'Monthly'} · {cal.c.baseCurrency}</span>
				</div>
				<ul class="flex flex-col divide-y divide-line border-y border-line">
					{#each cal.upcoming as r (r.id)}
						<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-3">
							<span class="flex flex-col">
								<span class="flex flex-wrap items-center gap-2">
									<span class="font-medium">{dayLabel(r.payDate)}</span>
									<Pill tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Pill>
								</span>
								<span class="text-caption text-ink-3">
									{r.status === 'draft' ? 'Contractor invoice' : `Pay for ${range(r.periodStart, r.periodEnd)}`} · debit {dayLabel(r.debitDate)} · {r.employeeCount} {r.employeeCount === 1 ? 'person' : 'people'}
								</span>
							</span>
							<span class="text-right">
								<span class="num block">{money(loadedCost(r), r.ccy)}</span>
								<span class="block text-caption text-ink-3">{r.status === 'paid' ? 'paid' : r.status === 'draft' ? 'so far' : 'estimated'}</span>
							</span>
						</li>
					{/each}
					{#each cal.later as p (p.payDate)}
						<li class="flex items-baseline justify-between gap-3 py-3 text-body-sm text-ink-2">
							<span>{dayLabel(p.payDate)} <span class="text-ink-3">· debit {dayLabel(p.debitDate)}</span></span>
							<span class="text-caption text-ink-3">Not in Gusto yet</span>
						</li>
					{/each}
				</ul>
				{#if cal.earlier.length}
					<details class="text-body-sm">
						<summary class="cursor-pointer text-ink-2">Paid runs ({cal.earlier.length})</summary>
						<ul class="mt-2 flex flex-col divide-y divide-line">
							{#each [...cal.earlier].reverse() as r (r.id)}
								<li class="flex items-baseline justify-between gap-3 py-2">
									<span>{dayLabel(r.payDate)} <span class="text-ink-3">· {r.employeeCount} people</span></span>
									<span class="num">{money(loadedCost(r), r.ccy)}</span>
								</li>
							{/each}
						</ul>
						<p class="mt-2 text-caption text-ink-3">Each month's runs add up to the payroll entry in the ledger.</p>
					</details>
				{/if}
			</section>
		{/each}
	</div>
</section>

<div class="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<UploadDemo kinds={['payroll_register', 'pto_report']} title="Upload a Gusto export" />
	<Integrations categories={['payroll']} title="Payroll tools" />
</div>
