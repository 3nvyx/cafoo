/**
 * Loads seed/out/seed.json into the running SpacetimeDB database through reducers: Cafoo Inc, then the group (Cafoo Ltd,
 * the eliminations company, FX rates, Cafoo Ltd's trading and the intercompany entries), then the close checklist.
 * Runs as the advisor identity (token in .secrets/<db>/advisor.token) so the same identity later drives the agents.
 * Finally, unless SEED_NO_BOOTSTRAP=1 or a CFO already holds the seat, it arms a one-time CFO claim link as the database
 * owner (spacetime CLI), prints it and saves it in .secrets/cfo-bootstrap.<db>.txt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildCompany } from './company';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbConnection } from '@cafoo/stdb-bindings';
import { ACCOUNTS, ELIM_ACCOUNTS, UK_ACCOUNTS, type SeedAccount } from './accounts';
import type { Seed } from './generate';
import { armCfoBootstrap, armFailureHelp, ownerCall } from './owner';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const URI = process.env.SPACETIMEDB_URI ?? 'ws://localhost:3000';
const DB = process.env.SPACETIMEDB_DB_NAME ?? 'cafoo';
// Kept per database, like the agents' identities (apps/agents/src/stdb.ts), so reseeding one database never
// replaces the advisor another one registered. The default database still reads the older .secrets/advisor.token.
const TOKEN_FILE = join(root, '.secrets', DB, 'advisor.token');
const LEGACY_TOKEN_FILE = DB === 'cafoo' ? join(root, '.secrets', 'advisor.token') : undefined;

function loadToken(): string | undefined {
  try {
    for (const p of [TOKEN_FILE, LEGACY_TOKEN_FILE]) {
      if (p && existsSync(p)) return readFileSync(p, 'utf8').trim() || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
function saveToken(token: string) {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token, 'utf8');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, timeoutMs = 15000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

function connect(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(loadToken())
      .onConnect((conn, identity, token) => {
        saveToken(token);
        console.log(`connected as ${identity.toHexString().slice(0, 12)}…`);
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve(conn))
          .onError(ctx => reject((ctx as { event?: unknown }).event ?? new Error('subscription failed')))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => reject(err))
      .build();
  });
}

/** SEED_PROFILE=quillmesh names the group after the demo company in plan.md; the default keeps the test fixture's names. */
const PROFILE = process.env.SEED_PROFILE ?? 'default';
/** An intercompany account name ("Due from Cafoo Ltd") with the profile's company names. */
const named = (name: string) => (PROFILE === 'quillmesh' ? name.replace(/\bCafoo (Inc|Ltd)\b/g, 'Quillmesh $1') : name);
const chart = (accounts: SeedAccount[]) => accounts.map(a => ({ ...a, name: named(a.name) }));

/** Charts of accounts come from code (accounts.ts), not seed.json, so a stale seed.json cannot leave an account out. */
const CHARTS: Record<string, SeedAccount[]> = { US: chart(ACCOUNTS), UK: chart(UK_ACCOUNTS), ELIM: chart(ELIM_ACCOUNTS) };

/**
 * Clear the demo. Once setup is sealed the Advisor (this loader's identity) may no longer reset, so fall back to the
 * spacetime CLI, which runs as the database owner who published the module.
 */
