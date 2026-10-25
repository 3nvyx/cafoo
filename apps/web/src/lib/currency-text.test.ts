import { describe, expect, it } from 'vitest';
import type { FxRate } from './data/types';
import { reportingFirst } from './currency-text';

const rates: FxRate[] = [{ id: 'r1', fromCcy: 'GBP', toCcy: 'USD', ym: '2026-09', rateE6: '1250000', kind: 'closing' }];
const ctx = { rates, reportingCcy: 'USD', ym: '2026-09' };

describe('reportingFirst', () => {
	it('puts the reporting currency first and the pounds in brackets', () => {
		expect(reportingFirst("Restate what Cafoo Ltd owes in dollars at the month's closing rate, a £4,404.78 gain.", ctx)).toBe(
			"Restate what Cafoo Ltd owes in dollars at the month's closing rate, a $5,505.98 gain (£4,404.78)."
		);
	});
	it('handles a loss and an amount with no cents', () => {
		expect(reportingFirst('a £1,000 loss', ctx)).toBe('a $1,250.00 loss (£1,000)');
	});
	it('leaves text alone when there is no rate, no match or the amount is already in the reporting currency', () => {
		expect(reportingFirst('a £10.00 gain', { ...ctx, ym: '2026-08' })).toBe('a £10.00 gain');
		expect(reportingFirst('Paid £10.00 to Ridgeway', ctx)).toBe('Paid £10.00 to Ridgeway');
		expect(reportingFirst('a £10.00 gain', { ...ctx, reportingCcy: 'GBP' })).toBe('a £10.00 gain');
	});
	it('uses the inverse of a recorded rate', () => {
		const inv: FxRate[] = [{ id: 'r2', fromCcy: 'USD', toCcy: 'GBP', ym: '2026-09', rateE6: '800000', kind: 'closing' }];
		expect(reportingFirst('a £800.00 gain', { ...ctx, rates: inv })).toBe('a $1,000.00 gain (£800.00)');
	});
});
