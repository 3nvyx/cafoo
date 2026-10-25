// Rewrites raw-values-baseline.json with the current counts. Counts may only
// go down; set RATCHET_ALLOW_RAISE=1 to raise one deliberately.
import { writeFileSync, existsSync } from 'node:fs';
import { BASELINE_FILE, KINDS, scanWebSource, readBaseline } from './raw-values.mjs';

const current = scanWebSource();
const isFirst = !existsSync(BASELINE_FILE);
const previous = isFirst ? {} : readBaseline();
const next = {};
let raised = [];
for (const [file, { counts }] of Object.entries(current)) {
	const row = {};
	for (const kind of KINDS) {
		if (counts[kind] === 0) continue;
		row[kind] = counts[kind];
		const before = previous[file]?.[kind] ?? 0;
		if (counts[kind] > before) raised.push(`${file} ${kind} ${before} -> ${counts[kind]}`);
	}
	next[file] = row;
}
if (raised.length && !isFirst && !process.env.RATCHET_ALLOW_RAISE) {
	console.error('baseline: refusing to raise counts (set RATCHET_ALLOW_RAISE=1 to override):');
	for (const line of raised) console.error('  ' + line);
	process.exit(1);
}
writeFileSync(BASELINE_FILE, JSON.stringify(next, null, '\t') + '\n');
const total = Object.values(next).reduce((n, row) => n + Object.values(row).reduce((a, b) => a + b, 0), 0);
console.log(`baseline: ${Object.keys(next).length} files, ${total} violations`);
