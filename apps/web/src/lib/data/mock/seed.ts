// Turns the hand-written seed JSON into typed table rows.
import reference from './seed/reference.json';
import customers from './seed/customers.json';
import vendors from './seed/vendors.json';
import bank from './seed/bank.json';
import journal from './seed/journal.json';
import governance from './seed/governance.json';
import group from './seed/group.json';
import footprint from './seed/footprint.json';
import type {
	Account,
	AgentMessage,
	Approval,
	AuditEvent,
	BankMatch,
	BankTransaction,
	Bill,
	CharterEval,
	CharterVersion,
	CloseTask,
	Contract,
	CreditCheck,
	Customer,
	FxRate,
	Invoice,
	JournalEntry,
	JournalLine,
	Period,
	Proposal,
	PublicFootprint,
	Settings,
	Subsidiary,
	Vendor
} from '../types';

export interface Tables {
	subsidiary: Subsidiary[];
	account: Account[];
	period: Period[];
	journal_entry: JournalEntry[];
	journal_line: JournalLine[];
	customer: Customer[];
	contract: Contract[];
	invoice: Invoice[];
	vendor: Vendor[];
	bill: Bill[];
	bank_transaction: BankTransaction[];
	bank_match: BankMatch[];
	proposal: Proposal[];
	approval: Approval[];
	agent_message: AgentMessage[];
	close_task: CloseTask[];
	credit_check: CreditCheck[];
	audit_event: AuditEvent[];
	public_footprint: PublicFootprint[];
	settings: Settings;
	fx_rate: FxRate[];
	charter_version: CharterVersion[];
	charter_eval: CharterEval[];
}

type SeedLine = [string, string, string, { customerId?: string; vendorId?: string; ccy?: string; fxRateE6?: string }?];
interface SeedEntry extends Omit<JournalEntry, 'id'> {
	id: string;
	lines: SeedLine[];
}

export const SUBSIDIARY_ID = 'sub-us';
/** Account ids follow the code, which is unique across the group ("1000" is Cafoo Inc's, "1000-UK" Cafoo Ltd's). */
export const accountIdFor = (code: string) => `acc-${code}`;
const subsidiaryIdFor = (code: string) => (code === 'US' ? SUBSIDIARY_ID : `sub-${code.toLowerCase()}`);

export function loadSeed(): Tables {
	const subsidiary: Subsidiary[] = [
		...reference.subsidiaries.map((s) => ({ ...s, code: 'US', isElimination: false })),
		...group.subsidiaries.map((s) => ({ id: subsidiaryIdFor(s.code), name: s.name, baseCurrency: s.baseCurrency, code: s.code, parentId: SUBSIDIARY_ID, isElimination: s.isElimination }))
	];
	const account: Account[] = [
		...[...reference.accounts.map((a) => ({ ...a, isIntercompany: false })), ...group.usAccounts].map((a) => ({
			id: accountIdFor(a.code),
			subsidiaryId: SUBSIDIARY_ID,
			code: a.code,
			name: a.name,
			type: a.type as Account['type'],
			isIntercompany: a.isIntercompany
		})),
		...group.accounts.map((a) => ({
			id: accountIdFor(a.code),
			subsidiaryId: subsidiaryIdFor(a.subsidiary),
			code: a.code,
			name: a.name,
			type: a.type as Account['type'],
			isIntercompany: a.isIntercompany
		}))
	].sort((a, b) => a.code.localeCompare(b.code));

	const journal_entry: JournalEntry[] = [];
	const journal_line: JournalLine[] = [];
	for (const raw of [...(journal.journalEntries as unknown as SeedEntry[]), ...(group.journalEntries as unknown as SeedEntry[])]) {
		const { lines, ...je } = raw;
		journal_entry.push(je);
		lines.forEach(([code, debitMinor, creditMinor, extra], i) => {
			journal_line.push({
				id: `${je.id}-l${i + 1}`,
				jeId: je.id,
				accountId: accountIdFor(code),
				debitMinor,
				creditMinor,
				...(extra ?? {})
			});
		});
	}

	return structuredClone({
		subsidiary,
		account,
		period: reference.periods.map((p) => ({ ...p, subsidiaryId: SUBSIDIARY_ID })) as Period[],
		journal_entry,
		journal_line,
		customer: customers.customers as Customer[],
		contract: customers.contracts as Contract[],
		invoice: customers.invoices as Invoice[],
		vendor: vendors.vendors as Vendor[],
		bill: vendors.bills as Bill[],
		bank_transaction: bank.bankTransactions.map((t) => ({ ...t, ym: t.bookedAt.slice(0, 7) })),
		bank_match: bank.bankMatches as BankMatch[],
		proposal: governance.proposals as Proposal[],
		approval: governance.approvals as Approval[],
		agent_message: governance.agentMessages as AgentMessage[],
		close_task: governance.closeTasks as CloseTask[],
		credit_check: customers.creditChecks as CreditCheck[],
		audit_event: governance.auditEvents as AuditEvent[],
		public_footprint: footprint.publicFootprints as PublicFootprint[],
		settings: { ...reference.settings, reportingCcy: group.reportingCcy },
		fx_rate: group.fxRates.map((r, i) => ({ id: `fx-${i + 1}`, ...r, kind: r.kind as FxRate['kind'] })),
		charter_version: [],
		charter_eval: []
	});
}
