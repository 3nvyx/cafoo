// Rewrites raw-values-baseline.json with the current counts. The total may
// only go down: a file's count may rise (a rename, a move) as long as the sum
// across files does not. Set RATCHET_ALLOW_RAISE=1 to raise the total deliberately.
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
const sum = (b) => Object.values(b).reduce((n, row) => n + Object.values(row).reduce((a, c) => a + c, 0), 0);
if (sum(next) > sum(previous) && !isFirst && !process.env.RATCHET_ALLOW_RAISE) {
	console.error(`baseline: refusing to raise the total from ${sum(previous)} to ${sum(next)} (set RATCHET_ALLOW_RAISE=1 to override):`);
	for (const line of raised) console.error('  ' + line);
	process.exit(1);
}
writeFileSync(BASELINE_FILE, JSON.stringify(next, null, '\t') + '\n');
console.log(`baseline: ${Object.keys(next).length} files, ${sum(next)} violations`);
