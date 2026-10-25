// The shared calendar's logic: what goes on it, how a month is laid out in weeks, and how multi-day entries stack in
// lanes. Days are `YYYY-MM-DD` strings throughout, read as UTC, so no time zone can move an entry by a day.
import type { CalendarEvent, CalendarTag, Employee, PayRun, PayRunStatus, PtoKind, PtoRequest } from './data/types.js';
import { payDates, type Region } from './payroll.js';

/** Each tag's names (filter chip, single entry) and colour pair. The classes are written out in full so Tailwind sees them. */
export const TAGS: Record<CalendarTag, { label: string; one: string; fill: string; text: string }> = {
	leave: { label: 'Leave', one: 'Leave', fill: 'bg-tag-leave-soft', text: 'text-on-tag-leave-soft' },
	sick: { label: 'Sick days', one: 'Sick day', fill: 'bg-tag-sick-soft', text: 'text-on-tag-sick-soft' },
	pay: { label: 'Payroll', one: 'Payroll', fill: 'bg-tag-pay-soft', text: 'text-on-tag-pay-soft' },
	due: { label: 'Due dates', one: 'Due date', fill: 'bg-tag-due-soft', text: 'text-on-tag-due-soft' },
	holiday: { label: 'Holidays', one: 'Holiday', fill: 'bg-tag-holiday-soft', text: 'text-on-tag-holiday-soft' }
};
export const TAG_ORDER: CalendarTag[] = ['pay', 'leave', 'sick', 'due', 'holiday'];

const PTO_TITLE: Record<PtoKind, string> = {
	vacation: 'Vacation',
	sick: 'Sick',
	parental: 'Parental leave',
	bereavement: 'Bereavement',
	jury_duty: 'Jury duty',
	unpaid: 'Unpaid leave'
};

/** One entry as the calendar shows it, whichever table it came from. */
export interface CalendarItem {
	/** Unique across sources: `event:cal-01`, `pto:pto-05`. */
	id: string;
	tag: CalendarTag;
	title: string;
	startDay: string;
	endDay: string;
	/** Who it is about, in full, when it is about someone. */
	who?: string;
	/** Still waiting for the CFO; drawn as an outline instead of a fill. */
	pending: boolean;
	note?: string;
	source: 'event' | 'pto' | 'payroll';
}

/**
 * Everything on the calendar: hand-made entries plus time off. Declined requests are left out; pending ones stay,
 * marked, so the CFO sees what approving them would put on the calendar.
 */
export function calendarItems(events: CalendarEvent[], pto: PtoRequest[], employees: Employee[]): CalendarItem[] {
	const name = (id?: string) => (id ? employees.find((e) => e.id === id)?.name : undefined);
	return [
		...events.map((e) => ({
			id: `event:${e.id}`,
			tag: e.tag,
			title: e.title,
			startDay: e.startDay,
			endDay: e.endDay,
			who: name(e.employeeId),
			pending: false,
			note: e.notePlain,
			source: 'event' as const
		})),
		...pto
			.filter((r) => r.status !== 'declined')
			.map((r) => ({
				id: `pto:${r.id}`,
				tag: r.kind === 'sick' ? ('sick' as const) : ('leave' as const),
				title: PTO_TITLE[r.kind],
				startDay: r.startAt.slice(0, 10),
				endDay: r.endAt.slice(0, 10),
				who: name(r.employeeId) ?? r.employeeId,
				pending: r.status === 'pending',
				note: r.notePlain,
				source: 'pto' as const
			}))
	];
}

const RUN_WORD: Record<PayRunStatus, string> = { draft: 'contractor pay, so far', scheduled: 'scheduled', processing: 'processing', paid: 'paid' };

/**
 * The pay calendar as calendar entries: each payday and each payroll debit (when Gusto draws the money, two banking
 * days earlier), one entry per day with every company on it. Runs Gusto already has come first; the pay dates still
 * to come through `through` (a `YYYY-MM`) that Gusto has not scheduled yet are added, marked as estimates.
 */
