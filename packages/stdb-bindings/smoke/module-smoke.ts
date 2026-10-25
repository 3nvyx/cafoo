/**
 * Module smoke test. Publishes the working-tree module to a throwaway database, seeds it with the demo loader, and
 * checks every gate, refusal and legitimate flow that the module reviews pinned down, then deletes the database: the
 * CFO seat bootstrap, the two-tier gate, revenue, bank and vendor rules, revaluations and eliminations, charters, the
 * live feed and resetDemo. A second throwaway database checks an in-place upgrade from a module that predates
 * bank_match.paymentJeId (seeded with that commit's own loader and bindings, extracted with git archive).
 * Exits non-zero on any failed assertion.
 *
 *   pnpm -F @luyten/stdb-bindings smoke
 *
 * Needs a local SpacetimeDB on :3000 and the spacetime CLI (SPACETIME_BIN, ~/.local/bin/spacetime, or PATH).
 * SMOKE_DB names the database (must end in "smoke"); LEGACY_REF is the git commit of the pre-paymentJeId module
 * (default 57884e2); SMOKE_SKIP_LEGACY=1 skips the upgrade check; SMOKE_KEEP=1 keeps the databases for inspection.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbConnection } from '../src/index';
import { bankExceptionAcceptance, bankExceptionSnapshot, currentBankExceptions } from '../../ledger-core/src/bank-exceptions';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const moduleDir = join(repo, 'spacetimedb', 'spacetimedb');
const DB = process.env.SMOKE_DB ?? 'luyten-smoke';
const LEGACY_DB = `${DB}-legacy`;
const LEGACY_REF = process.env.LEGACY_REF ?? '57884e2';
const URI = 'ws://localhost:3000';
if (!DB.endsWith('smoke')) throw new Error(`refusing to use database "${DB}": SMOKE_DB must end in "smoke"`);
const BIN = process.env.SPACETIME_BIN ?? (existsSync(join(homedir(), '.local', 'bin', 'spacetime')) ? join(homedir(), '.local', 'bin', 'spacetime') : 'spacetime');

// ---------- reporting ----------
let failures = 0;
let passes = 0;
const pass = (label: string, detail = '') => {
  passes++;
  console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};
const fail = (label: string, detail: string) => {
  failures++;
  console.log(`  FAIL  ${label} — ${detail}`);
};
const check = (cond: boolean, label: string, detail = '') => (cond ? pass(label, detail) : fail(label, detail || 'condition false'));
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function refuses(label: string, f: () => Promise<unknown>, re: RegExp) {
  try {
    await f();
    fail(label, 'was accepted');
  } catch (e) {
    const m = msgOf(e);
    if (re.test(m)) pass(label, m.length > 140 ? `${m.slice(0, 140)}…` : m);
    else fail(label, `refused for the wrong reason: ${m}`);
  }
}
async function accepts<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await f();
    pass(label);
    return r;
  } catch (e) {
    fail(label, `refused: ${msgOf(e)}`);
    return undefined;
  }
}
async function section(name: string, f: () => Promise<void>) {
  console.log(`\n${name}`);
  try {
    await f();
  } catch (e) {
    fail(`${name} (section aborted)`, msgOf(e));
  }
}

// ---------- process helpers ----------
function run(cmd: string, args: string[], env: Record<string, string> = {}, cwd = repo) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) {
    const out = (r.stderr || r.stdout || String(r.error)).trim();
    // The spacetime CLI puts a reducer's refusal on its first "Error:" line, ahead of a long backtrace.
    const first = out.match(/^Error: .*$/m)?.[0];
    throw new Error(`${cmd} ${args.join(' ')} failed: ${first ? `${first} … ` : ''}${out.slice(-600)}`);
  }
  return r.stdout;
}
const publish = (db: string, dir: string, fresh: boolean) =>
  run(BIN, ['publish', db, '--server', 'local', '--yes', '--no-config', '-p', dir, ...(fresh ? ['--delete-data=always'] : [])]);
const dropDb = (db: string) => spawnSync(BIN, ['delete', db, '-s', 'local', '--yes'], { encoding: 'utf8' });
// The smoke arms its own CFO claim (below), so the loader must not arm one.
const seedDb = (db: string) => {
  run('pnpm', ['-F', '@luyten/seed', 'generate']);
  run('pnpm', ['-F', '@luyten/seed', 'load'], { SPACETIMEDB_DB_NAME: db, SEED_NO_BOOTSTRAP: '1' });
};
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Arm a one-time CFO claim as the database owner: the CLI identity that published the smoke database. */
const armBootstrap = (db: string, secret: string, ttlMinutes = 60) =>
  run(BIN, ['call', db, 'arm_cfo_bootstrap', JSON.stringify(sha256(secret)), String(ttlMinutes), '--server', 'local', '--no-config', '--yes']);

// ---------- money (same rounding as ledger-core and the module) ----------
const FX = 1_000_000n;
const divRound = (n: bigint, d: bigint) => {
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
};
const applyFx = (amount: bigint, rateE6: bigint) => divRound(amount * (rateE6 === 0n ? FX : rateE6), FX);
const absB = (n: bigint) => (n < 0n ? -n : n);

// ---------- credit check evidence (the cascade's facts, as packages/crs-mcp records them) ----------
const bureauFile = (score: number) => ({ fileStatus: 'returned', score, tradelines: 9, derogatories: 0, activeDerogatories: 0, collections: 0, publicRecords: [] });
/** A clean full cascade: identity PASS, low fraud, three scored bureau files (lowest 760), no public records. Tier A. */
const CLEAN_FACTS = {
  identity: { result: 'PASS', codes: [], texts: [], deceased: false, synthetic: false, available: true },
  fraud: { score: 12, level: 'low', signals: [], available: true },
  bureaus: { transunion: bureauFile(781), equifax: bureauFile(760), experian: bureauFile(790) },
  publicRecords: { available: true, counts: { bankruptcies: 0, judgments: 0, liens: 0 }, bankruptcies: [], judgments: [], liens: [], criminal: [], evictions: [] },
};
/** An early stop: the identity check says the person has died. Tier BLOCK. */
const DECEASED_FACTS = {
  identity: { result: 'FAIL', codes: ['2301'], texts: ['Deceased'], deceased: true, synthetic: false, available: true },
  fraud: { score: 74, level: 'high', signals: [], available: true },
  bureaus: {},
};

// ---------- connections ----------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(f: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
type Who = { conn: DbConnection; identity: NonNullable<DbConnection['identity']>; name: string; token: string };
function connect(db: string, name: string, token?: string, tables?: string[]): Promise<Who> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(db)
      .withToken(token)
      .onConnect((conn, identity, newToken) => {
        // A refused subscription (an unknown table or view) rejects instead of leaving the smoke waiting forever.
        const sub = conn
          .subscriptionBuilder()
          .onApplied(() => resolve({ conn, identity, name, token: newToken }))
          .onError(ctx => reject(new Error(`subscription for ${name} refused: ${String((ctx as { event?: unknown }).event ?? 'unknown error')}`)));
        if (tables) sub.subscribe(tables.map(t => `SELECT * FROM ${t}`));
        else sub.subscribeToAllTables();
      })
      .onConnectError((_c, e) => reject(e))
      .build();
  });
}
/** The advisor identity the seed loader saved for that database (.secrets/<db>/advisor.token). */
const advisorToken = (db: string) => readFileSync(join(repo, '.secrets', db, 'advisor.token'), 'utf8').trim();

