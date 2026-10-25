import { describe, expect, it } from 'vitest';
import { loadSeed, type Tables } from '../seed';
import type { DocumentKind, UploadedDocument } from '../../types';
import { fullyDilutedShares } from '../../../financing';
import { handlers, tickers } from './financing';
import type { ArrayTable, MockContext, ProposeInput, RowOf } from './types';

/**
 * A minimal mock engine: every Proposal is approved at once, its lines posted and its onApproved run. With `hold` on,
 * Proposals wait for the CFO until `approve(id)`.
 */
function engine() {
	const t: Tables = loadSeed();
	t.period.push({ id: '2026-10', subsidiaryId: 'sub-us', year: 2026, month: 10, status: 'open' });
	let n = 0;
	let clock = '2026-10-02T11:00:00Z';
	const proposals: ProposeInput[] = [];
	let hold = false;
	const waiting = new Map<string, ProposeInput>();
	const post = (id: string, p: ProposeInput) => {
		const row = t.proposal.find((x) => x.id === id)!;
		row.status = 'approved';
		if (p.payload.lines?.length) {
			const jeId = `je-${id}`;
			t.journal_entry.push({ id: jeId, periodId: '2026-10', postedAt: clock, memo: p.payload.memo ?? '', source: 'agent', proposalId: id, postedByRole: 'advisor' });
			p.payload.lines.forEach((l, i) => t.journal_line.push({ id: `${jeId}-l${i}`, jeId, accountId: `acc-${l.account}`, debitMinor: l.debitMinor, creditMinor: l.creditMinor }));
		}
		p.onApproved?.(ctx, row);
	};
	const ctx: MockContext = {
		t,
		now: () => clock,
		id: (p) => `${p}-${++n}`,
		insert<K extends ArrayTable>(table: K, row: RowOf<K>) {
			(t[table] as RowOf<K>[]).push(row);
			return row;
		},
		update: () => {},
		message: () => {},
		activity: () => {},
		later: (_ms, fn) => fn(),
		openPeriodId: () => '2026-10',
		synced: () => {},
		propose(p) {
			const id = `pr-${++n}`;
			proposals.push(p);
			t.proposal.push({ id, periodId: p.periodId ?? '2026-10', kind: p.kind, payloadJson: JSON.stringify(p.payload), rationale: p.rationale, summaryPlain: p.summaryPlain, amountMinor: p.amountMinor, proposerRole: p.proposerRole, status: 'awaiting_cfo', createdAt: clock });
			if (hold) waiting.set(id, p);
			else post(id, p);
			return id;
		}
	};
	const upload = (kind: DocumentKind) => {
		const h = handlers.find((x) => x.kind === kind)!;
		const r = h.read(ctx);
		const doc: UploadedDocument = { id: ctx.id('doc'), kind, fileName: h.fileName, sizeBytes: h.sizeBytes, uploadedAt: ctx.now(), status: 'parsed', extractedJson: JSON.stringify(r.extracted), summaryPlain: r.summaryPlain, flagsPlain: r.flagsPlain ?? [], readByRole: h.readByRole, proposalIds: [], subsidiaryId: 'sub-us' };
		t.document.push(doc);
		return { reading: r, ids: h.apply(ctx, doc) };
	};
	const bal = (code: string) => t.journal_line.filter((l) => l.accountId === `acc-${code}`).reduce((s, l) => s + BigInt(l.creditMinor) - BigInt(l.debitMinor), 0n);
	const approve = (id: string) => {
		const p = waiting.get(id)!;
		waiting.delete(id);
		post(id, p);
	};
	return { t, ctx, upload, bal, proposals, approve, setNow: (iso: string) => (clock = iso), setHold: (on: boolean) => (hold = on) };
}

