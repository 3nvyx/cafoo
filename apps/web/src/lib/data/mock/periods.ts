// Which month new demo data books into. Pure, so the mock and its tests share it.
import type { Period } from '../types';

/**
 * The month the clock is in while that month is open; otherwise the earliest month not locked. On the demo's
 * October 2 that is "2026-10", so uploads and connected tools book into October while September closes.
 * Undefined when every month is locked.
 */
export function currentOpenPeriodId(periods: Pick<Period, 'id' | 'status'>[], nowIso: string): string | undefined {
	const ym = nowIso.slice(0, 7);
	const current = periods.find((p) => p.id === ym && p.status !== 'closed');
	if (current) return current.id;
	return periods
		.filter((p) => p.status !== 'closed')
		.map((p) => p.id)
		.sort()[0];
}

/** Whether month "yyyy-mm" has ended by `nowIso`. */
export function monthEnded(ym: string, nowIso: string): boolean {
	return nowIso.slice(0, 7) > ym;
}
