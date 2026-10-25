import { describe, expect, it } from 'vitest';
import type { Proposal } from '../types';
import { dollarsIn, percentsIn, reviseForNote, type SendBackContext } from './send-back';

const ctx: SendBackContext = {
	openReceivable: (id) => ({ c06: 450000n, c14: 920000n, c15: 100000n })[id] ?? 0n,
	customerName: (id) => id,
	materiality: 1000000n
};

const allowance = (): Proposal => ({
	id: 'pr-13',
	periodId: '2026-09',
	kind: 'journal_entry',
	proposerRole: 'credit',
	status: 'awaiting_cfo',
	amountMinor: '1127500',
	createdAt: '2026-10-02T11:00:00Z',
	summaryPlain: 'Set aside $11,275.',
	rationale: 'Tier migration.',
	payloadJson: JSON.stringify({
		tiers: { c06: 'D', c14: 'D', c15: 'BLOCK' },
		ratesBp: { D: 7500, BLOCK: 10000 },
		memo: 'Allowance for credit losses, September',
		lines: [
			{ account: '6500', debitMinor: '1127500', creditMinor: '0' },
			{ account: '1150', debitMinor: '0', creditMinor: '337500', customerId: 'c06' },
			{ account: '1150', debitMinor: '0', creditMinor: '690000', customerId: 'c14' },
			{ account: '1150', debitMinor: '0', creditMinor: '100000', customerId: 'c15' }
		]
	})
});

const accrual = (): Proposal => ({
	...allowance(),
	id: 'pr-12',
	kind: 'accrual',
	amountMinor: '295000',
	rationale: 'Timesheets show 59 hours.',
	payloadJson: JSON.stringify({ memo: 'Support hours', lines: [{ account: '5100', debitMinor: '295000', creditMinor: '0' }, { account: '2100', debitMinor: '0', creditMinor: '295000', vendorId: 'v02' }] })
});

const revised = (p: Proposal, note: string) => {
	const r = reviseForNote(p, note, ctx);
	if (!r.ok) throw new Error(r.reason);
	return r.revision;
};
const declined = (p: Proposal, note: string) => {
	const r = reviseForNote(p, note, ctx);
	if (r.ok) throw new Error('expected the note to be declined');
	return r.reason;
};
const creditsOf = (payloadJson: unknown) => (payloadJson as { lines: { account: string; creditMinor: string; customerId?: string }[] }).lines.filter((l) => l.account === '1150').map((l) => [l.customerId, l.creditMinor]);

describe('reading the note', () => {
	it('tells what the note asks for from what it rejects', () => {
		expect(percentsIn('reserve 50% not 75%')).toEqual([{ value: 5000n, rejected: false }, { value: 7500n, rejected: true }]);
		expect(percentsIn('use 37.5 percent')).toEqual([{ value: 3750n, rejected: false }]);
		expect(dollarsIn('it should be $2,000, not $2,950.50')).toEqual([{ value: 200000n, rejected: false }, { value: 295050n, rejected: true }]);
		expect(dollarsIn('make it $10k')).toEqual([{ value: 1000000n, rejected: false }]);
	});
});

describe('an Allowance note with a percentage', () => {
	it('recomputes the reserve at the new rate and leaves the full reserve alone', () => {
		const r = revised(allowance(), 'reserve 50% not 75%');
		expect(r.amountMinor).toBe('785000');
		expect(creditsOf(r.payload)).toEqual([['c06', '225000'], ['c14', '460000'], ['c15', '100000']]);
		expect(r.payload.ratesBp).toEqual({ D: 5000, BLOCK: 10000 });
		for (const text of [r.summaryPlain, r.rationale, r.body]) expect(text).toMatch(/\$7,850\.00/);
		expect(r.rationale).toContain('$11,275.00');
		expect(r.critique.body).toContain('$3,425.00 less');
	});

	it('takes the rate from the words around it, not the first number', () => {
		expect(revised(allowance(), '75% is too high, use 50%').amountMinor).toBe('785000');
	});

	it('moves only the reserves at the rate the note names', () => {
		expect(revised(allowance(), 'cut the 100% reserve to 80%').amountMinor).toBe('1107500');
	});

	it('declines when it cannot tell the rate, or the rate makes no sense', () => {
		expect(declined(allowance(), 'somewhere between 40% and 60%')).toMatch(/more than one rate/);
		expect(declined(allowance(), 'not 75%')).toMatch(/only says which rate not to use/);
		expect(declined(allowance(), 'reserve 120%')).toMatch(/more than the whole balance/);
		expect(declined(allowance(), 'reserve 0%')).toMatch(/remove the reserve/);
		expect(declined(allowance(), 'keep 75% for tier D')).toMatch(/already at 75%/);
	});
});

describe('a note with a dollar amount', () => {
	it('scales a plain entry to the amount and keeps it balanced', () => {
		const r = revised(accrual(), 'it should be $2,000, not $2,950');
		expect(r.amountMinor).toBe('200000');
		const lines = (r.payload.lines as { debitMinor: string; creditMinor: string; vendorId?: string }[]);
		expect(lines.map((l) => [l.debitMinor, l.creditMinor, l.vendorId])).toEqual([['200000', '0', undefined], ['0', '200000', 'v02']]);
		expect(r.critique.body).toContain('cannot tie it to the source documents');
	});

	it('scales an Allowance to the amount when no rate is given', () => {
		const r = revised(allowance(), 'set aside $9,000');
		expect(r.amountMinor).toBe('900000');
		const lines = r.payload.lines as { debitMinor: string; creditMinor: string }[];
		expect(lines.reduce((s, l) => s + BigInt(l.debitMinor), 0n)).toBe(900000n);
		expect(lines.reduce((s, l) => s + BigInt(l.creditMinor), 0n)).toBe(900000n);
	});

	it('declines amounts that come from evidence', () => {
		expect(declined({ ...accrual(), kind: 'revenue_schedule' }, 'make it $1,000')).toMatch(/comes from its evidence/);
		expect(declined({ ...accrual(), payloadJson: JSON.stringify({ bankTransactionId: 'bt1', lines: [{ account: '1000', debitMinor: '5', creditMinor: '0' }, { account: '1100', debitMinor: '0', creditMinor: '5' }] }) }, '$1')).toMatch(/bank lines/);
		expect(declined(accrual(), 'make it $2,950')).toMatch(/already proposed/);
	});
});

describe('a note with no number', () => {
	it('is declined, never reported as addressed', () => {
		const why = declined(allowance(), 'Please take another look, this seems high');
		expect(why).toMatch(/no percentage or dollar amount/);
		expect(why).not.toMatch(/addressed/i);
		expect(declined({ ...allowance(), payloadJson: JSON.stringify({ customerId: 'c06' }) }, 'cut it to 50%')).toMatch(/no journal lines/);
	});
});
