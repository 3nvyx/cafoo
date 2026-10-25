// The scripted close and the CFO's send-back, run on the in-memory source with fake timers. Unit tests run on plain
// Vite (see vitest.config.ts), which does not compile Svelte runes, so `$state` is stood in for by the identity: the
// source's own logic does not depend on reactivity.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bankExceptionState } from '../../close';

(globalThis as Record<string, unknown>).$state = <T>(value: T) => value;
const { MockDataSource } = await import('./mock-source.svelte');

const PERIOD = '2026-09';
const CLOSE_MS = 32_000;

let db: InstanceType<typeof MockDataSource>;
beforeEach(() => {
	vi.useFakeTimers();
	db = new MockDataSource();
});
afterEach(() => {
	vi.useRealTimers();
});

async function runClose() {
	await db.startClose(PERIOD);
	vi.advanceTimersByTime(CLOSE_MS);
}
const proposal = (id: string) => db.proposals().find((p) => p.id === id)!;
const messages = (id: string) => db.agentMessages().filter((m) => m.proposalId === id);
const unmatched = () => bankExceptionState(db, PERIOD).rows.map((r) => r.id);

describe('the scripted close', () => {
	it('files a Red Team critique on every proposal before the Advisor rules on it', async () => {
		const seeded = new Set(db.proposals().map((p) => p.id));
		await runClose();
		const filed = db.proposals().filter((p) => !seeded.has(p.id));
		expect(filed.map((p) => p.id)).toEqual(expect.arrayContaining(['pr-09', 'pr-14', 'pr-18', 'pr-20', 'pr-12', 'pr-13', 'pr-c1', 'pr-c2', 'pr-c3']));
		const log = db.agentMessages();
		for (const p of filed) {
			const critique = log.findIndex((m) => m.proposalId === p.id && m.senderRole === 'redteam' && m.kind === 'critique');
			const ruling = log.findIndex((m) => m.proposalId === p.id && m.senderRole === 'advisor' && m.kind === 'ruling');
			expect(critique, `${p.id} has no Red Team critique`).toBeGreaterThanOrEqual(0);
			expect(critique, `${p.id} was ruled on before its critique`).toBeLessThan(ruling);
		}
	});

	it('makes the consolidation critiques specific to the books', async () => {
		await runClose();
		expect(messages('pr-c1').find((m) => m.kind === 'critique')!.body).toMatch(/closing rate.*2900-UK.*2950-UK|closing rate.*2950-UK.*2900-UK/s);
		expect(messages('pr-c2').find((m) => m.kind === 'critique')!.body).toMatch(/tie to the cent.*reverses in 2026-10/s);
		expect(messages('pr-c3').find((m) => m.kind === 'critique')!.body).toMatch(/\$0\.01.*under the \$1 tolerance/s);
	});

	it('leaves only the genuinely ambiguous bank lines as exceptions', async () => {
		expect(unmatched()).toEqual(expect.arrayContaining(['bt12', 'bt17', 'bt20', 'bt21', 'bt22', 'bt29', 'bt30', 'bt15']));
		await runClose();
		// The airfare with no receipt, a half payment of an $800 invoice and a payer whose name fits two customers.
		expect(unmatched()).toEqual(['bt14', 'bt31', 'bt32']);
		for (const id of ['i26', 'i14', 'i11', 'i15']) expect(db.invoices().find((i) => i.id === id)!.status).toBe('paid');
		expect(db.bankMatches().filter((m) => m.proposalId === 'pr-14')).toMatchObject([{ bankTransactionId: 'bt12', targetKind: 'invoice', targetId: 'i26', scoreBp: 9100 }]);
	});

	it('books the fee and the interest, and pairs the returned Apex payment without paying its bill', async () => {
		await runClose();
		const lines = (proposalId: string) => {
			const je = db.journalEntries().find((j) => j.proposalId === proposalId)!;
			return db.journalLines().filter((l) => l.jeId === je.id).map((l) => [l.accountId, l.debitMinor, l.creditMinor]);
		};
		expect(lines('pr-18')).toEqual([['acc-6700', '8400', '0'], ['acc-1000', '0', '8400']]);
		expect(lines('pr-19')).toEqual([['acc-1000', '1250', '0'], ['acc-4200', '0', '1250']]);
		expect(db.journalEntries().some((j) => j.proposalId === 'pr-20')).toBe(false);
		expect(db.bankMatches().filter((m) => m.proposalId === 'pr-20').map((m) => m.bankTransactionId)).toEqual(['bt20', 'bt21']);
		expect(db.bills().find((b) => b.id === 'b14')!.status).toBe('open');
	});
});

