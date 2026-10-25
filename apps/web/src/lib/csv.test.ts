import { describe, expect, it } from 'vitest';
import { decimal, toCsv } from './csv';

describe('toCsv', () => {
	it('quotes commas and quotes, and ends each table with CRLF', () => {
		expect(toCsv([{ title: 'T', header: ['a', 'b'], rows: [['x, y', 'say "hi"']] }])).toBe('a,b\r\n"x, y","say ""hi"""\r\n');
	});
	it('defuses formulas but leaves plain negative numbers alone', () => {
		expect(toCsv([{ title: 'T', header: ['m'], rows: [['=SUM(A1)'], ['-12.50'], ['@x']] }])).toBe("m\r\n'=SUM(A1)\r\n-12.50\r\n'@x\r\n");
	});
	it('puts a title row and a blank line between several tables', () => {
		const t = (title: string) => ({ title, header: ['h'], rows: [['1']] });
		expect(toCsv([t('One'), t('Two')])).toBe('One\r\nh\r\n1\r\n\r\nTwo\r\nh\r\n1\r\n');
	});
});

describe('decimal', () => {
	it('formats minor units with two places and a leading sign', () => {
		expect(decimal('-123456')).toBe('-1234.56');
		expect(decimal('5')).toBe('0.05');
		expect(decimal(undefined)).toBe('0.00');
	});
});
