/**
 * What each agent may call, for the Charters page: every tool on a role's harness allowlist (harness/<role>.ts),
 * with a one-line description and the source behind it, plus the services the role's code path uses without a
 * model tool (the Bright Data counterparty lookup, the Nessie bank feed). The harness stays the source of truth for
 * what is allowed; this file only describes it, and test/charter-tools.test.ts fails when a harness tool has no entry.
 */
import { HARNESSES, type Role } from '../harness';
import { baseName } from '../harness/rules';

export type ToolSource = 'ledger' | 'engine' | 'crs' | 'brightdata' | 'apify' | 'moss' | 'nessie' | 'agent_sdk';

/** In display order. */
export const TOOL_SOURCES: Record<ToolSource, string> = {
  ledger: 'Ledger reducers (SpacetimeDB)',
  engine: 'Ledger engine (ledger-core)',
  crs: 'CRS credit MCP tools',
  brightdata: 'Bright Data',
  apify: 'Apify',
  moss: 'Moss search',
  nessie: 'Capital One Nessie',
  agent_sdk: 'Claude Agent SDK',
};

export interface CatalogTool {
  /** The tool name the model calls, without the mcp__<server>__ prefix, or a service name for a service. */
  name: string;
  source: ToolSource;
  description: string;
  /** 'tool': on the role's harness allowlist. 'service': used by the role's code path, not called by the model. */
  kind: 'tool' | 'service';
}

const T: Record<string, { source: ToolSource; description: string }> = {
  // Agent SDK built-ins.
  Agent: { source: 'agent_sdk', description: 'Hand a task to a worker agent (the Advisor runs the close this way).' },
  SendMessage: { source: 'agent_sdk', description: 'Message another agent in the same run.' },
  // Read-only books tools computed by ledger-core over the live snapshot.
  close_snapshot: { source: 'engine', description: 'Everything needed to start the close: tasks, unmatched bank lines, open invoices and bills, schedules, receivables, unverified vendors.' },
  list_proposals: { source: 'engine', description: "The month's Proposals with status, Red Team critiques and the Advisor ruling." },
  score_bank_matches: { source: 'engine', description: 'Score unmatched bank lines against open invoices and bills: confidence, exact-amount candidates, duplicates.' },
  detect_missing_accruals: { source: 'engine', description: 'Bills for work done in the month but billed after it, with ready-to-propose accruals.' },
  build_revenue_schedule: { source: 'engine', description: 'Straight-line ASC 606 schedule for a contract: one line per month of the term.' },
  allowance_target: { source: 'engine', description: 'Expected-credit-loss target for a customer from its Risk Tier, and the change from today.' },
  revaluation_candidates: { source: 'engine', description: "Each company's foreign-currency balances restated at the closing rate, ready to propose." },
  elimination_candidates: { source: 'engine', description: "The month's intercompany eliminations, ready to propose, and any pair whose sides differ." },
  // Ledger reducers: each writes one row as the agent's own identity; the module refuses what the role may not do.
  propose_bank_match: { source: 'ledger', description: 'Propose matching bank lines to the invoices or bills they pay, to the cent.' },
  propose_journal_entry: { source: 'ledger', description: 'Propose a balanced journal entry citing the bank lines or bills it explains.' },
  propose_accrual: { source: 'ledger', description: 'Propose an accrual for work done this month and billed later; it reverses in a later month.' },
  propose_revenue_schedule: { source: 'ledger', description: "Propose recognition schedule lines for a customer's contract item." },
  propose_credit_decision: { source: 'ledger', description: "Propose a customer's Risk Tier and payment terms, citing the cascade's request ids." },
  propose_vendor_block: { source: 'ledger', description: 'Propose blocking all payments to a vendor whose owner failed identity or fraud checks.' },
  propose_vendor_verify: { source: 'ledger', description: "Propose a vendor check: mark a vendor verified from its owner's identity and fraud results." },
  propose_fx_revaluation: { source: 'ledger', description: "Propose restating one company's foreign-currency balances at the month's closing rate." },
  propose_ic_elimination: { source: 'ledger', description: 'Propose removing what group companies owe or charged each other, on the elimination company.' },
  record_credit_check: { source: 'ledger', description: "Store one evidence row of the cascade just run (product, request id) on the customer or vendor; the books derive the tier." },
  post_message: { source: 'ledger', description: 'Say something in the close thread or on a Proposal thread.' },
  update_close_task: { source: 'ledger', description: 'Move a close task forward (only the Advisor or the CFO marks one done).' },
  approve_proposal: { source: 'ledger', description: 'Approve a Proposal, optionally amended; at or above materiality it waits for the CFO.' },
  reject_proposal: { source: 'ledger', description: 'Reject a Proposal with a rationale.' },
  post_ruling: { source: 'ledger', description: 'Post a ruling or coordination message in the close thread.' },
  request_period_lock: { source: 'ledger', description: 'Ask the CFO to lock the month; refused while anything is open or waiting.' },
  submit_critique: { source: 'ledger', description: 'Attach a critique to a Proposal before the Advisor rules.' },
  // CRS credit: the MCP server in packages/crs-mcp over the CRS sandbox (personas from crs-sandbox-dataset.csv).
  run_credit_cascade: { source: 'crs', description: 'The full Credit Check cascade on a persona: identity, fraud, three bureaus, public records; returns tier, decision, terms, request ids.' },
  crs_personas: { source: 'crs', description: 'The 20 CRS sandbox personas and the decision each should lead to; only these people can be checked.' },
  crs_cascade: { source: 'crs', description: "Credit cascade on a guarantor or vendor owner: identity, fraud, TransUnion, Equifax, Experian, public records." },
  crs_identity_verify: { source: 'crs', description: 'TransUnion identity verification: PASS, FAIL or KBA_REQUIRED with message codes (deceased, SSN mismatch).' },
  crs_fraud_score: { source: 'crs', description: 'Fraud Finder risk check on email, phone, address and IP: score 0 to 100 and plain signals.' },
  crs_credit_report: { source: 'crs', description: 'One bureau soft pull (TransUnion, Equifax or Experian): file status, score, tradelines, derogatories.' },
  crs_public_records: { source: 'crs', description: 'Bankruptcies, liens, judgments, criminal and eviction records.' },
  // Outside services.
  collect_public_footprint: { source: 'brightdata', description: 'What a logged-out visitor sees (Yelp, job board, LinkedIn company page), fetched through Bright Data; a signal, never a tier.' },
  check_customer_site: { source: 'apify', description: "Read a customer's public website (Apify crawl) for closing, insolvency or change-of-owner sentences." },
  search_customer_site: { source: 'apify', description: "Search a customer's crawled website (Apify, indexed in Moss) for what the business says about itself." },
  search_policies: { source: 'moss', description: 'Search the house accounting policies through Moss and cite the policy id.' },
};

