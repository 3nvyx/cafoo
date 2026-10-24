/**
 * Custom charter contracts shared by the gateway, the web app (apps/web/src/lib/data/types.ts mirrors these) and the
 * eval runner. A charter version is its markdown plus a mapping: every line ("May 2", "Must never 1", "Escalates 3",
 * "Plain summary") mapped to exactly one target, a rule template from src/charter/library.ts (optional params), an
 * existing eval scenario (optional vars), or a custom scenario written as YAML.
 */
import type { CharterLine } from '../harness';
import { BATCH_MIN_SCORE_BP } from '../harness/bookkeeper';
import { IC_DIFFERENCE_TOLERANCE_MINOR } from '../harness/consolidation';

/** Numbers a charter line can set through a parameterized rule template. */
export interface CharterParams {
  /** Batch bank matches need every match at or above this confidence, in basis points. Default 7500. */
  batchMinScoreBp?: number;
  /** Largest Proposal amount, in minor units, the role may propose; anything larger is left for a human. Default: no cap. */
  maxProposalMinor?: bigint;
  /** Intercompany differences above this, in reporting-currency minor units, are raised in the close thread. Default 100n ($1). */
  icDifferenceToleranceMinor?: bigint;
}

/** Params with every default filled in; maxProposalMinor stays undefined when no charter line caps amounts. */
export type ResolvedParams = CharterParams & { batchMinScoreBp: number; icDifferenceToleranceMinor: bigint };

export const DEFAULT_PARAMS: ResolvedParams = { batchMinScoreBp: BATCH_MIN_SCORE_BP, icDifferenceToleranceMinor: IC_DIFFERENCE_TOLERANCE_MINOR };

export type MappingTarget =
  | { kind: 'rule'; template: string; params?: Record<string, unknown> }
  | { kind: 'scenario'; scenario: string; vars?: Record<string, string | number | boolean | null> }
  | { kind: 'custom_scenario'; yaml: string };

export interface CharterMappingEntry {
  label: CharterLine;
  /** The line's text exactly as the charter says it (whitespace squashed). */
  text: string;
  target: MappingTarget;
}

/** One input a rule template takes, as the charter editor renders it. */
export interface ParamSpec {
  name: string;
  labelPlain: string;
  /** bp: basis points shown as a percentage; minor: money in minor units; kinds: Proposal kinds; int and text: as typed. */
  type: 'bp' | 'minor' | 'kinds' | 'int' | 'text';
  default?: string | number | string[];
  min?: number;
  max?: number;
  /** Choices for `kinds`. */
  options?: string[];
}