export function payrollItems(runs: PayRun[], companies: { id: string; name: string; region: Region }[], through: string): CalendarItem[] {
	const byDay = new Map<string, { kind: 'payday' | 'debit'; day: string; lines: string[] }>();
	const add = (kind: 'payday' | 'debit', day: string, line: string) => {
		const key = `${kind}:${day}`;
		const at = byDay.get(key) ?? byDay.set(key, { kind, day, lines: [] }).get(key)!;
		at.lines.push(line);
	};
	for (const c of companies) {
		const own = runs.filter((r) => r.subsidiaryId === c.id);
		for (const r of own) {
			add('payday', r.payDate.slice(0, 10), `${c.name}, ${r.employeeCount} ${r.employeeCount === 1 ? 'person' : 'people'}, ${RUN_WORD[r.status]}`);
			add('debit', r.debitDate.slice(0, 10), `${c.name}, ${RUN_WORD[r.status]}`);
		}
		const known = new Set(own.map((r) => r.payDate.slice(0, 10)));
		const last = own.map((r) => r.payDate.slice(0, 7)).sort().at(-1);
		if (!last) continue;
		for (let ym = last; ym <= through; ym = shiftMonth(ym, 1)) {
			for (const p of payDates(c.region, ym)) {
				if (known.has(p.payDate)) continue;
				add('payday', p.payDate, `${c.name}, not in Gusto yet`);
				add('debit', p.debitDate, `${c.name}, not in Gusto yet`);
			}
		}
	}
	return [...byDay.values()].map((d) => ({
		id: `payroll:${d.kind}:${d.day}`,
		tag: 'pay' as const,
		title: d.kind === 'payday' ? 'Payday' : 'Payroll debit',
		startDay: d.day,
		endDay: d.day,
		pending: false,
		note: d.lines.join(' · '),
		source: 'payroll' as const
	}));
}

/** The text on a bar: "Priya · Vacation" for a person's entry, the title alone otherwise. */
export const barText = (i: CalendarItem) => (i.who ? `${i.who.split(' ')[0]} · ${i.title}` : i.title);

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
	const d = toDate(day);
	d.setUTCDate(d.getUTCDate() + n);
	return iso(d);
}

/** `2026-10` moved by `n` months. */
export function shiftMonth(ym: string, n: number): string {
	const d = toDate(`${ym}-01`);
	d.setUTCMonth(d.getUTCMonth() + n);
	return iso(d).slice(0, 7);
}

/** Day `d` of a month, or its last day when the month is shorter (the 31st of February is the 28th). */
export function dayIn(ym: string, d: number): string {
	const last = Number(addDays(`${shiftMonth(ym, 1)}-01`, -1).slice(8));
	return `${ym}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Monday 0 … Sunday 6. */
export const weekday = (day: string) => (toDate(day).getUTCDay() + 6) % 7;

/** The weeks that show a month, Monday first, padded with the days either side so every week has seven. */
export function monthWeeks(ym: string): string[][] {
	const first = `${ym}-01`;
	let day = addDays(first, -weekday(first));
	const weeks: string[][] = [];
	while (weeks.length === 0 || day.slice(0, 7) === ym) {
		const week = Array.from({ length: 7 }, (_, i) => addDays(day, i));
		weeks.push(week);
		day = addDays(day, 7);
	}
	return weeks;
}

export const isOn = (i: CalendarItem, day: string) => i.startDay <= day && i.endDay >= day;

/** Whole days an entry covers, both ends included. */
export const spanDays = (i: Pick<CalendarItem, 'startDay' | 'endDay'>) => Math.round((toDate(i.endDay).getTime() - toDate(i.startDay).getTime()) / 86_400_000) + 1;

/** One entry's bar within one week. */
export interface Segment {
	item: CalendarItem;
	/** First column, Monday 0. */
	col: number;
	span: number;
	lane: number;
	/** The entry runs on from the week before or into the week after, so that end of the bar is drawn square. */
	fromBefore: boolean;
	intoAfter: boolean;
}

/**
 * Stacks a week's entries into at most `lanes` rows of bars: earliest first, longer first on the same day, each in
 * the lowest lane free for all its days. What does not fit is counted per day for the "+2 more" line.
 */
export function layoutWeek(week: string[], items: CalendarItem[], lanes: number): { segments: Segment[]; hidden: number[] } {
	const [first, last] = [week[0], week[6]];
	const order = (i: CalendarItem) => TAG_ORDER.indexOf(i.tag);
	const here = items
		.filter((i) => i.startDay <= last && i.endDay >= first)
		.sort((a, b) => a.startDay.localeCompare(b.startDay) || b.endDay.localeCompare(a.endDay) || order(a) - order(b) || a.id.localeCompare(b.id));
	const taken = Array.from({ length: lanes }, () => Array<boolean>(7).fill(false));
	const segments: Segment[] = [];
	const hidden = Array<number>(7).fill(0);
	for (const item of here) {
		const col = item.startDay < first ? 0 : week.indexOf(item.startDay);
		const end = item.endDay > last ? 6 : week.indexOf(item.endDay);
		const lane = taken.findIndex((row) => row.slice(col, end + 1).every((t) => !t));
		if (lane < 0) {
			for (let c = col; c <= end; c++) hidden[c]++;
			continue;
		}
		for (let c = col; c <= end; c++) taken[lane][c] = true;
		segments.push({ item, col, span: end - col + 1, lane, fromBefore: item.startDay < first, intoAfter: item.endDay > last });
	}
	return { segments, hidden };
}
