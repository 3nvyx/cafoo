// Cap table tools: fully diluted ownership, round modeling, SAFE conversion and the option pool top-up. Pure and
// integer-only, like `financing.ts`. Money is minor units (cents) as bigint. A price per share is minor units times
// 10^4 (`E4`), so $1.80 a share is 1_800_000n. Ownership is parts per million (`ppm`, 1_000_000n is 100%).
//
// Rounding, stated once:
// - The pre-money capitalization (shares before new money, including the pool top-up and the SAFE conversion shares)
//   is solved exactly as a fraction. Prices are measured against that exact figure and rounded down to the E4 unit.
// - Shares are always whole shares. SAFE conversion shares and new-money shares round down (an investor never gets a
//   share they did not pay for in full). The pool top-up rounds up, so the pool reaches at least its target.
// - Ownership percentages round down to the ppm.
import type { CapTableEntry, Instrument, SecurityClass } from './data/types';

const BP = 10_000n;
const E4 = 10_000n;
const PPM = 1_000_000n;

export type HoldingClass = 'common' | 'preferred' | 'options' | 'pool' | 'warrant';

export const HOLDING_CLASS_LABEL: Record<HoldingClass, string> = {
	common: 'Common',
	preferred: 'Preferred',
	options: 'Options granted',
	pool: 'Unallocated pool',
	warrant: 'Warrants'
};

/** One holder's shares in one class, on a fully diluted basis. */
export interface Holding {
	holder: string;
	class: HoldingClass;
	shares: bigint;
}

// --- Exact fractions ---------------------------------------------------------------------------------------------

interface Frac {
	n: bigint;
	d: bigint;
}
const abs = (a: bigint) => (a < 0n ? -a : a);
const gcd = (a: bigint, b: bigint): bigint => {
	a = abs(a);
	b = abs(b);
	while (b) [a, b] = [b, a % b];
	return a || 1n;
};
const frac = (n: bigint, d: bigint = 1n): Frac => {
	if (d === 0n) throw new Error('Division by zero');
	if (d < 0n) [n, d] = [-n, -d];
	const g = gcd(n, d);
	return { n: n / g, d: d / g };
};
const add = (a: Frac, b: Frac) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Frac, b: Frac) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Frac, b: Frac) => frac(a.n * b.n, a.d * b.d);
const div = (a: Frac, b: Frac) => frac(a.n * b.d, a.d * b.n);
const cmp = (a: Frac, b: Frac) => {
	const x = a.n * b.d - b.n * a.d;
	return x > 0n ? 1 : x < 0n ? -1 : 0;
};
/** Floor for non-negative fractions, which is all this module uses. */
const floor = (a: Frac) => a.n / a.d;
const ceil = (a: Frac) => (a.n % a.d === 0n ? a.n / a.d : a.n / a.d + 1n);

// --- Ownership ---------------------------------------------------------------------------------------------------

export interface OwnershipLine<K extends string = string> {
	key: K;
	shares: bigint;
	/** Share of the fully diluted total, rounded down. */
	ppm: bigint;
}

export interface Ownership {
	total: bigint;
	byHolder: OwnershipLine[];
	byClass: OwnershipLine<HoldingClass>[];
}

const CLASS_ORDER: HoldingClass[] = ['common', 'preferred', 'options', 'pool', 'warrant'];

/** Share of a total in ppm, rounded down. Zero when the total is zero. */
export function sharePpm(shares: bigint, total: bigint): bigint {
	return total > 0n ? (shares * PPM) / total : 0n;
}

/** Fully diluted ownership by holder (largest first, ties by name) and by class (in a fixed class order). */
export function ownership(holdings: Holding[]): Ownership {
	const total = holdings.reduce((t, h) => t + h.shares, 0n);
	const holders = new Map<string, bigint>();
	const classes = new Map<HoldingClass, bigint>();
	for (const h of holdings) {
		if (h.shares === 0n) continue;
		holders.set(h.holder, (holders.get(h.holder) ?? 0n) + h.shares);
		classes.set(h.class, (classes.get(h.class) ?? 0n) + h.shares);
	}
	const byHolder = [...holders]
		.map(([key, shares]) => ({ key, shares, ppm: sharePpm(shares, total) }))
		.sort((a, b) => (b.shares > a.shares ? 1 : b.shares < a.shares ? -1 : a.key.localeCompare(b.key)));
	const byClass = CLASS_ORDER.filter((c) => classes.has(c)).map((key) => ({ key, shares: classes.get(key)!, ppm: sharePpm(classes.get(key)!, total) }));
	return { total, byHolder, byClass };
}

