<script lang="ts">
	// The shared calendar: one month at a time, Monday first, with every entry as a bar across its days. Bars stack in
	// up to three lanes and the rest shows as "+2 more"; picking a day lists everything on it below the grid. Filter
	// chips hide whole tags. Time off still waiting for the CFO is an outline, so approving it visibly fills it in.
	import { tick } from 'svelte';
	import type { CalendarTag } from '#lib/data/types.js';
	import { TAGS, TAG_ORDER, addDays, barText, dayIn, isOn, layoutWeek, monthWeeks, shiftMonth, spanDays, weekday, type CalendarItem } from '#lib/calendar.js';
	import Icon from './Icon.svelte';

	let { items, today, title = 'Calendar' }: { items: CalendarItem[]; today: string; title?: string } = $props();

	const LANES = 3;
	const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
	const uid = $props.id();

	// svelte-ignore state_referenced_locally -- the calendar opens on today's month; it moves on its own after that.
	let month = $state(today.slice(0, 7));
	// svelte-ignore state_referenced_locally
	let selected = $state(today);
	let hiddenTags = $state<CalendarTag[]>([]);
	let grid: HTMLDivElement | undefined = $state();

	const weeks = $derived(monthWeeks(month));
	const inView = $derived(items.filter((i) => i.startDay <= weeks.at(-1)![6] && i.endDay >= weeks[0][0]));
	const visible = $derived(inView.filter((i) => !hiddenTags.includes(i.tag)));
	const layouts = $derived(weeks.map((w) => layoutWeek(w, visible, LANES)));
	const onSelected = $derived(visible.filter((i) => isOn(i, selected)).sort((a, b) => TAG_ORDER.indexOf(a.tag) - TAG_ORDER.indexOf(b.tag) || a.startDay.localeCompare(b.startDay)));
	const counts = $derived(Object.fromEntries(TAG_ORDER.map((t) => [t, inView.filter((i) => i.tag === t).length])) as Record<CalendarTag, number>);
	const anyPending = $derived(visible.some((i) => i.pending));

	const fmt = (day: string, o: Intl.DateTimeFormatOptions) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' });
	const monthLabel = $derived(fmt(`${month}-01`, { month: 'long', year: 'numeric' }));
	const short = (day: string) => fmt(day, { month: 'short', day: 'numeric' });
	const range = (i: CalendarItem) => (i.startDay === i.endDay ? short(i.startDay) : `${short(i.startDay)} to ${short(i.endDay)} · ${spanDays(i)} days`);

	function dayLabel(day: string) {
		const n = visible.filter((i) => isOn(i, day)).length;
		return `${fmt(day, { weekday: 'long', month: 'long', day: 'numeric' })}${day === today ? ', today' : ''}, ${n === 0 ? 'nothing on' : n === 1 ? '1 entry' : `${n} entries`}`;
	}

	function toggle(tag: CalendarTag) {
		hiddenTags = hiddenTags.includes(tag) ? hiddenTags.filter((t) => t !== tag) : [...hiddenTags, tag];
	}

	function go(n: number) {
		month = shiftMonth(month, n);
		// Keep the picked day in view: the same day of the new month, or its last day.
		selected = dayIn(month, Number(selected.slice(8)));
	}

	function goToday() {
		month = today.slice(0, 7);
		selected = today;
	}

	/** Arrow keys walk the days (a week up or down), Home and End the week, Page Up and Down the month. */
	async function onkey(e: KeyboardEvent) {
		const moves: Record<string, () => string> = {
			ArrowLeft: () => addDays(selected, -1),
			ArrowRight: () => addDays(selected, 1),
			ArrowUp: () => addDays(selected, -7),
			ArrowDown: () => addDays(selected, 7),
			Home: () => addDays(selected, -weekday(selected)),
			End: () => addDays(selected, 6 - weekday(selected)),
			PageUp: () => dayIn(shiftMonth(selected.slice(0, 7), -1), Number(selected.slice(8))),
			PageDown: () => dayIn(shiftMonth(selected.slice(0, 7), 1), Number(selected.slice(8)))
		};
		const move = moves[e.key];
		if (!move) return;
		e.preventDefault();
		const next = move();
		selected = next;
		if (next.slice(0, 7) !== month) month = next.slice(0, 7);
		await tick();
		grid?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus();
	}
</script>

