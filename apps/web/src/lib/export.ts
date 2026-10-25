// Spreadsheet downloads made in the browser: CSV and Excel (.xlsx) from the same tables, so the two never disagree.
// The CSV follows the gateway's /export/csv rules (apps/agents/src/exports.ts toCsv): RFC 4180 quoting, and a text cell
// a spreadsheet would run as a formula gets a leading apostrophe. The .xlsx is written here with no dependency: a
// minimal Office Open XML workbook (inline strings, one sheet per table) in an uncompressed zip.
import type { Cell } from './data/cell';

/** A number cell, as an exact decimal string ("-1234.56"): a spreadsheet can sum it, and it is never a float here. */
export interface NumCell {
	n: string;
}
export type ExportCell = string | NumCell;
export interface ExportTable {
	title: string;
	header: string[];
	rows: ExportCell[][];
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
export const num = (n: string): NumCell => ({ n: DECIMAL.test(n) ? n : '0' });
const isNum = (c: ExportCell): c is NumCell => typeof c === 'object';

/** Minor units as a decimal string with two places, sign first: -123456n becomes "-1234.56". */
export function decimal(minor: bigint): string {
	const neg = minor < 0n;
	const a = neg ? -minor : minor;
	return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** Minor units as a number cell in major units. */
export const money = (minor: bigint): NumCell => ({ n: decimal(minor) });

/** A text cell made safe for a spreadsheet: =, +, -, @, tab or CR first gets an apostrophe, unless it is a plain number. */
export function defuse(v: string): string {
	return /^[=+\-@\t\r]/.test(v) && !DECIMAL.test(v) ? `'${v}` : v;
}

/** RFC 4180 CSV. Several tables are separated by a blank line, each under a title row. */
export function toCsv(tables: ExportTable[]): string {
	const cell = (c: ExportCell) => {
		const safe = isNum(c) ? c.n : defuse(c);
		return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
	};
	const line = (cells: ExportCell[]) => cells.map(cell).join(',');
	const one = (t: ExportTable) => [...(tables.length > 1 ? [line([t.title])] : []), line(t.header), ...t.rows.map(line)].join('\r\n');
	return tables.map(one).join('\r\n\r\n') + '\r\n';
}

/**
 * A Tables page cell as a spreadsheet cell: money in major units and whole numbers as numbers, times as ISO text, long
 * ids whole (the grid shortens them), everything else as the grid shows it.
 */
export function gridCell(c: Cell): ExportCell {
	if (c.kind === 'money' && typeof c.sort === 'bigint') return money(c.sort);
	if (c.kind === 'number' && typeof c.sort === 'bigint') return { n: c.sort.toString() };
	if (c.kind === 'date' || c.kind === 'id') return c.full || c.text;
	return c.text;
}

// XLSX

/** XML text: escaped, with the characters XML 1.0 forbids removed. */
function xml(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "A", "B", ... "Z", "AA": the spreadsheet column name of a zero-based index. */
export function columnName(i: number): string {
	let s = '';
	for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
	return s;
}

/** A sheet name Excel accepts: no []:*?/\, at most 31 characters, unique in the workbook. */
export function sheetName(title: string, taken: Set<string>): string {
	const base = (title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'Sheet').slice(0, 31);
	let name = base;
	for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
	taken.add(name.toLowerCase());
	return name;
}

function sheetXml(t: ExportTable): string {
	const row = (cells: ExportCell[], r: number, bold: boolean) =>
		`<row r="${r}">${cells
			.map((c, i) => {
				const ref = `${columnName(i)}${r}`;
				if (isNum(c)) return `<c r="${ref}"><v>${c.n}</v></c>`;
				if (c === '') return '';
				return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(c)}</t></is></c>`;
			})
			.join('')}</row>`;
	const rows = [row(t.header, 1, true), ...t.rows.map((r, i) => row(r, i + 2, false))].join('');
	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		'<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
		`<sheetData>${rows}</sheetData></worksheet>`
	);
}

/** The workbook's parts, by path inside the zip. */
export function xlsxParts(tables: ExportTable[]): [string, string][] {
	const list = tables.length ? tables : [{ title: 'Sheet', header: [], rows: [] }];
	const taken = new Set<string>();
	const names = list.map((t) => sheetName(t.title, taken));
	const ns = 'http://schemas.openxmlformats.org';
	return [
		[
			'[Content_Types].xml',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				`<Types xmlns="${ns}/package/2006/content-types">` +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
				'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
				list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
				'</Types>'
		],
		[
			'_rels/.rels',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				`<Relationships xmlns="${ns}/package/2006/relationships">` +
				`<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
				'</Relationships>'
		],
		[
			'xl/workbook.xml',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				`<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>` +
				names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
				'</sheets></workbook>'
		],
		[
			'xl/_rels/workbook.xml.rels',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				`<Relationships xmlns="${ns}/package/2006/relationships">` +
				list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
				`<Relationship Id="rId${list.length + 1}" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
				'</Relationships>'
		],
		[
			'xl/styles.xml',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				`<styleSheet xmlns="${ns}/spreadsheetml/2006/main">` +
				'<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
				'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
				'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
				'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
				'<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
				'</styleSheet>'
		],
		...list.map((t, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(t)])
	];
}

// Zip (stored, no compression): enough for a workbook, and every spreadsheet app reads it.

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of the given files, stored uncompressed. */
export function zip(files: [string, Uint8Array][]): Uint8Array {
	const enc = new TextEncoder();
	const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const [path, data] of files) {
		const name = enc.encode(path);
		const crc = crc32(data);
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true); // UTF-8 names
		lv.setUint16(8, 0, true); // stored
		lv.setUint16(10, 0, true);
		lv.setUint16(12, DOS_DATE, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, 0, true);
		cv.setUint16(14, DOS_DATE, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);
		locals.push(local, data);
		centrals.push(central);
		offset += local.length + data.length;
	}
	const centralSize = centrals.reduce((t, c) => t + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	const out = new Uint8Array(offset + centralSize + 22);
	let at = 0;
	for (const part of [...locals, ...centrals, end]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** The tables as an Excel workbook, one sheet each. */
export function toXlsx(tables: ExportTable[]): Uint8Array {
	const enc = new TextEncoder();
	return zip(xlsxParts(tables).map(([p, s]) => [p, enc.encode(s)]));
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A file name safe on every system: "Trial balance, Sep 2026" becomes "trial-balance-sep-2026". */
export function fileStem(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'export'
	);
}

/** Save the tables in the browser as `<stem>.csv` or `<stem>.xlsx`. */
export function download(tables: ExportTable[], format: 'csv' | 'xlsx', title: string) {
	const blob =
		format === 'csv'
			? new Blob(['﻿', toCsv(tables)], { type: 'text/csv;charset=utf-8' })
			: new Blob([toXlsx(tables) as BlobPart], { type: XLSX_TYPE });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${fileStem(title)}.${format}`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
