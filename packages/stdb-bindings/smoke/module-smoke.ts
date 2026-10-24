/**
 * Module smoke test. Publishes the working-tree module to a throwaway database, seeds it with the demo loader, and
 * checks every gate, refusal and legitimate flow that the module reviews pinned down, then deletes the database.
 * A second throwaway database checks an in-place upgrade from a module that predates bank_match.paymentJeId.
 * Exits non-zero on any failed assertion.
 *
 *   pnpm -F @cafoo/stdb-bindings smoke
 *
 * Needs a local SpacetimeDB on :3000 and the spacetime CLI (SPACETIME_BIN, ~/.local/bin/spacetime, or PATH).
 * SMOKE_DB names the database (must end in "smoke"); LEGACY_REF is the git commit of the pre-paymentJeId module
 * (default 57884e2); SMOKE_SKIP_LEGACY=1 skips the upgrade check; SMOKE_KEEP=1 keeps the databases for inspection.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbConnection } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const moduleDir = join(repo, 'spacetimedb', 'spacetimedb');
const DB = process.env.SMOKE_DB ?? 'cafoo-smoke';
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
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || String(r.error)).trim().slice(-600)}`);
  return r.stdout;
}
const publish = (db: string, dir: string, fresh: boolean) =>
  run(BIN, ['publish', db, '--server', 'local', '--yes', '--no-config', '-p', dir, ...(fresh ? ['--delete-data=always'] : [])]);
const dropDb = (db: string) => spawnSync(BIN, ['delete', db, '-s', 'local', '--yes'], { encoding: 'utf8' });
const seedDb = (db: string) => {
  run('pnpm', ['-F', '@cafoo/seed', 'generate']);
  run('pnpm', ['-F', '@cafoo/seed', 'load'], { SPACETIMEDB_DB_NAME: db });
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
type Who = { conn: DbConnection; identity: NonNullable<DbConnection['identity']>; name: string };
function connect(db: string, name: string, token?: string, tables?: string[]): Promise<Who> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(db)
      .withToken(token)
      .onConnect((conn, identity) => {
        const sub = conn.subscriptionBuilder().onApplied(() => resolve({ conn, identity, name }));
        if (tables) sub.subscribe(tables.map(t => `SELECT * FROM ${t}`));
        else sub.subscribeToAllTables();
      })
      .onConnectError((_c, e) => reject(e))
      .build();
  });
}
const advisorToken = () => readFileSync(join(repo, '.secrets', 'advisor.token'), 'utf8').trim();

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

  const A = await connect(DB, 'advisor', advisorToken());
  const X = await connect(DB, 'cfo');
  await X.conn.reducers.registerAgent({ role: { tag: 'Cfo' }, displayName: 'Smoke CFO', model: 'human' });
  const workers: Record<string, Who> = {};
  for (const [role, tag] of [['bookkeeper', 'Bookkeeper'], ['revenue', 'Revenue'], ['credit', 'Credit'], ['redteam', 'Redteam']] as const) {
    workers[role] = await connect(DB, role);
    await A.conn.reducers.grantRole({ identity: workers[role]!.identity, role: { tag }, displayName: `Smoke ${role}`, model: 'smoke' });
  }
  const B = workers.bookkeeper!;
  const R = workers.revenue!;
  const C = workers.credit!;
  const RT = workers.redteam!;
  const db = X.conn.db;
  await sleep(300);
  const sub = [...db.subsidiary.iter()][0]!.id.toString();

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
  const cust0 = [...db.customer.iter()][0]!;
  await X.conn.reducers.seedInvoice({ customerId: cust0.id, contractCode: undefined, number: 'SMOKE-EUR-1', ym: CLOSE, issuedAtMicros: 1788000000000000n, dueAtMicros: 1799000000000000n, amountMinor: 110000n, status: 'open' });
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
  const anyJe = [...db.journalEntry.iter()][0]!;

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
    await refuses('advisor records a credit check', () => A.conn.reducers.recordCreditCheck({ subjectKind: 'vendor', subjectId: bds.id, personaId: 'P01', product: 'fraud_finder', requestId: 'adv-1', summaryJson: '{}', tier: 'A', decision: 'APPROVE' }), /Only credit/);
    await refuses('advisor resets the sealed demo', () => A.conn.reducers.resetDemo({ confirm: 'RESET' }), /sealed/);
    await refuses('advisor seeds a journal entry after sealing', () => A.conn.reducers.seedJournalEntry({ subsidiaryCode: 'US', periodYm: CLOSE, memo: 'x', lines: [{ accountCode: '1000', debitMinor: 1n, creditMinor: 0n, ccy: 'USD', fxRateE6: 1000000n, customerId: undefined, vendorId: undefined, memo: '' }, { accountCode: '3000', debitMinor: 0n, creditMinor: 1n, ccy: 'USD', fxRateE6: 1000000n, customerId: undefined, vendorId: undefined, memo: '' }] }), /sealed/);
    await A.conn.reducers.rejectProposal({ proposalId: open.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
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
    const nw = [...db.vendor.iter()].find(v => v.name === 'Northwind Cloud')!;
    const rec = (product: string, requestId: string, tier: string, decision: string) =>
      C.conn.reducers.recordCreditCheck({ subjectKind: 'vendor', subjectId: nw.id, personaId: 'P01', product, requestId, summaryJson: '{}', tier, decision });
    await rec('tu_identity_verification', 'smk-id-1', 'A', 'APPROVE');
    await rec('fraud_finder', 'smk-fr-1', 'A', 'APPROVE');
    await sleep(20);
    await rec('fraud_finder', 'smk-fr-2', 'BLOCK', 'DECLINE');
    await sleep(200);
    const verify = (ids: string[]) => propose(C, 'vendor_verify', { vendorId: nw.id.toString(), creditCheckIds: ids }, CLOSE);
    check(db.vendor.id.find(nw.id)!.verification.tag === 'Unverified', 'recording clean checks does not verify a vendor');
    await refuses('verification citing older clean rows after a newer DECLINE', () => verify(['smk-id-1', 'smk-fr-1']), /latest fraud_finder check .* is DECLINE/);
    await refuses('verification citing an unrecorded request id', () => verify(['smk-id-1', 'smk-fr-1', 'nope']), /not recorded credit checks/);
    await sleep(20);
    await rec('fraud_finder', 'smk-fr-3', 'B', 'APPROVE');
    await sleep(200);
    await refuses('verification that also cites the old DECLINE row', () => verify(['smk-id-1', 'smk-fr-3', 'smk-fr-2']), /not a clean APPROVE/);
    const ok = await accepts('verification citing the latest clean identity and fraud checks', () => verify(['smk-id-1', 'smk-fr-3']));
    if (ok) {
      await settle(ok);
      check(db.vendor.id.find(nw.id)!.verification.tag === 'Verified', 'the ruled verification verifies the vendor');
    }
  });

  await section('M3, L2: bank lines already matched, in locked months, or listed twice', async () => {
    const seedMatched = [...db.bankTransaction.iter()].find(t => t.matched && t.ym === PREV)!;
    const bm = (matches: object[]) => propose(B, 'bank_match', { matches }, CLOSE);
    await refuses(`bank match on a ${PREV} line the seed marked matched`, () => bm([{ bankTxId: seedMatched.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }]), /already matched/);
    await refuses('bankTxIds citing a seed-matched line', () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '1', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1' }], { bankTxIds: [seedMatched.id.toString()] }), /already matched/);
    await refuses(`bank match on an unmatched line in locked ${PREV}`, () => bm([{ bankTxId: txLocked.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }]), /locked/);
    await refuses(`bankTxIds citing an unmatched line in locked ${PREV}`, () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '7777', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '7777' }], { bankTxIds: [txLocked.id.toString()] }), /locked/);
    const free = [...db.bankTransaction.iter()].find(t => !t.matched && t.ym === CLOSE)!;
    await refuses(`L2: "0${free.id}" and "${free.id}" in one bank match`, () => bm([{ bankTxId: `0${free.id}`, targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }, { bankTxId: free.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }]), /appears twice/);
    await refuses('L2: duplicate bankTxIds in a journal entry', () => je(B, CLOSE, [{ accountCode: '6000', debitMinor: '1', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1' }], { bankTxIds: [`0${free.id}`, Number(free.id)] }), /listed twice/);
  });

  await section('L6 and finding 6: nothing pays a blocked vendor; voiding its bill is allowed', async () => {
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

  await section('L1: the CFO sees a conflict that arose while a proposal waited', async () => {
    const payroll = [...db.bankTransaction.iter()].find(t => !t.matched && t.ym === CLOSE && t.amountMinor <= -1_000_000n)!;
    const bm = await propose(B, 'bank_match', { matches: [{ bankTxId: payroll.id.toString(), targetKind: 'je', targetId: anyJe.id.toString(), scoreBp: 9000 }] }, CLOSE);
    await approve(bm);
    check(status(bm.id) === 'AwaitingCfo', 'a material bank match waits for the CFO');
    const claim = await je(B, CLOSE, [{ accountCode: '5300', debitMinor: '1000', creditMinor: '0' }, { accountCode: '1000', debitMinor: '0', creditMinor: '1000' }], { bankTxIds: [payroll.id.toString()] });
    await settle(claim);
    await refuses('CFO confirms the bank match after the line was claimed', () => X.conn.reducers.cfoConfirm({ proposalId: bm.id, note: 'go' }), /already matched/);
    await X.conn.reducers.cfoSendBack({ proposalId: bm.id, notePlain: 'smoke cleanup' });
    await A.conn.reducers.rejectProposal({ proposalId: bm.id, rationale: 'smoke cleanup', summaryPlain: 'Rejected by the smoke test.' });
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
    // A blocked close task stops the lock, by name.
    const task = [...db.closeTask.iter()].find(t => db.period.id.find(t.periodId)!.ym === CLOSE && t.status.tag !== 'Done')!;
    await B.conn.reducers.updateCloseTask({ taskId: task.id, status: 'blocked', note: 'smoke: waiting on a person' });
    await waitFor(() => db.closeTask.id.find(task.id)!.status.tag === 'Blocked', 'blocked task');
    const blockedRe = new RegExp(`close task\\(s\\) for ${CLOSE} are blocked: "${task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
    await refuses('advisor requests the lock while a close task is blocked', () => A.conn.reducers.requestPeriodLock({ periodYm: CLOSE, rationale: 'smoke', summaryPlain: 'Smoke: ready to lock.' }), blockedRe);
    await refuses('CFO locks while a close task is blocked', () => X.conn.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'smoke lock' }), blockedRe);
    await B.conn.reducers.updateCloseTask({ taskId: task.id, status: 'in_progress', note: 'smoke: unblocked' });
    await waitFor(() => db.closeTask.id.find(task.id)!.status.tag === 'InProgress', 'unblocked task');
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
  const dir = mkdtempSync(join(tmpdir(), 'cafoo-legacy-module-'));
  try {
    copyFileSync(join(moduleDir, 'package.json'), join(dir, 'package.json'));
    copyFileSync(join(moduleDir, 'tsconfig.json'), join(dir, 'tsconfig.json'));
    symlinkSync(join(moduleDir, 'node_modules'), join(dir, 'node_modules'));
    mkdirSync(join(dir, 'src'));
    for (const f of ['index.ts', 'tables.ts']) writeFileSync(join(dir, 'src', f), run('git', ['-C', repo, 'show', `${LEGACY_REF}:spacetimedb/spacetimedb/src/${f}`]));
    console.log(`\npublishing the ${LEGACY_REF} module to ${LEGACY_DB} and seeding it`);
    publish(LEGACY_DB, dir, true);
    seedDb(LEGACY_DB);
    // The old schema has no paymentJeId, so these connections do not subscribe to bank_match.
    const tables = ['proposal', 'journal_entry', 'bank_transaction', 'bill', 'vendor', 'subsidiary', 'agent_roster'];
    const A = await connect(LEGACY_DB, 'advisor', advisorToken(), tables);
    const B = await connect(LEGACY_DB, 'bookkeeper', undefined, tables);
    await A.conn.reducers.grantRole({ identity: B.identity, role: { tag: 'Bookkeeper' }, displayName: 'Smoke bookkeeper', model: 'smoke' });
    const db = A.conn.db;
    const sub = [...db.subsidiary.iter()][0]!.id.toString();
    const close = JSON.parse(readFileSync(join(repo, 'seed', 'out', 'seed.json'), 'utf8')).closeYm as string;
    const lumen = [...db.vendor.iter()].find(v => v.name === 'Lumen Analytics')!;
    const bill = [...db.bill.iter()].find(b => b.vendorId === lumen.id && b.ym === close)!;
    const tx = [...db.bankTransaction.iter()].find(t => !t.matched && t.ym === close && t.amountMinor === -bill.amountMinor && t.counterparty === lumen.name)!;
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

    await accepts('M1: the working-tree module publishes over it in place', async () => publish(LEGACY_DB, moduleDir, false));
    const X = await connect(LEGACY_DB, 'cfo');
    await X.conn.reducers.registerAgent({ role: { tag: 'Cfo' }, displayName: 'Smoke CFO', model: 'human' });
    await sleep(300);
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