describe('financing seed', () => {
	const t = loadSeed();
	it('has a closed pre-seed that ties to the equity already in the books', () => {
		const pre = t.instrument.filter((i) => i.roundId === 'rd-preseed-2025');
		expect(pre.every((i) => i.status === 'converted' && i.classification === 'equity')).toBe(true);
		const paid = t.cap_table_entry.filter((e) => e.security === 'common').reduce((s, e) => s + BigInt(e.investedMinor), 0n);
		const equity = t.journal_line.filter((l) => l.accountId === 'acc-3000').reduce((s, l) => s + BigInt(l.creditMinor) - BigInt(l.debitMinor), 0n);
		expect(paid).toBe(equity);
	});
	it('has a Seed 2026 of four SAFEs worth $2M and a $1M note against a $3M target', () => {
		const seed = t.instrument.filter((i) => i.roundId === 'rd-seed-2026');
		expect(seed.filter((i) => i.kind === 'safe_post_money').reduce((s, i) => s + BigInt(i.principalMinor), 0n)).toBe(200_000_000n);
		expect(seed.filter((i) => i.kind === 'convertible_note').map((i) => [i.principalMinor, i.interestBp])).toEqual([['100000000', 600]]);
		expect(t.funding_round.find((r) => r.id === 'rd-seed-2026')?.targetMinor).toBe('300000000');
	});
	it('links founders and option holders to real employees, and adds up to 12.5M fully diluted', () => {
		const ids = new Set(t.employee.map((e) => e.id));
		for (const e of t.cap_table_entry.filter((x) => x.employeeId)) {
			expect(ids.has(e.employeeId!), e.id).toBe(true);
			const emp = t.employee.find((x) => x.id === e.employeeId)!;
			expect(emp.name).toBe(e.holderName);
			if (e.security === 'options_granted') expect(emp.optionsGranted).toBe(e.shares);
		}
		expect(fullyDilutedShares(t.cap_table_entry)).toBe(12_500_000n);
	});
});

describe('the Seed 2026 demo, upload by upload', () => {
	const e = engine();
	const balanced = () => {
		for (const je of e.t.journal_entry.filter((x) => x.id.startsWith('je-pr-'))) {
			const lines = e.t.journal_line.filter((l) => l.jeId === je.id);
			expect(lines.reduce((s, l) => s + BigInt(l.debitMinor) - BigInt(l.creditMinor), 0n), je.id).toBe(0n);
		}
	};

	it('records the first close: the short wire, the note and the pounds into Cafoo Ltd', () => {
		const { ids, reading } = e.upload('closing_tracker');
		expect(ids).toHaveLength(4);
		expect(reading.flagsPlain?.length).toBeGreaterThan(0);
		expect(e.bal('2600')).toBe(120_000_000n);
		expect(e.bal('2650')).toBe(100_000_000n);
		expect(-e.bal('1060')).toBe(3_500n);
		expect(e.t.commitment.find((c) => c.id === 'cm-harrow')).toMatchObject({ status: 'short', receivedMinor: '99996500' });
		expect(e.t.commitment.find((c) => c.id === 'cm-fenwick')).toMatchObject({ status: 'funded', receivedMinor: '15625000' });
		expect(e.upload('closing_tracker').ids).toHaveLength(0);
		balanced();
	});

	it('matches the SPV wire and learns its name', () => {
		const { ids, reading } = e.upload('wire_confirmation');
		expect(ids).toHaveLength(1);
		expect(reading.flagsPlain?.[0]).toMatch(/TWA SERIES 14 LLC/);
		expect(e.t.investor.find((i) => i.id === 'inv-tidewater')?.payerNames).toContain('TWA SERIES 14 LLC');
		expect(e.bal('2600')).toBe(175_000_000n);
	});

	it('records the SAFE, its counsel fees, the note and a month of interest', () => {
		expect(e.upload('safe').ids).toHaveLength(2);
		expect(e.t.instrument.find((i) => i.id === 'ins-fenwick')?.signedAt).toBeTruthy();
		const note = e.upload('convertible_note');
		expect(note.ids).toHaveLength(2);
		// interest to the day it is booked: funded Oct 1, booked Oct 2, so two days, $328.77
		expect(-e.bal('7200')).toBe(32_877n);
		expect(e.bal('2660')).toBe(32_877n);
	});

	it('keeps the MFN as a flag, not a discount', () => {
		e.upload('side_letter');
		const b = e.t.instrument.find((i) => i.id === 'ins-brightwater')!;
		expect(b.mfn).toBe(true);
		expect(b.discountBp).toBeUndefined();
	});

	it('restates the SAFEs on the books to the valuer’s fair value', () => {
		e.upload('valuation_report');
		expect(e.bal('2600')).toBe((175_000_000n * 10_620n) / 10_000n);
		expect(-e.bal('7300')).toBe(10_850_000n);
	});

	it('adds the missing grant from the pool without changing fully diluted', () => {
		const before = fullyDilutedShares(e.t.cap_table_entry);
		e.upload('cap_table');
		expect(fullyDilutedShares(e.t.cap_table_entry)).toBe(before);
		expect(e.t.cap_table_entry.find((x) => x.employeeId === 'emp-08')?.shares).toBe(25_000);
	});

	it('converts every funded SAFE and the note into Series A preferred, clearing the liabilities', () => {
		const { ids } = e.upload('term_sheet');
		expect(ids).toHaveLength(1);
		expect(e.t.funding_round.find((r) => r.id === 'rd-series-a-2026')).toMatchObject({ status: 'planned', preMoneyMinor: '6000000000' });
		expect(e.bal('2600')).toBe(0n);
		expect(e.bal('2650')).toBe(0n);
		expect(e.bal('2660')).toBe(0n);
		// no estimates booked: no legal-fee accrual, no interest beyond today
		expect(e.bal('3310')).toBe(0n);
		expect(-e.bal('7200')).toBe(32_877n);
		const converted = e.t.instrument.filter((i) => i.status === 'converted' && i.roundId === 'rd-seed-2026');
		expect(converted.map((i) => i.id).sort()).toEqual(['ins-fenwick', 'ins-harrow', 'ins-orrin', 'ins-tidewater']);
		expect(converted.every((i) => i.classification === 'equity' && (i.shares ?? 0) > 0)).toBe(true);
		expect(e.t.cap_table_entry.filter((x) => x.security === 'safe' || x.security === 'note')).toHaveLength(0);
		// raising money never touched revenue
		const ours = new Set(e.t.journal_entry.filter((x) => x.id.startsWith('je-pr-')).map((x) => x.id));
		expect(e.t.journal_line.some((l) => ours.has(l.jeId) && l.accountId.startsWith('acc-4'))).toBe(false);
		balanced();
	});

	it('only moves statuses and notes from the live tracker', () => {
		const lines = e.t.journal_line.length;
		for (let i = 0; i < 8; i++) tickers[0].tick(e.ctx);
		expect(e.t.journal_line.length).toBe(lines);
	});
});