describe('sending a ruling back', () => {
	it('recomputes the Allowance at the rate in the note, with a critique and a fresh ruling', async () => {
		await runClose();
		expect(proposal('pr-13').status).toBe('awaiting_cfo');
		await db.cfoSendBack('pr-13', 'reserve 50% not 75%');
		vi.advanceTimersByTime(4500);
		const revised = proposal('pr-13-v2');
		expect(proposal('pr-13').status).toBe('superseded');
		// c06 4,500.00 and c14 9,200.00 at 50%, c15's full reserve untouched: 2,250 + 4,600 + 1,000.
		expect(revised.amountMinor).toBe('785000');
		expect(revised.summaryPlain).toContain('$7,850.00 instead of $11,275.00');
		expect(revised.rationale).toContain('now $7,850.00');
		const [first] = messages('pr-13-v2');
		expect(first!.body).toContain('Copperline Electric $4,500.00 x 50% = $2,250.00 (was $3,375.00 at 75%)');
		expect(revised.status).toBe('open');
		vi.advanceTimersByTime(2200);
		const critique = messages('pr-13-v2').find((m) => m.kind === 'critique')!;
		expect(critique.senderRole).toBe('redteam');
		expect(critique.body).toContain('$3,425.00 less');
		expect(messages('pr-13-v2').some((m) => m.kind === 'ruling')).toBe(false);
		vi.advanceTimersByTime(1500);
		// $7,850 is under the $10,000 threshold, so the Advisor posts it.
		expect(proposal('pr-13-v2').status).toBe('approved');
		const je = db.journalEntries().find((j) => j.proposalId === 'pr-13-v2')!;
		expect(db.journalLines().filter((l) => l.jeId === je.id).map((l) => [l.accountId, l.debitMinor, l.creditMinor, l.customerId])).toEqual([
			['acc-6500', '785000', '0', undefined],
			['acc-1150', '0', '225000', 'c06'],
			['acc-1150', '0', '460000', 'c14'],
			['acc-1150', '0', '100000', 'c15']
		]);
	});

	it('keeps a revised Allowance that is still material waiting for the CFO', async () => {
		await runClose();
		await db.cfoSendBack('pr-13', 'make it 70%');
		vi.advanceTimersByTime(4500 + 3200 + 50);
		// 70% of 13,700.00 plus the full 1,000.00 is 10,590.00: over the threshold.
		expect(proposal('pr-13-v2').amountMinor).toBe('1059000');
		expect(proposal('pr-13-v2').status).toBe('awaiting_cfo');
	});

	it('declines a vague note in plain words, rejects the proposal and lets the close lock', async () => {
		await runClose();
		await db.cfoSendBack('pr-11', 'Please look harder at this');
		vi.advanceTimersByTime(4500);
		expect(proposal('pr-11').status).toBe('rejected');
		expect(db.proposals().some((p) => p.id === 'pr-11-v2')).toBe(false);
		const said = messages('pr-11').at(-1)!;
		expect(said.senderRole).toBe('revenue');
		expect(said.body).toMatch(/^I can't apply that note automatically: .+\. Leaving it rejected so it doesn't post; amend it in Expert mode or ask me in chat\.$/);
		expect(said.body).not.toMatch(/addressed|re-checked|resubmit/i);
		expect(db.journalEntries().some((j) => j.proposalId === 'pr-11')).toBe(false);

		// Everything else gets the CFO's confirmation and the bank exceptions are accepted: the Advisor asks for the lock.
		for (const p of db.proposals().filter((p) => p.status === 'awaiting_cfo')) await db.cfoConfirm(p.id);
		await db.acceptBankExceptions(PERIOD, bankExceptionState(db, PERIOD).snapshot, 'Airfare receipt is coming; the two deposits need the customers to say what they paid.');
		expect(db.periods().find((p) => p.id === PERIOD)!.status).toBe('closing');
		await db.lockPeriod(PERIOD);
		expect(db.periods().find((p) => p.id === PERIOD)!.status).toBe('closed');
	});

	it('does not claim to apply a percentage to something that is not an Allowance', async () => {
		await runClose();
		await db.cfoSendBack('pr-11', 'defer 50% of it');
		vi.advanceTimersByTime(4500);
		expect(proposal('pr-11').status).toBe('rejected');
		expect(messages('pr-11').at(-1)!.body).toContain('a percentage only means something to me for the Allowance, and this is a revenue schedule');
	});

	it('will not overwrite an amount that comes from bank lines', async () => {
		await runClose();
		await db.cfoSendBack('pr-10', 'make it $10,000');
		vi.advanceTimersByTime(4500);
		expect(proposal('pr-10').status).toBe('rejected');
		expect(messages('pr-10').at(-1)!.body).toContain('the amount comes from bank lines');
	});
});

describe('Cafoo Ltd', () => {
	it('has its customers, contracts and an open receivable that agree with the pound ledger', () => {
		const uk = db.subsidiaries().find((s) => s.code === 'UK')!;
		const customers = db.customers().filter((c) => c.subsidiaryId === uk.id);
		expect(customers.map((c) => c.name).sort()).toEqual(['Harrowgate Joinery', 'Larkspur Bakery', 'Pembroke Dental Care']);
		const ids = new Set(customers.map((c) => c.id));
		// ARR is the monthly fee x 12; September's fees are the £19,200 the ledger recognised.
		expect(db.contracts().filter((k) => ids.has(k.customerId)).map((k) => BigInt(k.arrMinor) / 12n)).toEqual([900000n, 610000n, 410000n]);
		const sep = db.invoices().filter((i) => ids.has(i.customerId) && i.issuedAt.startsWith(PERIOD));
		expect(sep.reduce((s, i) => s + BigInt(i.amountMinor), 0n)).toBe(1920000n);

		// Receivables on the invoices equal 1100-UK on the ledger.
		const open = db.invoices().filter((i) => ids.has(i.customerId) && i.status !== 'paid').reduce((s, i) => s + BigInt(i.amountMinor), 0n);
		const ar = db.journalLines().filter((l) => l.accountId === 'acc-1100-UK').reduce((s, l) => s + BigInt(l.debitMinor) - BigInt(l.creditMinor), 0n);
		expect(open).toBe(410000n);
		expect(ar).toBe(open);
	});
});
