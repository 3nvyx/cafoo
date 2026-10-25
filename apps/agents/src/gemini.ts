/**
 * Gemini, the Red Team's second critic. It reads each Proposal after the first critic (Grok, or its scripted critique)
 * and adds only what that critique missed. It writes through the same Red Team identity and harness, so a Gemini
 * critique can do no more than a Grok one. Every Gemini critique's body starts with a label ("Gemini: ", or
 * "Gemini (scripted): " for the Demo mode stand-ins in fixtures/gemini/critiques.json) so the app can show who wrote it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, type RoleConn } from './stdb';

type Critique = { body: string; summaryPlain: string };
type ProposalRow = NonNullable<ReturnType<RoleConn['db']['proposal']['id']['find']>>;

export const GEMINI_LABEL = 'Gemini: ';
export const GEMINI_SCRIPTED_LABEL = 'Gemini (scripted): ';
/** A Gemini critique as written to the ledger: the label, then the critique. */
export const labeled = (c: Critique, scripted: boolean): Critique => ({ ...c, body: `${scripted ? GEMINI_SCRIPTED_LABEL : GEMINI_LABEL}${c.body}` });

export type GeminiScenario =
  | 'bank_match_weak'
  | 'allowance_bankruptcy'
  | 'allowance_tier'
  | 'revenue_schedule'
  | 'vendor_verify'
  | 'vendor_block'
  | 'accrual'
  | 'fx_revaluation'
  | 'ic_elimination'
  | 'material_entry';

/** Which scripted critique fits a Proposal: the same cases the first critic's scripted critiques cover. */
export function geminiScenario(p: ProposalRow, materiality: bigint): GeminiScenario | null {
  const payload = JSON.parse(p.payloadJson);
  const kind: string = p.kind.tag;
  if (kind === 'BankMatch' && payload.matches?.length === 1 && payload.matches[0].scoreBp < 7500) return 'bank_match_weak';
  if (kind === 'RevenueSchedule') return 'revenue_schedule';
  if (kind === 'VendorVerify') return 'vendor_verify';
  if (kind === 'VendorBlock') return 'vendor_block';
  if (kind === 'Accrual') return 'accrual';
  if (kind === 'JournalEntry' && /allowance/i.test(payload.memo ?? '') && p.amountMinor >= materiality) return /bankruptcy/i.test(p.summaryPlain) ? 'allowance_bankruptcy' : 'allowance_tier';
  if (kind === 'FxRevaluation') return 'fx_revaluation';
  if (kind === 'IcElimination') return 'ic_elimination';
  if (kind === 'JournalEntry' && p.amountMinor >= materiality) return 'material_entry';
  return null;
}

let fixtures: Record<GeminiScenario, Critique> | null = null;
/** The scripted critiques, read once. */
export function geminiFixtures(): Record<GeminiScenario, Critique> {
  fixtures ??= JSON.parse(readFileSync(join(repoRoot, 'fixtures', 'gemini', 'critiques.json'), 'utf8')).critiques;
  return fixtures!;
}

/** Gemini's scripted critique of a Proposal, labeled, or null when Gemini has nothing to add. */
export function scriptedGeminiCritique(p: ProposalRow, materiality: bigint, vendorName?: (id: bigint) => string | undefined): Critique | null {
  const scenario = geminiScenario(p, materiality);
  if (!scenario) return null;
  const payload = JSON.parse(p.payloadJson);
  const vendor = (/^\d+$/.test(String(payload.vendorId ?? '')) && vendorName?.(BigInt(payload.vendorId))) || 'this vendor';
  const period = String(payload.periodYm ?? 'month-end');
  const fill = (s: string) => s.replaceAll('{vendor}', vendor).replaceAll('{period}', period);
  const c = geminiFixtures()[scenario];
  return labeled({ body: fill(c.body), summaryPlain: fill(c.summaryPlain) }, true);
}
