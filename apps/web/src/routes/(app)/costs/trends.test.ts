import { describe, expect, it } from 'vitest';
import type { CloudCost } from '#lib/data/types.js';
import { seriesBy, spikes, topInferenceProduct } from './trends';

const row = (ym: string, provider: CloudCost['provider'], service: string, dollars: number, product?: string): CloudCost => ({
	id: `${ym}-${provider}-${service}`,
	subsidiaryId: 's',
	provider,
	service,
	ym,
	environment: 'production',
	category: 'cost_of_revenue',
	amountMinor: String(dollars * 100),
	ccy: 'USD',
	usageQuantity: 1,
	usageUnit: 'GPU-hours',
	product
});

describe('seriesBy', () => {
	it('sums each key per month and folds the tail into other', () => {
		const rows = [row('2026-01', 'aws', 'a', 10), row('2026-02', 'aws', 'a', 20), row('2026-02', 'gcp', 'b', 5), row('2026-02', 'vercel', 'c', 1), row('2026-01', 'github', 'd', 2)];
		const s = seriesBy(rows, ['2026-01', '2026-02'], (r) => r.provider, 1);
		expect(s).toEqual([
			{ key: 'aws', values: [1000n, 2000n], total: 3000n },
			{ key: 'other', values: [200n, 600n], total: 800n }
		]);
		expect(seriesBy([], ['2026-01'], (r) => r.provider)).toEqual([]);
	});
});

describe('spikes', () => {
	it('flags a month well above the previous three', () => {
		// Previous three months: 10,000, 11,000, 12,000 dollars, average 11,000. 15,180 is 38% above.
		const rows = [row('2026-01', 'aws', 'GPU', 10_000), row('2026-02', 'aws', 'GPU', 11_000), row('2026-03', 'aws', 'GPU', 12_000), row('2026-04', 'aws', 'GPU', 15_180), row('2026-05', 'aws', 'GPU', 12_500)];
		expect(spikes(rows)).toEqual([{ ym: '2026-04', provider: 'aws', service: 'GPU', amountMinor: 1_518_000n, baselineMinor: 1_100_000n, upBp: 3800 }]);
	});

	it('ignores steady growth and small lines', () => {
		const steady = ['2026-01', '2026-02', '2026-03', '2026-04'].map((m, i) => row(m, 'aws', 'GPU', 10_000 + i * 1_000));
		const small = ['2026-01', '2026-02', '2026-03', '2026-04'].map((m, i) => row(m, 'vercel', 'web', i === 3 ? 900 : 100));
		expect(spikes([...steady, ...small])).toEqual([]);
		expect(spikes([])).toEqual([]);
	});
});

describe('topInferenceProduct', () => {
	it('picks the product with the most inference cost that month', () => {
		const rows = [row('2026-01', 'anthropic', 'Claude', 900, 'Extract API'), row('2026-01', 'openai', 'Embed', 200, 'Search'), row('2026-02', 'openai', 'Embed', 5_000, 'Search')];
		expect(topInferenceProduct(rows, '2026-01', () => true)).toBe('Extract API');
		expect(topInferenceProduct(rows, '2025-12', () => true)).toBeUndefined();
	});
});
