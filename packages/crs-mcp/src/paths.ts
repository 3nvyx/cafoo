import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

/** Repo root: the nearest ancestor of this file that holds pnpm-workspace.yaml. */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return (cachedRoot = dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: packages/crs-mcp/{src,dist} -> repo root.
  return (cachedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
}

export const datasetPath = (): string => join(repoRoot(), 'crs-sandbox-dataset.csv');
export const fixturesDir = (): string => join(repoRoot(), 'fixtures', 'crs');
export const secretsPath = (): string => join(repoRoot(), '.secrets', 'crs.json');
