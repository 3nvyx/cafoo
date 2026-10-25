// Worked examples for the cap table tools, each computed by hand in the comments. Money is cents, prices are cents x
// 10^4 (so $2.00 a share is 2_000_000n), ownership is ppm. Shares are whole: conversions and new money round down,
// the pool top-up rounds up, prices round down to the E4 unit.
import { describe, expect, it } from 'vitest';
import { holdingsFromCapTable, modelRound, ownership, parseDollars, parsePercentPpm, poolTopUp, safesFromInstruments, sharePpm, type Holding } from './cap-table';
import type { CapTableEntry, Instrument } from './data/types';

const M$ = (n: number) => BigInt(n) * 1_000_000n * 100n; // millions of dollars in cents

// 10,000,000 fully diluted shares: two founders, options granted and a 1,000,000-share pool.
const base: Holding[] = [
	{ holder: 'Ada', class: 'common', shares: 6_000_000n },
	{ holder: 'Ben', class: 'common', shares: 2_500_000n },
	{ holder: 'Options granted to the team', class: 'options', shares: 500_000n },
	{ holder: 'Unallocated pool', class: 'pool', shares: 1_000_000n }
];

describe('ownership', () => {
	it('splits fully diluted shares by holder and by class', () => {
		const o = ownership(base);
		expect(o.total).toBe(10_000_000n);
		// 6.0M / 10M = 60%, 2.5M / 10M = 25%, 1M / 10M = 10%, 0.5M / 10M = 5%.
		expect(o.byHolder.map((h) => [h.key, h.ppm])).toEqual([
			['Ada', 600_000n],
			['Ben', 250_000n],
			['Unallocated pool', 100_000n],
			['Options granted to the team', 50_000n]
		]);
		expect(o.byClass.map((c) => [c.key, c.shares, c.ppm])).toEqual([
			['common', 8_500_000n, 850_000n],
			['options', 500_000n, 50_000n],
			['pool', 1_000_000n, 100_000n]
		]);
	});

	it('merges a holder across lines and rounds ppm down', () => {
		// 1 of 3 shares = 333,333.33 ppm, rounded down to 333,333.
		const o = ownership([
			{ holder: 'A', class: 'common', shares: 1n },
			{ holder: 'B', class: 'common', shares: 1n },
			{ holder: 'B', class: 'preferred', shares: 1n }
		]);
		expect(o.byHolder).toEqual([
			{ key: 'B', shares: 2n, ppm: 666_666n },
			{ key: 'A', shares: 1n, ppm: 333_333n }
		]);
		expect(sharePpm(1n, 0n)).toBe(0n);
	});

	it('handles an empty cap table', () => {
		expect(ownership([])).toEqual({ total: 0n, byHolder: [], byClass: [] });
	});

	it('reads holdings from cap table lines, leaving SAFEs and notes out', () => {
		const line = (holderName: string, security: CapTableEntry['security'], shares: number) => ({ holderName, security, shares });
		const h = holdingsFromCapTable([line('Ada', 'common', 10), line('Pool', 'option_pool', 5), line('Kim', 'options_granted', 2), line('Fund', 'safe', 0), line('Fund', 'note', 0), line('Seed fund', 'preferred', 3)]);
		expect(h).toEqual([
			{ holder: 'Ada', class: 'common', shares: 10n },
			{ holder: 'Unallocated pool', class: 'pool', shares: 5n },
			{ holder: 'Options granted to the team', class: 'options', shares: 2n },
			{ holder: 'Seed fund', class: 'preferred', shares: 3n }
		]);
	});
});

