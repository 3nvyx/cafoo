import { describe, expect, it } from 'vitest';
import governance from './data/mock/seed/governance.json';
import customers from './data/mock/seed/customers.json';
import type { AgentMessage, CreditCheck, Proposal } from './data/types';
import { KIND } from './labels';
import { agentActivity, creditFinding } from './agent-activity';

const proposals = governance.proposals as Proposal[];
const messages = governance.agentMessages as AgentMessage[];
const creditChecks = (customers as unknown as { creditChecks: CreditCheck[] }).creditChecks;
const byRole = () => Object.fromEntries(agentActivity({ proposals, messages, creditChecks, kindLabel: (k) => KIND[k], nameOf: (_k, id) => (id === 'c03' ? 'Copperline' : undefined) }).map((a) => [a.role, a]));

describe('agent activity', () => {
	it("shows the Bookkeeper's bank matches, accruals and entries with the tools behind them", () => {
		const bk = byRole().bookkeeper;
		expect(bk.made).toBe(4);
		expect(bk.byKind).toEqual(expect.arrayContaining([{ label: 'Accrual', count: 2 }, { label: 'Bank Match', count: 1 }, { label: 'Journal Entry', count: 1 }]));
		const match = bk.items.find((i) => i.proposalId === 'pr-01')!;
		expect(match.tools).toEqual(['score_bank_matches', 'propose_bank_match']);
		expect(bk.toolsUsed.map((t) => t.name)).toEqual(expect.arrayContaining(['propose_accrual', 'detect_missing_accruals', 'propose_journal_entry']));
		// Statements on its own Proposals repeat the Proposal, so they are not separate items.
		expect(bk.items.every((i) => i.id.startsWith('p:') || !i.proposalId)).toBe(true);
	});

	it('records each Credit Check as a CRS cascade run with its tier', () => {
		const cr = byRole().credit;
		const check = cr.items.find((i) => i.label === 'Credit Check' && i.text.includes('per-03'))!;
		expect(check.text).toBe('Ran the CRS cascade on persona per-03, guarantor of Copperline: Tier C, fair credit.');
		expect(check.tools).toEqual(['run_credit_cascade', 'record_credit_check']);
	});

	it('gives the Red Team its critiques and the Advisor its rulings, and leaves out superseded Proposals', () => {
		const a = byRole();
		expect(a.redteam.items.length).toBeGreaterThan(0);
		expect(a.redteam.items.filter((i) => i.label === 'Critique').every((i) => i.tools[0] === 'submit_critique')).toBe(true);
		expect(a.advisor.items.some((i) => i.tools[0] === 'reject_proposal')).toBe(true);
		expect(a.advisor.items.some((i) => i.tools[0] === 'approve_proposal')).toBe(true);
		expect(a.revenue.items.some((i) => i.proposalId === 'pr-07' && i.id.startsWith('p:'))).toBe(false);
	});

	it('reads a live cascade row: file status, identity and fraud', () => {
		const live = JSON.stringify({ product: 'transunion_credit', requestId: 'r1', facts: { identity: { result: 'PASS' }, fraud: { level: 'low' }, bureaus: { transunion: { fileStatus: 'no_hit' }, equifax: { fileStatus: 'no_hit' } } } });
		expect(creditFinding(live)).toBe('NO_HIT');
		expect(creditFinding(JSON.stringify({ facts: { identity: { result: 'FAIL', deceased: true }, fraud: { level: 'high' } } }))).toBe('identity FAIL, DECEASED, fraud risk high');
		expect(creditFinding('not json')).toBe('');
	});
});
