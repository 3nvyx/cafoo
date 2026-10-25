/**
 * End-to-end smoke test of the live feed, against a local SpacetimeDB (destructive: it republishes its database).
 *   pnpm -F @luyten/agents smoke:feed            database luyten-c1 (SPACETIMEDB_DB_NAME to choose another; never luyten)
 * Steps: publish the module fresh, generate and load the demo group with a CFO bootstrap secret, run the September close
 * without waiting, claim the CFO seat with the secret, confirm what waits for the CFO, explicitly accept the remaining
 * bank exceptions as the fixture CFO, and resume until the lock is requested. Lock September, then switch the feed on
 * and send every October event back to back while the continuous
 * Bookkeeper books what lands, and confirm the (material) bank-match batches as the CFO. It then checks: exact receipts
 * and bill payments matched, the partial payment left unmatched, the part-name receipt rejected, the payroll run
 * waiting for the CFO, no Proposal in September from the feed.
 * Exit 0 when every check holds, 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankExceptionAcceptance, bankExceptionSnapshot, currentBankExceptions } from '@luyten/ledger-core';
import { closePeriod } from '../close-period';

process.env.SPACETIMEDB_DB_NAME ||= 'luyten-c1';
process.env.DEMO_STEP_MS = '0';
process.env.CLOSE_NO_WAIT = '1';
const DB = process.env.SPACETIMEDB_DB_NAME;
if (DB === 'luyten') {
  console.error('smoke:feed republishes its database; pick another one than luyten with SPACETIMEDB_DB_NAME.');
  process.exit(2);
}
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const SERVER = process.env.SPACETIME_SERVER ?? 'local';
const CLI = process.env.SPACETIME_BIN ?? (spawnSync('sh', ['-c', 'test -x ~/.local/bin/spacetime && echo ~/.local/bin/spacetime']).stdout.toString().trim() || 'spacetime');
const CLOSE = closePeriod();
const NEXT = `${CLOSE.slice(0, 4)}-${String(Number(CLOSE.slice(5, 7)) + 1).padStart(2, '0')}`;

const step = (m: string) => console.log(`\n[smoke:feed] ${m}`);
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.signal})`);
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

step(`publish the module fresh to ${DB} and load the demo group (close month ${CLOSE})`);
run(CLI, ['publish', DB, '--server', SERVER, '--delete-data=always', '--yes'], join(repoRoot, 'spacetimedb'));
run('pnpm', ['-F', '@luyten/seed', 'generate'], repoRoot, { CLOSE_PERIOD: CLOSE });
run('pnpm', ['-F', '@luyten/seed', 'load'], repoRoot, { SEED_NO_BOOTSTRAP: '' });

// Imported after the environment is set: env.ts reads the database name and step time once.
const { Cast, RoleConn, sleep, waitFor } = await import('../stdb');
const { runScriptedClose } = await import('../scripted/close');
const { takeCfoSeat } = await import('../cfo-seat');
const { startFeeder } = await import('../feed/feeder');
const { startContinuousBookkeeper, waitingFeedLines, citedBankTxIds } = await import('../continuous/bookkeeper');

const cast = await Cast.connectAll();
const A = cast.advisor;
const period = (ym: string) => [...A.db.period.iter()].find(p => p.ym === ym);

step(`close ${CLOSE} without waiting for the CFO`);
console.log(JSON.stringify(await runScriptedClose(cast, CLOSE)));

step('claim the CFO seat with the bootstrap secret and confirm what waits');
const cfo = await RoleConn.connect('cfo');
console.log(`  CFO seat: ${await takeCfoSeat(cfo, 'Smoke CFO')} (${cfo.hex})`);
// This is an explicit decision by the isolated fixture CFO, never the production demo-CFO automation.
const exceptionInput = (source = cfo) => ({
  periodYm: CLOSE,
  bankRows: [...source.db.bankTransaction.iter()].map(row => ({
    id: String(row.id), subsidiaryId: String(row.subsidiaryId), ym: row.ym,
    bookedAt: new Date(Number(row.bookedAt.microsSinceUnixEpoch / 1000n)).toISOString(),
    amountMinor: String(row.amountMinor), ccy: row.ccy, description: row.description,
    counterparty: row.counterparty, matched: row.matched,
  })),
  auditEvents: [...source.db.auditEvent.iter()].map(event => ({
    id: String(event.id), actorRole: event.actorRole, action: event.action, targetTable: event.targetTable,
    targetId: String(event.targetId), detail: event.detail,
    at: new Date(Number(event.at.microsSinceUnixEpoch / 1000n)).toISOString(),
  })),
});
// The seed locked July and August itself: switching the feed on before the CFO locks September sends nothing.
await cfo.reducers.setFeedEnabled({ enabled: true });
await waitFor(() => A.db.settings.key.find('feed_enabled')?.valueI64 === 1n, 'feed switched on');
const early = startFeeder(cast, { intervalMs: 0, autoStart: false });
const earlySent = await early.drain();
check(`feed sends nothing before the CFO locks ${CLOSE}`, earlySent === 0 && early.status().planned === 0, `${earlySent} sent; ${early.status().blockedReason ?? ''}`);
early.stop();
await cfo.reducers.setFeedEnabled({ enabled: false });
for (let round = 1; round <= 4 && period(CLOSE)?.status.tag === 'Open'; round++) {
  const waiting = [...A.db.proposal.iter()].filter(p => p.periodId === period(CLOSE)?.id && p.status.tag === 'AwaitingCfo');
  for (const p of waiting) await cfo.reducers.cfoConfirm({ proposalId: p.id, note: '' });
  console.log(`  round ${round}: confirmed ${waiting.length}; resuming the close`);
  await sleep(300);
  console.log(`  ${JSON.stringify(await runScriptedClose(cast, CLOSE))}`);
  await sleep(300);
}
const pendingClose = [...cfo.db.proposal.iter()].filter(p => p.periodId === period(CLOSE)?.id && ['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag));
const remainingExceptions = currentBankExceptions(exceptionInput());
if (period(CLOSE)?.status.tag === 'Open' && pendingClose.length === 0 && remainingExceptions.length > 0) {
  step(`fixture CFO reviews and accepts ${remainingExceptions.length} remaining ${CLOSE} bank exceptions`);
  await cfo.reducers.acceptBankExceptions({
    periodYm: CLOSE,
    expectedSnapshot: bankExceptionSnapshot(exceptionInput()),
    reasonPlain: 'Smoke fixture CFO reviewed these unmatched bank lines and accepts carrying them as explicit exceptions for this feed test.',
  });
  await waitFor(() => bankExceptionAcceptance(exceptionInput(A)).accepted, 'Advisor sees fixture CFO bank exception acceptance');
  console.log(`  ${JSON.stringify(await runScriptedClose(cast, CLOSE))}`);
  await sleep(300);
}
check(`${CLOSE} lock requested`, period(CLOSE)?.status.tag === 'Closing', `status ${period(CLOSE)?.status.tag}`);
const groupProposals = [...A.db.proposal.iter()].filter(p => p.periodId === period(CLOSE)?.id && (p.kind.tag === 'FxRevaluation' || p.kind.tag === 'IcElimination'));
check('the close proposed 1 revaluation and 2 eliminations', groupProposals.filter(p => p.kind.tag === 'FxRevaluation').length === 1 && groupProposals.filter(p => p.kind.tag === 'IcElimination').length === 2, groupProposals.map(p => `${p.kind.tag} ${p.status.tag} ${p.amountMinor}`).join(', '));
await cfo.reducers.lockPeriod({ periodYm: CLOSE, rationale: 'Smoke test: the CFO locks the month after reviewing the board pack.' });
await waitFor(() => period(CLOSE)?.status.tag === 'Closed', `${CLOSE} locked`);
check(`${CLOSE} locked by the CFO`, period(CLOSE)?.status.tag === 'Closed');
const septemberBefore = [...A.db.proposal.iter()].filter(p => p.periodId === period(CLOSE)?.id).length;

step(`switch the feed on and send every ${NEXT} event back to back`);
await cfo.reducers.setFeedEnabled({ enabled: true });
await waitFor(() => A.db.settings.key.find('feed_enabled')?.valueI64 === 1n, 'feed switched on');
const bookkeeper = startContinuousBookkeeper(cast, { debounceMs: 300 });
const feeder = startFeeder(cast, { intervalMs: 0, autoStart: false });
const plan = feeder.plan();
console.log(`  ${plan.length} event(s) planned for ${NEXT}`);
const sent = await feeder.drain();
console.log(`  sent ${sent}; status ${JSON.stringify(feeder.status())}`);
check('every planned event ingested', feeder.status().ingested === plan.length && plan.length > 0, `${feeder.status().ingested}/${plan.length}`);
// Let the continuous Bookkeeper and the rulings settle: no feed line waiting and no new Proposal for two seconds.
let last = -1;
let quiet = 0;
for (let i = 0; i < 120 && quiet < 4; i++) {
  await sleep(500);
  const n = [...A.db.proposal.iter()].length + [...A.db.approval.iter()].length;
  quiet = n === last && waitingFeedLines(A).size === 0 ? quiet + 1 : 0;
  last = n;
}
await bookkeeper.idle();
bookkeeper.stop();
feeder.stop();
// A batch of receipts is usually material as a whole, so it waits for the CFO like any other: confirm the bank matches
// (the payroll entry stays waiting, as a CFO who has not looked at it yet would leave it).
const matchesWaiting = [...A.db.proposal.iter()].filter(p => p.periodId === period(NEXT)?.id && p.kind.tag === 'BankMatch' && p.status.tag === 'AwaitingCfo');
for (const p of matchesWaiting) await cfo.reducers.cfoConfirm({ proposalId: p.id, note: '' });
console.log(`  the CFO confirmed ${matchesWaiting.length} material bank match proposal(s)`);
await sleep(500);

step('check what the Bookkeeper made of the feed');
const rowOf = new Map([...A.db.feedEvent.iter()].map(e => [e.externalId, e.rowId]));
const tx = (externalId: string) => A.db.bankTransaction.id.find(rowOf.get(externalId) ?? -1n);
const cited = citedBankTxIds(A);
const proposalsCiting = (id: bigint) =>
  [...A.db.proposal.iter()].filter(p => {
    try {
      const x = JSON.parse(p.payloadJson) as { matches?: { bankTxId: string }[]; bankTxIds?: string[] };
      return (x.matches ?? []).some(m => BigInt(m.bankTxId) === id) || (x.bankTxIds ?? []).some(t => BigInt(t) === id);
    } catch {
      return false;
    }
  });
for (const e of plan) {
  if (e.kind !== 'bank_tx') continue;
  const t = tx(e.externalId);
  if (!t) {
    check(`${e.externalId} landed`, false);
    continue;
  }
  const ps = proposalsCiting(t.id);
  const state = ps.map(p => `${p.kind.tag} ${p.status.tag}`).join(', ') || 'no proposal';
  if (e.expect === 'auto_match') check(`${e.externalId} matched exactly`, t.matched && ps.some(p => p.kind.tag === 'BankMatch'), state);
  else if (e.expect === 'partial') check(`${e.externalId} (partial payment) left unmatched for a person`, !t.matched && !cited.has(t.id), state);
  else if (e.expect === 'review') check(`${e.externalId} (part-name receipt) not matched`, !t.matched && ps.every(p => p.status.tag === 'Rejected'), state);
  else if (e.material) check(`${e.externalId} (material) waits for the CFO`, ps.some(p => p.status.tag === 'AwaitingCfo') && !t.matched, state);
  else check(`${e.externalId} booked`, t.matched, state);
}
const feedLines = new Set(plan.filter(e => e.kind === 'bank_tx').map(e => rowOf.get(e.externalId)).filter((x): x is bigint => x !== undefined));
const feedProposals = [...A.db.proposal.iter()].filter(p => [...feedLines].some(id => proposalsCiting(id).some(q => q.id === p.id)));
check(`every feed Proposal is in ${NEXT}`, feedProposals.length > 0 && feedProposals.every(p => p.periodId === period(NEXT)?.id), `${feedProposals.length} proposal(s)`);
check(`no new Proposal in ${CLOSE}`, [...A.db.proposal.iter()].filter(p => p.periodId === period(CLOSE)?.id).length === septemberBefore);
check('feed Proposals carry no close task', feedProposals.every(p => p.closeTaskId === undefined));
const newInvoices = plan.filter(e => e.kind === 'invoice');
check('new usage invoices paid by their receipts', newInvoices.every(e => [...A.db.invoice.iter()].find(i => e.kind === 'invoice' && i.number === e.invoice.number)?.status.tag === 'Paid'), `${newInvoices.length} invoice(s)`);

const failed = checks.filter(c => !c.ok);
console.log(`\n[smoke:feed] ${checks.length - failed.length}/${checks.length} checks passed on ${DB}`);
cfo.disconnect();
cast.disconnectAll();
process.exit(failed.length ? 1 : 0);
