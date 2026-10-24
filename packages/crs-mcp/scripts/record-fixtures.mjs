// Re-records fixtures/crs from the live CRS sandbox: one call per persona row of the dataset,
// sequential, persona bodies only. Logs in once; aborts on the first login error.
// Run: pnpm -F @cafoo/crs-mcp fixtures:record   (needs CRS_USERNAME/CRS_PASSWORD and CRS_REPLAY="0")
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CrsClient, CrsLoginError, resolveMode } from '../dist/client.js';
import { loadDataset, fixtureName } from '../dist/csv.js';
import { fixturesDir } from '../dist/paths.js';

if (resolveMode() !== 'live') {
  console.error('fixtures:record needs live mode: set CRS_USERNAME and CRS_PASSWORD, and CRS_REPLAY="0". Nothing was sent.');
  process.exit(1);
}
const dir = fixturesDir();
const client = new CrsClient({ record: dir, log: (m) => console.error(m) });
const rows = loadDataset().filter((r) => r.source === 'persona');
const only = process.argv[2]?.toUpperCase(); // optional persona filter, e.g. P05
let n = 0;
for (const row of rows) {
  if (only && row.personaId !== only) continue;
  try {
    const res = await client.call(row);
    n++;
    console.log(`${row.personaId} ${row.product} ${fixtureName(row)} -> ${res.status} ${res.headers.requestId ?? ''}`);
  } catch (e) {
    console.error(`${row.personaId} ${row.product}: ${e.message}`);
    if (e instanceof CrsLoginError) process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 250));
}
const metaPath = join(dir, '_meta.json');
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
writeFileSync(metaPath, JSON.stringify({ ...meta, lastRecordedAt: new Date().toISOString(), lastRecordedCount: n, synthesized: only ? meta.synthesized : false }, null, 2) + '\n');
console.log(`recorded ${n} responses into ${dir}`);
