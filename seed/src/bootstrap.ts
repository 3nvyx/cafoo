/**
 * `pnpm cfo:bootstrap`: arm a new one-time CFO claim link while the seat is still empty (the loader's link expired or
 * got lost). Runs as the database owner through the spacetime CLI; replaces any earlier secret for this database.
 * Env: SPACETIMEDB_URI, SPACETIMEDB_DB_NAME, CFO_BOOTSTRAP_TTL_MINUTES (default 1440, at most 10080), PUBLIC_WEB_ORIGIN.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armCfoBootstrap, armFailureHelp, DEFAULT_TTL_MINUTES } from './owner';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uri = process.env.SPACETIMEDB_URI ?? 'ws://localhost:3000';
const db = process.env.SPACETIMEDB_DB_NAME ?? 'cafoo';
const ttl = Number(process.env.CFO_BOOTSTRAP_TTL_MINUTES ?? DEFAULT_TTL_MINUTES);
if (!Number.isInteger(ttl) || ttl < 1 || ttl > 10080) {
  console.error(`CFO_BOOTSTRAP_TTL_MINUTES must be a whole number of minutes from 1 to 10080; got ${process.env.CFO_BOOTSTRAP_TTL_MINUTES}.`);
  process.exit(2);
}

const r = armCfoBootstrap({ root, uri, db, ttlMinutes: ttl });
if (!r.ok) {
  console.error(armFailureHelp(db, r.error));
  process.exit(1);
}
console.log(`CFO claim link for ${db} (one use, valid until about ${r.expiresAt}):\n  ${r.link}`);
if (r.saveError) {
  console.error(`Could not save it to ${r.file} (${r.saveError}); copy the link now.`);
  process.exit(1);
}
console.log(`Saved in ${r.file}.`);
