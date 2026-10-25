import { describe, expect, it } from 'vitest';
import { cell } from './data/cell';
import { columnName, crc32, decimal, defuse, fileStem, gridCell, money, sheetName, toCsv, toXlsx, xlsxParts, type ExportTable } from './export';

const table: ExportTable = {
	title: 'Trial balance',
	header: ['Code', 'Account', 'Debit'],
	rows: [
		['1000', 'Cash, operating', money(1234567n)],
		['=HYPERLINK("x")', '-sneaky', money(-5n)]
	]
};

describe('decimal', () => {
	it('writes minor units as exact major units', () => {
		expect(decimal(0n)).toBe('0.00');
		expect(decimal(5n)).toBe('0.05');
		expect(decimal(-123456n)).toBe('-1234.56');
		expect(decimal(900719925474099312n)).toBe('9007199254740993.12');
	});
});

describe('toCsv', () => {
	it('quotes, defuses formulas and keeps numbers as numbers, like the gateway', () => {
		expect(toCsv([table])).toBe('Code,Account,Debit\r\n1000,"Cash, operating",12345.67\r\n"\'=HYPERLINK(""x"")",\'-sneaky,-0.05\r\n');
	});
	it('puts each table under its title when there are several', () => {
		const csv = toCsv([table, { ...table, title: 'Second', rows: [] }]);
		expect(csv.startsWith('Trial balance\r\n')).toBe(true);
		expect(csv).toContain('\r\n\r\nSecond\r\nCode,Account,Debit\r\n');
	});
	it('leaves plain negative numbers alone', () => {
		expect(defuse('-12.50')).toBe('-12.50');
		expect(defuse('+1')).toBe("'+1");
		expect(defuse('@sum')).toBe("'@sum");
	});
});

describe('xlsx', () => {
	it('names columns like a spreadsheet', () => {
		expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
	});
	it('makes sheet names Excel accepts and keeps them unique', () => {
		const taken = new Set<string>();
		expect(sheetName('P&L: Sep/2026 [draft]', taken)).toBe('P&L Sep 2026 draft');
		expect(sheetName('A very long sheet title that goes past the limit', taken)).toHaveLength(31);
		expect(sheetName('A very long sheet title that goes past the limit', taken)).toMatch(/ 2$/);
	});
	it('writes numbers as numbers and text as escaped inline strings', () => {
		const sheet = xlsxParts([table]).find(([p]) => p === 'xl/worksheets/sheet1.xml')![1];
		expect(sheet).toContain('<c r="C2"><v>12345.67</v></c>');
		expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t></is></c>');
		expect(sheet).not.toContain('<f>');
	});
	it('is a zip whose entries carry the right checksums', () => {
		const bytes = toXlsx([table]);
		const view = new DataView(bytes.buffer);
		expect(view.getUint32(0, true)).toBe(0x04034b50);
		const end = bytes.length - 22;
		expect(view.getUint32(end, true)).toBe(0x06054b50);
		const parts = xlsxParts([table]);
		expect(view.getUint16(end + 10, true)).toBe(parts.length);
		// Walk the local entries and check each one's stored CRC and name.
		let at = 0;
		const dec = new TextDecoder();
		for (const [path, text] of parts) {
			expect(view.getUint32(at, true)).toBe(0x04034b50);
			const size = view.getUint32(at + 18, true);
			const nameLen = view.getUint16(at + 26, true);
			expect(dec.decode(bytes.subarray(at + 30, at + 30 + nameLen))).toBe(path);
			const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
			expect(dec.decode(data)).toBe(text);
			expect(view.getUint32(at + 14, true)).toBe(crc32(data));
			at += 30 + nameLen + size;
		}
	});
	it('computes the standard CRC-32', () => {
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
	});
});

describe('gridCell', () => {
	it('exports money in major units and keeps ids whole', () => {
		expect(gridCell(cell('123456', 'amountMinor'))).toEqual({ n: '1234.56' });
		expect(gridCell(cell(42n, 'count'))).toEqual({ n: '42' });
		expect(gridCell(cell('2026-09-30T12:00:00Z', 'postedAt'))).toBe('2026-09-30T12:00:00Z');
		expect(gridCell(cell('Payroll', 'memo'))).toBe('Payroll');
		expect(gridCell(cell(undefined, 'memo'))).toBe('');
	});
});

describe('fileStem', () => {
	it('makes a safe file name', () => {
		expect(fileStem('Trial balance, Sep 2026')).toBe('trial-balance-sep-2026');
		expect(fileStem('***')).toBe('export');
	});
});