/** Services a role's code path uses without a model tool (bookkeeping.ts vendorLookup, feed/feeder.ts with nessie.ts). */
const SERVICES: Partial<Record<Role, CatalogTool[]>> = {
  bookkeeper: [
    { name: 'Counterparty lookup', source: 'brightdata', kind: 'service', description: 'Google results through Bright Data for an unknown payee before a payment is classified.' },
    { name: 'Bank feed', source: 'nessie', kind: 'service', description: 'Capital One Nessie deposits and withdrawals arrive as Feed rows the Continuous Bookkeeper matches.' },
  ],
};

const ORDER = Object.keys(TOOL_SOURCES) as ToolSource[];

/** Every tool the role may call, then its services, grouped in TOOL_SOURCES order. Throws on an undescribed tool. */
export function roleTools(role: Role): CatalogTool[] {
  const seen = new Set<string>();
  const tools: CatalogTool[] = [];
  for (const full of HARNESSES[role].tools) {
    const name = baseName(full);
    if (seen.has(name)) continue;
    seen.add(name);
    const info = T[name];
    if (!info) throw new Error(`charter/tools.ts has no description for ${role} tool ${full}`);
    tools.push({ name, kind: 'tool', ...info });
  }
  const all = [...tools, ...(SERVICES[role] ?? [])];
  return all.sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
}

/** Every role's tools, for GET /charters/catalog (key tools) and the web's Demo-mode copy. */
export function toolCatalog() {
  const roles = Object.keys(HARNESSES) as Role[];
  return { sources: TOOL_SOURCES, byRole: Object.fromEntries(roles.map(r => [r, roleTools(r)])) as Record<Role, CatalogTool[]> };
}
