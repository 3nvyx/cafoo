/**
 * Where a month's close stands, read from the live tables. A close is opened by the Advisor's opening message in the
 * close thread, not merely by the month having Proposals: the continuous Bookkeeper files Proposals from the live bank
 * feed during an open month, before anyone starts that month's close. Opening pauses the feed and the continuous
 * Bookkeeper for that month; a close only resumes when it has work of its own to resume.
 */
import { bankExceptionAcceptance, closeMonthLabel, closeOrderRefusal, currentBankExceptions } from '@cafoo/ledger-core';
import type { RoleConn } from './stdb';

/** The start of the Advisor's first message in close:<ym>; its presence marks that month's close as opened. */
export const openingMarker = (ym: string) => `Opening the ${ym} close`;

/** Proposal statuses still waiting for a ruling or the CFO. */
export const PENDING_STATUSES: readonly string[] = ['Open', 'AwaitingCfo', 'SentBack'];

const micros = (t: { microsSinceUnixEpoch: bigint } | undefined) => t?.microsSinceUnixEpoch ?? 0n;

/**
 * When the Advisor opened the close of `ym` (server time, microseconds): the first opening, or with `which: 'last'` the
 * latest one (a close run again after failing). Undefined while it has not been opened.
 */
export function closeOpenedAt(c: RoleConn, ym: string, which: 'first' | 'last' = 'first'): bigint | undefined {
  const thread = `close:${ym}`;
  const marker = openingMarker(ym);
  let at: bigint | undefined;
  for (const m of c.db.agentMessage.iter()) {
    if (m.threadId !== thread || m.senderRole !== 'advisor' || !m.body.startsWith(marker)) continue;
    const t = micros(m.createdAt);
    if (at === undefined || (which === 'first' ? t < at : t > at)) at = t;
  }
  return at;
}

/** Has the Advisor opened the close of `ym`? Then the feed and the continuous Bookkeeper leave that month alone. */
export const closeOpened = (c: RoleConn, ym: string) => closeOpenedAt(c, ym) !== undefined;

/**
 * Has the close of `ym` work to resume? It was opened and at least one Proposal of the month was filed at or after the
 * opening (the feed's Bookkeeper pauses once a close opens, so those are the close's own); or, for a close run before
 * the opening message existed, a Proposal of the month is filed against a close task. A close that failed right after
 * opening, before filing anything, therefore runs fresh again instead of resuming with nothing.
 */
export function closeHasWork(c: RoleConn, ym: string): boolean {
  const period = [...c.db.period.iter()].find(p => p.ym === ym);
  if (!period) return false;
  const proposals = [...c.db.proposal.iter()].filter(p => p.periodId === period.id);
  if (proposals.some(p => p.closeTaskId !== undefined)) return true;
  const openedAt = closeOpenedAt(c, ym);
  return openedAt !== undefined && proposals.some(p => micros(p.createdAt) >= openedAt);
}

/** "2026-09" for "2026-10". */
export function previousYm(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Was the month locked by the CFO (not by the seed, which locks the history months)? */
export function lockedByCfo(c: RoleConn, ym: string): boolean {
  const period = [...c.db.period.iter()].find(p => p.ym === ym);
  if (!period || period.status.tag !== 'Closed') return false;
  return [...c.db.periodLock.iter()].some(l => l.periodId === period.id && l.lockedByRole === 'cfo');
}

/**
 * A feed month: open, its previous month locked by the CFO, and its own close not opened. The live feed fills only such
 * a month and the continuous Bookkeeper books only there (the module applies the same rule to ingest).
 */
export function isFeedMonth(c: RoleConn, ym: string): boolean {
  const period = [...c.db.period.iter()].find(p => p.ym === ym);
  return !!period && period.status.tag === 'Open' && lockedByCfo(c, previousYm(ym)) && !closeOpened(c, ym);
}

/** Bank transactions cited by a Proposal still waiting for a ruling or the CFO. */
export function pendingBankTxIds(c: RoleConn): Set<bigint> {
  return citedBankTxIds(c, { pendingOnly: true });
}

/**
 * Bank transactions a Proposal cites (a match or an entry's bankTxIds): every Proposal, or only those still waiting,
 * or only one period's.
 */
export function citedBankTxIds(c: RoleConn, opts: { pendingOnly?: boolean; periodId?: bigint } = {}): Set<bigint> {
  const ids = new Set<bigint>();
  for (const p of c.db.proposal.iter()) {
    if (opts.pendingOnly && !PENDING_STATUSES.includes(p.status.tag)) continue;
    if (opts.periodId !== undefined && p.periodId !== opts.periodId) continue;
    try {
      const payload = JSON.parse(p.payloadJson) as { matches?: { bankTxId?: unknown }[]; bankTxIds?: unknown[] };
      for (const m of payload.matches ?? []) if (/^\d+$/.test(String(m?.bankTxId))) ids.add(BigInt(String(m.bankTxId)));
      for (const t of payload.bankTxIds ?? []) if (/^\d+$/.test(String(t))) ids.add(BigInt(String(t)));
    } catch {
      /* a malformed payload cites nothing */
    }
  }
  return ids;
}

const iso = (t: { microsSinceUnixEpoch: bigint }) => new Date(Number(t.microsSinceUnixEpoch / 1000n)).toISOString();

/**
 * Unmatched bank lines through `ym` and whether the CFO's acceptance of exactly these is current, computed from the
 * same rows and the same ledger-core functions the module's lock gate uses, so chat and the lock never disagree.
 */
export function bankExceptionsOf(c: RoleConn, ym: string) {
  const input = {
    periodYm: ym,
    bankRows: [...c.db.bankTransaction.iter()].map(row => ({
      id: String(row.id), subsidiaryId: String(row.subsidiaryId), ym: row.ym, bookedAt: iso(row.bookedAt),
      amountMinor: String(row.amountMinor), ccy: row.ccy, description: row.description, counterparty: row.counterparty, matched: row.matched,
    })),
    auditEvents: [...c.db.auditEvent.iter()].map(e => ({
      id: String(e.id), actorRole: e.actorRole, action: e.action, targetTable: e.targetTable, targetId: String(e.targetId), detail: e.detail, at: iso(e.at),
    })),
  };
  return { rows: currentBankExceptions(input), accepted: bankExceptionAcceptance(input).accepted };
}

/**
 * Why the close of `ym` cannot start, in words for the CFO: the month is not in the books, is already locked or waiting
 * for its lock, or an earlier month is not locked yet (months close in order, docs/adr/0014). Undefined when it can.
 * A close already under way for the month is not refused: running it again resumes it.
 */
export function closeStartRefusal(c: RoleConn, ym: string): string | undefined {
  const periods = [...c.db.period.iter()];
  const period = periods.find(p => p.ym === ym);
  const month = closeMonthLabel(ym);
  if (!period) return `The books have no ${month} yet, so there is nothing to close.`;
  if (period.status.tag === 'Closed') return `${month} is already locked. Unlock it before running its close again.`;
  return closeOrderRefusal(periods.map(p => ({ ym: p.ym, status: p.status })), ym, 'start');
}