describe('review fixes', () => {
	it('raises one conversion per round, sized from the instruments, even when the term sheet is uploaded twice', () => {
		const e = engine();
		e.upload('closing_tracker');
		e.upload('valuation_report');
		expect(e.upload('term_sheet').ids).toHaveLength(1);
		expect(e.bal('2600')).toBe(0n);
		// Tidewater's money lands after the conversion, then the term sheet comes in again
		e.upload('wire_confirmation');
		expect(e.bal('2600')).toBe(55_000_000n);
		expect(e.upload('term_sheet').ids).toHaveLength(0);
		expect(e.t.proposal.filter((p) => p.kind === 'instrument_conversion')).toHaveLength(1);
		expect(e.bal('2600')).toBe(55_000_000n);
		expect(e.bal('3310')).toBe(0n);
		expect(e.t.instrument.find((i) => i.id === 'ins-tidewater')?.status).toBe('outstanding');
	});

	it('restates each SAFE to fair value once, however often the report is uploaded', () => {
		const e = engine();
		e.upload('closing_tracker');
		e.upload('valuation_report');
		e.upload('wire_confirmation');
		e.upload('valuation_report');
		e.upload('valuation_report');
		expect(-e.bal('7300')).toBe((175_000_000n * 620n) / 10_000n);
	});

	it('accrues note interest only up to the day it is booked, and picks up where it stopped', () => {
		const e = engine();
		e.upload('closing_tracker');
		e.upload('convertible_note');
		expect(e.bal('2660')).toBe(32_877n);
		expect(e.upload('convertible_note').ids).toHaveLength(0); // same day again: nothing new to book
		e.setNow('2026-10-20T09:00:00Z');
		e.upload('convertible_note');
		// Oct 3 to Oct 21 is 18 more days: $2,958.90
		expect(e.bal('2660')).toBe(32_877n + 295_890n);
		// converting on Oct 25 books Oct 21..25 (5 days, $821.92) as interest, nothing up to the Dec 15 close
		e.setNow('2026-10-25T09:00:00Z');
		const before = -e.bal('7200');
		e.upload('term_sheet');
		expect(-e.bal('7200') - before).toBe(82_192n);
		expect(e.bal('2660')).toBe(0n);
		expect(e.bal('3310')).toBe(0n);
		expect(e.t.proposal.find((p) => p.kind === 'instrument_conversion')?.summaryPlain).toMatch(/December 15 close/);
	});

	it('keeps the live tracker’s progress in the tables, so a fresh seed starts from the first move', () => {
		const a = engine();
		tickers[0].tick(a.ctx);
		expect(a.t.commitment.find((c) => c.id === 'cm-fenwick')?.status).toBe('signed');
		const b = engine();
		tickers[0].tick(b.ctx);
		expect(b.t.commitment.find((c) => c.id === 'cm-fenwick')?.status).toBe('signed');
		for (let i = 0; i < 10; i++) tickers[0].tick(b.ctx);
		expect(b.t.commitment.find((c) => c.id === 'cm-tidewater')?.notePlain).toMatch(/TWA Series 14/);
	});
});

