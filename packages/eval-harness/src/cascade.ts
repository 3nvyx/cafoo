import { CrsClient, runCascade, type CascadeResult } from '@cafoo/crs-mcp';

const cache = new Map<string, Promise<CascadeResult>>();
let client: CrsClient | undefined;

/**
 * Runs the credit cascade in-process. Replay mode is forced: deterministic correctness never touches the
 * network, never logs in, and needs no credentials, whatever CRS_* variables are set.
 */
export function cascade(personaId: string, subjectKind: 'customer_guarantor' | 'vendor_owner', asOf: string): Promise<CascadeResult> {
  const k = `${personaId}|${subjectKind}|${asOf}`;
  let p = cache.get(k);
  if (!p) {
    client ??= new CrsClient({ mode: 'replay' });
    p = runCascade(client, personaId, { subjectKind, asOf });
    cache.set(k, p);
  }
  return p;
}