// ---------- the main database ----------
async function main() {
  console.log(`publishing the working-tree module to ${DB} and seeding it`);
  publish(DB, moduleDir, true);
  seedDb(DB);
  const seed = JSON.parse(readFileSync(join(repo, 'seed', 'out', 'seed.json'), 'utf8')) as { closeYm: string };
  const CLOSE = seed.closeYm;
  const ymAdd = (ym: string, n: number) => {
    const [y, m] = ym.split('-').map(Number);
    const i = y! * 12 + (m! - 1) + n;
    return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  };
  const PREV = ymAdd(CLOSE, -1);
  const NEXT = ymAdd(CLOSE, 1);

  const A = await connect(DB, 'advisor', advisorToken(DB));
  const X = await connect(DB, 'cfo');
  await section('CFO seat: claimed only with the owner-armed one-time secret', async () => {
    await refuses('a connection registers itself as CFO', () => X.conn.reducers.registerAgent({ role: { tag: 'Cfo' }, displayName: 'Smoke CFO', model: 'human' }), /Claim the CFO seat with the one-time bootstrap secret/);
    await refuses('a claim before any secret is armed', () => X.conn.reducers.claimCfo({ secret: 'nothing-armed', displayName: 'Smoke CFO' }), /No CFO claim is armed/);
    const secret = randomBytes(18).toString('base64url');
    await refuses('the advisor arms a CFO claim', () => A.conn.reducers.armCfoBootstrap({ secretSha256: sha256(secret), ttlMinutes: 60 }), /Only the database owner/);
    await refuses('the owner arms with a malformed hash', async () => run(BIN, ['call', DB, 'arm_cfo_bootstrap', '"abc"', '60', '--server', 'local', '--no-config', '--yes']), /64-character hex/);
    await accepts('the database owner arms a CFO claim through the CLI', async () => armBootstrap(DB, secret));
    await refuses('a claim with a wrong secret', () => X.conn.reducers.claimCfo({ secret: `${secret}x`, displayName: 'Smoke CFO' }), /not the claim secret/);
    await refuses('the advisor claims with the right secret', () => A.conn.reducers.claimCfo({ secret, displayName: 'Advisor' }), /registered as advisor/);
    await accepts('a claim with the armed secret (surrounding whitespace ignored)', () => X.conn.reducers.claimCfo({ secret: ` ${secret}\n`, displayName: 'Smoke CFO' }));
    const roster = await waitFor(() => X.conn.db.agentRoster.role.find('cfo'), 'cfo roster row');
    check(roster.model === 'human' && roster.displayName === 'Smoke CFO', 'the roster shows the human CFO', `${roster.displayName} (${roster.model})`);
    const Y = await connect(DB, 'second claimant', undefined, ['agent_roster']);
    await refuses('a second claim with the same secret', () => Y.conn.reducers.claimCfo({ secret, displayName: 'Impostor' }), /already claimed/);
    Y.conn.disconnect();
    await refuses('the owner arms again once a CFO exists', async () => armBootstrap(DB, secret), /already claimed/);
    await accepts('the CFO re-registers as itself (display-name refresh)', () => X.conn.reducers.registerAgent({ role: { tag: 'Cfo' }, displayName: 'Smoke CFO', model: 'human' }));
    // agent_identity is private; my_agent_identity shows each caller its own row only, so a browser can tell whether
    // it holds the CFO seat without reading anyone else's identity.
    const mineOf = async (name: string, token: string | undefined) => {
      const w = await connect(DB, name, token, ['my_agent_identity']);
      await sleep(200);
      const rows = [...w.conn.db.myAgentIdentity.iter()];
      w.conn.disconnect();
      return rows;
    };
    const cfoRows = await mineOf('cfo view', X.token);
    check(cfoRows.length === 1 && cfoRows[0]!.role.tag === 'Cfo' && cfoRows[0]!.identity.isEqual(X.identity), 'my_agent_identity shows the CFO its own seat', cfoRows.map(r => r.role.tag).join(', '));
    const advRows = await mineOf('advisor view', advisorToken(DB));
    check(advRows.length === 1 && advRows[0]!.role.tag === 'Advisor', 'my_agent_identity shows the advisor its own role, not the CFO row', advRows.map(r => r.role.tag).join(', '));
    const noRows = await mineOf('unregistered view', undefined);
    check(noRows.length === 0, 'my_agent_identity shows an unregistered connection nothing', `${noRows.length} row(s)`);
  });
  const workers: Record<string, Who> = {};
  for (const [role, tag] of [['bookkeeper', 'Bookkeeper'], ['revenue', 'Revenue'], ['credit', 'Credit'], ['redteam', 'Redteam'], ['consolidation', 'Consolidation'], ['feed', 'Feed']] as const) {
    workers[role] = await connect(DB, role);
    await A.conn.reducers.grantRole({ identity: workers[role]!.identity, role: { tag }, displayName: `Smoke ${role}`, model: 'smoke' });
  }
  const B = workers.bookkeeper!;
  const R = workers.revenue!;
  const C = workers.credit!;
  const RT = workers.redteam!;
  const CN = workers.consolidation!;
  const F = workers.feed!;
  const db = X.conn.db;
  /** Review the current fixture state immediately before a successful lock; previous consent cannot survive changes. */
  const acceptFixtureBankExceptions = async (periodYm: string) => {
    const input = () => ({
      periodYm,
      bankRows: [...db.bankTransaction.iter()].map(row => ({
        id: String(row.id), subsidiaryId: String(row.subsidiaryId), ym: row.ym,
        bookedAt: new Date(Number(row.bookedAt.microsSinceUnixEpoch / 1000n)).toISOString(),
        amountMinor: String(row.amountMinor), ccy: row.ccy, description: row.description,
        counterparty: row.counterparty, matched: row.matched,
      })),
      auditEvents: [...db.auditEvent.iter()].map(event => ({
        id: String(event.id), actorRole: event.actorRole, action: event.action, targetTable: event.targetTable,
        targetId: String(event.targetId), detail: event.detail,
        at: new Date(Number(event.at.microsSinceUnixEpoch / 1000n)).toISOString(),
      })),
    });
    const exceptions = currentBankExceptions(input());
    if (exceptions.length === 0) return;
    await accepts(`fixture CFO explicitly accepts ${exceptions.length} bank exception(s) through ${periodYm}`, () => X.conn.reducers.acceptBankExceptions({
      periodYm,
      expectedSnapshot: bankExceptionSnapshot(input()),
      reasonPlain: 'Smoke fixture CFO reviewed these unmatched bank lines and accepts carrying them as explicit exceptions for the lock probe.',
    }));
    await waitFor(() => bankExceptionAcceptance(input()).accepted, `fixture CFO bank exception acceptance for ${periodYm}`);
  };
  await sleep(300);
  // The root company: no parent and not the elimination company (iteration order is not guaranteed once UK/ELIM exist).
  const root = [...db.subsidiary.iter()].find(s => s.parentId === undefined && !s.isElimination)!;
  const sub = root.id.toString();

  let seq = 0;
  type P = NonNullable<ReturnType<typeof db.proposal.id.find>>;
  async function propose(who: Who, kind: string, payload: unknown, periodYm: string, amountMinor = 0n): Promise<P> {
    const summary = `Smoke ${kind} number ${++seq}, a plain English summary.`;
    await who.conn.reducers.propose({ kind, payloadJson: JSON.stringify(payload), rationale: 'smoke', summaryPlain: summary, amountMinor, periodYm, closeTaskId: undefined });
    return waitFor(() => [...db.proposal.iter()].find(p => p.summaryPlain === summary), `proposal ${seq}`);
  }
  type L = { accountCode: string; debitMinor: string; creditMinor: string; ccy?: string; fxRateE6?: string; customerId?: string; vendorId?: string };
  const je = (who: Who, periodYm: string, lines: L[], extra: object = {}, kind = 'journal_entry') =>
    propose(who, kind, { subsidiaryId: sub, periodYm, memo: `smoke ${kind}`, lines, ...extra }, periodYm);
  const status = (id: bigint) => db.proposal.id.find(id)!.status.tag;
  /** The Advisor's ruling, once this client has seen the proposal leave the open states. */
  async function approve(p: P) {
    await A.conn.reducers.approveProposal({ proposalId: p.id, rationale: 'smoke ruling', summaryPlain: 'Approved by the smoke test.', amendedPayloadJson: undefined });
    await waitFor(() => !['Open', 'SentBack'].includes(status(p.id)), `ruling on proposal ${p.id}`);
  }
  /** Advisor approves; if the amount is material the CFO confirms. Resolves once the proposal has applied. */
  async function settle(p: P) {
    await approve(p);
    if (status(p.id) === 'AwaitingCfo') await X.conn.reducers.cfoConfirm({ proposalId: p.id, note: '' });
    await waitFor(() => ['Approved', 'Amended'].includes(status(p.id)), `proposal ${p.id} applied`);
  }
  const entriesOf = (proposalId: bigint) => [...db.journalEntry.iter()].filter(j => j.proposalId === proposalId);
  const linesOf = (jeId: bigint) => [...db.journalLine.jeId.filter(jeId)];
  const subscriptionItems = () => new Set([...db.contractItem.iter()].filter(i => i.kind.tag === 'Subscription').map(i => i.id));
  const unrecognized = (upTo: string, customer?: bigint) => {
    const items = subscriptionItems();
    return [...db.revenueScheduleLine.iter()].filter(l => !l.recognized && l.ym <= upTo && items.has(l.contractItemId) && (customer === undefined || l.customerId === customer));
  };
  const sumOf = (ls: { amountMinor: bigint }[]) => ls.reduce((a, l) => a + l.amountMinor, 0n);

  // CFO-only fixtures (setup is sealed after the load): FX rates, probe invoices and bank lines.
  await X.conn.reducers.seedFxRate({ fromCcy: 'EUR', toCcy: 'USD', ym: NEXT, rateE6: 1_080_000n, kind: 'spot' });
  await X.conn.reducers.seedFxRate({ fromCcy: 'jpy', toCcy: 'usd', ym: NEXT, rateE6: 6_700n, kind: 'spot' });
  const cust0 = [...db.customer.iter()].find(c => c.subsidiaryId === root.id)!;
  await X.conn.reducers.seedInvoice({ customerId: cust0.id, contractCode: undefined, number: 'SMOKE-EUR-1', ym: CLOSE, issuedAtMicros: 1788000000000000n, dueAtMicros: 1799000000000000n, amountMinor: 110000n, status: 'open' });
  // These probes wait for the real once-a-minute scheduler while the other smoke cases run.
  for (const probe of [
    { number: 'SMOKE-OVERDUE-TICK', dueAtMicros: 1n, status: 'open' },
    { number: 'SMOKE-OVERDUE-FUTURE', dueAtMicros: 7_258_118_400_000_000n, status: 'open' },
    { number: 'SMOKE-OVERDUE-PAID', dueAtMicros: 1n, status: 'paid' },
  ]) {
    await X.conn.reducers.seedInvoice({ customerId: cust0.id, contractCode: undefined, ym: CLOSE, issuedAtMicros: 0n, amountMinor: 1n, ...probe });
  }
  const bds = await waitFor(() => [...db.vendor.iter()].find(v => v.name.startsWith('Brennan')), 'BDS vendor');
  await X.conn.reducers.seedBankTransactions({
    subsidiaryCode: 'US',
    txs: [
      { bookedAtMicros: 1789000000000000n, ym: CLOSE, amountMinor: 100000n, ccy: 'EUR', description: 'SMOKE EUR WIRE SMOKE-EUR-1', counterparty: cust0.name, matched: false },
      { bookedAtMicros: 1789000000000000n, ym: CLOSE, amountMinor: -2475000n, ccy: 'USD', description: 'SMOKE ACH DEBIT BRENNAN BDS-0001', counterparty: bds.name, matched: false },
      { bookedAtMicros: 1786000000000000n, ym: PREV, amountMinor: -7777n, ccy: 'USD', description: 'SMOKE LOCKED MONTH LINE', counterparty: 'Smoke', matched: false },
      { bookedAtMicros: 1789000000000000n, ym: CLOSE, amountMinor: -1234n, ccy: 'USD', description: 'SMOKE MISC OUTFLOW', counterparty: 'Smoke Misc', matched: false },
      { bookedAtMicros: 1789000000000000n, ym: CLOSE, amountMinor: 50000n, ccy: 'USD', description: 'SMOKE REFUND FROM BRENNAN', counterparty: bds.name, matched: false },
    ],
  });
  const invEur = await waitFor(() => [...db.invoice.iter()].find(i => i.number === 'SMOKE-EUR-1'), 'probe invoice');
  const txEur = await waitFor(() => [...db.bankTransaction.iter()].find(t => t.description === 'SMOKE EUR WIRE SMOKE-EUR-1'), 'EUR line');
  const txBds = await waitFor(() => [...db.bankTransaction.iter()].find(t => t.description === 'SMOKE ACH DEBIT BRENNAN BDS-0001'), 'BDS line');
  const txLocked = await waitFor(() => [...db.bankTransaction.iter()].find(t => t.description === 'SMOKE LOCKED MONTH LINE'), 'locked-month line');
  const txMisc = await waitFor(() => [...db.bankTransaction.iter()].find(t => t.description === 'SMOKE MISC OUTFLOW'), 'misc outflow');
  const txRefund = await waitFor(() => [...db.bankTransaction.iter()].find(t => t.description === 'SMOKE REFUND FROM BRENNAN'), 'BDS refund');
  const anyJe = [...db.journalEntry.iter()].find(j => j.subsidiaryId === root.id)!;

  await section('Finding 1: a month with unrecognized subscription revenue cannot lock', async () => {
    const due = unrecognized(CLOSE);
    check(due.length > 0, `seed leaves ${CLOSE} subscription lines unrecognized`, `${due.length} lines, ${sumOf(due)} minor`);
    await refuses(`advisor requests the ${CLOSE} lock`, () => A.conn.reducers.requestPeriodLock({ periodYm: CLOSE, rationale: 'smoke', summaryPlain: 'Smoke: ready to lock.' }), /still unrecognized for \d+ customer\(s\): .+\$/);
    await refuses(`CFO locks ${CLOSE}`, () => X.conn.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'smoke' }), /cannot be locked yet: \$[\d,]+\.\d\d of subscription revenue/);
  });

  await section('Q2: opening balances stay off the first month\'s P&L', async () => {
    const opening = [...db.journalEntry.iter()].filter(j => j.memo.startsWith('Opening balance'));
    const perCustomer = opening.filter(j => j.memo.startsWith('Opening balance: revenue recognized before'));
    const pnl = opening.flatMap(j => linesOf(j.id)).filter(l => l.accountCode.startsWith('4') || l.accountCode.startsWith('5') || l.accountCode.startsWith('6'));
    check(perCustomer.length > 0 && pnl.length === 0, 'per-customer opening-balance entries exist and post to balance-sheet accounts only', `${perCustomer.length} per-customer entries, ${pnl.length} P&L lines`);
    // The first seeded month's subscription revenue is exactly that month's schedule lines, nothing earned earlier.
    const first = ymAdd(CLOSE, -2);
    const firstPeriod = [...db.period.iter()].find(x => x.ym === first)!;
    const credited = [...db.journalEntry.periodId.filter(firstPeriod.id)].flatMap(j => linesOf(j.id)).filter(l => l.accountCode === '4000').reduce((a, l) => a + l.creditMinor - l.debitMinor, 0n);
    const items = subscriptionItems();
    const scheduled = [...db.revenueScheduleLine.ym.filter(first)].filter(l => items.has(l.contractItemId)).reduce((a, l) => a + l.amountMinor, 0n);
    check(credited === scheduled, `${first} subscription revenue equals ${first} schedule lines`, `${credited} vs ${scheduled}`);
  });

  await section('Finding 4 (round 6): malformed payloads are refused, not crashes', async () => {
    const raw = (who: Who, kind: string, payloadJson: string) =>
      who.conn.reducers.propose({ kind, payloadJson, rationale: 'smoke', summaryPlain: `Smoke malformed ${kind} payload probe.`, amountMinor: 0n, periodYm: CLOSE, closeTaskId: undefined });
    await refuses('journal entry payload null', () => raw(B, 'journal_entry', 'null'), /must be a JSON object/);
    await refuses('bank match payload null', () => raw(B, 'bank_match', 'null'), /must be a JSON object/);
    await refuses('journal entry lines [null, null]', () => raw(B, 'journal_entry', JSON.stringify({ subsidiaryId: sub, periodYm: CLOSE, memo: 'x', lines: [null, null] })), /item 1 must be an object/);
    await refuses('journal entry lines as a string', () => raw(B, 'journal_entry', JSON.stringify({ subsidiaryId: sub, periodYm: CLOSE, memo: 'x', lines: 'abc' })), /list of lines/);
    await refuses('bankTxIds as a string', () => raw(B, 'journal_entry', JSON.stringify({ subsidiaryId: sub, periodYm: CLOSE, memo: 'x', lines: [{ accountCode: '6000', debitMinor: '1', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1' }], bankTxIds: '12' })), /bankTxIds must be a list/);
    await refuses('vendor verification creditCheckIds as a string', () => raw(C, 'vendor_verify', JSON.stringify({ vendorId: bds.id.toString(), creditCheckIds: 'abc' })), /creditCheckIds must be a list/);
    await refuses('revenue schedule payload as a list', () => raw(R, 'revenue_schedule', '[]'), /must be a JSON object/);
    await refuses('bank match with a non-numeric score', () => raw(B, 'bank_match', JSON.stringify({ matches: [{ bankTxId: txMisc.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 'high' }] })), /scoreBp must be a whole number/);
    await refuses('credit decision with text payment terms', () => raw(C, 'credit_decision', JSON.stringify({ customerId: cust0.id.toString(), tier: 'A', paymentTermsDays: 'thirty' })), /paymentTermsDays must be a whole number/);
    await refuses('vendor block with no reason', () => raw(C, 'vendor_block', JSON.stringify({ vendorId: bds.id.toString() })), /needs a plain-English reason/);
    const alive = await accepts('the database still takes a valid proposal afterwards', () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '1', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1' }]));
    if (alive) await A.conn.reducers.rejectProposal({ proposalId: alive.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
  });

  await section('Gate: roles are enforced in the reducers', async () => {
    const open = await je(B, CLOSE, [{ accountCode: '6000', debitMinor: '500', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '500' }]);
    await refuses('bookkeeper approves a proposal', () => B.conn.reducers.approveProposal({ proposalId: open.id, rationale: 'x', summaryPlain: 'Bookkeeper approving itself.', amendedPayloadJson: undefined }), /Only advisor may approve/);
    await refuses('advisor confirms as CFO', () => A.conn.reducers.cfoConfirm({ proposalId: open.id, note: 'x' }), /Only cfo/);
    await refuses('bookkeeper reverses an entry', () => B.conn.reducers.cfoReverse({ jeId: anyJe.id, reasonPlain: 'x' }), /Only cfo/);
    await refuses('advisor grants itself the CFO role', () => A.conn.reducers.grantRole({ identity: A.identity, role: { tag: 'Cfo' }, displayName: 'x', model: 'x' }), /Only the CFO can grant/);
    await refuses('bookkeeper registers as advisor', () => B.conn.reducers.registerAgent({ role: { tag: 'Advisor' }, displayName: 'x', model: 'x' }), /registered as bookkeeper/);
    await refuses('red team proposes', () => RT.conn.reducers.propose({ kind: 'journal_entry', payloadJson: '{}', rationale: 'x', summaryPlain: 'Red team trying to propose.', amountMinor: 0n, periodYm: CLOSE, closeTaskId: undefined }), /may propose/);
    await refuses('bookkeeper proposes a revenue schedule', () => B.conn.reducers.propose({ kind: 'revenue_schedule', payloadJson: '{"lines":[]}', rationale: 'x', summaryPlain: 'Bookkeeper proposing revenue.', amountMinor: 0n, periodYm: CLOSE, closeTaskId: undefined }), /does not propose revenue_schedule/);
    await refuses('advisor records a credit check', () => A.conn.reducers.recordCreditCheck({ subjectKind: 'vendor', subjectId: bds.id, personaId: 'P01', product: 'fraud_finder', requestId: 'adv-1', summaryJson: '{}' }), /Only credit/);
    await refuses('advisor resets the sealed demo', () => A.conn.reducers.resetDemo({ confirm: 'RESET' }), /sealed/);
    await refuses('advisor seeds a journal entry after sealing', () => A.conn.reducers.seedJournalEntry({ subsidiaryCode: 'US', periodYm: CLOSE, memo: 'x', lines: [{ accountCode: '1000', debitMinor: 1n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1000000n, customerId: undefined, vendorId: undefined, memo: '' }, { accountCode: '3000', debitMinor: 0n, creditMinor: 1n, ccy: 'USD', fxRateE6: 1000000n, customerId: undefined, vendorId: undefined, memo: '' }] }), /sealed/);
    await A.conn.reducers.rejectProposal({ proposalId: open.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
  });

  await section('F10: the Advisor never proposes, and no identity approves or confirms its own Proposal', async () => {
    const small = [{ accountCode: '6000', debitMinor: '300', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '300' }];
    await refuses('the advisor proposes a journal entry', () => A.conn.reducers.propose({ kind: 'journal_entry', payloadJson: JSON.stringify({ subsidiaryId: sub, periodYm: CLOSE, memo: 'smoke advisor entry', lines: small }), rationale: 'x', summaryPlain: 'The Advisor trying to propose its own entry.', amountMinor: 0n, periodYm: CLOSE, closeTaskId: undefined }), /may propose\. Your connection is advisor/);
    await sleep(200);
    check(![...db.proposal.iter()].some(p => p.proposerRole === 'advisor'), 'no proposal on file comes from the advisor');
    // A bookkeeper the CFO later promotes to Advisor cannot rule on what it proposed as a bookkeeper.
    const W = await connect(DB, 'promoted bookkeeper');
    await A.conn.reducers.grantRole({ identity: W.identity, role: { tag: 'Bookkeeper' }, displayName: 'Smoke promoted bookkeeper', model: 'smoke' });
    await sleep(300);
    const own = await je(W, CLOSE, small);
    await accepts('the CFO promotes that bookkeeper to advisor', () => X.conn.reducers.grantRole({ identity: W.identity, role: { tag: 'Advisor' }, displayName: 'Smoke second advisor', model: 'smoke' }));
    await sleep(300);
    await refuses('the promoted advisor approves the proposal it made', () => W.conn.reducers.approveProposal({ proposalId: own.id, rationale: 'x', summaryPlain: 'Approving the proposal I made myself.', amendedPayloadJson: undefined }), /its own Proposal/);
    await refuses('the promoted advisor approves it with an amendment', () => W.conn.reducers.approveProposal({ proposalId: own.id, rationale: 'x', summaryPlain: 'Amending the proposal I made myself.', amendedPayloadJson: own.payloadJson }), /its own Proposal/);
    await sleep(200);
    check(status(own.id) === 'Open', 'the proposal stays open for another identity to rule', status(own.id));
    // A bookkeeper the CFO later makes CFO cannot confirm what it proposed.
    const V = await connect(DB, 'bookkeeper made cfo');
    await A.conn.reducers.grantRole({ identity: V.identity, role: { tag: 'Bookkeeper' }, displayName: 'Smoke bookkeeper made CFO', model: 'smoke' });
    await sleep(300);
    const material = await je(V, CLOSE, [{ accountCode: '6000', debitMinor: '2000000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '2000000' }]);
    await approve(material);
    check(status(material.id) === 'AwaitingCfo', 'the material proposal waits for the CFO', status(material.id));
    await accepts('the CFO makes that bookkeeper a second CFO', () => X.conn.reducers.grantRole({ identity: V.identity, role: { tag: 'Cfo' }, displayName: 'Smoke CFO', model: 'human' }));
    await sleep(300);
    await refuses('the new CFO confirms the proposal it made', () => V.conn.reducers.cfoConfirm({ proposalId: material.id, note: 'x' }), /its own Proposal/);
    await sleep(200);
    check(status(material.id) === 'AwaitingCfo', 'it still waits for a CFO who did not propose it', status(material.id));
    await X.conn.reducers.cfoSendBack({ proposalId: material.id, notePlain: 'smoke cleanup' });
    for (const p of [material, own]) await A.conn.reducers.rejectProposal({ proposalId: p.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    W.conn.disconnect();
    V.conn.disconnect();
  });

  await section('F24: a credit tier is derived from the recorded evidence, never taken from the caller', async () => {
    const guarantor = cust0.guarantorPersonaId;
    const other = guarantor === 'P02' ? 'P03' : 'P02';
    const nw = [...db.vendor.iter()].find(v => v.name === 'Northwind Cloud')!;
    const rec = (requestId: string, facts: unknown, o: { personaId?: string; subjectKind?: string; subjectId?: bigint } = {}) =>
      C.conn.reducers.recordCreditCheck({
        subjectKind: o.subjectKind ?? 'customer',
        subjectId: o.subjectId ?? cust0.id,
        personaId: o.personaId ?? guarantor,
        product: 'fraud_finder',
        requestId,
        summaryJson: JSON.stringify({ product: 'fraud_finder', requestId, summary: 'smoke evidence', status: 200, ...(facts === undefined ? {} : { facts }) }),
      });
    const rowOf = (requestId: string) => waitFor(() => [...db.creditCheck.iter()].find(r => r.requestId === requestId), `credit check ${requestId}`);
    await refuses('a credit check with no evidence facts', () => rec('smk-cc-none', undefined), /facts/);
    await refuses("a credit check on someone other than the customer's guarantor", () => rec('smk-cc-other', CLEAN_FACTS, { personaId: other }), new RegExp(`guarantor of customer ${cust0.id} .* is ${guarantor}; a check on ${other} is not evidence`));
    await refuses('a credit check on a vendor with no owner on file', () => rec('smk-cc-nw', CLEAN_FACTS, { subjectKind: 'vendor', subjectId: nw.id, personaId: 'P01' }), /no owner/);
    await refuses('evidence that passes identity and fraud but skips the bureaus', () => rec('smk-cc-short', { ...CLEAN_FACTS, bureaus: {} }), /all three credit bureaus/);
    await refuses('evidence whose fraud level contradicts its score', () => rec('smk-cc-fraud', { ...CLEAN_FACTS, fraud: { ...CLEAN_FACTS.fraud, score: 85, level: 'low' } }), /fraud level/);
    await accepts("a deceased guarantor's evidence (the caller states no tier)", () => rec('smk-cc-dead', DECEASED_FACTS));
    const dead = await rowOf('smk-cc-dead');
    check(dead.tier === 'BLOCK' && dead.decision === 'DECLINE', 'the tier on file is the one its evidence derives', `${dead.tier}/${dead.decision}`);
    const decide = (tier: string, ids: string[], paymentTermsDays: number) => propose(C, 'credit_decision', { customerId: cust0.id.toString(), tier, paymentTermsDays, creditCheckIds: ids }, CLOSE);
    await refuses('a credit decision citing no credit check', () => decide('A', [], 45), /must cite/);
    await refuses('a credit decision with a tier its evidence does not derive', () => decide('A', ['smk-cc-dead'], 45), /derives tier BLOCK, not A/);
    await refuses('a credit decision with an unknown tier', () => decide('AAA', ['smk-cc-dead'], 45), /tier must be one of/);
    await sleep(20);
    await accepts('clean evidence for the same guarantor', () => rec('smk-cc-clean', CLEAN_FACTS));
    const clean = await rowOf('smk-cc-clean');
    check(clean.tier === 'A' && clean.decision === 'APPROVE', 'clean evidence derives tier A', `${clean.tier}/${clean.decision}`);
    await refuses('longer payment terms than the tier allows', () => decide('A', ['smk-cc-clean'], 60), /at most 45-day/);
    const ok = await accepts('a tier A decision citing the clean check', () => decide('A', ['smk-cc-clean'], 30));
    if (ok) {
      await settle(ok);
      const c = db.customer.id.find(cust0.id)!;
      check(c.creditTier === 'A' && c.paymentTermsDays === 30, 'the ruled decision sets the tier and terms', `${c.creditTier} ${c.paymentTermsDays}`);
    }
    await sleep(20);
    await accepts('newer evidence: the guarantor has since died', () => rec('smk-cc-dead-2', DECEASED_FACTS));
    await rowOf('smk-cc-dead-2');
    await refuses('a decision citing the older clean check after a newer BLOCK', () => decide('A', ['smk-cc-clean'], 30), /latest credit check \(request smk-cc-dead-2.*derives tier BLOCK/);
    const block = await accepts('a BLOCK decision with no credit, citing the latest check', () => decide('BLOCK', ['smk-cc-dead-2'], 0));
    if (block) await settle(block);
    // A provider call can come back without a request id; the books store it as ''. Such a row cannot be cited, so it
    // must not make every decision for the customer impossible: the decision's tier must match the latest check's.
    await sleep(20);
    await accepts('newer clean evidence recorded without a request id', () => rec('', CLEAN_FACTS));
    await waitFor(() => [...db.creditCheck.iter()].find(r => r.requestId === '' && r.subjectId === cust0.id && r.tier === 'A'), 'the id-less clean check');
    const idless = await accepts('a tier A decision while the latest check (tier A) has no request id', () => decide('A', ['smk-cc-clean'], 30));
    if (idless) await settle(idless);
    // A newer check at the same tier does not strand a decision that is still waiting for its ruling.
    const waiting = await accepts('a tier A decision citing the clean check', () => decide('A', ['smk-cc-clean'], 30));
    await sleep(20);
    await accepts('newer clean evidence lands before the ruling', () => rec('smk-cc-clean-3', CLEAN_FACTS));
    await rowOf('smk-cc-clean-3');
    if (waiting) await accepts('the waiting decision is still ruled on, since the latest check derives the same tier', () => settle(waiting));
  });

  await section('Advisor amendments wait for the CFO, whatever the amount', async () => {
    const small = await je(B, CLOSE, [{ accountCode: '6000', debitMinor: '300', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '300' }]);
    const amendedPayload = JSON.stringify({ ...JSON.parse(small.payloadJson), memo: 'smoke amended memo' });
    await accepts('the Advisor amends an entry far below the threshold', () =>
      A.conn.reducers.approveProposal({ proposalId: small.id, rationale: 'smoke amendment', summaryPlain: 'Amended by the smoke test.', amendedPayloadJson: amendedPayload }),
    );
    await waitFor(() => !['Open', 'SentBack'].includes(status(small.id)), 'amendment ruled');
    check(status(small.id) === 'AwaitingCfo', 'an amendment waits for the CFO even below the threshold', status(small.id));
    check(entriesOf(small.id).length === 0, 'nothing posts before the CFO confirms the amendment');
    await accepts('the CFO confirms the amendment', () => X.conn.reducers.cfoConfirm({ proposalId: small.id, note: '' }));
    await waitFor(() => status(small.id) === 'Amended', 'amendment applied');
    const posted = entriesOf(small.id);
    check(posted.length === 1 && posted[0]!.memo === 'smoke amended memo', 'the confirmed amendment posts the amended entry', posted.map(e => e.memo).join(', '));
  });

  await section('Feed on fresh seed data: the month being closed is never a feed month', async () => {
    const at = (ym: string) => {
      const [y, m] = ym.split('-').map(Number);
      return BigInt(Date.UTC(y!, m! - 1, 10, 12)) * 1000n;
    };
    const line = (externalId: string, ym: string) => ({ externalId, bookedAtMicros: at(ym), amountMinor: 1000n, ccy: 'USD', description: `SMOKE FRESH ${externalId}`, counterparty: 'Smoke Feed Co' });
    await accepts('the CFO switches the feed on', () => X.conn.reducers.setFeedEnabled({ enabled: true }));
    await refuses(`the feed books into ${CLOSE}, whose previous month carries only the seed's lock`, () => F.conn.reducers.ingestBankTransactions({ subsidiaryCode: root.code, txs: [line('smk-fresh-1', CLOSE)] }), new RegExp(`${PREV} was locked by the seed data, not closed by the CFO`));
    await refuses(`the feed books into ${NEXT} while ${CLOSE} is open`, () => F.conn.reducers.ingestBankTransactions({ subsidiaryCode: root.code, txs: [line('smk-fresh-2', NEXT)] }), new RegExp(`${CLOSE} is not locked yet`));
    await refuses('an invoice into the month being closed', () => F.conn.reducers.ingestInvoices({ invoices: [{ externalId: 'smk-fresh-inv', customerId: cust0.id, contractCode: undefined, number: 'SMOKE-FRESH-1', issuedAtMicros: at(CLOSE), dueAtMicros: at(CLOSE) + 30n * 86_400_000_000n, amountMinor: 1000n }] }), /locked by the seed data/);
    await accepts('the CFO switches the feed off again', () => X.conn.reducers.setFeedEnabled({ enabled: false }));
    check(db.feedEvent.count() === 0n, 'nothing was booked');
  });

  await section('Charters: drafts, evals, and publishing only after a passing eval', async () => {
    const mapping = JSON.stringify([{ label: 'May 1', text: 'Propose journal entries.', target: { kind: 'rule', template: 'builtin:bookkeeper.may.1' } }]);
    const body = '# Bookkeeper\n\nMay 1: Propose journal entries.\n';
    const draft = (who: Who, o: Partial<{ role: string; bodyMd: string; mappingJson: string; summaryPlain: string; basedOnVersionId: bigint }>) =>
      who.conn.reducers.saveCharterDraft({ role: 'bookkeeper', bodyMd: body, mappingJson: mapping, summaryPlain: 'Smoke draft of the bookkeeper charter.', basedOnVersionId: undefined, ...o });
    await refuses('a worker saves a charter draft', () => draft(B, {}), /Only cfo or ui may save charter drafts/);
    await refuses('a draft for a role without a charter', () => draft(X, { role: 'cfo' }), /Charters exist for/);
    await refuses('a mapping that is not a JSON list', () => draft(X, { mappingJson: '{"May 1":"x"}' }), /must be a JSON list/);
    await refuses('a draft without a plain summary', () => draft(X, { summaryPlain: 'short' }), /plain-English summary/);
    await refuses('a charter over 20 KB', () => draft(X, { bodyMd: 'x'.repeat(21 * 1024) }), /at most 20 KB/);
    await accepts('the CFO saves a bookkeeper draft', () => draft(X, { summaryPlain: 'Smoke: raise the batch threshold to 90%.' }));
    const v1 = await waitFor(() => [...db.charterVersion.iter()].find(v => v.summaryPlain === 'Smoke: raise the batch threshold to 90%.'), 'draft v1');
    check(v1.role === 'bookkeeper' && v1.version === 1 && v1.status.tag === 'Draft' && v1.authoredByRole === 'cfo', 'the first draft is version 1 (built-in is 0)', `${v1.role} v${v1.version} ${v1.status.tag} by ${v1.authoredByRole}`);
    const U = await connect(DB, 'browser', undefined, ['charter_version']);
    await U.conn.reducers.registerAgent({ role: { tag: 'Ui' }, displayName: 'Smoke browser', model: 'browser' });
    await accepts('a browser (ui) saves version 2 based on version 1', () => draft(U, { summaryPlain: 'Smoke: second draft from the browser.', basedOnVersionId: v1.id }));
    U.conn.disconnect();
    const v2 = await waitFor(() => [...db.charterVersion.iter()].find(v => v.summaryPlain === 'Smoke: second draft from the browser.'), 'draft v2');
    check(v2.version === 2 && v2.basedOnVersionId === v1.id, 'the next draft is version 2 and names its base', `v${v2.version} based on ${v2.basedOnVersionId}`);
    const evalOf = (who: Who, id: bigint, passed: boolean, summaryPlain: string, mode = 'snapshot') =>
      who.conn.reducers.recordCharterEval({ charterVersionId: id, passed, mode, resultsJson: JSON.stringify({ versionId: id.toString(), passed }), summaryPlain });
    const publish = (who: Who, id: bigint, notePlain = '') => who.conn.reducers.publishCharter({ charterVersionId: id, notePlain });
    await refuses('publishing a version that was never evaluated', () => publish(X, v1.id), /Run an eval of version 1 of the bookkeeper charter first/);
    await refuses('a worker records an eval', () => evalOf(B, v1.id, true, 'Smoke eval from a worker.'), /Only advisor may record charter evals/);
    await refuses('an eval with an unknown mode', () => evalOf(A, v1.id, true, 'Smoke eval in a made-up mode.', 'live'), /mode must be dry_run or snapshot/);
    await accepts('the eval runner records a passing snapshot eval', () => evalOf(A, v1.id, true, 'Smoke eval passed in snapshot mode.'));
    await sleep(20);
    await accepts('and then a failing one', () => evalOf(A, v1.id, false, 'Smoke eval failed: the May 2 probe was denied.'));
    await sleep(100);
    await refuses('publishing when the latest eval failed', () => publish(X, v1.id), /latest eval of version 1 of the bookkeeper charter failed: Smoke eval failed/);
    await refuses('the advisor publishes a charter', () => publish(A, v1.id), /Only cfo may publish charters/);
    await sleep(20);
    await accepts('the eval runner records a passing dry run', () => evalOf(A, v1.id, true, 'Smoke eval passed in a dry run.', 'dry_run'));
    await sleep(100);
    await accepts('the CFO publishes version 1 after its latest eval passed', () => publish(X, v1.id, 'Smoke: tighter batch threshold.'));
    const live1 = await waitFor(() => (db.charterVersion.id.find(v1.id)!.status.tag === 'Live' ? db.charterVersion.id.find(v1.id) : undefined), 'v1 live');
    check(live1.publishedAt !== undefined && live1.publishedBy !== undefined, 'the live version carries who published it and when');
    const note = await waitFor(() => [...db.agentMessage.iter()].find(m => m.threadId === 'charter:bookkeeper' && m.senderRole === 'cfo'), 'charter message', 3000).catch(() => undefined);
    check(!!note && /^The CFO published version 1 of the bookkeeper charter: Smoke: tighter batch threshold\.$/.test(note.summaryPlain), 'publishing posts a plain message in the charter thread', note?.summaryPlain ?? 'no message');
    await refuses('an eval of the live version', () => evalOf(A, v1.id, true, 'Smoke eval of a live version.'), /already live/);
    await accepts('version 2 passes a snapshot eval', () => evalOf(A, v2.id, true, 'Smoke snapshot eval of version 2 passed.'));
    await sleep(100);
    await refuses('publishing on a passing snapshot eval alone', () => publish(X, v2.id), /was a snapshot run; a charter publishes only after a passing dry run/);
    await sleep(20);
    await accepts('version 2 passes a dry run', () => evalOf(A, v2.id, true, 'Smoke dry run of version 2 passed.', 'dry_run'));
    await sleep(100);
    await accepts('the CFO publishes version 2', () => publish(X, v2.id));
    await waitFor(() => db.charterVersion.id.find(v2.id)!.status.tag === 'Live', 'v2 live');
    check(db.charterVersion.id.find(v1.id)!.status.tag === 'Retired', 'publishing version 2 retires version 1');
    await accepts('the CFO restores the built-in charter', () => X.conn.reducers.retireLiveCharter({ role: 'bookkeeper', notePlain: 'Smoke: back to the shipped charter.' }));
    await waitFor(() => db.charterVersion.id.find(v2.id)!.status.tag === 'Retired', 'v2 retired');
    check([...db.charterVersion.iter()].every(v => v.role !== 'bookkeeper' || v.status.tag !== 'Live'), 'no bookkeeper version is live; the built-in applies');
    await refuses('restoring the built-in charter twice', () => X.conn.reducers.retireLiveCharter({ role: 'bookkeeper', notePlain: '' }), /has no published charter/);
    await accepts('a retired version whose latest eval passed can be published again', () => publish(X, v1.id, 'Smoke: reinstate version 1.'));
    await waitFor(() => db.charterVersion.id.find(v1.id)!.status.tag === 'Live', 'v1 live again');
  });

  await section('H1, findings 2 and 10: FX rates and materiality', async () => {
    await refuses('USD line at fxRateE6 1', () => je(B, NEXT, [{ accountCode: '1100', debitMinor: '5000000000', creditMinor: '0', fxRateE6: '1' }, { accountCode: '4100', debitMinor: '0', creditMinor: '5000000000', fxRateE6: '1' }]), /must be 1000000/);
    await refuses('EUR line at an unrecorded rate', () => je(B, NEXT, [{ accountCode: '1100', debitMinor: '100000', creditMinor: '0', ccy: 'EUR', fxRateE6: '1100000' }, { accountCode: '4100', debitMinor: '0', creditMinor: '110000' }]), /not a recorded rate/);
    const eur = await accepts('EUR line at the recorded rate', () => je(B, NEXT, [{ accountCode: '1100', debitMinor: '100000000', creditMinor: '0', ccy: 'EUR', fxRateE6: '1080000' }, { accountCode: '4100', debitMinor: '0', creditMinor: '108000000' }]));
    if (eur) check(eur.amountMinor === 108000000n, 'EUR entry counts at its converted amount', `${eur.amountMinor}`);
    const jpy = await accepts('JPY credit line at a sub-1.0 rate (lower-case "jpy" rate row)', () => je(B, NEXT, [{ accountCode: '1100', debitMinor: '900000', creditMinor: '0' }, { accountCode: '4100', debitMinor: '0', creditMinor: '134328359', ccy: 'JPY', fxRateE6: '6700' }]));
    if (jpy) {
      check(jpy.amountMinor === 134328359n, 'finding 2: the raw JPY credit sets the amount, not the 900,000 converted debit', `${jpy.amountMinor}`);
      await approve(jpy);
      check(status(jpy.id) === 'AwaitingCfo', 'finding 2: it waits for the CFO', status(jpy.id));
      await X.conn.reducers.cfoSendBack({ proposalId: jpy.id, notePlain: 'smoke cleanup' });
      await waitFor(() => status(jpy.id) === 'SentBack', 'send back');
      await A.conn.reducers.rejectProposal({ proposalId: jpy.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    }
    if (eur) await A.conn.reducers.rejectProposal({ proposalId: eur.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    const lower = await accepts('finding 10: lower-case "usd" line at 1.0', () => je(B, NEXT, [{ accountCode: '1100', debitMinor: '100', creditMinor: '0', ccy: 'usd' }, { accountCode: '4100', debitMinor: '0', creditMinor: '100', ccy: 'Usd' }]));
    if (lower) await A.conn.reducers.rejectProposal({ proposalId: lower.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
  });

  await section('Finding 3: revenue schedules name real, unscheduled subscription months', async () => {
    const line0 = unrecognized(CLOSE)[0]!;
    const usageItem = [...db.contractItem.iter()].find(i => i.kind.tag === 'Usage')!;
    const usageCustomer = db.contract.id.find(usageItem.contractId)!.customerId;
    const otherCustomer = [...db.customer.iter()].find(c => c.id !== line0.customerId)!;
    const sched = (lines: object[]) => propose(R, 'revenue_schedule', { lines }, CLOSE);
    const l = (o: object) => ({ contractItemId: line0.contractItemId.toString(), customerId: line0.customerId.toString(), ym: '2030-01', amountMinor: '100', ...o });
    await refuses('a month the item already has', () => sched([l({ ym: line0.ym })]), /already has a schedule line/);
    await refuses('the same month twice in one schedule', () => sched([l({}), l({})]), /two lines for 2030-01/);
    await refuses('a nonexistent contract item', () => sched([l({ contractItemId: '999999' })]), /Unknown contract item/);
    await refuses('a nonexistent customer', () => sched([l({ customerId: '888888' })]), /Unknown customer/);
    await refuses("another customer's item", () => sched([l({ customerId: otherCustomer.id.toString() })]), /belongs to customer/);
    await refuses('a usage item', () => sched([l({ contractItemId: usageItem.id.toString(), customerId: usageCustomer.toString() })]), /only subscription items/);
    await refuses('a month that is not YYYY-MM', () => sched([l({ ym: '2030-13' })]), /YYYY-MM/);
  });

  await section('H2 and findings 3 and 5: subscription revenue is recognized exactly once', async () => {
    const c014 = [...db.contract.iter()].find(k => k.code === 'C-014')!;
    const c014Item = [...db.contractItem.contractId.filter(c014.id)].find(i => i.kind.tag === 'Subscription')!;
    const monthly = c014.totalMinor / 12n;
    const schedLines = Array.from({ length: 12 }, (_, k) => ({ contractItemId: c014Item.id.toString(), customerId: c014.customerId.toString(), ym: ymAdd(c014.startYm, k), amountMinor: monthly.toString() }));
    const schedule = await accepts('C-014 schedule proposed (pending)', () => propose(R, 'revenue_schedule', { lines: schedLines }, CLOSE));
    // A pending renewal for another customer that only covers a far-future month must not block recognition.
    const due = unrecognized(CLOSE);
    const byCustomer = new Map<bigint, bigint>();
    for (const x of due) byCustomer.set(x.customerId, (byCustomer.get(x.customerId) ?? 0n) + x.amountMinor);
    const [renewCustomer] = [...byCustomer.keys()];
    const renewItem = [...db.revenueScheduleLine.customerId.filter(renewCustomer!)][0]!.contractItemId;
    const renewal = await accepts('finding 5: a pending renewal schedule covering 2030-06 only', () => propose(R, 'revenue_schedule', { lines: [{ contractItemId: renewItem.toString(), customerId: renewCustomer!.toString(), ym: '2030-06', amountMinor: '100' }] }, CLOSE));
    const recLines = (m: Map<bigint, bigint>): L[] => [...m].flatMap(([c, a]) => [
      { accountCode: '2400', debitMinor: a.toString(), creditMinor: '0', customerId: c.toString() },
      { accountCode: '4000', debitMinor: '0', creditMinor: a.toString(), customerId: c.toString() },
    ]);
    const withC014 = new Map(byCustomer).set(c014.customerId, monthly * 2n);
    await refuses('recognition including C-014 while its schedule is pending', () => je(R, CLOSE, recLines(withC014), { recognizeScheduleYm: CLOSE }), /still (open|awaiting cfo)/);
    const offByOne = recLines(byCustomer);
    offByOne[0] = { ...offByOne[0]!, debitMinor: (BigInt(offByOne[0]!.debitMinor) + 1n).toString() };
    offByOne[1] = { ...offByOne[1]!, creditMinor: (BigInt(offByOne[1]!.creditMinor) + 1n).toString() };
    await refuses('recognition off by one cent for one customer', () => je(R, CLOSE, offByOne, { recognizeScheduleYm: CLOSE }), /must equal the schedule lines it flips/);
    await refuses('finding 3: untagged 4000 padding line', () => je(R, CLOSE, [...recLines(byCustomer), { accountCode: '1100', debitMinor: '5000', creditMinor: '0' }, { accountCode: '4000', debitMinor: '0', creditMinor: '5000' }], { recognizeScheduleYm: CLOSE }), /every line on 4000 .* must name its customer/);
    await refuses('finding 3: recognizeScheduleYm after the entry month', () => je(R, CLOSE, recLines(byCustomer), { recognizeScheduleYm: NEXT }), /never before/);
    await refuses('finding 3: net credit to 4000 without recognizeScheduleYm', () => je(R, CLOSE, recLines(byCustomer)), /without recognizeScheduleYm/);
    const recognition = await accepts(`finding 5: recognition for ${byCustomer.size} customers through ${CLOSE} despite the far-future pending renewal`, () => je(R, CLOSE, recLines(byCustomer), { recognizeScheduleYm: CLOSE }));
    if (renewal) await A.conn.reducers.rejectProposal({ proposalId: renewal.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    if (recognition) {
      await settle(recognition);
      check(unrecognized(CLOSE).length === 0, `every existing ${CLOSE} subscription line recognized`);
      // Q3: the CFO's confirmation says what was confirmed.
      const msg = [...db.agentMessage.iter()].filter(m => m.senderRole === 'cfo' && m.proposalId === recognition.id).pop();
      if (msg) check(/^The CFO confirmed the journal entry of \$[\d,]+\.\d\d: Smoke journal_entry/.test(msg.summaryPlain), 'Q3: the CFO feed message names what was confirmed', msg.summaryPlain);
      else fail('Q3: the CFO feed message names what was confirmed', 'recognition was not material, so no CFO message');
    }
    if (schedule) {
      await settle(schedule);
      const c014Due = unrecognized(CLOSE, c014.customerId);
      check(sumOf(c014Due) === monthly * 2n, 'C-014 schedule lines now exist and are unrecognized', `${c014Due.length} lines`);
      const catchUp = await accepts('C-014 catch-up recognition once its schedule is approved', () => je(R, CLOSE, recLines(new Map([[c014.customerId, monthly * 2n]])), { recognizeScheduleYm: CLOSE }));
      if (catchUp) await settle(catchUp);
      await refuses('a second recognition of the same lines', () => je(R, CLOSE, recLines(new Map([[c014.customerId, monthly * 2n]])), { recognizeScheduleYm: CLOSE }), /must equal the schedule lines it flips/);
    }
    // No customer is recognized twice: agent 4000 credits equal the schedule lines agent entries recognized.
    const credited = new Map<bigint, bigint>();
    for (const l of db.journalLine.iter()) {
      if (l.accountCode !== '4000' || l.customerId === undefined || db.journalEntry.id.find(l.jeId)!.source.tag !== 'Agent') continue;
      credited.set(l.customerId, (credited.get(l.customerId) ?? 0n) + l.creditMinor - l.debitMinor);
    }
    const flipped = new Map<bigint, bigint>();
    for (const sl of db.revenueScheduleLine.iter()) if (sl.recognized && sl.jeId !== undefined) flipped.set(sl.customerId, (flipped.get(sl.customerId) ?? 0n) + sl.amountMinor);
    const mismatched = [...new Set([...credited.keys(), ...flipped.keys()])].filter(c => (credited.get(c) ?? 0n) !== (flipped.get(c) ?? 0n));
    check(mismatched.length === 0, 'no customer recognized twice', mismatched.length ? `mismatch for ${mismatched.join(', ')}` : `${credited.size} customers tie out`);
  });

  await section('M2: vendor verification needs the latest clean checks', async () => {
    // A vendor with an owner on file; each row's tier is derived from its facts (A clean, BLOCK deceased, B at 700).
    const nw = [...db.vendor.iter()].find(v => v.name === 'Lumen Analytics' && v.ownerPersonaId)!;
    const rec = (product: string, requestId: string, facts: unknown) =>
      C.conn.reducers.recordCreditCheck({ subjectKind: 'vendor', subjectId: nw.id, personaId: nw.ownerPersonaId!, product, requestId, summaryJson: JSON.stringify({ product, requestId, summary: 'smoke evidence', status: 200, facts }) });
    const tierB = { ...CLEAN_FACTS, bureaus: { ...CLEAN_FACTS.bureaus, equifax: bureauFile(700) } };
    await rec('tu_identity_verification', 'smk-id-1', CLEAN_FACTS);
    await rec('fraud_finder', 'smk-fr-1', CLEAN_FACTS);
    await sleep(20);
    await rec('fraud_finder', 'smk-fr-2', DECEASED_FACTS);
    await sleep(200);
    const verify = (ids: string[]) => propose(C, 'vendor_verify', { vendorId: nw.id.toString(), creditCheckIds: ids }, CLOSE);
    check(db.vendor.id.find(nw.id)!.verification.tag === 'Unverified', 'recording clean checks does not verify a vendor');
    await refuses('verification citing older clean rows after a newer DECLINE', () => verify(['smk-id-1', 'smk-fr-1']), /latest fraud_finder check .* is DECLINE/);
    await refuses('verification citing an unrecorded request id', () => verify(['smk-id-1', 'smk-fr-1', 'nope']), /not recorded credit checks/);
    await sleep(20);
    await rec('fraud_finder', 'smk-fr-3', tierB);
    await sleep(200);
    await refuses('verification that also cites the old DECLINE row', () => verify(['smk-id-1', 'smk-fr-3', 'smk-fr-2']), /not a clean APPROVE/);
    const ok = await accepts('verification citing the latest clean identity and fraud checks', () => verify(['smk-id-1', 'smk-fr-3']));
    if (ok) {
      await settle(ok);
      check(db.vendor.id.find(nw.id)!.verification.tag === 'Verified', 'the ruled verification verifies the vendor');
    }
  });

  await section('M3, L2: bank lines already matched, in locked months, or listed twice', async () => {
    const seedMatched = [...db.bankTransaction.iter()].find(t => t.matched && t.ym === PREV && t.subsidiaryId === root.id)!;
    const bm = (matches: object[]) => propose(B, 'bank_match', { matches }, CLOSE);
    await refuses(`bank match on a ${PREV} line the seed marked matched`, () => bm([{ bankTxId: seedMatched.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }]), /already matched/);
    await refuses('bankTxIds citing a seed-matched line', () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '1', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1' }], { bankTxIds: [seedMatched.id.toString()] }), /already matched/);
    await refuses(`bank match on an unmatched line in locked ${PREV}`, () => bm([{ bankTxId: txLocked.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }]), /locked/);
    await refuses(`bankTxIds citing an unmatched line in locked ${PREV}`, () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '7777', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '7777' }], { bankTxIds: [txLocked.id.toString()] }), /locked/);
    const free = [...db.bankTransaction.iter()].find(t => !t.matched && t.ym === CLOSE && t.subsidiaryId === root.id)!;
    await refuses(`L2: "0${free.id}" and "${free.id}" in one bank match`, () => bm([{ bankTxId: `0${free.id}`, targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }, { bankTxId: free.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }]), /appears twice/);
    await refuses('L2: duplicate bankTxIds in a journal entry', () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '1', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1' }], { bankTxIds: [`0${free.id}`, Number(free.id)] }), /listed twice/);
  });

  /** Record one owner check on a vendor with these facts (the module derives its tier). */
  const ownerCheck = (v: { id: bigint; ownerPersonaId?: string }, requestId: string, facts: unknown) =>
    C.conn.reducers.recordCreditCheck({
      subjectKind: 'vendor',
      subjectId: v.id,
      personaId: v.ownerPersonaId!,
      product: 'fraud_finder',
      requestId,
      summaryJson: JSON.stringify({ product: 'fraud_finder', requestId, summary: 'smoke evidence', status: 200, facts }),
    });

  await section('Vendor blocks rest on a BLOCK owner check whenever an owner is on file', async () => {
    const pet = [...db.vendor.iter()].find(v => v.name === 'Pettigrew Consulting' && v.ownerPersonaId)!;
    const block = () => propose(C, 'vendor_block', { vendorId: pet.id.toString(), reasonPlain: 'smoke: the owner failed its checks' }, CLOSE);
    await refuses('blocking a vendor whose owner has no recorded check', block, /no recorded owner check/);
    await accepts("a clean check on the vendor's owner", () => ownerCheck(pet, 'smk-pet-clean', CLEAN_FACTS));
    await waitFor(() => [...db.creditCheck.iter()].find(r => r.requestId === 'smk-pet-clean'), 'clean owner check');
    await refuses("blocking a vendor whose owner's latest check is clean", block, /derives tier A, not BLOCK/);
    await sleep(20);
    await accepts("a newer check: the vendor's owner has died", () => ownerCheck(pet, 'smk-pet-dead', DECEASED_FACTS));
    await waitFor(() => [...db.creditCheck.iter()].find(r => r.requestId === 'smk-pet-dead'), 'BLOCK owner check');
    const ok = await accepts("blocking once the owner's latest check derives BLOCK", block);
    if (ok) await settle(ok);
    check(db.vendor.id.find(pet.id)!.verification.tag === 'Blocked', 'Pettigrew is blocked');
  });

  await section('L6 and finding 6: nothing pays a blocked vendor; voiding its bill is allowed', async () => {
    await ownerCheck(bds, 'smk-bds-block', DECEASED_FACTS);
    await waitFor(() => [...db.creditCheck.iter()].find(r => r.requestId === 'smk-bds-block'), 'BDS owner check');
    const block = await propose(C, 'vendor_block', { vendorId: bds.id.toString(), reasonPlain: 'the owner failed identity checks' }, CLOSE);
    await settle(block);
    check(db.vendor.id.find(bds.id)!.verification.tag === 'Blocked', 'BDS is blocked');
    const bill = [...db.bill.vendorId.filter(bds.id)][0]!;
    await refuses("bank match paying the blocked vendor's bill", () => propose(B, 'bank_match', { matches: [{ bankTxId: txBds.id.toString(), targetKind: 'bill', targetId: bill.id.toString(), scoreBp: 9500 }] }, CLOSE), /is blocked/);
    await refuses('Dr 2000 without a vendor tag', () => je(B, CLOSE, [{ accountCode: '2000', debitMinor: '2475000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '2475000' }]), /must name its vendor/);
    await refuses("untagged expense paid from cash citing the blocked vendor's outflow", () => je(B, CLOSE, [{ accountCode: '5200', debitMinor: '2475000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '2475000' }], { bankTxIds: [txBds.id.toString()] }), /is blocked/);
    await refuses('Dr 2000 (BDS) / Cr 1000', () => je(B, CLOSE, [{ accountCode: '2000', debitMinor: '2475000', creditMinor: '0', vendorId: bds.id.toString() }, { accountCode: '1000', debitMinor: '0', creditMinor: '2475000', vendorId: bds.id.toString() }]), /is blocked/);
    const voided = await accepts('voiding the blocked bill: Dr 2000 (BDS) / Cr 5200 (BDS)', () => je(B, CLOSE, [{ accountCode: '2000', debitMinor: '2475000', creditMinor: '0', vendorId: bds.id.toString() }, { accountCode: '5200', debitMinor: '0', creditMinor: '2475000', vendorId: bds.id.toString() }]));
    if (voided) {
      await settle(voided);
      const voidJe = entriesOf(voided.id)[0]!;
      await refuses('round 6 #1: a bank match onto an entry tagged with the blocked vendor', () => propose(B, 'bank_match', { matches: [{ bankTxId: txMisc.id.toString(), targetKind: 'je', targetId: voidJe.id.toString(), scoreBp: 9000 }] }, CLOSE), /is tagged with Brennan.*blocked/);
    }
    // The two-step bypass: an untagged cash entry, then a journal-entry bank match linking the blocked vendor's outflow.
    const untagged = await accepts('an untagged Dr 5200 / Cr 1000 entry without bankTxIds', () => je(B, CLOSE, [{ accountCode: '5200', debitMinor: '2475000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '2475000' }]));
    if (untagged) {
      await settle(untagged);
      const untaggedJe = entriesOf(untagged.id)[0]!;
      await refuses("round 6 #1: a journal-entry bank match linking the blocked vendor's outflow", () => propose(B, 'bank_match', { matches: [{ bankTxId: txBds.id.toString(), targetKind: 'je', targetId: untaggedJe.id.toString(), scoreBp: 9000 }] }, CLOSE), /paid Brennan.*blocked/);
    }
    const refund = await accepts('round 6 #3: a refund coming in from the blocked vendor (Dr 1000 / Cr 5200, citing the inflow)', () => je(B, CLOSE, [{ accountCode: '1000', debitMinor: '50000', creditMinor: '0', vendorId: bds.id.toString() }, { accountCode: '5200', debitMinor: '0', creditMinor: '50000', vendorId: bds.id.toString() }], { bankTxIds: [txRefund.id.toString()] }));
    if (refund) await A.conn.reducers.rejectProposal({ proposalId: refund.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
  });

  let eurPaymentJe: bigint | undefined;
  await section('Finding 7: a foreign-currency bank line settles at a recorded rate', async () => {
    const m = [{ bankTxId: txEur.id.toString(), targetKind: 'invoice', targetId: invEur.id.toString(), scoreBp: 9500 }];
    await refuses(`EUR receipt before a ${CLOSE} EUR rate exists`, () => propose(B, 'bank_match', { matches: m }, CLOSE), /record a EUR\/USD rate/);
    await X.conn.reducers.seedFxRate({ fromCcy: 'EUR', toCcy: 'USD', ym: CLOSE, rateE6: 1_100_000n, kind: 'spot' });
    await sleep(200);
    const p = await accepts('EUR 1,000.00 receipt matched to a $1,100.00 invoice at 1.10', () => propose(B, 'bank_match', { matches: m }, CLOSE));
    if (p) {
      await settle(p);
      const entry = entriesOf(p.id)[0];
      const ls = entry ? linesOf(entry.id) : [];
      const cash = ls.find(l => l.accountCode === '1000');
      const ar = ls.find(l => l.accountCode === '1100');
      check(!!cash && cash.ccy === 'EUR' && cash.debitMinor === 100000n && cash.fxRateE6 === 1100000n && !!ar && ar.ccy === 'USD' && ar.creditMinor === 110000n, 'payment entry: cash in EUR at 1.10, receivable settled in USD', ls.map(l => `${l.accountCode} ${l.ccy} dr${l.debitMinor} cr${l.creditMinor} @${l.fxRateE6}`).join('; '));
      check(db.invoice.id.find(invEur.id)!.status.tag === 'Paid', 'the invoice is paid');
      eurPaymentJe = entry?.id;
    }
  });

  await section('Finding 2 (round 6): an accrual never touches subscription revenue', async () => {
    const accrualLines: L[] = [{ accountCode: '1100', debitMinor: '1000', creditMinor: '0', customerId: cust0.id.toString() }, { accountCode: '4000', debitMinor: '0', creditMinor: '1000', customerId: cust0.id.toString() }];
    await refuses('accrual with recognizeScheduleYm', () => je(B, CLOSE, [{ accountCode: '5600', debitMinor: '1000', creditMinor: '0' }, { accountCode: '2100', debitMinor: '0', creditMinor: '1000' }], { reversesInYm: NEXT, recognizeScheduleYm: CLOSE }, 'accrual'), /cannot recognize schedule lines/);
    await refuses('accrual crediting 4000', () => je(B, CLOSE, accrualLines, { reversesInYm: NEXT }, 'accrual'), /cannot post to 4000/);
    await refuses('journal entry with reversesInYm crediting 4000', () => je(R, CLOSE, accrualLines, { reversesInYm: NEXT, recognizeScheduleYm: CLOSE }), /cannot recognize schedule lines/);
  });

  await section('Finding 8: an entry needs an open month, and an accrual a later open month', async () => {
    await refuses(`journal entry for locked ${PREV}`, () => je(B, PREV, [{ accountCode: '6000', debitMinor: '2000000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '2000000' }]), /cannot post.*locked/);
    await refuses('accrual reversing in its own month', () => je(B, CLOSE, [{ accountCode: '5600', debitMinor: '10000', creditMinor: '0' }, { accountCode: '2100', debitMinor: '0', creditMinor: '10000' }], { reversesInYm: CLOSE }, 'accrual'), /reverses in a later month/);
    await refuses('accrual reversing in a month that does not exist', () => je(B, CLOSE, [{ accountCode: '5600', debitMinor: '10000', creditMinor: '0' }, { accountCode: '2100', debitMinor: '0', creditMinor: '10000' }], { reversesInYm: '2031-01' }, 'accrual'), /Unknown period/);
  });

  // ---------- group companies: the seed's UK and ELIM if it has them, else fixtures with the §2.5 codes ----------
  const UK_FIXTURE = 'UK';
  async function ensureGroup() {
    const find = () => ({ uk: [...db.subsidiary.iter()].find(x => x.code === UK_FIXTURE && !x.isElimination), elim: [...db.subsidiary.iter()].find(x => x.isElimination) });
    let { uk, elim } = find();
    if (uk && elim) return { uk, elim, fromSeed: true };
    const r = X.conn.reducers;
    await r.seedSubsidiary({ code: UK_FIXTURE, name: 'Smoke Ltd', functionalCcy: 'GBP', parentCode: root.code, isElimination: false });
    await r.seedSubsidiary({ code: 'ELIM', name: 'Smoke group eliminations', functionalCcy: 'USD', parentCode: root.code, isElimination: true });
    const acc = (code: string, name: string, accountType: string, isIntercompany: boolean) => ({ code, name, accountType, isIntercompany, sortOrder: Number(code.slice(0, 4)) });
    await r.seedAccounts({ subsidiaryCode: root.code, accounts: [acc('1900', 'Due from Smoke Ltd', 'asset', true), acc('1950', 'Loan to Smoke Ltd', 'asset', true), acc('4900', 'Intercompany service fees', 'revenue', true), acc('7100', 'FX gain or loss', 'expense', false)] });
    await r.seedAccounts({ subsidiaryCode: UK_FIXTURE, accounts: [acc('1000-UK', 'Cash', 'asset', false), acc('2900-UK', 'Due to Cafoo Inc', 'liability', true), acc('2950-UK', 'Loan from Cafoo Inc', 'liability', true), acc('3000-UK', 'Share capital', 'equity', false), acc('5500-UK', 'Rent & Office', 'expense', false), acc('5900-UK', 'Intercompany service fees', 'expense', true), acc('7100-UK', 'FX gain or loss', 'expense', false)] });
    await r.seedAccounts({ subsidiaryCode: 'ELIM', accounts: [acc('1900-ELIM', 'Due from (eliminated)', 'asset', true), acc('1950-ELIM', 'Loan to (eliminated)', 'asset', true), acc('2900-ELIM', 'Due to (eliminated)', 'liability', true), acc('2950-ELIM', 'Loan from (eliminated)', 'liability', true), acc('4900-ELIM', 'Service fees (eliminated)', 'revenue', true), acc('5900-ELIM', 'Service fees (eliminated)', 'expense', true)] });
    for (const [from, to, ym, rateE6, kind] of [['USD', 'GBP', PREV, 800000n, 'closing'], ['USD', 'GBP', PREV, 800000n, 'average'], ['GBP', 'USD', PREV, 1250000n, 'closing'], ['GBP', 'USD', CLOSE, 1280000n, 'closing'], ['USD', 'GBP', CLOSE, 781250n, 'closing'], ['USD', 'GBP', CLOSE, 787402n, 'average'], ['GBP', 'USD', NEXT, 1280000n, 'closing']] as const) {
      await r.seedFxRate({ fromCcy: from, toCcy: to, ym, rateE6, kind });
    }
    await waitFor(() => [...db.account.iter()].some(a => a.code === '5900-ELIM') && [...db.fxRate.iter()].some(x => x.ym === NEXT && x.fromCcy === 'GBP'), 'group accounts and rates');
    const line = (accountCode: string, debitMinor: bigint, creditMinor: bigint, ccy: string, fxRateE6: bigint) => ({ accountCode, debitMinor, creditMinor, ccy, fxRateE6, customerId: undefined, vendorId: undefined, memo: 'smoke group' });
    await r.seedJournalEntry({ subsidiaryCode: UK_FIXTURE, periodYm: PREV, memo: 'Smoke loan received', lines: [line('1000-UK', 16_000_000n, 0n, 'GBP', FX), line('2950-UK', 0n, 20_000_000n, 'USD', 800000n)] });
    await r.seedJournalEntry({ subsidiaryCode: root.code, periodYm: PREV, memo: 'Smoke loan to Smoke Ltd', lines: [line('1950', 20_000_000n, 0n, 'USD', FX), line('3000', 0n, 20_000_000n, 'USD', FX)] });
    await r.seedJournalEntry({ subsidiaryCode: root.code, periodYm: CLOSE, memo: 'Smoke service fee', lines: [line('1900', 1_500_000n, 0n, 'USD', FX), line('4900', 0n, 1_500_000n, 'USD', FX)] });
    await r.seedJournalEntry({ subsidiaryCode: UK_FIXTURE, periodYm: CLOSE, memo: 'Smoke service fee', lines: [line('5900-UK', 1_500_000n, 0n, 'USD', 787402n), line('2900-UK', 0n, 1_500_000n, 'USD', 787402n)] });
    await waitFor(() => [...db.journalEntry.iter()].filter(j => j.memo.startsWith('Smoke service fee')).length === 2, 'group entries');
    ({ uk, elim } = find());
    return { uk: uk!, elim: elim!, fromSeed: false };
  }
  const ymOfJe = new Map<bigint, string>();
  const entryYm = (jeId: bigint) => {
    let y = ymOfJe.get(jeId);
    if (y === undefined) ymOfJe.set(jeId, (y = db.period.id.find(db.journalEntry.id.find(jeId)!.periodId)!.ym));
    return y;
  };
  const acctLines = (accountId: bigint, ym: string, mode: 'through' | 'in') => [...db.journalLine.accountId.filter(accountId)].filter(l => (mode === 'through' ? entryYm(l.jeId) <= ym : entryYm(l.jeId) === ym));
  const functionalNet = (ls: { debitMinor: bigint; creditMinor: bigint; fxRateE6: bigint }[]) => ls.reduce((a, l) => a + applyFx(l.debitMinor, l.fxRateE6) - applyFx(l.creditMinor, l.fxRateE6), 0n);
  const closing = (from: string, to: string, ym: string) => {
    if (from === to) return FX;
    const rows = [...db.fxRate.iter()].filter(x => x.ym === ym && x.kind.tag === 'Closing');
    const direct = rows.find(x => x.fromCcy === from && x.toCcy === to);
    if (direct) return direct.rateE6;
    const inverse = rows.find(x => x.fromCcy === to && x.toCcy === from);
    if (!inverse) throw new Error(`no ${from}/${to} closing rate for ${ym}`);
    return divRound(FX * FX, inverse.rateE6);
  };
  type JL = { accountCode: string; debitMinor: string; creditMinor: string; ccy: string; fxRateE6: string };
  const jl = (accountCode: string, debitPositive: bigint, ccy: string): JL => ({ accountCode, debitMinor: (debitPositive > 0n ? debitPositive : 0n).toString(), creditMinor: (debitPositive < 0n ? -debitPositive : 0n).toString(), ccy, fxRateE6: '1000000' });
  /** The revaluation the module expects, computed from the client's copy of the ledger exactly as ledger-core does. */
  function revaluationOf(uk: { id: bigint; code: string; functionalCcy: string }, ym: string) {
    const items: Record<string, string>[] = [];
    const lines: JL[] = [];
    let gain = 0n;
    const accounts = [...db.account.iter()].filter(a => a.subsidiaryId === uk.id && (a.accountType.tag === 'Asset' || a.accountType.tag === 'Liability')).sort((a, b) => (a.code < b.code ? -1 : 1));
    for (const a of accounts) {
      const ls = acctLines(a.id, ym, 'through');
      const foreign = ls.find(l => l.ccy !== uk.functionalCcy);
      if (!foreign) continue;
      const txn = ls.filter(l => l.ccy === foreign.ccy).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0n);
      const booked = functionalNet(ls);
      const rate = closing(foreign.ccy, uk.functionalCcy, ym);
      const target = applyFx(txn, rate);
      const delta = target - booked;
      items.push({ accountCode: a.code, ccy: foreign.ccy, txnBalanceMinor: `${txn}`, closingRateE6: `${rate}`, bookedFunctionalMinor: `${booked}`, targetFunctionalMinor: `${target}`, deltaMinor: `${delta}` });
      if (delta !== 0n) lines.push(jl(a.code, delta, uk.functionalCcy));
      gain += delta;
    }
    if (gain !== 0n) lines.push(jl(`7100-${uk.code}`, -gain, uk.functionalCcy));
    return { subsidiaryId: uk.id.toString(), periodYm: ym, rateYm: ym, memo: `Smoke revaluation of ${uk.code} at the ${ym} closing rate`, items, lines };
  }
  const IC = [
    { label: 'Intercompany balance', basis: 'balance', src: '1900', cnt: '2900' },
    { label: 'Loan', basis: 'balance', src: '1950', cnt: '2950' },
    { label: 'Service fees', basis: 'activity', src: '4900', cnt: '5900' },
  ] as const;
  /** The elimination the module expects for one basis: each pair at the source amount, undone on the ELIM accounts. */
  function eliminationOf(elim: { id: bigint; code: string }, uk: { id: bigint; code: string }, basis: 'balance' | 'activity', ym: string) {
    const pairs: Record<string, string>[] = [];
    const lines: JL[] = [];
    for (const d of IC.filter(x => x.basis === basis)) {
      const sa = [...db.account.iter()].find(a => a.code === d.src)!;
      const signed = functionalNet(acctLines(sa.id, ym, basis === 'balance' ? 'through' : 'in'));
      if (signed === 0n) continue;
      const amount = absB(signed);
      pairs.push({ label: d.label, sourceSubsidiaryId: root.id.toString(), sourceAccountCode: d.src, counterSubsidiaryId: uk.id.toString(), counterAccountCode: `${d.cnt}-${uk.code}`, amountMinor: `${amount}`, counterTranslatedMinor: `${amount}`, differenceMinor: '0' });
      lines.push(jl(`${d.src}-${elim.code}`, -signed, 'USD'), jl(`${d.cnt}-${elim.code}`, signed, 'USD'));
    }
    return { subsidiaryId: elim.id.toString(), periodYm: ym, memo: `Smoke ${basis} elimination for ${ym}`, basis, ...(basis === 'balance' ? { reversesInYm: NEXT } : {}), pairs, lines };
  }

  await section('Group: an entry posts only to its own company\'s accounts', async () => {
    await ensureGroup();
    await refuses(`a ${root.code} journal entry with a line on a UK account`, () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '100', creditMinor: '0' }, { accountCode: '1000-UK', debitMinor: '0', creditMinor: '100' }]), /Account 1000-UK belongs to UK, not US/);
    await refuses(`the CFO seeds a ${root.code} entry with a line on a UK account`, () => X.conn.reducers.seedJournalEntry({ subsidiaryCode: root.code, periodYm: CLOSE, memo: 'x', lines: [{ accountCode: '6000', debitMinor: 1n, creditMinor: 0n, ccy: 'USD', fxRateE6: FX, customerId: undefined, vendorId: undefined, memo: '' }, { accountCode: '1000-UK', debitMinor: 0n, creditMinor: 1n, ccy: 'USD', fxRateE6: FX, customerId: undefined, vendorId: undefined, memo: '' }] }), /belongs to UK, not US/);
    await refuses('the consolidation agent proposes a journal entry', () => je(CN, CLOSE, [{ accountCode: '6000', debitMinor: '100', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '100' }]), /consolidation does not propose journal_entry/);
  });

  await section('Group: the elimination company, other companies\' bank lines, and amounts in the reporting currency', async () => {
    const { uk, elim } = await ensureGroup();
    const onElim = [{ accountCode: '4900-ELIM', debitMinor: '900000', creditMinor: '0' }, { accountCode: '5900-ELIM', debitMinor: '0', creditMinor: '900000' }];
    await refuses('a bookkeeper journal entry on the elimination company', () => propose(B, 'journal_entry', { subsidiaryId: elim.id.toString(), periodYm: CLOSE, memo: 'smoke', lines: onElim }, CLOSE), /ELIM is the elimination company; it takes only ic_elimination proposals/);
    await refuses('an accrual on the elimination company', () => propose(B, 'accrual', { subsidiaryId: elim.id.toString(), periodYm: CLOSE, memo: 'smoke', lines: onElim, reversesInYm: NEXT }, CLOSE), /takes only ic_elimination proposals/);
    // A UK bank line can be reconciled only by a UK entry.
    await X.conn.reducers.seedBankTransactions({ subsidiaryCode: uk.code, txs: [{ bookedAtMicros: 1789000000000000n, ym: CLOSE, amountMinor: -5000n, ccy: uk.functionalCcy, description: 'SMOKE UK BANK LINE', counterparty: 'Smoke Landlord Ltd', matched: false }] });
    const ukTx = await waitFor(() => [...db.bankTransaction.iter()].find(t => t.description === 'SMOKE UK BANK LINE'), 'UK bank line');
    await refuses(`a ${root.code} entry citing a ${uk.code} bank line`, () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '5000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '5000' }], { bankTxIds: [ukTx.id.toString()] }), new RegExp(`Bank transaction ${ukTx.id} is ${uk.code}'s; an entry for ${root.code} cannot reconcile another company's bank line`));
    await refuses(`a bank match of a ${uk.code} line to a ${root.code} entry`, () => propose(B, 'bank_match', { matches: [{ bankTxId: ukTx.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }] }, CLOSE), /a bank line is reconciled only by its own company's entry/);
    const ukJe = (lines: object[], extra: object = {}) => propose(B, 'journal_entry', { subsidiaryId: uk.id.toString(), periodYm: CLOSE, memo: 'smoke UK entry', lines, ...extra }, CLOSE);
    const own = await accepts(`a ${uk.code} entry citing its own bank line`, () => ukJe([{ accountCode: `5500-${uk.code}`, debitMinor: '5000', creditMinor: '0', ccy: uk.functionalCcy }, { accountCode: `1000-${uk.code}`, debitMinor: '0', creditMinor: '5000', ccy: uk.functionalCcy }], { bankTxIds: [ukTx.id.toString()] }));
    if (own) await A.conn.reducers.rejectProposal({ proposalId: own.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    // Rounding half away from zero, and a foreign entry sized line by line in the reporting currency: $0.07 at
    // 0.787402 is 5.51 pence, so 6 pence (truncation would give 5 and refuse the entry); 6 pence at the 1.28 closing
    // rate is 7.68 cents, so 8 cents.
    const usdAvg = [...db.fxRate.iter()].find(x => x.ym === CLOSE && x.fromCcy === 'USD' && x.toCcy === uk.functionalCcy && x.rateE6 === 787402n);
    if (usdAvg) {
      const tiny = await accepts(`a ${uk.code} entry with a $0.07 line at 0.787402 against 6 pence (balances only when rounding half away from zero)`, () => ukJe([{ accountCode: `5500-${uk.code}`, debitMinor: '7', creditMinor: '0', ccy: 'USD', fxRateE6: '787402' }, { accountCode: `1000-${uk.code}`, debitMinor: '0', creditMinor: '6', ccy: uk.functionalCcy }]));
      if (tiny) {
        check(tiny.amountMinor === 8n, 'its size is 8 cents: the dollar line as is, the 6 pence at the closing rate rounded half away from zero', `${tiny.amountMinor}`);
        await A.conn.reducers.rejectProposal({ proposalId: tiny.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
      }
    } else fail('rounding probe', `no USD/${uk.functionalCcy} 787402 rate for ${CLOSE}`);
    // A foreign schedule line in a month without its own rate is sized at the latest earlier closing rate, never 1:1.
    let ukCustomer = [...db.customer.iter()].find(c => c.subsidiaryId === uk.id);
    if (!ukCustomer) {
      await X.conn.reducers.seedCustomers({ subsidiaryCode: uk.code, customers: [{ name: 'Smoke UK Customer', domain: 'smoke.example', guarantorPersonaId: 'P01', guarantorName: 'Smoke Guarantor', paymentTermsDays: 30, yelpUrl: '', jobBoard: '', linkedinUrl: '' }] });
      ukCustomer = await waitFor(() => [...db.customer.iter()].find(c => c.subsidiaryId === uk.id), 'UK customer');
    }
    await X.conn.reducers.seedContract({ customerId: ukCustomer.id, code: 'SMOKE-UK-C1', startYm: '2027-01', endYm: '2027-12', totalMinor: 10_800_000n, plan: { tag: 'Annual' }, items: [{ kind: { tag: 'Subscription' }, priceMinor: 10_800_000n, qty: 1n, sspMinor: 10_800_000n, description: 'Smoke UK subscription' }] });
    const ukContract = await waitFor(() => [...db.contract.iter()].find(c => c.code === 'SMOKE-UK-C1'), 'UK contract');
    const ukItem = await waitFor(() => [...db.contractItem.contractId.filter(ukContract.id)][0], 'UK contract item');
    const schedLine = (ym: string) => ({ contractItemId: ukItem.id.toString(), customerId: ukCustomer!.id.toString(), ym, amountMinor: '900000' });
    const latest = [...db.fxRate.iter()].filter(x => x.kind.tag === 'Closing' && x.ym <= '2027-01' && ((x.fromCcy === uk.functionalCcy && x.toCcy === 'USD') || (x.fromCcy === 'USD' && x.toCcy === uk.functionalCcy))).map(x => x.ym).sort().pop()!;
    const expected = applyFx(900000n, closing(uk.functionalCcy, 'USD', latest));
    const sched = await accepts(`a ${uk.code} £9,000 schedule line for 2027-01, a month with no rate of its own`, () => propose(R, 'revenue_schedule', { lines: [schedLine('2027-01')] }, CLOSE));
    if (sched) {
      check(sched.amountMinor === expected && expected > 900000n, `it counts at the ${latest} closing rate, not 1:1`, `${sched.amountMinor} USD cents (expected ${expected})`);
      await A.conn.reducers.rejectProposal({ proposalId: sched.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    }
    await refuses(`a ${uk.code} schedule line in a month before any rate`, () => propose(R, 'revenue_schedule', { lines: [schedLine('2019-01')] }, CLOSE), new RegExp(`no ${uk.functionalCcy}/USD closing rate is recorded for 2019-01 or any month before it`));
  });

  await section('Consolidation: a revaluation must restate foreign balances at the closing rate, to the cent', async () => {
    const { uk, fromSeed } = await ensureGroup();
    const good = revaluationOf(uk, CLOSE);
    check(good.items.length >= 1 && good.lines.length >= 2, `the ledger gives ${uk.code} something to revalue in ${CLOSE}`, good.items.map(i => `${i.accountCode} ${i.ccy} delta ${i.deltaMinor}`).join('; '));
    const fx = (payload: object) => propose(CN, 'fx_revaluation', payload, CLOSE);
    const first = good.items[0]!;
    const wrongDelta = { ...good, items: good.items.map((i, k) => (k === 0 ? { ...i, deltaMinor: `${BigInt(i.deltaMinor!) + 100n}` } : i)) };
    await refuses('a revaluation with a wrong delta', () => fx(wrongDelta), new RegExp(`Item ${first.accountCode}: deltaMinor is .*but target minus booked is ${first.deltaMinor}`));
    const avg = [...db.fxRate.iter()].find(x => x.ym === CLOSE && x.kind.tag === 'Average' && x.fromCcy === first.ccy && x.toCcy === uk.functionalCcy);
    if (avg && avg.rateE6 !== BigInt(first.closingRateE6!)) {
      await refuses('a revaluation at the average rate instead of the closing rate', () => fx({ ...good, items: good.items.map((i, k) => (k === 0 ? { ...i, closingRateE6: `${avg.rateE6}` } : i)) }), /closingRateE6 is .* but the .* closing rate/);
    }
    const shifted = good.lines.map(l => ({ ...l, debitMinor: l.debitMinor === '0' ? '0' : `${BigInt(l.debitMinor) + 1n}`, creditMinor: l.creditMinor === '0' ? '0' : `${BigInt(l.creditMinor) + 1n}` }));
    if (good.lines.length === 2) await refuses('revaluation lines a cent off the deltas', () => fx({ ...good, lines: shifted }), /The revaluation lines net/);
    await refuses('revaluation lines in a foreign currency', () => fx({ ...good, lines: good.lines.map(l => ({ ...l, ccy: 'USD' })) }), /own currency \(GBP\)/);
    const pnl = [...db.account.iter()].find(a => a.code === `5900-${uk.code}`);
    if (pnl) await refuses('revaluing an expense account', () => fx({ ...good, items: [...good.items, { ...first, accountCode: pnl.code }] }), /only asset and liability balances are revalued/);
    await refuses('a revaluation for the elimination company', () => fx({ ...good, subsidiaryId: [...db.subsidiary.iter()].find(x => x.isElimination)!.id.toString() }), /elimination company/);
    const p = await accepts('the exact revaluation', () => fx(good));
    if (!p) return;
    const debits = good.lines.reduce((a, l) => a + BigInt(l.debitMinor), 0n);
    const usd = applyFx(debits, closing(uk.functionalCcy, 'USD', CLOSE));
    check(p.amountMinor === usd, 'its amount is the sum of its debits in the reporting currency at the closing rate', `${debits} ${uk.functionalCcy} pence -> ${p.amountMinor} USD cents (expected ${usd})`);
    if (fromSeed) check(debits === 440478n && p.amountMinor === 563812n, 'on the seeded group it is the planned £4,404.78 gain, $5,638.12', `${debits} pence, ${p.amountMinor} cents`);
    await refuses('a second revaluation while the first waits', () => fx(good), /still waiting/);
    await settle(p);
    const posted = entriesOf(p.id);
    check(posted.length === 1 && posted[0]!.subsidiaryId === uk.id, `the revaluation posts one ${uk.code} entry`, `${posted.length} entries`);
    const again = revaluationOf(uk, CLOSE);
    check(again.items.every(i => i.deltaMinor === '0'), 'afterwards every item stands at the closing rate (deltas zero)');
    await refuses('revaluing again once balances stand at the closing rate', () => fx(again), /nothing to revalue/);
  });

  await section('Consolidation: an elimination removes exactly what the group companies owe each other', async () => {
    const { uk, elim } = await ensureGroup();
    const bal = eliminationOf(elim, uk, 'balance', CLOSE);
    const act = eliminationOf(elim, uk, 'activity', CLOSE);
    check(bal.pairs.length >= 1 && act.pairs.length >= 1, `the ledger has intercompany balances and ${CLOSE} activity to eliminate`, `${bal.pairs.map(x => `${x.label} ${x.amountMinor}`).join('; ')} | ${act.pairs.map(x => `${x.label} ${x.amountMinor}`).join('; ')}`);
    const ic = (payload: object) => propose(CN, 'ic_elimination', payload, CLOSE);
    const wrong = { ...bal, pairs: bal.pairs.map((x, k) => (k === 0 ? { ...x, amountMinor: `${BigInt(x.amountMinor!) + 100n}` } : x)) };
    await refuses('an elimination with a wrong pair amount', () => ic(wrong), new RegExp(`Pair "${bal.pairs[0]!.label}": amountMinor is \\d+, but ${bal.pairs[0]!.sourceAccountCode} in ${root.code} shows ${bal.pairs[0]!.amountMinor}`));
    await refuses('an elimination posted to a trading company', () => ic({ ...bal, subsidiaryId: uk.id.toString() }), /not the elimination company/);
    const loan = bal.pairs.find(x => x.label === 'Loan');
    if (loan) {
      await refuses('the Loan pair listed twice', () => ic({ ...bal, pairs: [...bal.pairs, loan] }), /already appears in another pair/);
      await refuses('a balance pair of the loan against an expense account', () => ic({ ...bal, pairs: bal.pairs.map(x => (x === loan ? { ...x, counterAccountCode: `5900-${uk.code}` } : x)) }), new RegExp(`1950 pairs with group code 2950, not 5900-${uk.code}`));
    } else fail('elimination pinning', 'no Loan pair in the ledger');
    if (act.pairs[0]) await refuses('an activity pair of service fees against a liability', () => ic({ ...act, pairs: [{ ...act.pairs[0], counterAccountCode: `2900-${uk.code}` }] }), new RegExp(`4900 pairs with group code 5900, not 2900-${uk.code}`));
    const { reversesInYm: _drop, ...noReversal } = bal;
    await refuses('a balance elimination that does not reverse', () => ic(noReversal), /reverses the next month/);
    await refuses('an activity elimination that reverses', () => ic({ ...act, reversesInYm: NEXT }), /does not reverse/);
    await refuses('elimination lines that leave part of a pair standing', () => ic({ ...bal, lines: bal.lines.map(l => ({ ...l, debitMinor: l.debitMinor === '0' ? '0' : `${BigInt(l.debitMinor) - 100n}`, creditMinor: l.creditMinor === '0' ? '0' : `${BigInt(l.creditMinor) - 100n}` })) }), /The elimination lines net/);
    const p = await accepts('the exact balance elimination', () => ic(bal));
    if (p) {
      const total = bal.pairs.reduce((a, x) => a + BigInt(x.amountMinor!), 0n);
      check(p.amountMinor === total, 'its amount is the sum of the pairs', `${p.amountMinor} vs ${total}`);
      await refuses('a second balance elimination while the first waits', () => ic(bal), /still waiting/);
      await approve(p);
      check(status(p.id) === 'AwaitingCfo', 'a material elimination waits for the CFO', status(p.id));
      await X.conn.reducers.cfoConfirm({ proposalId: p.id, note: 'smoke' });
      await waitFor(() => status(p.id) === 'Approved', 'elimination applied');
      const posted = entriesOf(p.id);
      const main = posted.find(j => j.reversalOf === undefined);
      const auto = posted.find(j => j.reversalOf !== undefined);
      check(!!main && !!auto && entryYm(main.id) === CLOSE && entryYm(auto.id) === NEXT && auto.reversalOf === main.id && main.subsidiaryId === elim.id, `it posts in ${CLOSE} on the elimination company and reverses itself in ${NEXT}`, posted.map(j => `${j.id} ${entryYm(j.id)} rev:${j.reversalOf ?? '-'}`).join('; '));
      await refuses(`eliminating ${CLOSE} balances twice`, () => ic(eliminationOf(elim, uk, 'balance', CLOSE)), /already eliminated on the balance basis/);
      if (main && auto) {
        await accepts('the CFO reverses the elimination', () => X.conn.reducers.cfoReverse({ jeId: main.id, reasonPlain: 'smoke: undo elimination' }));
        const r1 = await waitFor(() => [...db.journalEntry.iter()].find(j => j.reversalOf === main.id && j.source.tag === 'Manual'), 'reversal of the elimination');
        const r2 = await waitFor(() => [...db.journalEntry.iter()].find(j => j.reversalOf === auto.id && j.source.tag === 'Manual'), 'reversal of its automatic reversal', 3000).catch(() => undefined);
        check(!!r1 && !!r2 && entryYm(r2.id) === NEXT, `reversing an elimination also reverses its ${NEXT} automatic reversal, as for an accrual`);
        const redo = await accepts('once reversed, the month can be eliminated again', () => ic(eliminationOf(elim, uk, 'balance', CLOSE)));
        // Posted, so the month is consolidated again when it locks below.
        if (redo) await settle(redo);
      }
    }
    const a = await accepts('the exact activity elimination', () => ic(act));
    if (a) {
      await settle(a);
      const posted = entriesOf(a.id);
      check(posted.length === 1 && entryYm(posted[0]!.id) === CLOSE, 'an activity elimination posts once, with no reversal', `${posted.length} entries`);
      await refuses(`eliminating ${CLOSE} activity twice`, () => ic(eliminationOf(elim, uk, 'activity', CLOSE)), /already eliminated on the activity basis/);
    }
  });

  await section('L1: one waiting Proposal per bank line, and the CFO sees a conflict that arose while a proposal waited', async () => {
    const payroll = [...db.bankTransaction.iter()].find(t => !t.matched && t.ym === CLOSE && t.amountMinor <= -1_000_000n && t.subsidiaryId === root.id)!;
    const bm = await propose(B, 'bank_match', { matches: [{ bankTxId: payroll.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }] }, CLOSE);
    await approve(bm);
    check(status(bm.id) === 'AwaitingCfo', 'a material bank match waits for the CFO');
    const citedRe = new RegExp(`Bank transaction ${payroll.id} is already cited by pending proposal ${bm.id}\\.`);
    const claim = () => je(B, CLOSE, [{ accountCode: '5300', debitMinor: '1000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1000' }], { bankTxIds: [payroll.id.toString()] });
    await refuses('a journal entry citing a bank line a waiting bank match already cites', claim, citedRe);
    await refuses('a second bank match on that line (id written "0…")', () => propose(B, 'bank_match', { matches: [{ bankTxId: `0${payroll.id}`, targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 8000 }] }, CLOSE), citedRe);
    await X.conn.reducers.cfoSendBack({ proposalId: bm.id, notePlain: 'smoke: check the payee' });
    await waitFor(() => status(bm.id) === 'SentBack', 'send back');
    await refuses('a sent-back bank match still holds its line', claim, citedRe);
    await accepts('the Advisor resubmits the sent-back bank match by ruling on it again', () => A.conn.reducers.approveProposal({ proposalId: bm.id, rationale: 'smoke: re-reviewed after the send-back', summaryPlain: 'Re-approved after the CFO sent it back.', amendedPayloadJson: undefined }));
    await waitFor(() => status(bm.id) === 'AwaitingCfo', 'resubmitted');
    // The conflict that can still arise while the CFO waits: its payee gets blocked.
    let payee = [...db.vendor.iter()].find(v => v.name.trim().toLowerCase() === payroll.counterparty.trim().toLowerCase());
    if (!payee) {
      await X.conn.reducers.seedVendors({ subsidiaryCode: root.code, vendors: [{ name: payroll.counterparty, domain: 'smoke.example', category: 'smoke', ownerPersonaId: undefined, yelpUrl: '', jobBoard: '', linkedinUrl: '' }] });
      payee = await waitFor(() => [...db.vendor.iter()].find(v => v.name === payroll.counterparty), 'payee vendor');
    }
    // The payee has no owner on file, so no owner check is possible and the block stands on its reason alone.
    await settle(await propose(C, 'vendor_block', { vendorId: payee.id.toString(), reasonPlain: 'smoke: the payee failed its checks while the match waited' }, CLOSE));
    await refuses('CFO confirms the bank match after its payee was blocked', () => X.conn.reducers.cfoConfirm({ proposalId: bm.id, note: 'go' }), /is blocked/);
    await X.conn.reducers.cfoSendBack({ proposalId: bm.id, notePlain: 'smoke cleanup' });
    await A.conn.reducers.rejectProposal({ proposalId: bm.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    await waitFor(() => status(bm.id) === 'Rejected', 'rejected');
    // A rejected Proposal no longer holds its line (shown on a line whose payee is not blocked).
    const bm2 = await propose(B, 'bank_match', { matches: [{ bankTxId: txMisc.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }] }, CLOSE);
    const miscEntry = () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '1234', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1234' }], { bankTxIds: [txMisc.id.toString()] });
    await refuses('a journal entry citing a line an open bank match cites', miscEntry, new RegExp(`already cited by pending proposal ${bm2.id}\\.`));
    await A.conn.reducers.rejectProposal({ proposalId: bm2.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    await waitFor(() => status(bm2.id) === 'Rejected', 'bm2 rejected');
    const freed = await accepts('once that bank match is rejected, another proposal may cite the line', miscEntry);
    if (freed) await A.conn.reducers.rejectProposal({ proposalId: freed.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
  });

  await section(`Q1: corrections to a locked month post in the next open month`, async () => {
    const fee = await je(B, CLOSE, [{ accountCode: '6000', debitMinor: '4200', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '4200' }]);
    await settle(fee);
    const feeJe = entriesOf(fee.id)[0]!;
    const accrual = await je(B, CLOSE, [{ accountCode: '5600', debitMinor: '10000', creditMinor: '0' }, { accountCode: '2100', debitMinor: '0', creditMinor: '10000' }], { reversesInYm: NEXT }, 'accrual');
    await settle(accrual);
    const accrualJe = entriesOf(accrual.id).find(j => j.reversalOf === undefined)!;
    const autoJe = entriesOf(accrual.id).find(j => j.reversalOf === accrualJe.id)!;
    // Decide everything still pending for the month, then lock it.
    for (const p of [...db.proposal.iter()].filter(x => ['Open', 'SentBack', 'AwaitingCfo'].includes(x.status.tag))) {
      if (p.status.tag === 'AwaitingCfo') await X.conn.reducers.cfoSendBack({ proposalId: p.id, notePlain: 'smoke cleanup' });
      await A.conn.reducers.rejectProposal({ proposalId: p.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
    }
    // A group month locks only once consolidated, and a correction posted after the consolidation makes it stale.
    const { uk, elim } = await ensureGroup();
    const ofMonth = (p: { payloadJson: string }) => JSON.parse(p.payloadJson) as { periodYm?: string; basis?: string };
    const fees = [...db.proposal.iter()].find(p => p.kind.tag === 'IcElimination' && ['Approved', 'Amended'].includes(p.status.tag) && ofMonth(p).periodYm === CLOSE && ofMonth(p).basis === 'activity');
    if (fees) {
      const feesJe = entriesOf(fees.id)[0]!;
      await accepts(`the CFO reverses the ${CLOSE} activity elimination`, () => X.conn.reducers.cfoReverse({ jeId: feesJe.id, reasonPlain: 'smoke: undo the elimination' }));
      await waitFor(() => [...db.journalEntry.iter()].some(j => j.reversalOf === feesJe.id), 'reversal of the activity elimination');
      await refuses('advisor requests the lock of a group month not eliminated', () => A.conn.reducers.requestPeriodLock({ periodYm: CLOSE, rationale: 'smoke', summaryPlain: 'Smoke: ready to lock.' }), /^The Advisor cannot ask to lock \w+ \d{4} until its consolidation matches the books: the service fees pair in \w+ \d{4} \(\$[\d,]+\.\d\d\) is not eliminated, so eliminate it\./);
      await refuses('CFO locks a group month not eliminated', () => X.conn.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'smoke lock' }), /cannot be locked until its consolidation matches the books: the service fees pair/);
      await settle(await propose(CN, 'ic_elimination', eliminationOf(elim, uk, 'activity', CLOSE), CLOSE));
    } else fail('the consolidation lock guard', `no posted ${CLOSE} activity elimination to undo`);
    const icFix = await je(B, CLOSE, [{ accountCode: '1900', debitMinor: '10000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '10000' }]);
    await settle(icFix);
    await refuses('CFO locks after a correction on an intercompany account posted since the elimination', () => X.conn.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'smoke lock' }), /the intercompany balance pair through \w+ \d{4} now shows \$[\d,]+\.\d\d but the elimination posted removed \$[\d,]+\.\d\d, so something posted after it: reverse that elimination and eliminate again/);
    await accepts('the CFO reverses the intercompany correction, so the elimination stands again', () => X.conn.reducers.cfoReverse({ jeId: entriesOf(icFix.id)[0]!.id, reasonPlain: 'smoke: undo the intercompany correction' }));
    // A dollar movement on Cafoo Ltd's loan, booked at the average rate after the revaluation, leaves it off the closing rate.
    const loanLines = [{ accountCode: `2950-${uk.code}`, debitMinor: '10000', creditMinor: '0', ccy: 'USD', fxRateE6: '787402' }, { accountCode: `1000-${uk.code}`, debitMinor: '0', creditMinor: '7874', ccy: uk.functionalCcy, fxRateE6: '1000000' }];
    const fxFix = await propose(B, 'journal_entry', { subsidiaryId: uk.id.toString(), periodYm: CLOSE, memo: 'smoke loan movement', lines: loanLines }, CLOSE);
    await settle(fxFix);
    await refuses('CFO locks after a foreign-currency balance moved since the revaluation', () => X.conn.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'smoke lock' }), new RegExp(`${uk.name} was revalued for \\w+ \\d{4}, but its USD balance on 2950-${uk.code} is £[\\d,]+\\.\\d\\d off the closing rate, so something posted after it: revalue it again`));
    await accepts('the CFO reverses that movement, so the revaluation stands again', () => X.conn.reducers.cfoReverse({ jeId: entriesOf(fxFix.id)[0]!.id, reasonPlain: 'smoke: undo the loan movement' }));
    // A blocked close task stops the lock, by name.
    const task = [...db.closeTask.iter()].find(t => db.period.id.find(t.periodId)!.ym === CLOSE && t.status.tag !== 'Done')!;
    await B.conn.reducers.updateCloseTask({ taskId: task.id, status: 'blocked', note: 'smoke: waiting on a person' });
    await waitFor(() => db.closeTask.id.find(task.id)!.status.tag === 'Blocked', 'blocked task');
    const blockedRe = new RegExp(`close task\\(s\\) for ${CLOSE} are blocked: "${task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
    await refuses('advisor requests the lock while a close task is blocked', () => A.conn.reducers.requestPeriodLock({ periodYm: CLOSE, rationale: 'smoke', summaryPlain: 'Smoke: ready to lock.' }), blockedRe);
    await refuses('CFO locks while a close task is blocked', () => X.conn.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'smoke lock' }), blockedRe);
    await B.conn.reducers.updateCloseTask({ taskId: task.id, status: 'in_progress', note: 'smoke: unblocked' });
    await waitFor(() => db.closeTask.id.find(task.id)!.status.tag === 'InProgress', 'unblocked task');
    await acceptFixtureBankExceptions(CLOSE);
    await accepts(`finding 1: CFO locks ${CLOSE} once its revenue is recognized and no task is blocked`, () => X.conn.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'smoke lock' }));
    await accepts(`CFO reverses a ${CLOSE} entry after the lock`, () => X.conn.reducers.cfoReverse({ jeId: feeJe.id, reasonPlain: 'smoke correction' }));
    const rev = [...db.journalEntry.iter()].find(j => j.reversalOf === feeJe.id);
    check(!!rev && db.period.id.find(rev.periodId)!.ym === NEXT && rev.memo.includes(`posted in ${NEXT} because ${CLOSE} is locked`), `the reversal posts in ${NEXT}`, rev ? `${db.period.id.find(rev.periodId)!.ym}: ${rev.memo}` : 'no reversal');
    await accepts(`CFO reverses the ${CLOSE} accrual after the lock`, () => X.conn.reducers.cfoReverse({ jeId: accrualJe.id, reasonPlain: 'smoke accrual correction' }));
    const accRev = await waitFor(() => [...db.journalEntry.iter()].find(j => j.reversalOf === accrualJe.id && j.source.tag === 'Manual'), "the CFO's accrual reversal");
    const autoRev = await waitFor(() => [...db.journalEntry.iter()].find(j => j.reversalOf === autoJe.id && j.source.tag === 'Manual'), "the CFO's reversal of the automatic reversal");
    const ymOf = (j: { periodId: bigint }) => db.period.id.find(j.periodId)!.ym;
    check(ymOf(accRev) === NEXT && accRev.memo.includes(`because ${CLOSE} is locked`), `the accrual's reversal moves to ${NEXT}`, `${ymOf(accRev)}: ${accRev.memo}`);
    check(ymOf(autoRev) === ymOf(autoJe) && !autoRev.memo.includes('is locked'), `its automatic reversal is reversed in its own open month (${ymOf(autoJe)})`, `${ymOf(autoRev)}: ${autoRev.memo}`);
    if (eurPaymentJe !== undefined) {
      await refuses(`reversing a ${CLOSE} bank-match payment names the locked bank line`, () => X.conn.reducers.cfoReverse({ jeId: eurPaymentJe!, reasonPlain: 'smoke' }), new RegExp(`undo the bank reconciliation of ${CLOSE}, which is locked: bank line ${txEur.id} "SMOKE EUR WIRE SMOKE-EUR-1" \\(\\$1,000\\.00 EUR, ${CLOSE}\\)`));
    }
    await accepts(`CFO unlocks ${CLOSE}`, () => X.conn.reducers.unlockPeriod({ periodYm: CLOSE, rationale: 'smoke reopen' }));
    const reopened = await waitFor(() => [...db.agentMessage.iter()].find(m => m.threadId === `close:${CLOSE}` && m.senderRole === 'cfo' && m.summaryPlain.startsWith('The CFO reopened')), 'unlock message', 3000).catch(() => undefined);
    check(reopened?.summaryPlain === `The CFO reopened ${CLOSE}: smoke reopen`, 'unlocking posts a close-thread message with the reason', reopened?.summaryPlain ?? 'no message');
  });

  await section('Feed: rows arrive only through the feed role, only into the open month after a locked one', async () => {
    const at = (ym: string, day: number) => {
      const [y, m] = ym.split('-').map(Number);
      return BigInt(Date.UTC(y!, m! - 1, day, 12)) * 1000n;
    };
    const tx = (externalId: string, ym: string, amountMinor: bigint) => ({ externalId, bookedAtMicros: at(ym, 10), amountMinor, ccy: 'usd', description: `SMOKE FEED ${externalId}`, counterparty: 'Smoke Feed Co' });
    const bank = (who: Who, txs: ReturnType<typeof tx>[], subsidiaryCode = root.code) => who.conn.reducers.ingestBankTransactions({ subsidiaryCode, txs });
    const feedOn = () => [...db.settings.iter()].find(x => x.key === 'feed_enabled')?.valueI64 === 1n;
    await refuses('the feed ingests while the CFO has it off', () => bank(F, [tx('smk-1', NEXT, 1000n)]), /live feed is off/);
    await refuses('the advisor switches the feed on', () => A.conn.reducers.setFeedEnabled({ enabled: true }), /Only cfo may switch the live feed/);
    await accepts('the CFO switches the feed on', () => X.conn.reducers.setFeedEnabled({ enabled: true }));
    await waitFor(() => feedOn(), 'feed on');
    await refuses('a worker ingests bank lines', () => bank(B, [tx('smk-1', NEXT, 1000n)]), /Only feed may ingest feed rows/);
    await refuses('the feed proposes', () => F.conn.reducers.propose({ kind: 'journal_entry', payloadJson: '{}', rationale: 'x', summaryPlain: 'The feed trying to propose.', amountMinor: 0n, periodYm: NEXT, closeTaskId: undefined }), /may propose/);
    await refuses(`the feed books into ${NEXT} while ${CLOSE} is still open`, () => bank(F, [tx('smk-1', NEXT, 1000n)]), new RegExp(`${CLOSE} is not locked yet`));
    const first = [...db.period.iter()].map(x => x.ym).sort()[0]!;
    await accepts(`CFO unlocks the first month of the books (${first})`, () => X.conn.reducers.unlockPeriod({ periodYm: first, rationale: 'smoke: feed probe' }));
    await refuses(`the feed books into ${first}, which has no locked month before it`, () => bank(F, [tx('smk-first', first, 1000n)]), new RegExp(`the books have no ${ymAdd(first, -1)} period before ${first}`));
    await acceptFixtureBankExceptions(first);
    await accepts(`CFO locks ${first} again`, () => X.conn.reducers.lockPeriod({ periodYm: first, rationale: 'smoke relock' }));
    await acceptFixtureBankExceptions(CLOSE);
    await accepts(`CFO locks ${CLOSE} again`, () => X.conn.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'smoke relock' }));
    await refuses(`the feed books into locked ${CLOSE}`, () => bank(F, [tx('smk-2', CLOSE, 1000n)]), new RegExp(`${CLOSE} is closed; the feed books only into the open month`));
    await refuses('the feed books into a month the books do not have', () => bank(F, [tx('smk-3', ymAdd(NEXT, 6), 1000n)]), /books have no/);
    await refuses('the feed books a bank line for the elimination company', () => bank(F, [tx('smk-4', NEXT, 1000n)], 'ELIM'), /elimination company/);
    await refuses('a zero-amount line refuses the whole batch', () => bank(F, [tx('smk-5', NEXT, 500n), tx('smk-6', NEXT, 0n)]), /cannot be zero/);
    check(!db.feedEvent.externalId.find('smk-5'), 'nothing from a refused batch is booked');
    await accepts(`the feed books two ${NEXT} bank lines, one listed twice`, () => bank(F, [tx('smk-a', NEXT, 125000n), tx('smk-b', NEXT, -4200n), tx('smk-a', NEXT, 125000n)]));
    const evA = await waitFor(() => db.feedEvent.externalId.find('smk-a'), 'feed event a');
    const evB = await waitFor(() => db.feedEvent.externalId.find('smk-b'), 'feed event b');
    const rowA = db.bankTransaction.id.find(evA.rowId);
    check(!!rowA && rowA.ym === NEXT && !rowA.matched && rowA.ccy === 'USD' && rowA.amountMinor === 125000n && rowA.subsidiaryId === root.id && evA.kind.tag === 'BankTx' && evA.ym === NEXT, 'the bank line is unmatched, in the open month, and linked from its feed event', rowA ? `${rowA.ym} ${rowA.ccy} ${rowA.amountMinor} matched=${rowA.matched}` : 'missing');
    check(!!db.bankTransaction.id.find(evB.rowId), 'the second line is booked too');
    await accepts('a replayed bank line is accepted and skipped', () => bank(F, [tx('smk-a', NEXT, 125000n)]));
    await sleep(200);
    check([...db.bankTransaction.iter()].filter(t => t.description === 'SMOKE FEED smk-a').length === 1, 'the replayed line is booked once');
    const inv = (externalId: string, number: string, customerId = cust0.id) => ({ externalId, customerId, contractCode: undefined, number, issuedAtMicros: at(NEXT, 5), dueAtMicros: at(NEXT, 5) + 30n * 86_400_000_000n, amountMinor: 250000n });
    await refuses('an invoice for an unknown customer', () => F.conn.reducers.ingestInvoices({ invoices: [inv('smk-inv-0', 'SMOKE-FEED-0', 999999n)] }), /unknown customer/);
    await refuses('a worker ingests invoices', () => B.conn.reducers.ingestInvoices({ invoices: [inv('smk-inv-1', 'SMOKE-FEED-1')] }), /Only feed/);
    await accepts('the feed books a new invoice', () => F.conn.reducers.ingestInvoices({ invoices: [inv('smk-inv-1', 'SMOKE-FEED-1')] }));
    const evI = await waitFor(() => db.feedEvent.externalId.find('smk-inv-1'), 'invoice feed event');
    const invRow = db.invoice.id.find(evI.rowId);
    check(!!invRow && invRow.number === 'SMOKE-FEED-1' && invRow.status.tag === 'Open' && invRow.ym === NEXT && evI.kind.tag === 'Invoice' && evI.subsidiaryId === cust0.subsidiaryId, 'the invoice is open, in the open month, and linked from its feed event');
    await accepts('an invoice whose number is already in the books is skipped', () => F.conn.reducers.ingestInvoices({ invoices: [inv('smk-inv-2', 'SMOKE-FEED-1')] }));
    await sleep(200);
    check(!db.feedEvent.externalId.find('smk-inv-2') && [...db.invoice.iter()].filter(i => i.number === 'SMOKE-FEED-1').length === 1, 'the duplicate number is not booked');
    // The feed stops once the open month's own close starts.
    await X.conn.reducers.seedCloseTasks({ periodYm: NEXT, tasks: [{ title: 'Smoke next-month task', description: 'smoke', ownerRole: 'bookkeeper', sortOrder: 1 }] });
    const nextTask = await waitFor(() => [...db.closeTask.iter()].find(t => t.title === 'Smoke next-month task'), 'next-month close task');
    await B.conn.reducers.updateCloseTask({ taskId: nextTask.id, status: 'in_progress', note: 'smoke: the close starts' });
    await waitFor(() => db.closeTask.id.find(nextTask.id)!.status.tag === 'InProgress', 'task in progress');
    await refuses(`the feed books into ${NEXT} once its close has started`, () => bank(F, [tx('smk-closing', NEXT, 1000n)]), new RegExp(`the ${NEXT} close has started \\(close task "Smoke next-month task" is in progress\\)`));
    await B.conn.reducers.updateCloseTask({ taskId: nextTask.id, status: 'todo', note: 'smoke: not yet' });
    await waitFor(() => db.closeTask.id.find(nextTask.id)!.status.tag === 'Todo', 'task back to todo');
    await accepts(`the feed books into ${NEXT} again while its close has not started`, () => bank(F, [tx('smk-after', NEXT, 1000n)]));
    await accepts('the CFO switches the feed off', () => X.conn.reducers.setFeedEnabled({ enabled: false }));
    await waitFor(() => !feedOn(), 'feed off');
    await refuses('the feed ingests after it is switched off', () => bank(F, [tx('smk-c', NEXT, 1000n)]), /live feed is off/);
  });

  await section('Overdue aging: the real scheduled tick updates unpaid invoices', async () => {
    const overdue = await waitFor(
      () => [...db.invoice.iter()].find(i => i.number === 'SMOKE-OVERDUE-TICK' && i.status.tag === 'Overdue'),
      'the scheduler to mark its past-due probe overdue',
      75_000
    );
    check(overdue.status.tag === 'Overdue', 'the real scheduler marks a past-due open invoice overdue');
    check([...db.invoice.iter()].find(i => i.number === 'SMOKE-OVERDUE-FUTURE')?.status.tag === 'Open', 'the scheduler leaves a future invoice open');
    check([...db.invoice.iter()].find(i => i.number === 'SMOKE-OVERDUE-PAID')?.status.tag === 'Paid', 'the scheduler leaves a paid invoice paid');
    check([...db.auditEvent.iter()].some(e => e.action === 'overdue_sweep' && e.detail.includes('SMOKE-OVERDUE-TICK')), 'the scheduler records the aging change in the audit trail');
  });

  await section('resetDemo clears the books and the feed log, keeps charters and the CFO', async () => {
    const charters = db.charterVersion.count();
    const evals = db.charterEval.count();
    await X.conn.reducers.setFeedEnabled({ enabled: true });
    await accepts('the CFO resets the demo', () => X.conn.reducers.resetDemo({ confirm: 'RESET' }));
    await waitFor(() => db.subsidiary.count() === 0n, 'reset');
    await sleep(200);
    check(db.feedEvent.count() === 0n && db.bankTransaction.count() === 0n, 'feed events and bank lines are cleared');
    check(db.charterVersion.count() === charters && db.charterEval.count() === evals && charters > 0n, 'charter versions and evals survive', `${db.charterVersion.count()} versions, ${db.charterEval.count()} evals`);
    check([...db.settings.iter()].find(x => x.key === 'feed_enabled')?.valueI64 === 0n, 'the reset turns the live feed off');
    check(!!db.agentRoster.role.find('cfo'), 'the CFO keeps the seat');
  });

  await section('Releasing the CFO seat: only the CFO or the database owner', async () => {
    await refuses('the Advisor releases the CFO seat', () => A.conn.reducers.releaseCfo({}), /Only the CFO or the database owner/);
    await refuses('a worker releases the CFO seat', () => B.conn.reducers.releaseCfo({}), /Only the CFO or the database owner/);
    check(!!db.agentRoster.role.find('cfo'), 'the CFO still holds the seat after both refusals');
    await accepts('the CFO gives up its own seat', () => X.conn.reducers.releaseCfo({}));
    await waitFor(() => !db.agentRoster.role.find('cfo'), 'seat released by the CFO');
    const again = randomBytes(18).toString('base64url');
    await accepts('the owner arms a new claim', async () => armBootstrap(DB, again));
    await accepts('the CFO claims the seat again', () => X.conn.reducers.claimCfo({ secret: again, displayName: 'Smoke CFO' }));
    await waitFor(() => !!db.agentRoster.role.find('cfo'), 'seat claimed again');
    await accepts('the database owner releases the seat through the CLI', async () => run(BIN, ['call', DB, 'release_cfo', '--server', 'local', '--no-config', '--yes']));
    await waitFor(() => !db.agentRoster.role.find('cfo'), 'seat released by the owner');
  });

  A.conn.disconnect();
  X.conn.disconnect();
  for (const w of Object.values(workers)) w.conn.disconnect();
}

// ---------- in-place upgrade from a module that predates paymentJeId (M1, finding 4) ----------
async function legacy() {
  const tracked = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${LEGACY_REF}:spacetimedb/spacetimedb/src/index.ts`]);
  if (tracked.status !== 0) {
    console.log(`\nSKIPPED the in-place upgrade check: commit ${LEGACY_REF} is not in this clone (shallow clone or rewritten history). Set LEGACY_REF to a commit from before bank_match.paymentJeId existed to run it.`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'luyten-legacy-'));
  try {
    // That commit's module, generated bindings and seed loader, extracted with git archive (the work tree is untouched),
    // so the old database is seeded exactly as it was then, whatever today's loader and bindings expect.
    const paths = ['spacetimedb/spacetimedb/src', 'spacetimedb/spacetimedb/package.json', 'spacetimedb/spacetimedb/tsconfig.json', 'packages/stdb-bindings/src', 'packages/stdb-bindings/package.json', 'seed/src', 'seed/package.json'];
    const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', LEGACY_REF, ...paths], { maxBuffer: 256 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(`git archive ${LEGACY_REF} failed: ${archive.stderr?.toString().trim()}`);
    const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr?.toString().trim()}`);
    const oldModule = join(dir, 'spacetimedb', 'spacetimedb');
    symlinkSync(join(moduleDir, 'node_modules'), join(oldModule, 'node_modules'));
    symlinkSync(join(repo, 'packages', 'stdb-bindings', 'node_modules'), join(dir, 'packages', 'stdb-bindings', 'node_modules'));
    // That commit's loader imports the bindings by its own package name (@cafoo/... before the rename to Luyten).
    const oldSeed = JSON.parse(readFileSync(join(dir, 'seed', 'package.json'), 'utf8'));
    const bindings = Object.keys({ ...oldSeed.dependencies, ...oldSeed.devDependencies }).find(n => n.endsWith('/stdb-bindings'));
    if (!bindings) throw new Error(`${LEGACY_REF}'s seed/package.json does not depend on the stdb bindings`);
    mkdirSync(dirname(join(dir, 'seed', 'node_modules', bindings)), { recursive: true });
    symlinkSync(join(dir, 'packages', 'stdb-bindings'), join(dir, 'seed', 'node_modules', bindings));
    symlinkSync(realpathSync(join(repo, 'seed', 'node_modules', 'spacetimedb')), join(dir, 'seed', 'node_modules', 'spacetimedb'));
    if (!existsSync(join(repo, 'seed', 'out', 'seed.json'))) run('pnpm', ['-F', '@luyten/seed', 'generate']);
    mkdirSync(join(dir, 'seed', 'out'), { recursive: true });
    copyFileSync(join(repo, 'seed', 'out', 'seed.json'), join(dir, 'seed', 'out', 'seed.json'));
    console.log(`\npublishing the ${LEGACY_REF} module to ${LEGACY_DB} and seeding it with that commit's loader`);
    publish(LEGACY_DB, oldModule, true);
    const tsx = join(repo, 'packages', 'stdb-bindings', 'node_modules', '.bin', 'tsx');
    run(tsx, [join(dir, 'seed', 'src', 'load.ts')], { SPACETIMEDB_DB_NAME: LEGACY_DB }, join(dir, 'seed'));
    const oldToken = [join(dir, '.secrets', LEGACY_DB, 'advisor.token'), join(dir, '.secrets', 'advisor.token')].find(f => existsSync(f));
    if (!oldToken) throw new Error('the legacy loader saved no advisor token');
    // Rows of tables whose schema changed since (bank_match.paymentJeId, subsidiary.isElimination, the listing columns on
    // customer and vendor) would not decode with today's bindings, so these connections do not subscribe to them.
    const tables = ['proposal', 'journal_entry', 'bank_transaction', 'bill', 'agent_roster'];
    const A = await connect(LEGACY_DB, 'advisor', readFileSync(oldToken, 'utf8').trim(), tables);
    const B = await connect(LEGACY_DB, 'bookkeeper', undefined, tables);
    // The old module seats the CFO by first claim and records no database owner, so an owner-armed claim is impossible
    // after the upgrade; a real database upgraded in place keeps the CFO it already had.
    const X0 = await connect(LEGACY_DB, 'cfo', undefined, tables);
    await X0.conn.reducers.registerAgent({ role: { tag: 'Cfo' }, displayName: 'Smoke CFO', model: 'human' });
    await A.conn.reducers.grantRole({ identity: B.identity, role: { tag: 'Bookkeeper' }, displayName: 'Smoke bookkeeper', model: 'smoke' });
    const db = A.conn.db;
    const sub = [...db.journalEntry.iter()][0]!.subsidiaryId.toString();
    const close = JSON.parse(readFileSync(join(dir, 'seed', 'out', 'seed.json'), 'utf8')).closeYm as string;
    // The Lumen Analytics payment and the bill it pays, found through the bank line (vendor rows are not subscribed).
    const tx = [...db.bankTransaction.iter()].find(t => !t.matched && t.ym === close && t.counterparty === 'Lumen Analytics' && t.amountMinor < 0n)!;
    const bill = [...db.bill.iter()].find(b => b.ym === close && b.amountMinor === -tx.amountMinor)!;
    const proposeOld = async (kind: string, payload: object, label: string) => {
      const summary = `Smoke legacy ${label}, a plain English summary.`;
      await B.conn.reducers.propose({ kind, payloadJson: JSON.stringify(payload), rationale: 'smoke', summaryPlain: summary, amountMinor: 0n, periodYm: close, closeTaskId: undefined });
      const p = await waitFor(() => [...db.proposal.iter()].find(x => x.summaryPlain === summary), label);
      await A.conn.reducers.approveProposal({ proposalId: p.id, rationale: 'smoke', summaryPlain: 'Approved by the smoke test.', amendedPayloadJson: undefined });
      return waitFor(() => [...db.journalEntry.iter()].find(j => j.proposalId === p.id), `${label} posted`);
    };
    const payment = await proposeOld('bank_match', { matches: [{ bankTxId: tx.id.toString(), targetKind: 'bill', targetId: bill.id.toString(), scoreBp: 9500 }] }, 'bank match');
    const badRate = await proposeOld('journal_entry', { subsidiaryId: sub, periodYm: close, memo: 'posted at a fake FX rate', lines: [{ accountCode: '6000', debitMinor: '5000000', creditMinor: '0', fxRateE6: '1' }, { accountCode: '1000', debitMinor: '0', creditMinor: '5000000', fxRateE6: '1' }] }, 'bad-rate entry');
    pass(`old module posted a payment entry (${payment.id}) and a bad-rate entry (${badRate.id})`);
    A.conn.disconnect();
    B.conn.disconnect();
    X0.conn.disconnect();

    await accepts('M1: the working-tree module publishes over it in place', async () => publish(LEGACY_DB, moduleDir, false));
    const X = await connect(LEGACY_DB, 'cfo', X0.token);
    await accepts('the upgraded database keeps its CFO (re-registering as itself)', () => X.conn.reducers.registerAgent({ role: { tag: 'Cfo' }, displayName: 'Smoke CFO', model: 'human' }));
    await sleep(300);
    const old = [...X.conn.db.subsidiary.iter()][0];
    check(!!old && old.isElimination === false, 'the existing subsidiary reads isElimination = false after the upgrade');
    const match = [...X.conn.db.bankMatch.iter()].find(m => m.bankTxId === tx.id)!;
    check(!!match && match.paymentJeId === undefined, 'the pre-upgrade match has no paymentJeId');
    const before = X.conn.db.bankMatch.count();
    await accepts('M1: CFO reverses the pre-upgrade payment entry', () => X.conn.reducers.cfoReverse({ jeId: payment.id, reasonPlain: 'smoke legacy unwind' }));
    await sleep(300);
    check(X.conn.db.bankMatch.count() === before - 1n && !X.conn.db.bankMatch.id.find(match.id), 'M1: exactly its match is removed', `${before} -> ${X.conn.db.bankMatch.count()}`);
    check(!X.conn.db.bankTransaction.id.find(tx.id)!.matched && X.conn.db.bill.id.find(bill.id)!.status.tag === 'Open', 'M1: its bank line is unmatched and its bill reopened');
    await accepts('finding 4: CFO reverses an entry posted at a bad rate before the rule existed', () => X.conn.reducers.cfoReverse({ jeId: badRate.id, reasonPlain: 'posted at a fake FX rate' }));
    X.conn.disconnect();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A row that does not decode is thrown from a websocket callback, outside any await: record it and carry on, so the
// run still reports every result (the affected waits then time out and fail on their own).
process.on('uncaughtException', e => fail('uncaught exception', msgOf(e)));
try {
  await main();
} catch (e) {
  fail('main database', msgOf(e));
}
if (process.env.SMOKE_SKIP_LEGACY !== '1') {
  try {
    await legacy();
  } catch (e) {
    fail('legacy upgrade', msgOf(e));
  }
}
if (process.env.SMOKE_KEEP !== '1') {
  dropDb(DB);
  dropDb(LEGACY_DB);
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
