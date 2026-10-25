import { describe, expect, it } from 'vitest';
import type { CalendarEvent, Employee, PayRun, PtoRequest } from './data/types.js';
import { addDays, calendarItems, dayIn, payrollItems, layoutWeek, monthWeeks, shiftMonth, spanDays, weekday, type CalendarItem } from './calendar.js';

const people = [{ id: 'emp-03', name: 'Priya Raman' }] as Employee[];
const pto = (id: string, status: PtoRequest['status'], kind: PtoRequest['kind'] = 'vacation'): PtoRequest => ({
	id,
	employeeId: 'emp-03',
	kind,
	startAt: '2026-10-08T00:00:00Z',
	endAt: '2026-10-09T00:00:00Z',
	hours: 16,
	status
});
const item = (id: string, startDay: string, endDay: string): CalendarItem => ({ id, tag: 'holiday', title: id, startDay, endDay, pending: false, source: 'event' });

describe('calendar days', () => {
	it('moves across month and year ends', () => {
		expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(shiftMonth('2026-12', 1)).toBe('2027-01');
		expect(shiftMonth('2026-01', -1)).toBe('2025-12');
		expect(dayIn('2026-02', 31)).toBe('2026-02-28');
		expect(dayIn('2026-10', 9)).toBe('2026-10-09');
		expect(weekday('2026-10-05')).toBe(0); // a Monday
		expect(spanDays({ startDay: '2026-10-19', endDay: '2026-10-23' })).toBe(5);
	});

	it('lays October 2026 out in Monday-first weeks, padded with the days either side', () => {
		const weeks = monthWeeks('2026-10');
		expect(weeks).toHaveLength(5);
		expect(weeks[0][0]).toBe('2026-09-28');
		expect(weeks[0][3]).toBe('2026-10-01');
		expect(weeks.at(-1)!.at(-1)).toBe('2026-11-01');
		expect(weeks.every((w) => w.length === 7)).toBe(true);
	});

	it('gives a month that starts on a Monday no leading days', () => {
		expect(monthWeeks('2026-06')[0][0]).toBe('2026-06-01');
	});
});

describe('calendarItems', () => {
	const events: CalendarEvent[] = [{ id: 'cal-04', tag: 'holiday', title: 'Christmas Day', startDay: '2026-12-25', endDay: '2026-12-25' }];

	it('puts hand-made entries and time off on one list, leaving declined requests out', () => {
		const items = calendarItems(events, [pto('pto-a', 'approved'), pto('pto-b', 'declined'), pto('pto-c', 'pending')], people);
		expect(items.map((i) => i.id)).toEqual(['event:cal-04', 'pto:pto-a', 'pto:pto-c']);
	});

	it('marks requests still waiting for the CFO, and files sick days under their own tag', () => {
		const [approved, waiting, sick] = calendarItems([], [pto('a', 'taken'), pto('b', 'pending'), pto('c', 'approved', 'sick')], people);
		expect(approved).toMatchObject({ tag: 'leave', title: 'Vacation', who: 'Priya Raman', startDay: '2026-10-08', endDay: '2026-10-09', pending: false });
		expect(waiting.pending).toBe(true);
		expect(sick.tag).toBe('sick');
	});
});

describe('payrollItems', () => {
	const run = (id: string, subsidiaryId: string, payDate: string, debitDate: string, status: PayRun['status']) =>
		({ id, subsidiaryId, payDate: `${payDate}T00:00:00Z`, debitDate: `${debitDate}T00:00:00Z`, status, employeeCount: 3 }) as PayRun;
	const companies = [
		{ id: 'sub-us', name: 'Cafoo Inc', region: 'US' as const },
		{ id: 'sub-uk', name: 'Cafoo Ltd', region: 'UK' as const }
	];
	const runs = [run('us-a', 'sub-us', '2026-10-15', '2026-10-13', 'processing'), run('us-b', 'sub-us', '2026-10-30', '2026-10-28', 'scheduled'), run('uk', 'sub-uk', '2026-10-30', '2026-10-28', 'scheduled')];

	it('puts one payday and one debit on each day, with every company paid that day', () => {
		const items = payrollItems(runs, companies, '2026-10');
		expect(items.map((i) => i.id).sort()).toEqual(['payroll:debit:2026-10-13', 'payroll:debit:2026-10-28', 'payroll:payday:2026-10-15', 'payroll:payday:2026-10-30']);
		const shared = items.find((i) => i.id === 'payroll:payday:2026-10-30')!;
		expect(shared).toMatchObject({ tag: 'pay', title: 'Payday', source: 'payroll' });
		expect(shared.note).toBe('Cafoo Inc, 3 people, scheduled · Cafoo Ltd, 3 people, scheduled');
	});

	it('adds the pay dates Gusto has not scheduled yet, through the month asked for', () => {
		const later = payrollItems(runs, companies, '2026-11').filter((i) => i.note?.includes('not in Gusto yet'));
		// November: Cafoo Inc on the 13th (the 15th is a Sunday) and the 30th; Cafoo Ltd on the 30th.
		expect(later.filter((i) => i.title === 'Payday').map((i) => [i.startDay, i.note])).toEqual([
			['2026-11-13', 'Cafoo Inc, not in Gusto yet'],
			['2026-11-30', 'Cafoo Inc, not in Gusto yet · Cafoo Ltd, not in Gusto yet']
		]);
	});
});

describe('layoutWeek', () => {
	const week = monthWeeks('2026-10')[1]; // Oct 5 to Oct 11

	it('places each entry in the lowest free lane and squares the ends that run past the week', () => {
		const { segments, hidden } = layoutWeek(week, [item('long', '2026-09-30', '2026-10-20'), item('a', '2026-10-06', '2026-10-07'), item('b', '2026-10-08', '2026-10-08')], 3);
		expect(segments.map((s) => [s.item.id, s.col, s.span, s.lane])).toEqual([
			['long', 0, 7, 0],
			['a', 1, 2, 1],
			['b', 3, 1, 1]
		]);
		expect(segments[0]).toMatchObject({ fromBefore: true, intoAfter: true });
		expect(hidden).toEqual([0, 0, 0, 0, 0, 0, 0]);
	});

	it('counts what does not fit, per day', () => {
		const items = ['a', 'b', 'c'].map((id) => item(id, '2026-10-06', '2026-10-07'));
		const { segments, hidden } = layoutWeek(week, items, 2);
		expect(segments).toHaveLength(2);
		expect(hidden).toEqual([0, 1, 1, 0, 0, 0, 0]);
	});
});
