import { expect, it } from 'vitest';
import { inReportScope } from './report-scope';

const invoice = { customerId: 'c-uk', amountMinor: '10000' };
const scope = {
	scope: 'group',
	rootId: 's-us',
	reportingCcy: 'USD',
	periodYm: '2026-09',
	customerSubs: new Map([['c-uk', 's-uk']]),
	subCcy: new Map([['s-us', 'USD'], ['s-uk', 'GBP']]),
	rates: []
};

it('fails visibly when a group invoice lacks the closing FX rate', () => {
	expect(() => inReportScope([invoice], scope, (row) => row.customerId, (row, convert) => ({ ...row, amountMinor: convert(row.amountMinor) })))
		.toThrow(/no closing rate from GBP to USD for 2026-09/i);
});
