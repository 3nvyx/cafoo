// Row mappers: generated client bindings (bigint ids, PascalCase enum tags,
// Timestamp objects) to the UI row types (string ids, lowercase unions, ISO strings).
import type * as B from '../../module_bindings/types';
import type * as U from '../types';

type Ts = { microsSinceUnixEpoch: bigint };

export const iso = (ts: Ts | undefined | null): string => (ts ? new Date(Number(ts.microsSinceUnixEpoch / 1000n)).toISOString() : new Date(0).toISOString());
export const sid = (id: bigint | number | undefined | null): string | undefined => (id === undefined || id === null ? undefined : String(id));
const snake = (tag: string) => tag.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const lower = <T extends string>(tag: string) => snake(tag) as T;

/** Period id (u64) to "yyyy-mm". */
export type PeriodYm = Map<string, string>;

export function lastDayOfYm(ym: string): string {
	const [y, m] = ym.split('-').map(Number);
	return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export const subsidiary = (r: B.Subsidiary): U.Subsidiary => ({ id: String(r.id), name: r.name, baseCurrency: r.functionalCcy });

export const account = (r: B.Account): U.Account => ({
	id: String(r.id),
	subsidiaryId: String(r.subsidiaryId),
	code: r.code,
	name: r.name,
	type: lower<U.AccountType>(r.accountType.tag)
});

export const period = (r: B.Period, locks: B.PeriodLock[]): U.Period => ({
	id: r.ym,
	subsidiaryId: String(r.subsidiaryId),
	year: r.year,
	month: r.month,
	status: lower<U.PeriodStatus>(r.status.tag),
	lockedAt: locks.find((l) => l.periodId === r.id) ? iso(locks.find((l) => l.periodId === r.id)!.lockedAt) : undefined
});

export const journalEntry = (r: B.JournalEntry, ym: PeriodYm): U.JournalEntry => ({
	id: String(r.id),
	periodId: ym.get(String(r.periodId)) ?? String(r.periodId),
	postedAt: iso(r.postedAt),
	memo: r.memo,
	source: lower<U.JournalSource>(r.source.tag),
	proposalId: sid(r.proposalId),
	postedByRole: (r.postedByRole || 'system') as U.PostedByRole,
	reversesJeId: sid(r.reversalOf)
});

export const journalLine = (r: B.JournalLine): U.JournalLine => ({
	id: String(r.id),
	jeId: String(r.jeId),
	accountId: String(r.accountId),
	debitMinor: r.debitMinor.toString(),
	creditMinor: r.creditMinor.toString(),
	customerId: sid(r.customerId),
	vendorId: sid(r.vendorId)
});

export const customer = (r: B.Customer): U.Customer => ({
	id: String(r.id),
	name: r.name,
	domain: r.domain,
	guarantorPersonaId: r.guarantorPersonaId,
	guarantorName: r.guarantorName,
	creditTier: (r.creditTier || undefined) as U.RiskTier | undefined,
	paymentTermsDays: r.paymentTermsDays
});

function monthsBetween(startYm: string, endYm: string): number {
	const [ys, ms] = startYm.split('-').map(Number);
	const [ye, me] = endYm.split('-').map(Number);
	return Math.max(1, (ye - ys) * 12 + (me - ms) + 1);
}

export const contract = (r: B.Contract): U.Contract => {
	const months = r.endYm ? monthsBetween(r.startYm, r.endYm) : 12;
	return {
		id: String(r.id),
		customerId: String(r.customerId),
		startAt: `${r.startYm}-01T00:00:00Z`,
		endAt: r.endYm ? `${lastDayOfYm(r.endYm)}T23:59:59Z` : undefined,
		billing: r.plan.tag === 'Annual' ? 'annual' : 'monthly',
		arrMinor: ((r.totalMinor * 12n) / BigInt(months)).toString()
	};
};

export const invoice = (r: B.Invoice): U.Invoice => ({
	id: String(r.id),
	number: r.number,
	customerId: String(r.customerId),
	issuedAt: iso(r.issuedAt),
	dueAt: iso(r.dueAt),
	amountMinor: r.amountMinor.toString(),
	status: lower<U.InvoiceStatus>(r.status.tag)
});

export const vendor = (r: B.Vendor): U.Vendor => ({
	id: String(r.id),
	name: r.name,
	category: r.category,
	verification: lower<U.VendorVerification>(r.verification.tag),
	notePlain: r.verificationNote || undefined
});

export const bill = (r: B.Bill): U.Bill => ({
	id: String(r.id),
	number: r.externalRef,
	vendorId: String(r.vendorId),
	issuedAt: iso(r.billedAt),
	dueAt: iso(r.dueAt),
	amountMinor: r.amountMinor.toString(),
	status: lower<U.InvoiceStatus>(r.status.tag)
});

export const bankTransaction = (r: B.BankTransaction): U.BankTransaction => ({
	id: String(r.id),
	bookedAt: iso(r.bookedAt),
	amountMinor: r.amountMinor.toString(),
	description: r.description,
	counterparty: r.counterparty,
	matched: r.matched
});

export const bankMatch = (r: B.BankMatch): U.BankMatch => ({
	id: String(r.id),
	bankTransactionId: String(r.bankTxId),
	targetKind: r.targetKind.tag === 'Je' ? 'journal_entry' : r.targetKind.tag === 'Bill' ? 'bill' : 'invoice',
	targetId: String(r.targetId),
	scoreBp: r.scoreBp,
	bucket: r.scoreBp >= 9500 ? 'exact' : r.scoreBp >= 8000 ? 'strong' : 'weak'
});

export const proposal = (r: B.Proposal, ym: PeriodYm): U.Proposal => ({
	id: String(r.id),
	periodId: r.periodId === undefined ? '' : (ym.get(String(r.periodId)) ?? ''),
	kind: lower<U.ProposalKind>(r.kind.tag),
	payloadJson: r.payloadJson,
	rationale: r.rationale,
	summaryPlain: r.summaryPlain,
	amountMinor: r.amountMinor.toString(),
	proposerRole: r.proposerRole as U.AgentRole,
	status: lower<U.ProposalStatus>(r.status.tag),
	createdAt: iso(r.createdAt)
});

export const approval = (r: B.Approval): U.Approval => ({
	id: String(r.id),
	proposalId: String(r.proposalId),
	decision: lower<U.ApprovalDecision>(r.decision.tag),
	rationale: r.rationale,
	summaryPlain: r.summaryPlain,
	at: iso(r.decidedAt),
	cfoConfirmedAt: r.cfoConfirmedAt ? iso(r.cfoConfirmedAt) : undefined
});

export const agentMessage = (r: B.AgentMessage): U.AgentMessage => ({
	id: String(r.id),
	threadId: r.threadId,
	senderRole: r.senderRole as U.AgentRole,
	kind: lower<U.MessageKind>(r.kind.tag),
	body: r.body,
	summaryPlain: r.summaryPlain,
	proposalId: sid(r.proposalId),
	createdAt: iso(r.createdAt)
});

export const closeTask = (r: B.CloseTask, ym: PeriodYm): U.CloseTask => ({
	id: String(r.id),
	periodId: ym.get(String(r.periodId)) ?? String(r.periodId),
	title: r.title,
	ownerRole: r.ownerRole as U.AgentRole,
	status: lower<U.CloseTaskStatus>(r.status.tag),
	order: r.sortOrder,
	proposalIds: r.evidenceProposalIds
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
});

export const creditCheck = (r: B.CreditCheck): U.CreditCheck => ({
	id: String(r.id),
	subjectKind: r.subjectKind.tag === 'Vendor' ? 'vendor' : 'customer',
	subjectId: String(r.subjectId),
	personaId: r.personaId,
	tier: r.tier as U.RiskTier,
	summaryJson: r.summaryJson,
	requestId: r.requestId,
	checkedAt: iso(r.createdAt)
});

export const auditEvent = (r: B.AuditEvent): U.AuditEvent => ({
	id: String(r.id),
	actorRole: r.actorRole as U.PostedByRole,
	action: r.action,
	targetTable: r.targetTable as U.TableName,
	targetId: String(r.targetId),
	detailJson: r.detail,
	at: iso(r.at)
});