describe('modelRound: a plain priced round', () => {
	it('prices the round on the pre-money and issues new shares', () => {
		// $20M pre / 10,000,000 shares = $2.00 a share. $5M / $2.00 = 2,500,000 new shares. Post: 12,500,000.
		const r = modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), investor: 'Lead' });
		expect(r.priceE4).toBe(2_000_000n);
		expect(r.newShares).toBe(2_500_000n);
		expect(r.postShares).toBe(12_500_000n);
		expect(r.postMoneyMinor).toBe(M$(25));
		expect(r.poolIncrease).toBe(0n);
		// Ada: 6M / 12.5M = 48%. Lead: 2.5M / 12.5M = 20%.
		const by = Object.fromEntries(r.rows.map((x) => [x.holder, x]));
		expect(by.Ada.afterPpm).toBe(480_000n);
		expect(by.Ada.beforePpm).toBe(600_000n);
		expect(by.Lead.afterPpm).toBe(200_000n);
		expect(by.Lead.class).toBe('preferred');
		expect(r.byClass.find((c) => c.class === 'preferred')?.afterPpm).toBe(200_000n);
	});

	it('rounds the new shares down to whole shares', () => {
		// $20M pre / 3 shares = $6,666,666.666... a share = 666,666,666.67 cents, which is 6,666,666,666,666.67 E4,
		// rounded down to 6,666,666,666,666. $10M buys 1,000,000,000 x 10^4 / 6,666,666,666,666 = 1.50000000000002
		// shares, rounded down to 1.
		const r = modelRound({ holdings: [{ holder: 'A', class: 'common', shares: 3n }], preMoneyMinor: M$(20), newMoneyMinor: M$(10) });
		expect(r.priceE4).toBe(6_666_666_666_666n);
		expect(r.newShares).toBe(1n);
	});

	it('refuses inputs it cannot price', () => {
		expect(() => modelRound({ holdings: [], preMoneyMinor: M$(20), newMoneyMinor: M$(5) })).toThrow(/no shares/);
		expect(() => modelRound({ holdings: base, preMoneyMinor: 0n, newMoneyMinor: M$(5) })).toThrow(/pre-money/);
		expect(() => modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: -1n })).toThrow(/negative/);
		expect(() => modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), poolTargetPpm: 1_000_000n })).toThrow(/pool target/);
	});
});

describe('option pool top-up', () => {
	it('grows the pool before the money so it is the target share of the post-money', () => {
		// S = 10,000,000, pool P = 1,000,000, V = $20M, M = $5M, target t = 15%.
		// I = (t(V + M)S - PV) / (V - t(V + M)) = (0.15 x 25 x 10M - 1M x 20) / (20 - 0.15 x 25)
		//   = (37.5M - 20M) / 16.25 = 1,076,923.08, rounded up to 1,076,924.
		// Capitalization S + I (exact) = 11,076,923.08; price = $20M / 11,076,923.08 = $1.805555..., rounded down to
		// 1,805,555 E4. New shares = $5M / $1.805555 = 2,769,231.3, rounded down to 2,769,231.
		// Post = 10,000,000 + 1,076,924 + 2,769,231 = 13,846,155; pool = 2,076,924 / 13,846,155 = 15.0000%.
		const r = modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), poolTargetPpm: 150_000n });
		expect(r.poolIncrease).toBe(1_076_924n);
		expect(r.capitalization).toBe(11_076_923n);
		expect(r.priceE4).toBe(1_805_555n);
		expect(r.newShares).toBe(2_769_231n);
		expect(r.postShares).toBe(13_846_155n);
		const pool = r.rows.find((x) => x.class === 'pool')!;
		expect(pool.after).toBe(2_076_924n);
		expect(pool.afterPpm).toBe(150_000n);
		expect(poolTopUp({ preRoundShares: 10_000_000n, poolShares: 1_000_000n, preMoneyMinor: M$(20), newMoneyMinor: M$(5), targetPpm: 150_000n })).toBe(1_076_924n);
	});

	it('adds nothing when the pool is already big enough', () => {
		// The pool is 1M of 12.5M after the round without a top-up = 8%, above a 5% target.
		expect(poolTopUp({ preRoundShares: 10_000_000n, poolShares: 1_000_000n, preMoneyMinor: M$(20), newMoneyMinor: M$(5), targetPpm: 50_000n })).toBe(0n);
		const r = modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), poolTargetPpm: 50_000n });
		expect(r.priceE4).toBe(2_000_000n);
	});

	it('creates a pool when there is none', () => {
		// S = 10,000,000, P = 0, V = $20M, M = $5M, t = 10%: I = (0.1 x 25 x 10M) / (20 - 2.5) = 1,428,571.43 -> 1,428,572.
		expect(poolTopUp({ preRoundShares: 10_000_000n, poolShares: 0n, preMoneyMinor: M$(20), newMoneyMinor: M$(5), targetPpm: 100_000n })).toBe(1_428_572n);
	});
});

