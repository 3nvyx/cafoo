/**
 * The CFO seat on a fresh database is claimed with a one-time bootstrap secret, never by registering: the seed loader
 * arms the secret's hash in the module and writes the secret to .secrets/cfo-bootstrap.<db>.txt, and the claim link
 * carries it to the browser. Agents never take the seat; only the demo CFO stand-in and the feed smoke test do, and
 * they claim with the same secret a person would.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STDB_DB } from './env';
import { repoRoot, type RoleConn } from './stdb';

/** Where the seed loader writes the secret; the per-database folder is checked too. */
export const bootstrapFiles = (db = STDB_DB) => [join(repoRoot, '.secrets', `cfo-bootstrap.${db}.txt`), join(repoRoot, '.secrets', db, 'cfo-bootstrap.txt')];
export const bootstrapFile = (db = STDB_DB) => bootstrapFiles(db).find(p => existsSync(p)) ?? bootstrapFiles(db)[0]!;

/** The secret from the bootstrap file: the value after `secret=` (the claim link), else the first non-empty line. */
export function parseBootstrapSecret(text: string): string | undefined {
  const fromLink = /secret=([^\s&#]+)/.exec(text)?.[1];
  if (fromLink) return decodeURIComponent(fromLink);
  return text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
}

export function readBootstrapSecret(db = STDB_DB): string | undefined {
  for (const p of bootstrapFiles(db)) {
    if (!existsSync(p)) continue;
    try {
      const secret = parseBootstrapSecret(readFileSync(p, 'utf8'));
      if (secret) return secret;
    } catch {
      /* try the next place */
    }
  }
  return undefined;
}

export const claimLink = (secret: string, webOrigin = process.env.PUBLIC_WEB_ORIGIN?.trim() || 'http://localhost:5173') => `${webOrigin.replace(/\/+$/, '')}/claim#secret=${encodeURIComponent(secret)}`;

/** Whether the roster already has a CFO. */
export const cfoSeated = (c: RoleConn) => [...c.db.agentRoster.iter()].some(r => r.role === 'cfo');

/**
 * Take the CFO seat with this connection: claim it with the bootstrap secret when nobody holds it, or re-register when
 * this identity already holds it (the module allows that, and refuses everyone else). Throws with the module's reason.
 */
export async function takeCfoSeat(cfo: RoleConn, displayName = 'CFO'): Promise<'claimed' | 'registered'> {
  if (!cfoSeated(cfo)) {
    const secret = readBootstrapSecret();
    if (!secret) throw new Error(`Nobody holds the CFO seat and there is no bootstrap secret in ${bootstrapFiles().join(' or ')}; run \`pnpm cfo:bootstrap\` (or reseed) to arm one.`);
    await cfo.reducers.claimCfo({ secret, displayName });
    return 'claimed';
  }
  await cfo.reducers.registerAgent({ role: { tag: 'Cfo' }, displayName, model: 'human' });
  return 'registered';
}