const HOLDING_OF: Partial<Record<SecurityClass, HoldingClass>> = {
	common: 'common',
	preferred: 'preferred',
	options_granted: 'options',
	option_pool: 'pool',
	warrant: 'warrant'
};

/** Cap table lines as holdings. SAFEs and notes own no shares until they convert, so they are left out. Options
 * granted are grouped into one "Options granted" holder and the pool into "Unallocated pool", as boards read them. */
export function holdingsFromCapTable(entries: Pick<CapTableEntry, 'holderName' | 'security' | 'shares'>[]): Holding[] {
	const out: Holding[] = [];
	for (const e of entries) {
		const cls = HOLDING_OF[e.security];
		if (!cls || e.shares <= 0) continue;
		const holder = cls === 'pool' ? HOLDING_CLASS_LABEL.pool : cls === 'options' ? 'Options granted to the team' : e.holderName;
		out.push({ holder, class: cls, shares: BigInt(e.shares) });
	}
	return out;
}

// --- SAFEs -------------------------------------------------------------------------------------------------------

export type SafeKind = 'post_money' | 'pre_money';

export interface Safe {
	id: string;
	holder: string;
	kind: SafeKind;
	/** The purchase amount. */
	amountMinor: bigint;
	/** Valuation cap. Post-money SAFEs: a post-money cap. Pre-money SAFEs: a pre-money cap. */
	capMinor?: bigint;
	/** 2000 = 20% off the round price. */
	discountBp?: number;
}

/** Outstanding (or signed, awaiting money) SAFEs from the instrument register. Notes and priced shares are left out. */
export function safesFromInstruments(instruments: Instrument[], holderName: (investorId: string) => string): Safe[] {
	return instruments
		.filter((i) => (i.kind === 'safe_post_money' || i.kind === 'safe_pre_money') && (i.status === 'outstanding' || i.status === 'draft'))
		.map((i) => ({
			id: i.id,
			holder: holderName(i.investorId),
			kind: i.kind === 'safe_post_money' ? 'post_money' : 'pre_money',
			amountMinor: BigInt(i.principalMinor || '0'),
			capMinor: i.valuationCapMinor && BigInt(i.valuationCapMinor) > 0n ? BigInt(i.valuationCapMinor) : undefined,
			discountBp: i.discountBp || undefined
		}));
}

export interface SafeConversion {
	id: string;
	holder: string;
	kind: SafeKind;
	amountMinor: bigint;
	/** Cap / the capitalization the SAFE's cap is measured against, rounded down. Undefined without a cap. */
	capPriceE4?: bigint;
	/** Round price less the discount, rounded down. The round price itself without a discount. */
	discountPriceE4: bigint;
	/** The lower of the two. */
	priceE4: bigint;
	basis: 'cap' | 'discount' | 'round price';
	/** amount / price, rounded down to a whole share. */
	shares: bigint;
}

// --- Round modeling ----------------------------------------------------------------------------------------------

export interface RoundInput {
	/** Today's fully diluted holdings, including options granted and the unallocated pool. */
	holdings: Holding[];
	/** Pre-money valuation. It includes the SAFE conversion shares and any pool top-up (the usual term sheet reading). */
	preMoneyMinor: bigint;
	newMoneyMinor: bigint;
	/** Holder name for the new money. */
	investor?: string;
	/** Optional: top up the unallocated pool, before the money comes in, to this share of the post-money (ppm). */
	poolTargetPpm?: bigint;
	safes?: Safe[];
}

export interface HolderAfter {
	holder: string;
	class: HoldingClass;
	before: bigint;
	after: bigint;
	beforePpm: bigint;
	afterPpm: bigint;
}

export interface RoundResult {
	/** Fully diluted shares before the round. */
	preRoundShares: bigint;
	/** The pre-money capitalization the price is set on (pre-round shares + pool top-up + SAFE shares), exact and
	 * rounded down to a whole share for display. */
	capitalization: bigint;
	priceE4: bigint;
	poolIncrease: bigint;
	conversions: SafeConversion[];
	convertedShares: bigint;
	newShares: bigint;
	postShares: bigint;
	postMoneyMinor: bigint;
	rows: HolderAfter[];
	byClass: { class: HoldingClass; before: bigint; after: bigint; beforePpm: bigint; afterPpm: bigint }[];
}