describe('SAFE conversion at a priced round', () => {
	it('a post-money SAFE at its cap owns purchase amount / cap of the capitalization', () => {
		// $1M SAFE, $10M post-money cap; V = $20M including the SAFE shares, M = $5M.
		// The SAFE takes $1M / $10M = 10% of C, so C = 10,000,000 / 0.9 = 11,111,111.11.
		// Cap price = $10M / C = $0.90 (900,000 E4); round price = $20M / C = $1.80 (1,800,000 E4).
		// SAFE shares = $1M / $0.90 = 1,111,111.1 -> 1,111,111. New shares = $5M / $1.80 = 2,777,777.8 -> 2,777,777.
		const r = modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), safes: [{ id: 's1', holder: 'Angel', kind: 'post_money', amountMinor: M$(1), capMinor: M$(10) }] });
		expect(r.priceE4).toBe(1_800_000n);
		const c = r.conversions[0];
		expect(c.capPriceE4).toBe(900_000n);
		expect(c.discountPriceE4).toBe(1_800_000n);
		expect(c.basis).toBe('cap');
		expect(c.shares).toBe(1_111_111n);
		expect(r.newShares).toBe(2_777_777n);
		expect(r.postShares).toBe(13_888_888n);
		// 1,111,111 of the 11,111,111 pre-money shares: 9.99999%, the cap's 10% less the share rounded away.
		expect(sharePpm(c.shares, r.capitalization + 0n)).toBe(99_999n);
	});

	it('a SAFE with only a discount converts at the discounted round price', () => {
		// $1M post-money SAFE, 20% discount, no cap; V = $20M, M = $5M. It takes $1M / ($20M x 0.8) = 6.25% of C,
		// so C = 10,000,000 / 0.9375 = 10,666,666.67. Round price = $20M / C = $1.875; discounted = $1.50.
		// SAFE shares = $1M / $1.50 = 666,666.67 -> 666,666. New shares = $5M / $1.875 = 2,666,666.67 -> 2,666,666.
		const r = modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), safes: [{ id: 's1', holder: 'Angel', kind: 'post_money', amountMinor: M$(1), discountBp: 2000 }] });
		expect(r.priceE4).toBe(1_875_000n);
		expect(r.conversions[0]).toMatchObject({ capPriceE4: undefined, discountPriceE4: 1_500_000n, priceE4: 1_500_000n, basis: 'discount', shares: 666_666n });
		expect(r.newShares).toBe(2_666_666n);
	});

	it('takes the discount when it beats the cap', () => {
		// Same as above with a $30M post-money cap: the cap price is $30M / 10,666,666.67 = $2.8125, above the
		// $1.50 discounted price, so the discount wins and the numbers match the discount-only SAFE.
		const r = modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), safes: [{ id: 's1', holder: 'Angel', kind: 'post_money', amountMinor: M$(1), capMinor: M$(30), discountBp: 2000 }] });
		expect(r.conversions[0]).toMatchObject({ capPriceE4: 2_812_500n, priceE4: 1_500_000n, basis: 'discount', shares: 666_666n });
	});

	it('a pre-money SAFE at its cap converts on the shares before the round only', () => {
		// $1M SAFE, $10M pre-money cap. Cap price = $10M / 10,000,000 = $1.00, so 1,000,000 shares whatever the round.
		// C = 10,000,000 + 1,000,000 = 11,000,000. Round price = $20M / 11M = $1.818181..., rounded down to
		// 1,818,181 E4. New shares = 5,000,000,000,000 / 1,818,181 = 2,750,001.2 (rounding the price down makes each
		// share a little cheaper, so the investor gets one more share than $5M / $1.8181818 = 2,750,000), down to 2,750,001.
		const r = modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), safes: [{ id: 's1', holder: 'Angel', kind: 'pre_money', amountMinor: M$(1), capMinor: M$(10) }] });
		expect(r.conversions[0]).toMatchObject({ capPriceE4: 1_000_000n, basis: 'cap', shares: 1_000_000n });
		expect(r.capitalization).toBe(11_000_000n);
		expect(r.priceE4).toBe(1_818_181n);
		expect(r.newShares).toBe(2_750_001n);
	});

	it('a pre-money SAFE flips to its discount when the cap is high', () => {
		// $1M pre-money SAFE, $30M cap, 20% discount. At the cap it would get $1M / $3.00 = 333,333 shares; at the
		// discount it takes 6.25% of C as in the discount example, $1.50 a share and 666,666 shares. The discount wins.
		const r = modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), safes: [{ id: 's1', holder: 'Angel', kind: 'pre_money', amountMinor: M$(1), capMinor: M$(30), discountBp: 2000 }] });
		expect(r.priceE4).toBe(1_875_000n);
		expect(r.conversions[0]).toMatchObject({ capPriceE4: 3_000_000n, priceE4: 1_500_000n, basis: 'discount', shares: 666_666n });
	});

	it('converts SAFEs and tops up the pool in the same round', () => {
		// $1M post-money SAFE at a $10M cap (10% of C) and a 15% post-money pool target, V = $20M, M = $5M.
		// Pool share of C = 0.15 x 25 / 20 = 18.75%. C = (10,000,000 - 1,000,000) / (1 - 0.1 - 0.1875) = 12,631,578.95.
		// I = 0.1875 x C - 1,000,000 = 1,368,421.05 -> 1,368,422. Price = $20M / C = $1.583333 (1,583,333 E4).
		// Cap price = $10M / C = $0.791666 (791,666 E4); SAFE shares = $1M / $0.791666 = 1,263,158.9 -> 1,263,158.
		// New shares = $5M / $1.583333 = 3,157,895.4 -> 3,157,895.
		const r = modelRound({
			holdings: base,
			preMoneyMinor: M$(20),
			newMoneyMinor: M$(5),
			poolTargetPpm: 150_000n,
			safes: [{ id: 's1', holder: 'Angel', kind: 'post_money', amountMinor: M$(1), capMinor: M$(10) }]
		});
		expect(r.capitalization).toBe(12_631_578n);
		expect(r.poolIncrease).toBe(1_368_422n);
		expect(r.priceE4).toBe(1_583_333n);
		expect(r.conversions[0].priceE4).toBe(791_666n);
		expect(r.conversions[0].shares).toBe(1_263_158n);
		expect(r.newShares).toBe(3_157_895n);
		expect(r.postShares).toBe(10_000_000n + 1_368_422n + 1_263_158n + 3_157_895n);
		expect(r.rows.find((x) => x.class === 'pool')!.afterPpm).toBeGreaterThanOrEqual(150_000n);
	});

	it('refuses SAFEs that would take the whole company', () => {
		expect(() => modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), safes: [{ id: 's1', holder: 'Angel', kind: 'post_money', amountMinor: M$(10), capMinor: M$(10) }] })).toThrow(/whole company/);
		expect(() => modelRound({ holdings: base, preMoneyMinor: M$(20), newMoneyMinor: M$(5), safes: [{ id: 's1', holder: 'Angel', kind: 'post_money', amountMinor: 0n }] })).toThrow(/purchase amount/);
	});

	it('reads outstanding SAFEs from the register', () => {
		const ins = (over: Partial<Instrument>): Instrument => ({
			id: 'i',
			roundId: 'r',
			investorId: 'inv',
			kind: 'safe_post_money',
			principalMinor: '100000000',
			ccy: 'USD',
			mfn: false,
			proRata: false,
			classification: 'liability',
			classificationPlain: '',
			status: 'outstanding',
			documentIds: [],
			...over
		});
		const s = safesFromInstruments(
			[ins({ id: 'a', valuationCapMinor: '1000000000', discountBp: 2000 }), ins({ id: 'b', kind: 'safe_pre_money' }), ins({ id: 'c', status: 'converted' }), ins({ id: 'd', kind: 'convertible_note' })],
			() => 'Angel'
		);
		expect(s).toEqual([
			{ id: 'a', holder: 'Angel', kind: 'post_money', amountMinor: 100_000_000n, capMinor: 1_000_000_000n, discountBp: 2000 },
			{ id: 'b', holder: 'Angel', kind: 'pre_money', amountMinor: 100_000_000n, capMinor: undefined, discountBp: undefined }
		]);
	});
});

describe('form parsing', () => {
	it('reads dollars as cents', () => {
		expect(parseDollars('12,000,000')).toBe(1_200_000_000n);
		expect(parseDollars('$1.5')).toBe(150n);
		expect(parseDollars('abc')).toBeNull();
		expect(parseDollars('1.234')).toBeNull();
	});
	it('reads percents as ppm', () => {
		expect(parsePercentPpm('15')).toBe(150_000n);
		expect(parsePercentPpm('12.5%')).toBe(125_000n);
		expect(parsePercentPpm('101')).toBeNull();
	});
});
