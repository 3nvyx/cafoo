/**
 * Bookkeeper helpers shared by the month-end close and the continuous Bookkeeper on the live bank feed: how an
 * unexplained outflow is classified from its bank description, the counterparty lookup, and date labels.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './stdb';

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
  const token = process.env.API_TOKEN;
  if (token && process.env.DEMO_MODE !== '1') {
    try {
      const res = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone: process.env.WEB_UNLOCKER_ZONE ?? 'web_unlocker1', url: `https://www.google.com/search?q=${encodeURIComponent(counterparty + ' company')}`, format: 'raw' }),
      });
      const text = await res.text();
      return `search results summarized: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 240)}…`;
    } catch (e) {
      return `lookup failed (${(e as Error).message}); classifying from the bank description.`;
    }
  }
  const slug = counterparty.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const p = join(repoRoot, 'fixtures', 'brightdata', `${slug}.md`);
  if (existsSync(p)) return readFileSync(p, 'utf8').trim().split('\n').slice(0, 3).join(' ');
  return `no public record found for "${counterparty}"; classifying from the bank description.`;
}
