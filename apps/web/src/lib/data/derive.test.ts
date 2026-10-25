import { describe, expect, it } from 'vitest';
import { nrrBp, type ArrWaterfall } from './derive';

const w = (start: number, expansion = 0, contraction = 0, churned = 0, added = 0): ArrWaterfall => ({
	start: String(start),
	added: String(added),
	expansion: String(expansion),
	contraction: String(contraction),
	churned: String(churned),
	end: String(start + added + expansion - contraction - churned),
	from: '2026-07-01',
	to: '2026-09-30'
});

describe('nrrBp (net revenue retention, as @luyten/ledger-core nrr() reports it)', () => {
	it('is what the starting customers are worth now, in basis points, leaving out new customers', () => {
		expect(nrrBp(w(100_000, 20_000, 5_000, 10_000, 50_000))).toBe(10_500);
	});

	it('floors like the engine (floor(ending * 10000 / starting))', () => {
		expect(nrrBp(w(3, 0, 1))).toBe(6_666);
	});

	it('has no value when nobody had ARR at the start', () => {
		expect(nrrBp(w(0, 0, 0, 0, 40_000))).toBeNull();
	});
});
