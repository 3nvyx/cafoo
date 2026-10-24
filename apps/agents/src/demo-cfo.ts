/**
 * Demo-only CFO stand-in, for recording eval fixtures and rehearsing the waiting close without a browser. It claims the
 * CFO seat with the bootstrap secret in .secrets/cfo-bootstrap.<db>.txt (or reuses its identity from
 * .secrets/<db>/cfo.token once it holds the seat) and confirms every Proposal of the month that waits for the
 * CFO, as a CFO clicking OK in the app would, until the Advisor has requested the lock or time runs out. It never
 * locks the month. It approves without reading, so never point it at books anyone relies on; and once it holds the CFO
 * seat, a browser can take the seat only by a grant from this identity or a database reset with delete-data.
 * Usage: node --import tsx src/demo-cfo.ts 2026-09 [--timeout-s 600]
 */
import { takeCfoSeat } from './cfo-seat';
import { RoleConn, sleep } from './stdb';

const ym = process.argv.slice(2).find(a => /^\d{4}-\d{2}$/.test(a));
const t = process.argv.indexOf('--timeout-s');
const timeoutMs = (t > 0 ? Number(process.argv[t + 1]) : 600) * 1000;
if (!ym) {
  console.error('usage: demo-cfo <YYYY-MM> [--timeout-s 600]');
  process.exit(2);
}

const cfo = await RoleConn.connect('cfo');
// Claims the seat with the bootstrap secret on first use; on later runs the same identity re-registers as itself, which
// the module allows.
try {
  await takeCfoSeat(cfo);
} catch (e) {
  console.error(`[demo-cfo] cannot act as the CFO: ${(e as Error).message}`);
  process.exit(1);
}
console.log(`[demo-cfo] confirming material rulings for ${ym} as ${cfo.hex}`);

const confirmed = new Set<bigint>();
const start = Date.now();
while (Date.now() - start < timeoutMs) {
  const period = [...cfo.db.period.iter()].find(p => p.ym === ym);
  for (const p of [...cfo.db.proposal.iter()].filter(x => x.periodId === period?.id && x.status.tag === 'AwaitingCfo' && !confirmed.has(x.id))) {
    confirmed.add(p.id);
    try {
      await cfo.reducers.cfoConfirm({ proposalId: p.id, note: '' });
      console.log(`[demo-cfo] confirmed ${p.id}: ${p.summaryPlain}`);
    } catch (e) {
      console.error(`[demo-cfo] could not confirm ${p.id}: ${(e as Error).message}`);
    }
  }
  // The Advisor's lock request moves the month to closing; the lock itself stays the CFO's (a person's) call.
  if (period && period.status.tag !== 'Open') break;
  await sleep(300);
}
console.log(`[demo-cfo] done: ${confirmed.size} confirmed`);
cfo.disconnect();
process.exit(0);