/** Whole shares an option pool needs to grow by so that, after a round priced on a pre-money that includes the
 * top-up, the pool is `targetPpm` of the post-money. Rounded up. Zero when the pool is already big enough.
 *
 * With S shares before the round, P in the pool, pre-money V and new money M: the price is V / (S + I), so the post
 * has (S + I) x (V + M) / V shares, and P + I = t x (S + I) x (V + M) / V gives
 * I = (t(V + M)S - PV) / (V - t(V + M)). */
export function poolTopUp(p: { preRoundShares: bigint; poolShares: bigint; preMoneyMinor: bigint; newMoneyMinor: bigint; targetPpm: bigint }): bigint {
	const r = modelRound({
		holdings: [
			{ holder: 'Others', class: 'common', shares: p.preRoundShares - p.poolShares },
			{ holder: HOLDING_CLASS_LABEL.pool, class: 'pool', shares: p.poolShares }
		],
		preMoneyMinor: p.preMoneyMinor,
		newMoneyMinor: p.newMoneyMinor,
		poolTargetPpm: p.targetPpm
	});
	return r.poolIncrease;
}

/** A priced round over today's holdings, with an optional pool top-up and SAFEs converting.
 *
 * The pre-money capitalization C is solved exactly. Each post-money SAFE takes amount / min(cap, V x (1 - d)) of C;
 * each SAFE without a cap takes amount / (V x (1 - d)) of C; a pre-money SAFE at its cap takes a fixed
 * amount x S / cap shares, S being the pre-round shares (its cap excludes the SAFEs and the top-up). The pool top-up
 * takes t x (V + M) / V of C less the pool already there. Then price = V / C. */
