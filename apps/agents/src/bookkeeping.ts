/**
 * Bookkeeper helpers shared by the month-end close and the continuous Bookkeeper on the live bank feed: how an
 * unexplained outflow is classified from its bank description, the counterparty lookup, and date labels.
 */
import { brightDataLive, googleResults, recordedLookup } from './brightdata';

export type OutflowClass = { code: string; label: string; needsLookup?: boolean };

/** The account an unexplained bank line is booked to, from its description; unknown payees need a lookup first. */
export function classifyOutflow(t: { description: string; amountMinor: bigint }): OutflowClass {
  const d = t.description.toUpperCase();
  if (d.includes('PAYROLL')) return { code: '5300', label: 'Payroll' };
  if (d.includes('SERVICE FEE') || d.includes('BANK')) return { code: '6000', label: 'Bank fees' };
  if (d.includes('TRAVEL')) return { code: '5800', label: 'Travel' };
  if (d.includes('COFFEE') || d.includes('OFFICE')) return { code: '5500', label: 'Office' };
  if (d.includes('SUBSCRIPTION')) return { code: '5100', label: 'Software subscription', needsLookup: true };
  return { code: t.amountMinor < 0n ? '5500' : '1100', label: 'Unclassified', needsLookup: true };
}

/** "September 15" for a bank booking time in microseconds. */
export const dayLabel = (micros: bigint) => new Date(Number(micros / 1000n)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

/** Bright Data lookup in live mode; recorded answer otherwise. */
export async function vendorLookup(counterparty: string): Promise<string> {
  if (brightDataLive()) {
    try {
      const results = await googleResults(`${counterparty} company`, 3);
      if (results.length === 0) return `web search found nothing for "${counterparty}"; classifying from the bank description.`;
      const lines = results.map(r => `${r.title} (${r.displayLink}): ${r.description}`.replace(/\s+/g, ' ').slice(0, 160));
      return `web search (Bright Data): ${lines.join(' | ')}`;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const recorded = recordedLookup(counterparty);
      return recorded ? `${recorded} (live lookup failed: ${why}; recorded answer used)` : `lookup failed (${why}); classifying from the bank description.`;
    }
  }
  const recorded = recordedLookup(counterparty);
  return recorded ?? `no public record found for "${counterparty}"; classifying from the bank description.`;
}