<section aria-labelledby="{uid}-h" class="card flex flex-col">
	<div class="flex flex-col gap-4 p-5 pb-4">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex flex-col gap-0.5">
				<h2 id="{uid}-h" class="text-title">{title}</h2>
				<p class="text-body-sm text-ink-2" aria-live="polite">{monthLabel}</p>
			</div>
			<div class="flex items-center gap-1">
				<button type="button" class="btn btn-quiet" onclick={goToday} disabled={month === today.slice(0, 7) && selected === today}>Today</button>
				<button type="button" class="btn btn-quiet w-11 px-0" aria-label="Previous month" onclick={() => go(-1)}><Icon name="chevronLeft" size={18} /></button>
				<button type="button" class="btn btn-quiet w-11 px-0" aria-label="Next month" onclick={() => go(1)}><Icon name="chevronRight" size={18} /></button>
			</div>
		</div>

		<div class="flex flex-wrap gap-1" role="group" aria-label="Show on the calendar">
			<!-- A tag shown wears its own colour pair, like its bars; a hidden one goes back to a plain chip. -->
			{#each TAG_ORDER as t (t)}
				{@const on = !hiddenTags.includes(t)}
				<button type="button" class="chip {on ? `border-transparent ${TAGS[t].fill} ${TAGS[t].text}` : 'text-ink-3'}" aria-pressed={on} onclick={() => toggle(t)}>
					{#if on}<Icon name="check" size={14} />{:else}<span class="size-3.5 rounded-sm border border-line-strong" aria-hidden="true"></span>{/if}
					{TAGS[t].label}
					<span class="num text-caption">{counts[t]}</span>
				</button>
			{/each}
		</div>
	</div>

	<div bind:this={grid} class="border-t border-line" role="group" aria-label="{monthLabel}. Use the arrow keys to move between days.">
		<div class="grid grid-cols-7 text-caption text-ink-3" aria-hidden="true">
			{#each WEEKDAYS as d (d)}<span class="px-2 py-1.5">{d}</span>{/each}
		</div>
		{#each weeks as week, w (week[0])}
			{@const lay = layouts[w]}
			<div class="relative min-h-20 border-t border-line sm:min-h-28">
				<!-- The days: full-height buttons behind the bars, so a click anywhere in a day picks it. -->
				<div class="absolute inset-0 grid grid-cols-7">
					{#each week as day, c (day)}
						{@const pick = day === selected}
						<button
							type="button"
							data-day={day}
							tabindex={pick ? 0 : -1}
							class="flex items-start p-1.5 transition-colors {c > 0 ? 'border-l border-line' : ''} {pick ? 'bg-accent-soft' : 'hover:bg-subtle'}"
							aria-label={dayLabel(day)}
							aria-pressed={pick}
							aria-current={day === today ? 'date' : undefined}
							onclick={() => (selected = day)}
							onkeydown={onkey}
						>
							<span
								class="num inline-flex size-6 items-center justify-center rounded-full text-caption {day === today
									? 'bg-inverse font-semibold text-on-inverse'
									: day.slice(0, 7) === month
										? pick
											? 'font-semibold text-on-accent-soft'
											: 'text-ink'
										: 'text-ink-3'}">{Number(day.slice(8))}</span
							>
						</button>
					{/each}
				</div>
				<!-- The bars: read out through each day's label and the list below, so hidden from assistive tech here. -->
				<div class="pointer-events-none relative grid grid-cols-7 content-start gap-y-1 pt-9 pb-1.5" aria-hidden="true">
					{#each lay.segments as s (s.item.id)}
						<span
							class="flex h-1.5 min-w-0 items-center rounded-sm text-caption sm:h-5 sm:px-1.5 {s.fromBefore ? 'rounded-l-none' : 'ml-1'} {s.intoAfter ? 'rounded-r-none' : 'mr-1'} {s.item.pending
								? `border border-dashed border-line bg-surface ${TAGS[s.item.tag].text}`
								: `${TAGS[s.item.tag].fill} ${TAGS[s.item.tag].text}`}"
							style="grid-column: {s.col + 1} / span {s.span}; grid-row: {s.lane + 1}"
						>
							<span class="hidden truncate font-medium sm:inline">{barText(s.item)}</span>
						</span>
					{/each}
					{#each lay.hidden as n, c (c)}
						{#if n}
							<span class="truncate px-1.5 text-micro text-ink-2" style="grid-column: {c + 1}; grid-row: {LANES + 1}">
								<span class="sm:hidden">+{n}</span><span class="hidden sm:inline">+{n} more</span>
							</span>
						{/if}
					{/each}
				</div>
			</div>
		{/each}
	</div>

	<div class="flex flex-col gap-3 border-t border-line p-5" aria-live="polite">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h3 class="text-body font-medium">{fmt(selected, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
			{#if anyPending}<p class="text-caption text-ink-3">Dashed outline: time off still waiting for your approval.</p>{/if}
		</div>
		{#if onSelected.length}
			<ul class="flex flex-col divide-y divide-line">
				{#each onSelected as i (i.id)}
					<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
						<span class="inline-flex w-20 shrink-0 justify-center rounded-sm px-2 py-0.5 text-caption font-semibold {i.pending ? `border border-dashed border-line bg-surface ${TAGS[i.tag].text}` : `${TAGS[i.tag].fill} ${TAGS[i.tag].text}`}">{TAGS[i.tag].one}</span>
						<span class="min-w-0 flex-1">
							<span class="font-medium">{i.who ? `${i.who} · ${i.title}` : i.title}</span>
							<span class="block text-caption text-ink-3">{range(i)}{i.pending ? ' · waiting for your approval' : ''}{i.note ? ` · ${i.note}` : ''}</span>
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-body-sm text-ink-3">Nothing on this day{hiddenTags.length ? ' among the tags shown' : ''}.</p>
		{/if}
	</div>
</section>
