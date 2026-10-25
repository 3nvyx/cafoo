<script lang="ts">
	// SaaS metrics laid out the way finance tools do (ChartMogul, Mosaic, NetSuite's SaaS metrics): ARR movement first,
	// then retention, margin and efficiency, each over a chosen window with its trend, its formula and its yardstick.
	// Then the readings particular to an AI startup. Root company's books; ARR from contracts.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { db } from '#lib/data/index.js';
	import { monthRange, postings, summarize, type Summary } from '#lib/data/dashboard.js';
	import { arrWaterfall, nrrBp, periodShort, ymShort } from '#lib/data/derive.js';
	import { formatMoney, toBig } from '#lib/data/money.js';
	import { rootOf } from '#lib/data/group.js';
	import { costOfService, type CostOfService } from '#lib/costs.js';
	import { aiTiles, burnMultiple, burnMultipleHealth, fte, ndrHealth, netBurn, ruleOf40, ruleOf40Health, runwayHealth, aiGrossMarginHealth, usdRate, type Health, type Tile } from '#lib/kpis.js';
	import {
		BURN_MONTHS,
		WINDOWS,
		arrMovement,
		burnMultipleLabel,
		burnReading,
		burnWindowLabel,
		runwayLabel,
		type BurnReading,
		cacPaybackHealth,
		cacPaybackMonths,
		grrBp,
		grrHealth,
		revenuePerEmployee,
		revenuePerEmployeeHealth,
		salesAndMarketing,
		shiftYm,
		sparkPath,
		windowGmAfterInferenceBp,
		windowRange,
		type Window
	} from '#lib/saas-metrics.js';
	import { drill } from '#lib/labels.js';
	import { ui } from '#lib/ui.svelte.js';
	import MetricTile from './MetricTile.svelte';

	const periods = $derived(db.periods());
	const params = $derived(page.url.searchParams);
	const windowId = $derived<Window>(WINDOWS.find((w) => w.id === params.get('window'))?.id ?? 'quarter');
	const months = $derived(WINDOWS.find((w) => w.id === windowId)!.months);
	const endYm = $derived(periods.find((p) => p.id === params.get('end'))?.id ?? periods.find((p) => p.id === ui.periodId)?.id ?? periods.at(-1)?.id);
	const period = $derived(periods.find((p) => p.id === endYm));
	const first = $derived(periods[0]?.id);

	const root = $derived(rootOf(db.subsidiaries()));
	const ps = $derived(root ? postings(db.accounts().filter((a) => a.subsidiaryId === root.id), db.journalEntries(), db.journalLines()) : []);
	const contracts = $derived(db.contracts());
	const employees = $derived(db.employees());
	const now = $derived(db.now());
	const rate = $derived(usdRate(db.fxRates()));

	// Per month, computed once: revenue from the books and the cost of service (for margin after inference).
	const monthly = $derived(
		new Map(
			periods.map((p) => {
				const s = summarize(ps, contracts, monthRange(p.id));
				const cos: CostOfService = costOfService(db.cloudCosts(), employees, p.id, rate, now.slice(0, 7) === p.id ? now : undefined);
				return [p.id, { s, cos }] as const;
			})
		)
	);

	interface Reading {
		end: string;
		s: Summary;
		w: ReturnType<typeof arrWaterfall>;
		win: ReturnType<typeof windowRange>;
		burn: bigint;
		netNew: bigint;
		multiple: number | null;
		nrr: number | null;
		grr: number | null;
		gm: number | null;
		sm: bigint;
		cac: number | null;
		heads: number;
		rpe: bigint | null;
		r40: ReturnType<typeof ruleOf40>;
		/** Runway and its burn: always the last BURN_MONTHS, the Overview's definition. */
		runway: BurnReading;
	}

	function readingAt(end: string): Reading | null {
		if (!first) return null;
		const win = windowRange(end, months, first);
		const s = summarize(ps, contracts, { from: win.from, to: win.to });
		const w = arrWaterfall(contracts, win.before, win.to);
		const burn = netBurn(s);
		const netNew = toBig(w.end) - toBig(w.start);
		const gm = windowGmAfterInferenceBp(win.yms.map((ym) => ({ revenue: toBig(monthly.get(ym)?.s.revenue), cos: monthly.get(ym)!.cos })).filter((m) => m.cos));
		const sm = salesAndMarketing(ps, win.from, win.to);
		const heads = fte(employees, win.to);
		return {
			end,
			s,
			w,
			win,
			burn,
			netNew,
			multiple: burnMultiple(burn, netNew),
			nrr: nrrBp(w),
			grr: grrBp(w),
			gm,
			sm,
			cac: cacPaybackMonths(sm, toBig(w.added) + toBig(w.expansion), gm),
			heads,
			rpe: revenuePerEmployee(toBig(s.revenue), win.months, heads),
			r40: ruleOf40(contracts, win.before, win.to, win.months, s.netMarginBp),
			runway: burnReading(ps, end, first)
		};
	}

	const r = $derived(endYm ? readingAt(endYm) : null);
	/** The same reading over the same-length window ending at each of the last twelve months, for the sparklines. */
	const trend = $derived.by(() => {
		if (!endYm || !first) return [];
		const out: Reading[] = [];
		for (let i = 11; i >= 0; i--) {
			const ym = shiftYm(endYm, -i);
			if (ym < first) continue;
			const x = ym === endYm ? r : readingAt(ym);
			if (x) out.push(x);
		}
		return out;
	});
	const line = (pick: (x: Reading) => number | null) => sparkPath(trend.map(pick), 96, 32);
	const trendLabel = $derived(trend.length > 1 ? `${ymShort(trend[0].end)} to ${ymShort(trend.at(-1)!.end)}` : '');

	const money = (m: bigint | string) => formatMoney(m.toString(), { whole: true, compact: true });
	const pct = (bp: number | null) => (bp === null ? '–' : `${(bp / 100).toFixed(1)}%`);
	const windowLabel = $derived(r ? (r.win.months === 1 ? ymShort(r.win.yms[0]) : `${ymShort(r.win.yms[0])} to ${ymShort(r.win.yms.at(-1)!)}`) : '');

	interface Card extends Tile {
		spark: string;
		formula: string;
	}
	const cards = $derived.by((): Card[] => {
		if (!r) return [];
		const m = (x: number | null) => (x === null ? null : x);
		const arrHealth: Health = r.netNew > 0n ? 'good' : r.netNew === 0n ? 'watch' : 'poor';
		return [
			{
				key: 'arr',
				label: 'ARR',
				value: money(r.s.arr),
				health: arrHealth,
				inputs: `${formatMoney(r.netNew.toString(), { whole: true, compact: true, signed: true })} net new over ${windowLabel}`,
				yardstick: 'Annual recurring revenue from active contracts at the end of the window.',
				formula: 'Sum of active contracts’ annual value',
				spark: line((x) => Number(toBig(x.s.arr)) / 100),
				href: '/customers'
			},
			{
				key: 'nrr',
				label: 'Net revenue retention',
				value: pct(r.nrr),
				health: ndrHealth(r.nrr),
				inputs: `${money(r.w.expansion)} expansion · ${money(r.w.contraction)} contraction · ${money(r.w.churned)} churn`,
				yardstick: 'Over 100% means upgrades beat losses; 110% or more is strong for B2B SaaS.',
				formula: '(Start ARR + expansion - contraction - churn) / start ARR',
				spark: line((x) => m(x.nrr)),
				href: '/reports'
			},
			{
				key: 'grr',
				label: 'Gross revenue retention',
				value: pct(r.grr),
				health: grrHealth(r.grr),
				inputs: `${money(r.w.start)} ARR at the start`,
				yardstick: 'Revenue kept before upgrades, capped at 100%. 90% or more is healthy; under 80% is a leak.',
				formula: '(Start ARR - contraction - churn) / start ARR',
				spark: line((x) => m(x.grr))
			},
			{
				key: 'gm',
				label: 'Gross margin after inference',
				value: pct(r.gm),
				health: aiGrossMarginHealth(r.gm),
				inputs: `${money(r.s.revenue)} revenue over ${windowLabel}`,
				yardstick: 'AI products usually keep 50% to 65%; classic software 75% to 80%.',
				formula: '(Revenue - hosting - service engineering - model calls) / revenue',
				spark: line((x) => m(x.gm)),
				href: '/costs'
			},
			{
				key: 'burn-multiple',
				label: 'Burn multiple',
				value: r.multiple === null ? (r.burn > 0n ? 'No ARR added' : '–') : burnMultipleLabel(r.multiple),
				health: burnMultipleHealth(r.multiple, r.burn),
				inputs: `${money(r.burn)} burned · ${money(r.netNew)} net new ARR`,
				yardstick: 'Under 1× is great, 1× to 2× good; over 2× means growth costs too much.',
				formula: 'Net operating cash burn / net new ARR',
				spark: line((x) => x.multiple)
			},
			{
				key: 'cac',
				label: 'CAC payback',
				value: r.cac === null ? '–' : `${r.cac.toFixed(1)} months`,
				health: cacPaybackHealth(r.cac),
				inputs: `${money(r.sm)} sales and marketing · ${money(toBig(r.w.added) + toBig(r.w.expansion))} new and expansion ARR`,
				yardstick: 'Months of gross profit to earn back what was spent to win it. Under 12 is strong; over 24 is slow.',
				formula: 'S&M spend / ((new + expansion ARR) / 12 × gross margin)',
				spark: line((x) => x.cac),
				href: r.win ? drill({ type: ['expense'] }, { from: r.win.yms[0], to: r.win.yms.at(-1) }) : undefined
			},
			{
				key: 'runway',
				label: 'Runway',
				value: runwayLabel(r.runway),
				health: runwayHealth(r.runway.runwayMonths),
				inputs: `${money(r.runway.cash)} cash · ${money(r.runway.monthlyBurn)} a month of operating burn, averaged ${burnWindowLabel(r.runway.yms)}`,
				yardstick: '18 months or more is comfortable between rounds; under 9 means raise now.',
				formula: `Cash / average monthly operating burn over the last ${BURN_MONTHS} months, whatever the window`,
				spark: line((x) => (x.runway.runwayMonths === null ? null : Math.min(x.runway.runwayMonths, 60)))
			},
			{
				key: 'rpe',
				label: 'Revenue per employee',
				value: r.rpe === null ? '–' : money(r.rpe),
				health: revenuePerEmployeeHealth(r.rpe),
				inputs: `${money(r.s.revenue)} revenue, annualized · ${r.heads} full-time equivalents`,
				yardstick: 'Early AI startups aim for $150k to $250k a person; public SaaS runs $200k to $400k.',
				formula: 'Revenue × 12 / months in window / FTE',
				spark: line((x) => (x.rpe === null ? null : Number(x.rpe) / 100)),
				href: '/people'
			},
			{
				key: 'r40',
				label: 'Rule of 40',
				value: r.r40 ? `${r.r40.score.toFixed(0)}` : '–',
				health: ruleOf40Health(r.r40?.score ?? null),
				inputs: r.r40 ? `${r.r40.growthPct.toFixed(0)}% ARR growth, annualized · ${r.r40.marginPct.toFixed(0)}% net margin` : 'Needs ARR and revenue',
				yardstick: 'Growth plus profit margin; 40 or more is healthy.',
				formula: 'Annualized ARR growth % + net margin %',
				spark: line((x) => x.r40?.score ?? null)
			}
		];
	});

	// ARR movement: twelve months ending with the chosen month.
	const moves = $derived(endYm && first ? arrMovement(contracts, Array.from({ length: 12 }, (_, i) => shiftYm(endYm, i - 11)).filter((ym) => ym >= first)) : []);
	const W = 720;
	const H = 220;
	const PAD = 28;
	const chart = $derived.by(() => {
		const up = moves.map((x) => Number(x.added + x.expansion));
		const down = moves.map((x) => Number(x.contraction + x.churned));
		const top = Math.max(1, ...up);
		const bottom = Math.max(1, ...down);
		const zero = PAD + ((H - 2 * PAD) * top) / (top + bottom);
		const scale = (H - 2 * PAD) / (top + bottom);
		const slot = (W - 16) / Math.max(1, moves.length);
		const bar = Math.min(32, slot * 0.6);
		return {
			zero,
			bars: moves.map((x, i) => {
				const cx = 8 + slot * i + slot / 2;
				const h = (v: bigint) => Number(v) * scale;
				const segs = [
					{ key: 'added', y: zero - h(x.added), h: h(x.added), color: 'var(--pos)' },
					{ key: 'expansion', y: zero - h(x.added) - h(x.expansion), h: h(x.expansion), color: 'var(--info)' },
					{ key: 'contraction', y: zero, h: h(x.contraction), color: 'var(--warn)' },
					{ key: 'churned', y: zero + h(x.contraction), h: h(x.churned), color: 'var(--neg)' }
				];
				return { x: cx - bar / 2, cx, w: bar, segs, netY: zero - h(x.net), m: x };
			})
		};
	});
	const LEGEND = [
		{ key: 'added', label: 'New', color: 'var(--pos)' },
		{ key: 'expansion', label: 'Expansion', color: 'var(--info)' },
		{ key: 'contraction', label: 'Contraction', color: 'var(--warn)' },
		{ key: 'churned', label: 'Churn', color: 'var(--neg)' }
	];

	const ai = $derived(
		period && monthly.get(period.id)
			? aiTiles({
					ym: period.id,
					revenueMinor: monthly.get(period.id)!.s.revenue,
					now,
					cloudCosts: db.cloudCosts(),
					employees,
					batches: db.batches(),
					deals: db.deals(),
					tickets: db.supportTickets(),
					invoices: db.invoices(),
					contracts,
					rate
				})
			: null
	);
	const sections = $derived<{ id: string; title: string; note: string; tiles: Tile[] }[]>([
		{ id: 'unit', title: 'AI unit economics', note: `What it costs to serve a customer once models, cloud and on-call time are counted, for ${period ? periodShort(period) : ''}.`, tiles: ai?.unit ?? [] },
		{ id: 'credits', title: 'Usage credits', note: 'Prepaid credits are owed to customers until used; expired ones become revenue.', tiles: ai?.credits ?? [] },
		{ id: 'market', title: 'Customers and pipeline', note: 'From the connected CRM, support and billing tools, live.', tiles: ai?.market ?? [] }
	]);

	function setParam(key: string, v: string) {
		const u = new URL(page.url.href);
		u.searchParams.set(key, v);
		goto(u, { replace: true, reset: false });
	}
