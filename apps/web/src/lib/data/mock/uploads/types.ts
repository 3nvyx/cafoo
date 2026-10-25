// The seam between the mock data source and each area's demo behaviour (Books, Financing, People, Cost of service, CRM).
// An area hands the mock its upload handlers (what a sample file says and what follows from it) and its live tickers
// (records that keep arriving from connected tools). The mock owns timing, the Red Team and Advisor, and posting.
import type { AgentRole, DocumentKind, MessageKind, Minor, Proposal, ProposalKind, UploadedDocument } from '../../types';
import type { ScriptLine } from '../script';
import type { Tables } from '../seed';

/** Tables whose rows are arrays (everything but settings). */
export type ArrayTable = { [K in keyof Tables]: Tables[K] extends unknown[] ? K : never }[keyof Tables];
export type RowOf<K extends ArrayTable> = Tables[K] extends (infer R)[] ? R : never;

export interface ProposeInput {
	kind: ProposalKind;
	proposerRole: AgentRole;
	/** Measured against the Materiality threshold, as every Proposal is. */
	amountMinor: Minor;
	summaryPlain: string;
	rationale: string;
	/** `lines` post as one journal entry when the Proposal is approved; `memo` names it. */
	payload: Record<string, unknown> & { memo?: string; lines?: ScriptLine[] };
	/** The month it books into; default `ctx.openPeriodId()`. A September Proposal joins September's close and, at or
	 * above materiality, blocks its lock until the CFO confirms it. */
	periodId?: string;
	/** The proposing agent's message in the thread (technical voice). */
	body: string;
	/** Optional Red Team critique before the Advisor rules. */
	critique?: { body: string; summary: string };
	/**
	 * Runs once the Proposal is approved (by the Advisor below materiality, or by the CFO above it), after posting.
	 * `approved` is the Proposal that was approved: after a send-back that is the resubmission, not the original, so
	 * read its id (and its journal entry via `journal_entry.proposalId`) from here, never from a closed-over id.
	 */
	onApproved?: (ctx: MockContext, approved: Proposal) => void;
}

export interface MockContext {
	/** The live tables. Mutate rows in place, then call `update` so screens and subscribers hear about it. */
	readonly t: Tables;
	/** The demo clock, ISO. */
	now(): string;
	/** A fresh id with this prefix ("doc", "pr", "tk"). */
	id(prefix: string): string;
	insert<K extends ArrayTable>(table: K, row: RowOf<K>): RowOf<K>;
	update<K extends ArrayTable>(table: K, row: RowOf<K>): void;
	message(m: { role: AgentRole; kind: MessageKind; body: string; summary: string; proposalId?: string }): void;
	/** What an agent is doing now (null clears it). */
	activity(role: AgentRole | null, label?: string): void;
	/** Raises a Proposal; the Red Team and Advisor follow on the usual timing. Returns its id. */
	propose(p: ProposeInput): string;
	later(ms: number, fn: () => void): void;
	/**
	 * The month the demo clock is in while it is open, otherwise the earliest month not locked ("2026-10"); undefined
	 * when every month is locked, and then nothing may be proposed (propose() throws a plain error).
	 */
	openPeriodId(): string | undefined;
	/** Marks an integration as just synced (lastSyncAt = now, recordsSynced += n). */
	synced(integrationId: string, n?: number): void;
}

export interface Reading {
	/** The fields read from the file; stored as `extractedJson`. */
	extracted: unknown;
	summaryPlain: string;
	/** Fields that need a person. Non-empty makes the document 'needs_review'. */
	flagsPlain?: string[];
}

/** One kind of sample file and what Cafoo does with it. */
export interface UploadHandler {
	kind: DocumentKind;
	fileName: string;
	sizeBytes: number;
	readByRole: AgentRole;
	/** The recorded reading of the sample. */
	read(ctx: MockContext): Reading;
	/** What follows once the reading lands: rows inserted, Proposals raised. Returns the Proposal ids. */
	apply(ctx: MockContext, doc: UploadedDocument): string[];
}

/** Something that keeps arriving from a connected tool. Runs every `everyMs` while `when` holds (default: always). */
export interface LiveTicker {
	name: string;
	everyMs: number;
	/** The integration it streams from; the ticker only runs while that integration is connected. */
	integrationId?: string;
	tick(ctx: MockContext): void;
}
