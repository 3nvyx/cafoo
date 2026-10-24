/**
 * Revenue catch-up: a recognition entry must leave out a customer whose new revenue schedule still waits for a ruling
 * (the module refuses it, and so does the Revenue harness). Once that schedule is approved during the close, its
 * subscription lines through the close month are still unrecognized. This finds them, per customer, for the scripted
 * close and the live orchestrator alike.
 */
import type { Snapshot } from './snapshot';
import type { RoleConn } from './stdb';

/**
 * Unrecognized subscription revenue through `closeYm`, per customer whose revenue schedule was approved in this period,
 * leaving out customers already credited on 4000 by a recognition proposal still waiting for a ruling or the CFO (so a
 * second pass cannot propose the same catch-up twice).
 */
export function catchUpAmounts(A: RoleConn, s: Snapshot): Map<bigint, bigint> {
  const approved = new Set(
    [...A.db.proposal.iter()]
      .filter(p => p.periodId === s.period.id && p.kind.tag === 'RevenueSchedule' && (p.status.tag === 'Approved' || p.status.tag === 'Amended'))
      .flatMap(p => {
        try {
          return (JSON.parse(p.payloadJson).lines as { customerId: string }[]).map(l => BigInt(l.customerId));
        } catch {
          return [];
        }
      })
  );
  const byCustomer = new Map<bigint, bigint>();
  if (!approved.size) return byCustomer;
  const covered = new Set<bigint>();
  for (const p of A.db.proposal.iter()) {
    if (p.kind.tag !== 'JournalEntry' || !['Open', 'AwaitingCfo', 'SentBack'].includes(p.status.tag)) continue;
    try {
      const payload = JSON.parse(p.payloadJson) as { recognizeScheduleYm?: string; lines?: { accountCode?: string; customerId?: string }[] };
      if (!payload.recognizeScheduleYm) continue;
      for (const l of payload.lines ?? []) if (l.accountCode === '4000' && l.customerId && /^\d+$/.test(l.customerId)) covered.add(BigInt(l.customerId));
    } catch {
      /* a malformed payload covers nobody */
    }
  }
  const subscription = new Set(s.items.filter(i => i.kind === 'subscription').map(i => i.id));
  for (const sl of s.scheduleLines) {
    if (approved.has(sl.customerId) && !covered.has(sl.customerId) && sl.ym <= s.closeYm && !sl.recognized && subscription.has(sl.contractItemId)) {
      byCustomer.set(sl.customerId, (byCustomer.get(sl.customerId) ?? 0n) + sl.amountMinor);
    }
  }
  return byCustomer;
}