export function modelRound(input: RoundInput): RoundResult {
	const V = input.preMoneyMinor;
	const M = input.newMoneyMinor;
	const safes = input.safes ?? [];
	const S = input.holdings.reduce((t, h) => t + h.shares, 0n);
	const P0 = input.holdings.filter((h) => h.class === 'pool').reduce((t, h) => t + h.shares, 0n);
	if (S <= 0n) throw new Error('The cap table has no shares yet.');
	if (V <= 0n) throw new Error('The pre-money valuation must be above zero.');
	if (M < 0n) throw new Error('New money cannot be negative.');
	for (const s of safes) {
		if (s.amountMinor <= 0n) throw new Error(`${s.holder}'s SAFE has no purchase amount.`);
		if (s.capMinor !== undefined && s.capMinor <= 0n) throw new Error(`${s.holder}'s SAFE cap must be above zero.`);
		if ((s.discountBp ?? 0) < 0 || (s.discountBp ?? 0) >= 10_000) throw new Error(`${s.holder}'s SAFE discount must be between 0% and 100%.`);
	}
	const t = input.poolTargetPpm ?? 0n;
	if (t < 0n || t >= PPM) throw new Error('The pool target must be between 0% and 100%.');

	const discounted = (s: Safe) => frac(V * (BP - BigInt(s.discountBp ?? 0)), BP);
	// Pre-money SAFEs with a cap: do they convert at the cap (fixed shares) or at the discount (a share of C)? It
	// depends on C, so start at the cap and flip until stable.
	const atCap = new Map<string, boolean>(safes.filter((s) => s.kind === 'pre_money' && s.capMinor).map((s) => [s.id, true]));

	const solve = (withPool: boolean) => {
		let fixed = frac(0n);
		let share = frac(0n);
		for (const s of safes) {
			if (s.kind === 'pre_money' && s.capMinor && atCap.get(s.id)) fixed = add(fixed, frac(s.amountMinor * S, s.capMinor));
			else {
				const m = s.kind === 'post_money' && s.capMinor && cmp(frac(s.capMinor), discounted(s)) < 0 ? frac(s.capMinor) : discounted(s);
				share = add(share, div(frac(s.amountMinor), m));
			}
		}
		const poolShare = withPool ? frac(t * (V + M), PPM * V) : frac(0n);
		const denom = sub(sub(frac(1n), share), poolShare);
		if (cmp(denom, frac(0n)) <= 0) throw new Error('The SAFEs and the pool top-up would take the whole company at this valuation.');
		const C = div(add(frac(withPool ? S - P0 : S), fixed), denom);
		const poolExact = withPool ? sub(mul(poolShare, C), frac(P0)) : frac(0n);
		return { C, poolExact };
	};

	let C = frac(S);
	let poolExact = frac(0n);
	for (let k = 0; k <= safes.length + 1; k++) {
		let r = solve(t > 0n);
		// The pool is already at or above the target: no top-up.
		if (t > 0n && cmp(r.poolExact, frac(0n)) <= 0) r = solve(false);
		C = r.C;
		poolExact = r.poolExact;
		let changed = false;
		for (const s of safes) {
			if (!atCap.has(s.id)) continue;
			// At the cap when cap / S <= V(1 - d) / C.
			const capWins = cmp(mul(frac(s.capMinor!), C), mul(discounted(s), frac(S))) <= 0;
			if (capWins !== atCap.get(s.id)) {
				atCap.set(s.id, capWins);
				changed = true;
			}
		}
		if (!changed) break;
	}

	const priceE4 = floor(div(frac(V * E4), C));
	if (priceE4 <= 0n) throw new Error('The price per share rounds to zero; the valuation is too low for this many shares.');
	const poolIncrease = cmp(poolExact, frac(0n)) > 0 ? ceil(poolExact) : 0n;

	const conversions: SafeConversion[] = safes.map((s) => {
		const base = s.kind === 'post_money' ? C : frac(S);
		const capPriceE4 = s.capMinor ? floor(div(frac(s.capMinor * E4), base)) : undefined;
		const discountPriceE4 = (priceE4 * (BP - BigInt(s.discountBp ?? 0))) / BP;
		const capWins = capPriceE4 !== undefined && capPriceE4 <= discountPriceE4;
		const price = capWins ? capPriceE4! : discountPriceE4;
		const basis: SafeConversion['basis'] = capWins ? 'cap' : (s.discountBp ?? 0) > 0 ? 'discount' : 'round price';
		return { id: s.id, holder: s.holder, kind: s.kind, amountMinor: s.amountMinor, capPriceE4, discountPriceE4, priceE4: price, basis, shares: (s.amountMinor * E4) / price };
	});
	const convertedShares = conversions.reduce((a, c) => a + c.shares, 0n);
	const newShares = (M * E4) / priceE4;
	const postShares = S + poolIncrease + convertedShares + newShares;

	// Holder lines before and after.
	const lines = new Map<string, HolderAfter>();
	const line = (holder: string, cls: HoldingClass) => {
		const k = `${cls}|${holder}`;
		let l = lines.get(k);
		if (!l) lines.set(k, (l = { holder, class: cls, before: 0n, after: 0n, beforePpm: 0n, afterPpm: 0n }));
		return l;
	};
	for (const h of input.holdings) {
		const l = line(h.holder, h.class);
		l.before += h.shares;
		l.after += h.shares;
	}
	if (poolIncrease > 0n) {
		const poolLine = [...lines.values()].find((l) => l.class === 'pool') ?? line(HOLDING_CLASS_LABEL.pool, 'pool');
		poolLine.after += poolIncrease;
	}
	for (const c of conversions) line(c.holder, 'preferred').after += c.shares;
	if (newShares > 0n) line(input.investor ?? 'New investors', 'preferred').after += newShares;
	const rows = [...lines.values()]
		.map((l) => ({ ...l, beforePpm: sharePpm(l.before, S), afterPpm: sharePpm(l.after, postShares) }))
		.sort((a, b) => (b.after > a.after ? 1 : b.after < a.after ? -1 : a.holder.localeCompare(b.holder)));

	const byClass = CLASS_ORDER.map((cls) => {
		const before = rows.filter((r) => r.class === cls).reduce((a, r) => a + r.before, 0n);
		const after = rows.filter((r) => r.class === cls).reduce((a, r) => a + r.after, 0n);
		return { class: cls, before, after, beforePpm: sharePpm(before, S), afterPpm: sharePpm(after, postShares) };
	}).filter((c) => c.before > 0n || c.after > 0n);

	return {
		preRoundShares: S,
		capitalization: floor(C),
		priceE4,
		poolIncrease,
		conversions,
		convertedShares,
		newShares,
		postShares,
		postMoneyMinor: V + M,
		rows,
		byClass
	};
}

/** Dollars typed into a form ("12,000,000" or "1.5") as cents; null when it is not a number. */
export function parseDollars(text: string): bigint | null {
	const t = text.replace(/[$,\s]/g, '');
	if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
	const [whole, cents = ''] = t.split('.');
	return BigInt(whole) * 100n + BigInt(cents.padEnd(2, '0'));
}

/** A percent typed into a form ("15" or "12.5") as ppm; null when it is not a number from 0 to 100. */
export function parsePercentPpm(text: string): bigint | null {
	const t = text.replace(/[%\s]/g, '');
	if (!/^\d+(\.\d{0,4})?$/.test(t)) return null;
	const [whole, dec = ''] = t.split('.');
	const ppm = BigInt(whole) * 10_000n + BigInt(dec.padEnd(4, '0'));
	return ppm <= PPM ? ppm : null;
}
