// In-process MCP server for the Claude Agent SDK. Every tool is read-only: it queries the CRS
// sandbox (or replays fixtures) and never touches the ledger. Proposals are the agent's job.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CrsClient } from './client.js';
import { runCascade } from './cascade.js';
import { personas } from './csv.js';
import { creditReport, fraudScore, identityVerify, publicRecords } from './products.js';

export const CRS_MCP_VERSION = '0.1.0';

export interface CrsMcpOptions {
  client?: CrsClient;
  /** Fixed reference date for lookbacks (tests, demo replays). Default: now. */
  asOf?: Date | string;
}

const personaId = z
  .string()
  .regex(/^[Pp](0[1-9]|1\d|20)$/, 'persona id P01..P20')
  .transform((s) => s.toUpperCase())
  .describe('Sandbox persona id, P01..P20');
const raw = z.boolean().optional().describe('Include the raw CRS response bodies (Expert mode). Default false.');
const readOnly = { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } };

function result(structured: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}
function failure(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], structuredContent: { error: msg }, isError: true };
}
async function guarded(fn: () => Promise<Record<string, unknown>>) {
  try {
    return result(await fn());
  } catch (e) {
    return failure(e);
  }
}

export function crsTools(opts: CrsMcpOptions = {}) {
  const client = opts.client ?? new CrsClient();
  const asOf = opts.asOf ? new Date(opts.asOf) : undefined;
  return [
    tool(
      'crs_personas',
      'List the 20 CRS sandbox personas (fake applicants) with profile and the decision each should lead to. Only these people can be checked.',
      {},
      async () =>
        guarded(async () => ({
          mode: client.mode,
          personas: personas().map(({ personaId: id, personaName, profile, expectedDecision, personaSummary }) => ({ personaId: id, personaName, profile, expectedDecision, personaSummary })),
        })),
      readOnly,
    ),
    tool(
      'crs_credit_report',
      'Pull one bureau credit report (soft pull) for a sandbox persona and return normalized facts: file status, score, tradelines, derogatories, public records, inquiries in 90 days, and the RequestID.',
      { personaId, bureau: z.enum(['transunion', 'equifax', 'experian']), raw },
      async (a) =>
        guarded(async () => {
          const r = await creditReport(client, a.personaId, a.bureau);
          return { personaId: a.personaId, mode: client.mode, facts: r.facts, evidence: r.evidence, ...(a.raw ? { raw: r.raw } : {}) };
        }),
      readOnly,
    ),
    tool(
      'crs_identity_verify',
      'Run TransUnion identity verification for a sandbox persona. Returns PASS, FAIL or KBA_REQUIRED with message codes (2101 address, 2201 SSN/name, 2202 SSN/DOB, 2301 deceased, 2401 fraud alert).',
      { personaId, raw },
      async (a) =>
        guarded(async () => {
          const r = await identityVerify(client, a.personaId);
          return { personaId: a.personaId, mode: client.mode, facts: r.facts, evidence: r.evidence, ...(a.raw ? { raw: r.raw } : {}) };
        }),
      readOnly,
    ),
    tool(
      'crs_fraud_score',
      'Run the Fraud Finder (email, phone, address, IP) risk check for a sandbox persona. Returns risk score 0-100, level (high at 70+) and plain signals.',
      { personaId, raw },
      async (a) =>
        guarded(async () => {
          const r = await fraudScore(client, a.personaId, asOf ?? new Date());
          return { personaId: a.personaId, mode: client.mode, facts: r.facts, evidence: r.evidence, ...(a.raw ? { raw: r.raw } : {}) };
        }),
      readOnly,
    ),
    tool(
      'crs_public_records',
      'Search bankruptcies, liens and judgments (PitchPoint), criminal records and eviction records for a sandbox persona.',
      { personaId, raw },
      async (a) =>
        guarded(async () => {
          const r = await publicRecords(client, a.personaId);
          return { personaId: a.personaId, mode: client.mode, facts: r.facts, evidence: r.evidence, ...(a.raw ? { raw: r.raw } : {}) };
        }),
      readOnly,
    ),
    tool(
      'crs_cascade',
      "Run the full Credit Check cascade on a customer's guarantor or a vendor's owner: identity, fraud, three bureaus, public records. Returns Risk Tier (A/B/C/D/BLOCK), decision, payment terms, evidence with RequestIDs, and plain and technical summaries. Read-only: propose the outcome separately.",
      { personaId, subjectKind: z.enum(['customer_guarantor', 'vendor_owner']) },
      async (a) =>
        guarded(async () => {
          const r = await runCascade(client, a.personaId, { subjectKind: a.subjectKind, ...(asOf ? { asOf } : {}) });
          return { mode: client.mode, ...r } as unknown as Record<string, unknown>;
        }),
      readOnly,
    ),
  ];
}

/** The `crs` MCP server: pass it to the Agent SDK as mcpServers: { crs: createCrsMcpServer() }. */
export function createCrsMcpServer(opts: CrsMcpOptions = {}) {
  return createSdkMcpServer({ name: 'crs', version: CRS_MCP_VERSION, tools: crsTools(opts) });
}