async function resetDemo(conn: DbConnection) {
  try {
    await conn.reducers.resetDemo({ confirm: 'RESET' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The module records its owner in init, which runs only when a database is first published (or republished with
    // --delete-data). A database upgraded in place has no recorded owner, so the CLI fallback cannot work there.
    if (![...conn.db.settings.iter()].some(s => s.key === 'database_owner' && s.valueText !== '')) {
      throw new Error(
        `reset as advisor refused (${msg}), and this database has no recorded owner because it was upgraded in place rather than published fresh. Publish it fresh with \`cd spacetimedb && spacetime publish ${DB} --server local --delete-data=always --yes\`, then run the loader again.`
      );
    }
    console.log(`reset as advisor refused (${msg}); resetting as the database owner with the spacetime CLI`);
    const r = ownerCall({ uri: URI, db: DB, reducer: 'reset_demo', args: ['"RESET"'] });
    if (!r.ok) {
      throw new Error(
        `owner reset failed (${r.error}). Republish with \`cd spacetimedb && spacetime publish ${DB} --server local --delete-data=always --yes\` and run the loader again.`
      );
    }
  }
}

/**
 * A database seeded before an account was added to the chart (e.g. 1250 Receivable from Vendors) lacks it, and the
 * agents' entries on it fail. The chart comes from code (accounts.ts), not seed.json, so a stale seed.json cannot hide
 * a gap. seedAccounts skips codes that exist, so add just the missing ones. Once setup is sealed only the CFO may seed
 * and this loader runs as the Advisor, so it stops with a non-zero exit and says how to fix it.
 */
async function topUpAccounts(conn: DbConnection) {
  const have = new Set([...conn.db.account.iter()].map(a => a.code));
  const subs = new Set([...conn.db.subsidiary.iter()].map(s => s.code));
  if (!subs.has('UK')) console.log('this database predates the group (no Cafoo Ltd); run `pnpm demo:reset` to load it');
  const missing = Object.entries(CHARTS).flatMap(([sub, chart]) => (subs.has(sub) ? chart.filter(a => !have.has(a.code)).map(a => ({ sub, a })) : []));
  if (missing.length === 0) return;
  const codes = missing.map(({ a }) => `${a.code} ${a.name}`).join(', ');
  const sealed = [...conn.db.settings.iter()].some(s => s.key === 'setup_sealed' && s.valueI64 === 1n);
  if (sealed) {
    console.error(
      `the database is missing account(s) ${codes}, and setup is sealed, so only the CFO can add them. Run \`pnpm demo:reset\` to reload the demo with the current chart of accounts.`
    );
    process.exit(1);
  }
  for (const sub of new Set(missing.map(m => m.sub))) {
    await conn.reducers.seedAccounts({ subsidiaryCode: sub, accounts: missing.filter(m => m.sub === sub).map(m => m.a) });
  }
  await waitFor(() => missing.every(({ a }) => [...conn.db.account.iter()].some(x => x.code === a.code)), 'missing accounts');
  console.log(`added missing account(s): ${codes}`);
}

const cfoSeated = (conn: DbConnection) => [...conn.db.agentRoster.iter()].some(x => x.role === 'cfo');

/** Arm the one-time CFO claim link unless told not to or the seat is taken. Never fails the load. */
function armClaimLink(conn: DbConnection) {
  if (process.env.SEED_NO_BOOTSTRAP === '1') {
    console.log('SEED_NO_BOOTSTRAP=1: no CFO claim link armed');
    return;
  }
  if (cfoSeated(conn)) {
    console.log('the CFO seat is already taken; no claim link needed');
    return;
  }
  try {
    const r = armCfoBootstrap({ root, uri: URI, db: DB });
    if (!r.ok) {
      console.error(armFailureHelp(DB, r.error));
      return;
    }
    const saved = r.saveError ? `Could not save it to ${r.file} (${r.saveError}); copy the link now.` : `Saved in ${r.file}.`;
    console.log(`\nClaim the CFO seat (one use, valid until about ${r.expiresAt}):\n  ${r.link}\n${saved} \`pnpm cfo:bootstrap\` arms a new one.\n`);
  } catch (e) {
    console.error(`Could not arm the CFO claim link (${e instanceof Error ? e.message : String(e)}); the demo data is loaded. Run \`pnpm cfo:bootstrap\` for a link.`);
  }
}

function profileName(code: string, name: string): string {
  if (PROFILE !== 'quillmesh') return name;
  return code === 'US' ? 'Quillmesh Inc' : code === 'UK' ? 'Quillmesh Ltd' : name;
}

async function main() {
  const seedPath = join(root, 'seed', 'out', 'seed.json');
  if (!existsSync(seedPath)) throw new Error('Run `pnpm -F @cafoo/seed generate` first.');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed;
  const conn = await connect();
  const r = conn.reducers;

  // 1. Register as advisor (idempotent; the module keeps the first claimant).
  const roster = [...conn.db.agentRoster.iter()];
  if (!roster.some(x => x.role === 'advisor')) {
    await r.registerAgent({ role: { tag: 'Advisor' }, displayName: 'Chief Finance Advisor', model: 'claude-opus-5-5' });
    console.log('registered advisor role');
  }

  if (conn.db.subsidiary.count() > 0n) {
    if (process.env.SEED_RESET === '1') {
      await resetDemo(conn);
      await waitFor(() => conn.db.subsidiary.count() === 0n, 'reset');
      console.log('demo data cleared');
    } else {
      await topUpAccounts(conn);
      console.log('database already seeded; set SEED_RESET=1 to reload');
      if (!cfoSeated(conn)) console.log('nobody holds the CFO seat yet; `pnpm cfo:bootstrap` prints a claim link');
      process.exit(0);
    }
  }
  const group = seed.group;
  if (!group) throw new Error('seed.json has no group data; run `pnpm -F @cafoo/seed generate` again.');

  // 2. Structure: Cafoo Inc, then the group companies (their periods are the group's: one row per month), then FX rates,
  // which must exist before any entry with a line in another currency.
  await r.seedSubsidiary({ code: seed.subsidiary.code, name: profileName(seed.subsidiary.code, seed.subsidiary.name), functionalCcy: seed.subsidiary.functionalCcy, parentCode: undefined, isElimination: false });
  await r.seedAccounts({ subsidiaryCode: 'US', accounts: CHARTS.US });
  await r.seedPeriods({ subsidiaryCode: 'US', yms: seed.periods.yms, closedYms: seed.periods.closedYms });
  for (const s of group.subsidiaries) {
    await r.seedSubsidiary({ code: s.code, name: profileName(s.code, s.name), functionalCcy: s.functionalCcy, parentCode: s.parentCode, isElimination: s.isElimination });
    await r.seedAccounts({ subsidiaryCode: s.code, accounts: CHARTS[s.code] ?? group.accounts.filter(a => a.subsidiaryCode === s.code).map(({ subsidiaryCode: _, ...a }) => a) });
  }
  for (const x of group.fxRates) await r.seedFxRate({ fromCcy: x.fromCcy, toCcy: x.toCcy, ym: x.ym, rateE6: BigInt(x.rateE6), kind: x.kind });
  const accountTotal = ACCOUNTS.length + group.subsidiaries.reduce((n, s) => n + (CHARTS[s.code]?.length ?? group.accounts.filter(a => a.subsidiaryCode === s.code).length), 0);
  await waitFor(
    () =>
      conn.db.account.count() >= BigInt(accountTotal) &&
      conn.db.period.count() >= BigInt(seed.periods.yms.length) &&
      conn.db.fxRate.count() >= BigInt(group.fxRates.length),
    'accounts, periods and FX rates'
  );
  const subsidiaryId = new Map([...conn.db.subsidiary.iter()].map(x => [x.code, x.id]));

  // 3. Parties
  await r.seedCustomers({ subsidiaryCode: 'US', customers: seed.customers.map(c => ({ name: c.name, domain: c.domain, guarantorPersonaId: c.guarantorPersonaId, guarantorName: c.guarantorName, paymentTermsDays: c.paymentTermsDays, yelpUrl: c.yelpUrl, jobBoard: c.jobBoard, linkedinUrl: c.linkedinUrl })) });
  await r.seedVendors({ subsidiaryCode: 'US', vendors: seed.vendors.map(v => ({ name: v.name, domain: v.domain, category: v.category, ownerPersonaId: v.ownerPersonaId, yelpUrl: v.yelpUrl, jobBoard: v.jobBoard, linkedinUrl: v.linkedinUrl })) });
  for (const sub of new Set(group.customers.map(c => c.subsidiaryCode))) {
    await r.seedCustomers({
      subsidiaryCode: sub,
      customers: group.customers.filter(c => c.subsidiaryCode === sub).map(c => ({ name: c.name, domain: c.domain, guarantorPersonaId: c.guarantorPersonaId, guarantorName: c.guarantorName, paymentTermsDays: c.paymentTermsDays, yelpUrl: undefined, jobBoard: undefined, linkedinUrl: undefined })),
    });
  }
  await waitFor(
    () => conn.db.customer.count() >= BigInt(seed.customers.length + group.customers.length) && conn.db.vendor.count() >= BigInt(seed.vendors.length),
    'customers and vendors'
  );
  const customerId = new Map<number, bigint>();
  for (const c of seed.customers) {
    const row = [...conn.db.customer.iter()].find(x => x.name === c.name);
    if (!row) throw new Error(`customer ${c.name} missing after seed`);
    customerId.set(c.idx, row.id);
  }
  const groupCustomerId = new Map<number, bigint>();
  for (const c of group.customers) {
    const row = [...conn.db.customer.iter()].find(x => x.name === c.name && x.subsidiaryId === subsidiaryId.get(c.subsidiaryCode));
    if (!row) throw new Error(`customer ${c.name} missing after seed`);
    groupCustomerId.set(c.idx, row.id);
  }
  const vendorId = new Map<number, bigint>();
  for (const v of seed.vendors) {
    const row = [...conn.db.vendor.iter()].find(x => x.name === v.name);
    if (!row) throw new Error(`vendor ${v.name} missing after seed`);
    vendorId.set(v.idx, row.id);
  }

  // 4. Contracts and schedules
  for (const c of seed.contracts) {
    await r.seedContract({
      customerId: customerId.get(c.customerIdx)!,
      code: c.code,
      startYm: c.startYm,
      endYm: c.endYm,
      totalMinor: BigInt(c.totalMinor),
      plan: { tag: c.plan === 'annual' ? 'Annual' : 'Usage' },
      items: c.items.map(i => ({ kind: { tag: i.kind === 'subscription' ? 'Subscription' : 'Usage' }, priceMinor: BigInt(i.priceMinor), qty: BigInt(i.qty), sspMinor: BigInt(i.sspMinor), description: i.description })),
    });
  }
  await waitFor(() => conn.db.contract.count() >= BigInt(seed.contracts.length), 'contracts');
  for (const c of seed.contracts) {
    if (c.scheduleLines.length === 0) continue;
    await r.seedRevenueScheduleLines({
      contractCode: c.code,
      customerId: customerId.get(c.customerIdx)!,
      lines: c.scheduleLines.map(l => ({ ym: l.ym, amountMinor: BigInt(l.amountMinor), recognized: l.recognized })),
    });
  }

  // 5. Invoices, bills, bank feed
  for (const inv of seed.invoices) {
    await r.seedInvoice({
      customerId: customerId.get(inv.customerIdx)!,
      contractCode: inv.contractCode,
      number: inv.number,
      ym: inv.ym,
      issuedAtMicros: BigInt(inv.issuedAtMicros),
      dueAtMicros: BigInt(inv.dueAtMicros),
      amountMinor: BigInt(inv.amountMinor),
      status: inv.status,
    });
  }
  for (const b of seed.bills) {
    await r.seedBill({
      vendorId: vendorId.get(b.vendorIdx)!,
      externalRef: b.externalRef,
      ym: b.ym,
      billedAtMicros: BigInt(b.billedAtMicros),
      dueAtMicros: BigInt(b.dueAtMicros),
      amountMinor: BigInt(b.amountMinor),
      expenseAccountCode: b.expenseAccountCode,
      status: b.status,
    });
  }
  for (const inv of group.invoices) {
    await r.seedInvoice({
      customerId: groupCustomerId.get(inv.customerIdx)!,
      contractCode: undefined,
      number: inv.number,
      ym: inv.ym,
      issuedAtMicros: BigInt(inv.issuedAtMicros),
      dueAtMicros: BigInt(inv.dueAtMicros),
      amountMinor: BigInt(inv.amountMinor),
      status: inv.status,
    });
  }
  const feed = [...seed.bankTransactions.map(x => ({ ...x, subsidiaryCode: 'US' })), ...group.bankTransactions];
  for (const sub of new Set(feed.map(x => x.subsidiaryCode))) {
    const txs = feed
      .filter(x => x.subsidiaryCode === sub)
      .map(x => ({ bookedAtMicros: BigInt(x.bookedAtMicros), ym: x.ym, amountMinor: BigInt(x.amountMinor), ccy: x.ccy, description: x.description, counterparty: x.counterparty, matched: x.matched }));
    for (let i = 0; i < txs.length; i += 40) {
      await r.seedBankTransactions({ subsidiaryCode: sub, txs: txs.slice(i, i + 40) });
    }
  }

  // 6. Journal entries
  let posted = 0;
  for (const je of seed.journalEntries) {
    await r.seedJournalEntry({
      subsidiaryCode: 'US',
      periodYm: je.periodYm,
      memo: je.memo,
      lines: je.lines.map(l => ({
        accountCode: l.accountCode,
        debitMinor: BigInt(l.debitMinor),
        creditMinor: BigInt(l.creditMinor),
        ccy: l.ccy,
        fxRateE6: BigInt(l.fxRateE6),
        customerId: l.customerId !== undefined ? customerId.get(l.customerId) : undefined,
        vendorId: l.vendorId !== undefined ? vendorId.get(l.vendorId) : undefined,
        memo: l.memo,
      })),
    });
    posted++;
  }
  // Group entries: Cafoo Ltd's books and both sides of the intercompany loan and service fees.
  for (const je of group.journalEntries) {
    await r.seedJournalEntry({
      subsidiaryCode: je.subsidiaryCode,
      periodYm: je.periodYm,
      memo: je.memo,
      lines: je.lines.map(l => ({
        accountCode: l.accountCode,
        debitMinor: BigInt(l.debitMinor),
        creditMinor: BigInt(l.creditMinor),
        ccy: l.ccy,
        fxRateE6: BigInt(l.fxRateE6),
        customerId: l.customerId !== undefined ? groupCustomerId.get(l.customerId) : undefined,
        vendorId: undefined,
        memo: l.memo,
      })),
    });
    posted++;
  }

  // 7. Close checklist: the group's tasks slot in at their sortOrder (Consolidate subsidiaries at 6) and later tasks
  // (the Board pack) move down.
  const firstGroupTask = Math.min(...group.closeTasks.map(t => t.sortOrder));
  const tasks = [
    ...seed.closeTasks.map(t => (t.sortOrder >= firstGroupTask ? { ...t, sortOrder: t.sortOrder + group.closeTasks.length } : t)),
    ...group.closeTasks,
  ].sort((a, b) => a.sortOrder - b.sortOrder);
  await r.seedCloseTasks({ periodYm: seed.closeYm, tasks });

  await waitFor(() => conn.db.journalEntry.count() >= BigInt(posted), 'journal entries');

  // 8. Company records outside the ledger: people, payroll, funding, the cap table, cost of service, the CRM.
  const company = buildCompany({
    closeYm: seed.closeYm,
    subsidiaryIds: new Map([...conn.db.subsidiary.iter()].map(x => [x.code, String(x.id)])),
    customers: [...conn.db.customer.iter()].map(c => ({ id: String(c.id), name: c.name })),
  });
  let companyRows = 0;
  for (const [kind, rows] of Object.entries(company)) {
    for (let i = 0; i < rows.length; i += 200) {
      await r.seedCompanyRecords({ kind, rows: rows.slice(i, i + 200).map(x => JSON.stringify(x)) });
    }
    companyRows += rows.length;
  }
  await waitFor(() => conn.db.companyRecord.count() >= BigInt(companyRows), 'company records');

  await r.sealSetup({});
  console.log('setup sealed: seeding is now CFO-only until a reset');
  console.log(
    JSON.stringify({
      closeYm: seed.closeYm,
      subsidiaries: Number(conn.db.subsidiary.count()),
      fxRates: Number(conn.db.fxRate.count()),
      customers: Number(conn.db.customer.count()),
      vendors: Number(conn.db.vendor.count()),
      contracts: Number(conn.db.contract.count()),
      invoices: Number(conn.db.invoice.count()),
      bills: Number(conn.db.bill.count()),
      bankTransactions: Number(conn.db.bankTransaction.count()),
      journalEntries: posted,
      journalLines: Number(conn.db.journalLine.count()),
      closeTasks: Number(conn.db.closeTask.count()),
    })
  );
  armClaimLink(conn);
  process.exit(0);
}

main().catch(err => {
  console.error('seed failed:', err?.message ?? err);
  process.exit(1);
});
