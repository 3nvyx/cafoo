import { describe, expect, it } from 'vitest';
import type { BankTransaction } from './data/types';
import { bankHints, exactHintCount, type BankHintBooks } from './bank-hints';

const books: BankHintBooks = {
	subsidiaries: [
		{ id: 's-us', code: 'US', name: 'Cafoo Inc', baseCurrency: 'USD', isElimination: false },
		{ id: 's-uk', code: 'UK', name: 'Cafoo Ltd', baseCurrency: 'GBP', parentId: 's-us', isElimination: false }
	],
	customers: [
		{ id: 'c1', name: 'Foxglove Catering', domain: 'f.example', guarantorPersonaId: 'p', guarantorName: 'G', paymentTermsDays: 30 },
		{ id: 'c2', name: 'Harbor Yoga Studio', domain: 'h.example', guarantorPersonaId: 'p', guarantorName: 'G', paymentTermsDays: 30 },
		{ id: 'c3', name: 'Larkspur Bakery', subsidiaryId: 's-uk', domain: 'l.example', guarantorPersonaId: 'p', guarantorName: 'G', paymentTermsDays: 30 }
	],
	vendors: [{ id: 'v1', name: 'Apex Kinetic Supplies', category: 'ops', verification: 'verified' }],
	invoices: [
		{ id: 'i1', number: 'INV-1058', customerId: 'c1', issuedAt: '2026-09-01T00:00:00Z', dueAt: '2026-10-01T00:00:00Z', amountMinor: '250000', status: 'open' },
		{ id: 'i2', number: 'INV-1047', customerId: 'c2', issuedAt: '2026-09-01T00:00:00Z', dueAt: '2026-09-16T00:00:00Z', amountMinor: '60000', status: 'open' },
		{ id: 'i3', number: 'INV-1043', customerId: 'c1', issuedAt: '2026-08-01T00:00:00Z', dueAt: '2026-09-15T00:00:00Z', amountMinor: '250000', status: 'paid' },
		{ id: 'i4', number: 'UK-2009', customerId: 'c3', issuedAt: '2026-09-01T00:00:00Z', dueAt: '2026-09-15T00:00:00Z', amountMinor: '410000', status: 'open' }
	],
	bills: [{ id: 'b1', number: 'AKS-0902', vendorId: 'v1', issuedAt: '2026-09-02T00:00:00Z', dueAt: '2026-10-02T00:00:00Z', amountMinor: '397500', status: 'open' }]
};

const line = (id: string, amountMinor: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
	id, subsidiaryId: 's-us', ym: '2026-09', bookedAt: '2026-09-15T00:00:00Z', amountMinor, ccy: 'USD', description: 'DEPOSIT', counterparty: 'Someone', matched: false, ...over
});

describe('bankHints', () => {
	it('finds the open invoice for the exact amount and explains why it was not matched', () => {
		const hints = bankHints([line('bt12', '250000', { description: 'DEPOSIT FOXGLOVE CAT LLC', counterparty: 'Foxglove Catering' })], books);
		const h = hints.get('bt12');
		expect(h).toMatchObject({ kind: 'invoice', number: 'INV-1058', counterparty: 'Foxglove Catering', exact: true });
		expect(h?.why).toMatch(/not auto-matched/i);
		expect(h?.why).toMatch(/due date/);
	});

	it('never offers a paid invoice, and the paid twin is skipped', () => {
		const h = bankHints([line('x', '250000', { counterparty: 'Foxglove Catering' })], books).get('x');
		expect(h?.number).toBe('INV-1058');
	});

	it('matches outflows to bills, not invoices', () => {
		const h = bankHints([line('bt20', '-397500', { counterparty: 'Apex Kinetic Supplies' })], books).get('bt20');
		expect(h).toMatchObject({ kind: 'bill', number: 'AKS-0902', exact: true });
		expect(bankHints([line('y', '-250000')], books).has('y')).toBe(false);
	});

	it('requires the same currency', () => {
		expect(bankHints([line('uk', '410000', { ccy: 'USD' })], books).has('uk')).toBe(false);
		expect(bankHints([line('uk', '410000', { ccy: 'GBP' })], books).get('uk')?.number).toBe('UK-2009');
	});

	it('picks the better-named candidate when two invoices share an amount', () => {
		const twin = { ...books, invoices: [...books.invoices, { id: 'i9', number: 'INV-9999', customerId: 'c2', issuedAt: '2026-09-01T00:00:00Z', dueAt: '2026-09-16T00:00:00Z', amountMinor: '250000', status: 'open' as const }] };
		expect(bankHints([line('t', '250000', { counterparty: 'Harbor Yoga Studio' })], twin).get('t')?.number).toBe('INV-9999');
	});

	it('leaves out lines with no candidate and counts the exact ones', () => {
		const hints = bankHints([line('a', '60000', { counterparty: 'Harbor Yoga Studio' }), line('fee', '-8400', { counterparty: 'Bank' })], books);
		expect(hints.has('fee')).toBe(false);
		expect(exactHintCount(hints)).toBe(1);
	});
});
