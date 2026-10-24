/**
 * Loads seed/out/seed.json into the running SpacetimeDB database through reducers.
 * Runs as the advisor identity (token in .secrets/advisor.token) so the same identity later drives the agents.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbConnection } from '@cafoo/stdb-bindings';
import type { Seed } from './generate';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const URI = process.env.SPACETIMEDB_URI ?? 'ws://localhost:3000';
const DB = process.env.SPACETIMEDB_DB_NAME ?? 'cafoo';
const TOKEN_FILE = join(root, '.secrets', 'advisor.token');

function loadToken(): string | undefined {
  try {
    return existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() || undefined : undefined;
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
      await r.resetDemo({ confirm: 'RESET' });
      await waitFor(() => conn.db.subsidiary.count() === 0n, 'reset');
      console.log('demo data cleared');
    } else {
      console.log('database already seeded; set SEED_RESET=1 to reload');
      process.exit(0);
    }
  }

  // 2. Structure
  await r.seedSubsidiary({ code: seed.subsidiary.code, name: seed.subsidiary.name, functionalCcy: seed.subsidiary.functionalCcy, parentCode: undefined });
  await r.seedAccounts({ subsidiaryCode: 'US', accounts: seed.accounts });
  await r.seedPeriods({ subsidiaryCode: 'US', yms: seed.periods.yms, closedYms: seed.periods.closedYms });
  await waitFor(() => conn.db.account.count() >= BigInt(seed.accounts.length) && conn.db.period.count() >= BigInt(seed.periods.yms.length), 'accounts and periods');

  // 3. Parties
  await r.seedCustomers({ subsidiaryCode: 'US', customers: seed.customers.map(c => ({ name: c.name, domain: c.domain, guarantorPersonaId: c.guarantorPersonaId, guarantorName: c.guarantorName, paymentTermsDays: c.paymentTermsDays })) });
  await r.seedVendors({ subsidiaryCode: 'US', vendors: seed.vendors.map(v => ({ name: v.name, domain: v.domain, category: v.category, ownerPersonaId: v.ownerPersonaId })) });
  await waitFor(() => conn.db.customer.count() >= BigInt(seed.customers.length) && conn.db.vendor.count() >= BigInt(seed.vendors.length), 'customers and vendors');
  const customerId = new Map<number, bigint>();
  for (const c of seed.customers) {
    const row = [...conn.db.customer.iter()].find(x => x.name === c.name);
    if (!row) throw new Error(`customer ${c.name} missing after seed`);
    customerId.set(c.idx, row.id);
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
  const txs = seed.bankTransactions.map(x => ({ bookedAtMicros: BigInt(x.bookedAtMicros), ym: x.ym, amountMinor: BigInt(x.amountMinor), ccy: x.ccy, description: x.description, counterparty: x.counterparty, matched: x.matched }));
  for (let i = 0; i < txs.length; i += 40) {
    await r.seedBankTransactions({ subsidiaryCode: 'US', txs: txs.slice(i, i + 40) });
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

  // 7. Close checklist
  await r.seedCloseTasks({ periodYm: seed.closeYm, tasks: seed.closeTasks });

  await waitFor(() => conn.db.journalEntry.count() >= BigInt(seed.journalEntries.length), 'journal entries');
  await r.sealSetup({});
  console.log('setup sealed: seeding is now CFO-only until a reset');
  console.log(
    JSON.stringify({
      closeYm: seed.closeYm,
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
  process.exit(0);
}

main().catch(err => {
  console.error('seed failed:', err?.message ?? err);
  process.exit(1);
});
