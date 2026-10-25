import { describe, expect, it } from 'vitest';
import type { CapTableEntry } from './data/types';
import {
	accruedInterestMinor,
	classify,
	conversionPriceE4,
	conversionShares,
	daysBetween,
	discountedPriceE4,
	formatPpm,
	formatPriceE4,
	fullyDilutedPpm,
	fullyDilutedShares,
	noteInterestMinor,
	parValueMinor,
	priceE4,
	pricedRound,
	rollForward,
	safeOwnershipPpm,
	toConvertible
} from './financing';

const M = (dollars: number) => BigInt(dollars) * 100n;

describe('days and note interest', () => {
	it('counts whole days, ignoring time of day', () => {
		expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
		expect(daysBetween('2026-10-01T23:00:00Z', '2026-12-15T01:00:00Z')).toBe(75);
		expect(daysBetween('2026-11-01', '2026-10-01')).toBe(-31);
	});
	it('accrues 6% simple interest, actual/365, to the cent', () => {
		// $1,000,000 x 6% x 31 / 365 = $5,095.890... -> $5,095.89
		expect(noteInterestMinor(M(1_000_000), 600, 31)).toBe(509_589n);
		expect(accruedInterestMinor(M(1_000_000), 600, '2026-10-01', '2026-12-15')).toBe(1_232_877n);
		// a full year is exactly the rate
		expect(noteInterestMinor(M(1_000_000), 600, 365)).toBe(M(60_000));
		expect(noteInterestMinor(M(1_000_000), 600, 0)).toBe(0n);
	});
});

describe('conversion prices', () => {
	it('gives a post-money SAFE its amount over the cap', () => {
		expect(safeOwnershipPpm(M(1_000_000), M(24_000_000))).toBe(41_666n);
		expect(safeOwnershipPpm(M(1_560_000), M(13_000_000))).toBe(120_000n);
	});
	it('converts at the lower of the cap price and the discounted price', () => {
		const round = priceE4(M(60_000_000), 14_000_000n); // $4.2857
		const disc = discountedPriceE4(round, 2000);
		const cap = priceE4(M(24_000_000), 14_000_000n); // $1.7142
		expect(formatPriceE4(round)).toBe('$4.2857');
		expect(conversionPriceE4(cap, disc)).toBe(cap);
		expect(conversionPriceE4(undefined, disc)).toBe(disc);
		// a high cap loses to the discount
		expect(conversionPriceE4(priceE4(M(80_000_000), 14_000_000n), disc)).toBe(disc);
	});
	it('rounds shares down', () => {
		expect(conversionShares(M(1_000), priceE4(M(3), 1n))).toBe(333n);
	});
});

