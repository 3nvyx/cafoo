import { describe, expect, it } from 'vitest';
import type { Proposal, UploadedDocument } from '../../types';
import { loadSeed } from '../seed';
import { handlers, tickers } from './costs';
import type { MockContext, ProposeInput } from './types';

/** A bare context over the seed: records Proposals instead of running the Advisor. */
function fakeCtx(opts: { now: string; open?: string }) {
	const t = loadSeed();
	const raised: ProposeInput[] = [];
	let n = 0;
	const ctx: MockContext = {
		t,
		now: () => opts.now,
		id: (prefix) => `${prefix}-${++n}`,
		insert: (table, row) => {
			(t[table] as unknown[]).push(row);
			return row;
		},
		update: () => {},
		message: () => {},
		activity: () => {},
		propose: (p) => {
			if (!opts.open && !p.periodId) throw new Error('Every month is locked.');
			raised.push(p);
			const id = `pr-${++n}`;
			t.proposal.push({ id, periodId: p.periodId ?? opts.open!, kind: p.kind, payloadJson: JSON.stringify(p.payload), rationale: p.rationale, summaryPlain: p.summaryPlain, amountMinor: p.amountMinor, proposerRole: p.proposerRole, status: 'open', createdAt: opts.now } as Proposal);
			return id;
		},
		later: () => {},
		openPeriodId: () => opts.open,
		synced: () => {}
	};
	return { ctx, raised };
}

const expiry = tickers.find((x) => x.name === 'batch-expiry')!;

describe('expiry watch', () => {
	it('raises each lapsed pack and lot once, into the open month, never the month it lapsed in', () => {
		const { ctx, raised } = fakeCtx({ now: '2026-10-02T11:00:30Z', open: '2026-10' });
		expiry.tick(ctx);
		expect(raised.map((p) => [p.kind, p.payload.batchId, p.periodId, p.amountMinor])).toEqual([
			['credit_breakage', 'bt-cp1', undefined, '102000'],
			['inventory_writeoff', 'bt-sl2', undefined, '42000']
		]);
		expiry.tick(ctx);
		expect(raised).toHaveLength(2);
	});

	it('picks up a pack that lapses during the demo', () => {
		const { ctx, raised } = fakeCtx({ now: '2026-10-02T11:02:05Z', open: '2026-10' });
		expiry.tick(ctx);
		expect(raised.map((p) => p.payload.batchId)).toContain('bt-cp3');
		expect(ctx.t.batch.find((b) => b.id === 'bt-cp3')!.status).toBe('expired');
	});

	it('waits while every month is locked', () => {
		const { ctx, raised } = fakeCtx({ now: '2026-10-02T11:00:30Z' });
		expiry.tick(ctx);
		expect(raised).toEqual([]);
	});
});

describe('September uploads', () => {
	const doc = { id: 'doc-1' } as UploadedDocument;
	const cloudBill = handlers.find((h) => h.kind === 'cloud_bill')!;

	it('join the September close while September is open', () => {
		const { ctx, raised } = fakeCtx({ now: '2026-10-02T11:00:00Z', open: '2026-10' });
		cloudBill.apply(ctx, doc);
		expect(raised.every((p) => p.periodId === '2026-09')).toBe(true);
	});

	it('book into the open month once September is closing, and only once per file', () => {
		const { ctx, raised } = fakeCtx({ now: '2026-10-02T11:00:00Z', open: '2026-10' });
		ctx.t.period.find((p) => p.id === '2026-09')!.status = 'closing';
		cloudBill.apply(ctx, doc);
		const first = raised.length;
		expect(first).toBeGreaterThan(0);
		expect(raised.every((p) => p.periodId === undefined)).toBe(true);
		cloudBill.apply(ctx, doc);
		expect(raised).toHaveLength(first);
	});
});
