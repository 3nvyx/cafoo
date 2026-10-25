import type { FxRate } from './types';
import { atClosingRate } from './group';
import { toBig } from './money';

type ReportScope = Readonly<{
	scope: string;
	rootId: string | undefined;
	reportingCcy: string;
	periodYm: string;
	customerSubs: ReadonlyMap<string, string>;
	subCcy: ReadonlyMap<string, string>;
	rates: FxRate[];
}>;

/** Select customer rows and translate them for a group report. Missing source data or FX stops the report. */
export function inReportScope<T>(
	rows: readonly T[],
	input: ReportScope,
	customerId: (row: T) => string,
	withConvertedAmount: (row: T, convert: (minor: string) => string) => T
): T[] {
	return rows.flatMap((row) => {
		const customer = customerId(row);
		const subsidiary = input.customerSubs.get(customer) ?? input.rootId;
		if (!subsidiary) throw new Error(`Customer ${customer} has no company for this report.`);
		if (input.scope !== 'group') return subsidiary === input.scope ? [row] : [];
		const fromCcy = input.subCcy.get(subsidiary);
		if (!fromCcy) throw new Error(`Company ${subsidiary} has no currency for this report.`);
		if (fromCcy === input.reportingCcy) return [row];
		const convert = (minor: string) => atClosingRate(toBig(minor), input.rates, fromCcy, input.reportingCcy, input.periodYm).toString();
		return [withConvertedAmount(row, convert)];
	});
}
