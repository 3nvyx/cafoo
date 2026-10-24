// Turns the hand-written seed JSON into typed table rows.
import reference from './seed/reference.json';
import customers from './seed/customers.json';
import vendors from './seed/vendors.json';
import bank from './seed/bank.json';
import journal from './seed/journal.json';
import governance from './seed/governance.json';
import type {
	Account,
	AgentMessage,
	Approval,
	AuditEvent,
	BankMatch,
	BankTransaction,
	Bill,
	CloseTask,
	Contract,
	CreditCheck,
	Customer,
	Invoice,
	JournalEntry,
	JournalLine,
	Period,
	Proposal,
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
	settings: Settings;
}

type SeedLine = [string, string, string, { customerId?: string; vendorId?: string }?];
interface SeedEntry extends Omit<JournalEntry, 'id'> {
	id: string;
	lines: SeedLine[];
}

export const SUBSIDIARY_ID = 'sub-us';
export const accountIdFor = (code: string) => `acc-${code}`;

export function loadSeed(): Tables {
	const account: Account[] = reference.accounts.map((a) => ({
		id: accountIdFor(a.code),
		subsidiaryId: SUBSIDIARY_ID,
		code: a.code,
		name: a.name,
		type: a.type as Account['type']
	}));

	const journal_entry: JournalEntry[] = [];
	const journal_line: JournalLine[] = [];
	for (const raw of journal.journalEntries as unknown as SeedEntry[]) {
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
		subsidiary: reference.subsidiaries as Subsidiary[],
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
		settings: { ...reference.settings }
	});
}