</script>

<svelte:head><title>Metrics · Luyten</title></svelte:head>

{#if period && r}
	<header class="flex flex-col gap-4 pb-6 md:flex-row md:items-end md:justify-between">
		<div class="flex flex-col gap-1">
			<p class="text-body-sm text-ink-2">{root?.name} · {windowLabel}</p>
			<h1 class="text-display">Metrics</h1>
			<p class="max-w-prose text-body-sm text-ink-2">
				Recurring revenue, retention, margin and efficiency, each with its trend over the last twelve months, the formula behind it and the yardstick investors read it against.
			</p>
		</div>
		<div class="flex flex-wrap items-end gap-2">
			<div class="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Window">
				{#each WINDOWS as w (w.id)}
					<button
						role="radio"
						aria-checked={windowId === w.id}
						class="rounded-sm px-3 py-1 text-body-sm {windowId === w.id ? 'bg-subtle font-medium text-ink' : 'text-ink-2 hover:text-ink'}"
						onclick={() => setParam('window', w.id)}>{w.label}</button
					>
				{/each}
			</div>
			<label class="flex flex-col gap-1 text-caption text-ink-2">
				Ending
				<select class="field text-ink" value={endYm} onchange={(e) => setParam('end', (e.currentTarget as HTMLSelectElement).value)}>
					{#each periods as p (p.id)}<option value={p.id}>{periodShort(p)}</option>{/each}
				</select>
			</label>
		</div>
	</header>

	<div class="flex flex-col gap-12">
		<section aria-labelledby="arr-h" class="flex flex-col gap-4">
			<div class="flex flex-col gap-1">
				<h2 id="arr-h" class="text-title">ARR movement</h2>
				<p class="text-body-sm text-ink-2">What added and what took away recurring revenue each month: new customers and upgrades above the line, downgrades and cancellations below it, the net change as a dot.</p>
			</div>
			<div class="card flex flex-col gap-4 p-5 lg:flex-row">
				<div class="min-w-0 flex-1">
					<svg viewBox="0 0 {W} {H}" class="h-auto w-full" role="img" aria-label="ARR movement by month, {trendLabel}">
						<line x1="0" x2={W} y1={chart.zero} y2={chart.zero} stroke="var(--line-strong)" stroke-width="1" />
						{#each chart.bars as b (b.m.ym)}
							<g>
								<title
									>{ymShort(b.m.ym)}: new {money(b.m.added)}, expansion {money(b.m.expansion)}, contraction {money(b.m.contraction)}, churn {money(b.m.churned)}, net {formatMoney(b.m.net.toString(), {
										whole: true,
										compact: true,
										signed: true
									})}</title
								>
								{#each b.segs as s (s.key)}{#if s.h > 0}<rect x={b.x} y={s.y} width={b.w} height={Math.max(1, s.h)} fill={s.color} rx="2" />{/if}{/each}
								<circle cx={b.cx} cy={b.netY} r="3.5" fill="var(--ink)" stroke="var(--surface)" stroke-width="1.5" />
								<text x={b.cx} y={H - 6} text-anchor="middle" font-size="11" fill="var(--ink-3)">{ymShort(b.m.ym).slice(0, 3)}</text>
							</g>
						{/each}
					</svg>
					<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-2">
						{#each LEGEND as l (l.key)}<span class="flex items-center gap-1.5"><svg class="size-2.5" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill={l.color} /></svg>{l.label}</span>{/each}
						<span class="flex items-center gap-1.5"><svg class="size-2.5" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="var(--ink)" /></svg>Net change</span>
					</div>
				</div>
				<table class="w-full shrink-0 text-body-sm lg:w-64">
					<caption class="pb-2 text-left text-caption text-ink-3">{windowLabel}</caption>
					<tbody>
						<tr><th scope="row" class="py-1 text-left font-normal text-ink-2">Starting ARR</th><td class="num py-1 text-right">{money(r.w.start)}</td></tr>
						<tr><th scope="row" class="py-1 text-left font-normal text-ink-2">New</th><td class="num py-1 text-right">+{money(r.w.added)}</td></tr>
						<tr><th scope="row" class="py-1 text-left font-normal text-ink-2">Expansion</th><td class="num py-1 text-right">+{money(r.w.expansion)}</td></tr>
						<tr><th scope="row" class="py-1 text-left font-normal text-ink-2">Contraction</th><td class="num py-1 text-right">-{money(r.w.contraction)}</td></tr>
						<tr><th scope="row" class="py-1 text-left font-normal text-ink-2">Churn</th><td class="num py-1 text-right">-{money(r.w.churned)}</td></tr>
						<tr class="border-t border-line font-medium"><th scope="row" class="py-1 text-left">Ending ARR</th><td class="num py-1 text-right">{money(r.w.end)}</td></tr>
					</tbody>
				</table>
			</div>
		</section>

		<section aria-labelledby="saas-h" class="flex flex-col gap-4">
			<div class="flex flex-col gap-1">
				<h2 id="saas-h" class="text-title">SaaS metrics</h2>
				<p class="text-body-sm text-ink-2">Over {windowLabel}. Each line shows the same reading for windows ending in each of the last twelve months{trendLabel ? ` (${trendLabel})` : ''}.</p>
			</div>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
				{#each cards as t (t.key)}
					<MetricTile label={t.label} value={t.value} health={t.health} inputs={t.inputs} yardstick={t.yardstick} href={t.href} spark={t.spark} sparkLabel="{t.label}, {trendLabel}" formula={t.formula} />
				{/each}
			</div>
		</section>

		{#each sections as sec (sec.id)}
			<section aria-labelledby="{sec.id}-h" class="flex flex-col gap-4">
				<div class="flex flex-col gap-1">
					<h2 id="{sec.id}-h" class="text-title">{sec.title}</h2>
					<p class="text-body-sm text-ink-2">{sec.note}</p>
				</div>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{#each sec.tiles as t (t.key)}
						<MetricTile label={t.label} value={t.value} health={t.health} inputs={t.inputs} yardstick={t.yardstick} href={t.href} />
					{/each}
				</div>
			</section>
		{/each}
	</div>
{/if}
