// CSV for the demo's client-side exports. Same shape as the agent gateway's /export/csv: one table, or several under a
// title row separated by a blank line; text a spreadsheet would run as a formula gets a leading apostrophe.

export interface CsvTable {
	title: string;
	header: string[];
	rows: string[][];
}

export function toCsv(tables: readonly CsvTable[]): string {
	const cell = (v: string) => {
		const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(?:\.\d+)?$/.test(v) ? `'${v}` : v;
		return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
	};
	const line = (cells: readonly string[]) => cells.map(cell).join(',');
	const one = (t: CsvTable) => [...(tables.length > 1 ? [line([t.title])] : []), line(t.header), ...t.rows.map(line)].join('\r\n');
	return tables.map(one).join('\r\n\r\n') + '\r\n';
}

/** Minor units as a plain decimal ("-1234.56"), the form a spreadsheet reads as a number. */
export function decimal(minor: string | bigint | undefined): string {
	const n = typeof minor === 'bigint' ? minor : BigInt(minor || '0');
	const neg = n < 0n;
	const a = neg ? -n : n;
	return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** Hand the browser a file to save. */
export function saveFile(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