describe('a priced round with SAFEs and a note converting', () => {
	const r = pricedRound({
		preRoundShares: 12_500_000n,
		preMoneyMinor: M(60_000_000),
		newMoneyMinor: M(12_000_000),
		convertibles: [
			{ id: 'safe', holderName: 'SAFEs', amountMinor: M(2_000_000), capMinor: M(24_000_000) },
			{ id: 'note', holderName: 'Note', amountMinor: M(1_000_000) + 1_232_877n, capMinor: M(24_000_000), discountBp: 2000 }
		]
	});
	it('puts the converting shares inside the pre-money', () => {
		// The convertibles take (2,000,000 + 1,012,328.77) / 24,000,000 = 12.55% of the pre-money capitalization.
		expect(r.capitalization).toBe(14_294_106n);
		expect(formatPriceE4(r.roundPriceE4)).toBe('$4.1975');
		// capitalization x price is the pre-money, within the price rounding (a millionth of a dollar a share)
		const implied = (r.capitalization * r.roundPriceE4) / 10_000n;
		expect(M(60_000_000) - implied).toBeLessThan(M(15));
	});
	it('converts both at the cap, since the cap beats a 20% discount here', () => {
		expect(r.rows.map((x) => x.basis)).toEqual(['cap', 'cap']);
		const safe = r.rows[0];
		// $2M at a $24M post-money cap is 8.33% of the pre-money capitalization
		expect(fullyDilutedPpm(safe.shares, r.capitalization)).toBe(83_333n);
		expect(r.postMoneyShares).toBe(12_500_000n + r.convertedShares + r.newMoneyShares);
		// new money buys 12/72 of the company
		expect(fullyDilutedPpm(r.newMoneyShares, r.postMoneyShares)).toBe(166_666n);
	});
	it('uses the discount when the round is priced below the cap', () => {
		const low = pricedRound({ preRoundShares: 10_000_000n, preMoneyMinor: M(20_000_000), newMoneyMinor: M(5_000_000), convertibles: [{ id: 'n', holderName: 'N', amountMinor: M(1_000_000), capMinor: M(24_000_000), discountBp: 2000 }] });
		expect(low.rows[0].basis).toBe('discount');
		expect(low.rows[0].priceE4).toBe(discountedPriceE4(low.roundPriceE4, 2000));
	});
	it('handles a round with nothing converting', () => {
		const plain = pricedRound({ preRoundShares: 10_000_000n, preMoneyMinor: M(40_000_000), newMoneyMinor: M(10_000_000), convertibles: [] });
		expect(plain.capitalization).toBe(10_000_000n);
		expect(formatPriceE4(plain.roundPriceE4)).toBe('$4.0000');
		expect(plain.newMoneyShares).toBe(2_500_000n);
	});
});

describe('cap table', () => {
	const row = (id: string, security: CapTableEntry['security'], shares: number, investorId?: string): CapTableEntry => ({ id, holderName: id, investorId, security, shares, investedMinor: '0', ccy: 'USD', asOf: '2026-10-02' });
	const table = [row('Founder', 'common', 8_000_000), row('Pool', 'option_pool', 850_000), row('Granted', 'options_granted', 1_150_000), row('Pre-seed', 'common', 2_500_000), row('Seed SAFE', 'safe', 0, 'inv-a')];
	it('counts fully diluted shares without unconverted SAFEs', () => {
		expect(fullyDilutedShares(table)).toBe(12_500_000n);
		expect(formatPpm(fullyDilutedPpm(8_000_000, 12_500_000n))).toBe('64.00%');
	});
	it('rolls SAFEs into preferred and adds the new investor', () => {
		const after = rollForward(table, [{ instrumentInvestorId: 'inv-a', holderName: 'Seed SAFE', shares: 600_000n }, { holderName: 'Unfunded SAFE', shares: 100_000n }], [{ holderName: 'Lead', shares: 2_000_000n, investedMinor: M(10_000_000) }], '2026-12-15');
		expect(after.find((e) => e.holderName === 'Seed SAFE')).toMatchObject({ security: 'preferred', shares: 600_000 });
		expect(after.filter((e) => e.security === 'safe')).toHaveLength(0);
		expect(fullyDilutedShares(after)).toBe(12_500_000n + 600_000n + 100_000n + 2_000_000n);
	});
	it('par value is a hundredth of a cent a share', () => {
		expect(parValueMinor(1_000_000n)).toBe(10_000n);
	});
	it('says plainly why each instrument sits where it does', () => {
		expect(classify('safe_post_money').classification).toBe('liability');
		expect(classify('convertible_note').plain).toMatch(/not income/);
		expect(classify('preferred_shares').classification).toBe('equity');
		expect(classify('safe_post_money', 'converted').classification).toBe('equity');
	});
	it('refuses to price a pre-money SAFE rather than treat it as post-money', () => {
		const pre = { id: 'x', roundId: 'r', investorId: 'i', kind: 'safe_pre_money', principalMinor: '100', ccy: 'USD', mfn: false, proRata: false, classification: 'liability', classificationPlain: '', status: 'outstanding', documentIds: [] } as const;
		expect(() => toConvertible({ ...pre, documentIds: [] }, 'X', undefined, '2026-12-15')).toThrow(/Pre-money SAFEs are not supported yet/);
	});
});
