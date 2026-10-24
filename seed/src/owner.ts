/**
 * Acting as the database owner through the spacetime CLI (the identity that published the module, recorded by the
 * module's init), and the one-time CFO bootstrap secret. Shared by the loader and `pnpm cfo:bootstrap`.
 *
 * Nobody can take the CFO seat by asking. The owner arms the SHA-256 of a random secret (144 bits, base64url) with
 * arm_cfo_bootstrap; the secret goes to `.secrets/cfo-bootstrap.<db>.txt` and into the claim link
 * `<web origin>/claim#secret=…`; claimCfo with the matching secret takes the seat once, before the TTL runs out.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_TTL_MINUTES = 1440;

/** The spacetime CLI binary and the server URL to pass with -s (the CLI's own default server is not the local one). */
export function spacetimeCli(uri: string) {
  const local = join(homedir(), '.local', 'bin', 'spacetime');
  const bin = process.env.SPACETIME_BIN ?? (existsSync(local) ? local : 'spacetime');
  const server = process.env.SPACETIMEDB_SERVER ?? uri.replace(/^ws(s?):\/\//, 'http$1://');
  return { bin, server };
}

/** Call a reducer as the database owner. Arguments are JSON values, one per reducer parameter. */
export function ownerCall(opts: { uri: string; db: string; reducer: string; args: string[] }): { ok: true } | { ok: false; error: string } {
  const { bin, server } = spacetimeCli(opts.uri);
  const r = spawnSync(bin, ['call', opts.db, opts.reducer, ...opts.args, '-s', server, '--no-config', '--yes'], { encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || String(r.error ?? `exit ${r.status}`)).trim() };
}

export const bootstrapFile = (root: string, db: string) => join(root, '.secrets', `cfo-bootstrap.${db}.txt`);

export const claimLink = (secret: string) =>
  `${(process.env.PUBLIC_WEB_ORIGIN?.trim() || 'http://localhost:5173').replace(/\/+$/, '')}/claim#secret=${encodeURIComponent(secret)}`;

/**
 * Arm a fresh bootstrap secret for `db` and write it, with its claim link, to .secrets/cfo-bootstrap.<db>.txt.
 * Arming again replaces the previous secret. The module refuses when a CFO already holds the seat, when the CLI is not
 * the database owner, or when the database never recorded an owner (upgraded in place instead of published fresh).
 */
export function armCfoBootstrap(opts: { root: string; uri: string; db: string; ttlMinutes?: number }):
  | { ok: true; secret: string; link: string; file: string; expiresAt: string; saveError?: string }
  | { ok: false; error: string } {
  const ttl = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const secret = randomBytes(18).toString('base64url');
  const sha = createHash('sha256').update(secret, 'utf8').digest('hex');
  const called = ownerCall({ uri: opts.uri, db: opts.db, reducer: 'arm_cfo_bootstrap', args: [JSON.stringify(sha), String(ttl)] });
  if (!called.ok) return called;
  const link = claimLink(secret);
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
  const file = bootstrapFile(opts.root, opts.db);
  // The secret is armed now; failing to save it must not lose it, so a write error is reported, not thrown.
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${secret}\n${link}\n# One-time CFO bootstrap secret for database ${opts.db}, valid until about ${expiresAt}. Open the link to claim the CFO seat; run \`pnpm cfo:bootstrap\` for a new one.\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    chmodSync(file, 0o600); // the mode above applies only when the file is created
  } catch (e) {
    return { ok: true, secret, link, file, expiresAt, saveError: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, secret, link, file, expiresAt };
}

/** Plain explanation of a failed arming, with the way out. */
export function armFailureHelp(db: string, error: string): string {
  if (/CFO seat is already claimed/i.test(error)) return `The CFO seat on ${db} is already claimed, so no claim link is needed.`;
  return (
    `Could not arm the CFO claim link on ${db}: ${error}\n` +
    `Arming runs as the database owner through the spacetime CLI, so it works only from the login that published the module, on a database published fresh ` +
    `(\`cd spacetimedb && spacetime publish ${db} --server local --delete-data=always --yes\`). Then run \`pnpm cfo:bootstrap\` for a link.`
  );
}