describe('nothing books twice around a pending conversion', () => {
	const conversionId = (e: ReturnType<typeof engine>) => e.t.proposal.find((p) => p.kind === 'instrument_conversion')!.id;
	const accruals = (e: ReturnType<typeof engine>) => e.t.proposal.filter((p) => p.kind === 'interest_accrual');

	it('note re-uploaded while the conversion waits: no second accrual, interest booked once', () => {
		const e = engine();
		e.upload('closing_tracker');
		e.upload('convertible_note'); // Oct 1..3 booked
		e.setHold(true);
		e.setNow('2026-10-20T09:00:00Z');
		e.upload('term_sheet'); // carries Oct 3..21 to 7200
		const reading = e.upload('convertible_note');
		expect(reading.ids).toHaveLength(0);
		expect(reading.reading.summaryPlain).toMatch(/conversion is waiting; interest is included/);
		expect(accruals(e)).toHaveLength(1);
		e.approve(conversionId(e));
		expect(e.bal('2660')).toBe(0n);
		// Oct 1 to Oct 21 at 6% on $1M, exactly once: 20 days
		expect(-e.bal('7200')).toBe(328_767n);
	});

	it('accrual still in debate when the term sheet arrives: the conversion waits for it', () => {
		const e = engine();
		e.upload('closing_tracker');
		e.setHold(true);
		e.upload('convertible_note');
		const pending = accruals(e)[0];
		expect(e.upload('term_sheet').ids).toHaveLength(0);
		e.approve(pending.id);
		e.setHold(false);
		expect(e.upload('term_sheet').ids).toHaveLength(1);
		expect(e.bal('2660')).toBe(0n);
	});

	it('valuation report uploaded while the conversion waits: the converting SAFEs are not restated', () => {
		const e = engine();
		e.upload('closing_tracker');
		e.setHold(true);
		e.upload('term_sheet');
		const reading = e.upload('valuation_report');
		expect(reading.ids).toHaveLength(0);
		expect(reading.reading.summaryPlain).toMatch(/conversion that is waiting/);
		e.approve(conversionId(e));
		expect(e.bal('2600')).toBe(0n);
		expect(e.bal('7300')).toBe(0n);
		// a SAFE funded after the conversion can still be restated
		e.setHold(false);
		e.upload('wire_confirmation');
		expect(e.upload('valuation_report').ids).toHaveLength(1);
		expect(e.bal('2600')).toBe(55_000_000n + 3_410_000n);
	});

	it('restatement still in debate when the term sheet arrives: the conversion waits for it', () => {
		const e = engine();
		e.upload('closing_tracker');
		e.setHold(true);
		e.upload('valuation_report');
		const fv = e.t.proposal.find((p) => p.kind === 'journal_entry' && p.payloadJson.includes('adjustments'))!;
		expect(e.upload('term_sheet').ids).toHaveLength(0);
		e.approve(fv.id);
		e.setHold(false);
		expect(e.upload('term_sheet').ids).toHaveLength(1);
		expect(e.bal('2600')).toBe(0n);
		expect(-e.bal('7300')).toBe(7_440_000n);
	});
});
