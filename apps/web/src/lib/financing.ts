// Fundraising maths for the Capital accountant: SAFE and note conversion, note interest, and the cap table. Pure and
// integer-only. Money is minor units (cents) as bigint; a price per share is minor units times 10^4 (`E4`), so
// $4.2000 a share is 4_200_000n; ownership is parts per million (`ppm`, 1_000_000n is 100%).
import type { CapTableEntry, Instrument, SecurityClass } from './data/types';

const BP = 10_000n;
const E4 = 10_000n;
const PPM = 1_000_000n;
const DAY_MS = 86_400_000;

const big = (v: string | number | bigint | undefined | null): bigint => {
	if (v === undefined || v === null || v === '') return 0n;
	try {
		return BigInt(v);
	} catch {
		return 0n;
	}
};
const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** a / b rounded half away from zero (b > 0). */
const divRound = (a: bigint, b: bigint) => (a >= 0n ? (2n * a + b) / (2n * b) : -((2n * -a + b) / (2n * b)));

/** Whole days from `from` to `to` (UTC dates; time of day ignored). Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
	const d = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
	return Math.round((d(to) - d(from)) / DAY_MS);
}

/** Simple interest on a note, actual/365: principal x rate x days / 365, rounded to the cent. Zero for no days. */
export function noteInterestMinor(principalMinor: bigint, rateBp: number, days: number): bigint {
	if (days <= 0 || rateBp <= 0) return 0n;
	return divRound(principalMinor * BigInt(rateBp) * BigInt(days), BP * 365n);
}

/** Interest a note has earned from the day its money arrived up to, not including, `to`. */
export function accruedInterestMinor(principalMinor: bigint, rateBp: number, fundedAt: string, to: string): bigint {
	return noteInterestMinor(principalMinor, rateBp, daysBetween(fundedAt, to));
}

/** A post-money SAFE's ownership at conversion when it converts at its cap: purchase amount / post-money cap. */
export function safeOwnershipPpm(amountMinor: bigint, postMoneyCapMinor: bigint): bigint {
	if (postMoneyCapMinor <= 0n) return 0n;
	return (amountMinor * PPM) / postMoneyCapMinor;
}

/** The price a valuation buys at: valuation / shares, rounded down to four decimals of a cent. */
export function priceE4(valuationMinor: bigint, shares: bigint): bigint {
	if (shares <= 0n) return 0n;
	return (valuationMinor * E4) / shares;
}

/** A round's price less a discount (2000 bp = 20% off), rounded down. */
export function discountedPriceE4(roundPriceE4: bigint, discountBp: number): bigint {
	return (roundPriceE4 * (BP - BigInt(discountBp))) / BP;
}

/** The price a SAFE or note converts at: the lower of its cap price and its discounted price. */
export function conversionPriceE4(capPrice: bigint | undefined, discountedPrice: bigint): bigint {
	return capPrice === undefined || capPrice <= 0n ? discountedPrice : min(capPrice, discountedPrice);
}

/** Shares an amount buys at a price: rounded down, as share purchase agreements do. */
export function conversionShares(amountMinor: bigint, price: bigint): bigint {
	if (price <= 0n) return 0n;
	return (amountMinor * E4) / price;
}

export interface Convertible {
	id: string;
	holderName: string;
	/** What converts: a SAFE's purchase amount, or a note's principal plus interest to the conversion date. */
	amountMinor: bigint;
	capMinor?: bigint;
	discountBp?: number;
}

export interface ConversionRow {
	id: string;
	holderName: string;
	amountMinor: bigint;
	capPriceE4?: bigint;
	discountedPriceE4: bigint;
	priceE4: bigint;
	/** Which term set the price. */
	basis: 'cap' | 'discount' | 'round price';
	shares: bigint;
}

export interface PricedRound {
	/** Shares before the round on a fully diluted basis: common, preferred, options granted and the unallocated pool. */
	preRoundShares: bigint;
	preMoneyMinor: bigint;
	newMoneyMinor: bigint;
	convertibles: Convertible[];
}

export interface PricedRoundResult {
	/** Pre-money capitalization including the shares the SAFEs and notes convert into. */
	capitalization: bigint;
	roundPriceE4: bigint;
	rows: ConversionRow[];
	convertedShares: bigint;
	newMoneyShares: bigint;
	postMoneyShares: bigint;
	postMoneyMinor: bigint;
}

/**
 * A priced round with SAFEs and notes converting, on the standard terms: the pre-money valuation includes the
 * converting shares, and each SAFE or note converts at the lower of its cap price and the round price less its
 * discount, both measured against that same capitalization.
 *
 * Each convertible buys `amount / m` of the capitalization, where m = min(cap, pre-money x (1 - discount)). So the
 * capitalization C = preRoundShares / (1 - sum(amount / m)), the round price = pre-money / C, and new money buys
 * newMoney / price shares.
 */
export function pricedRound(r: PricedRound): PricedRoundResult {
	const SCALE = 10n ** 18n;
	const V = r.preMoneyMinor;
	const effective = (c: Convertible) => {
		const disc = (V * (BP - BigInt(c.discountBp ?? 0))) / BP;
		return c.capMinor && c.capMinor > 0n ? min(c.capMinor, disc) : disc;
	};
	let taken = 0n;
	for (const c of r.convertibles) {
		const m = effective(c);
		if (m > 0n) taken += (c.amountMinor * SCALE) / m;
	}
	// The convertibles can never take the whole company; cap at 99% so the maths stays defined on bad inputs.
	if (taken > (SCALE * 99n) / 100n) taken = (SCALE * 99n) / 100n;
	const capitalization = (r.preRoundShares * SCALE) / (SCALE - taken);
	const roundPrice = priceE4(V, capitalization);

	const rows: ConversionRow[] = r.convertibles.map((c) => {
		const capPrice = c.capMinor && c.capMinor > 0n ? priceE4(c.capMinor, capitalization) : undefined;
		const disc = discountedPriceE4(roundPrice, c.discountBp ?? 0);
		const price = conversionPriceE4(capPrice, disc);
		const basis: ConversionRow['basis'] = capPrice !== undefined && capPrice < disc ? 'cap' : (c.discountBp ?? 0) > 0 ? 'discount' : 'round price';
		return { id: c.id, holderName: c.holderName, amountMinor: c.amountMinor, capPriceE4: capPrice, discountedPriceE4: disc, priceE4: price, basis, shares: conversionShares(c.amountMinor, price) };
	});
	const convertedShares = rows.reduce((t, x) => t + x.shares, 0n);
	const newMoneyShares = conversionShares(r.newMoneyMinor, roundPrice);
	const postMoneyShares = r.preRoundShares + convertedShares + newMoneyShares;
	return { capitalization, roundPriceE4: roundPrice, rows, convertedShares, newMoneyShares, postMoneyShares, postMoneyMinor: V + r.newMoneyMinor };
}

/** Classes that count toward fully diluted shares. SAFEs and notes count only once they convert. */
const DILUTING: SecurityClass[] = ['common', 'preferred', 'options_granted', 'option_pool', 'warrant'];

export function fullyDilutedShares(entries: Pick<CapTableEntry, 'security' | 'shares'>[]): bigint {
	return entries.filter((e) => DILUTING.includes(e.security)).reduce((t, e) => t + BigInt(e.shares), 0n);
}

/** One holder's share of the fully diluted total, in ppm. */
export function fullyDilutedPpm(shares: number | bigint, total: bigint): bigint {
	return total > 0n ? (BigInt(shares) * PPM) / total : 0n;
}

/** The cap table after a priced round: converted SAFE and note rows become preferred, new investors join. */
export function rollForward(
	entries: CapTableEntry[],
	conversions: { instrumentInvestorId?: string; holderName: string; shares: bigint }[],
	newHolders: { holderName: string; investorId?: string; shares: bigint; investedMinor: bigint }[],
	asOf: string,
	ccy = 'USD'
): CapTableEntry[] {
	const out: CapTableEntry[] = [];
	const used = new Set<number>();
	for (const e of entries) {
		if (e.security === 'safe' || e.security === 'note') {
			const i = conversions.findIndex((c, k) => !used.has(k) && ((c.instrumentInvestorId && c.instrumentInvestorId === e.investorId) || c.holderName === e.holderName));
			if (i >= 0) {
				used.add(i);
				out.push({ ...e, security: 'preferred', shares: Number(conversions[i].shares), asOf });
				continue;
			}
		}
		out.push(e);
	}
	// Conversions with no SAFE or note row yet (signed, money not yet on the cap table) still convert.
	conversions.forEach((c, k) => {
		if (!used.has(k)) out.push({ id: `pf-${k}`, holderName: c.holderName, investorId: c.instrumentInvestorId, security: 'preferred', shares: Number(c.shares), investedMinor: '0', ccy, asOf });
	});
	newHolders.forEach((h, k) => out.push({ id: `pf-new-${k}`, holderName: h.holderName, investorId: h.investorId, security: 'preferred', shares: Number(h.shares), investedMinor: h.investedMinor.toString(), ccy, asOf }));
	return out;
}

/** The convertible a SAFE or note becomes at a priced round: SAFEs at their purchase amount, notes with interest. */
export function toConvertible(ins: Instrument, holderName: string, fundedAt: string | undefined, conversionDate: string): Convertible {
	// A pre-money SAFE's cap excludes the other convertibles, so it cannot share the post-money capitalization below.
	if (ins.kind === 'safe_pre_money') throw new Error(`Pre-money SAFEs are not supported yet (${holderName}); a person must work out its conversion.`);
	if (ins.kind !== 'safe_post_money' && ins.kind !== 'convertible_note') throw new Error(`Only SAFEs and notes convert in a priced round, not ${ins.kind.replace(/_/g, ' ')}.`);
	const principal = big(ins.principalMinor);
	const interest = ins.kind === 'convertible_note' && fundedAt ? accruedInterestMinor(principal, ins.interestBp ?? 0, fundedAt, conversionDate) : 0n;
	return { id: ins.id, holderName, amountMinor: principal + interest, capMinor: ins.valuationCapMinor ? big(ins.valuationCapMinor) : undefined, discountBp: ins.discountBp };
}

/** Par value of shares at $0.0001 each, in cents (rounded to the cent). */
export function parValueMinor(shares: bigint): bigint {
	return divRound(shares, 100n);
}

/** "$4.1972" from a price in E4. */
export function formatPriceE4(p: bigint | string | undefined): string {
	const v = big(p);
	const dollars4 = v / 100n; // cents x 10^4 / 100 = dollars x 10^4
	const whole = dollars4 / E4;
	const frac = (dollars4 % E4).toString().padStart(4, '0');
	return `$${whole.toLocaleString('en-US')}.${frac}`;
}

/** "12.34%" from ppm. */
export function formatPpm(ppm: bigint, digits = 2): string {
	const scale = 10n ** BigInt(digits);
	const v = divRound(ppm * 100n * scale, PPM);
	const s = v.toString().padStart(digits + 1, '0');
	return `${s.slice(0, -digits) || '0'}.${s.slice(-digits)}%`;
}

/** How an instrument sits on the balance sheet, with the plain reason a CFO can read. */
export function classify(kind: Instrument['kind'], status: Instrument['status'] = 'outstanding'): { classification: Instrument['classification']; plain: string } {
	if (status === 'converted') return { classification: 'equity', plain: 'Equity: it has converted into shares, so it sits in stock and paid-in capital. Nothing is owed and none of it was income.' };
	switch (kind) {
		case 'safe_post_money':
		case 'safe_pre_money':
			return { classification: 'liability', plain: 'A liability, not income: on a sale of the company before it converts, the SAFE pays the investor cash, so it is carried at fair value until it converts into shares.' };
		case 'convertible_note':
			return { classification: 'liability', plain: 'A liability, not income: Luyten owes the principal plus interest until the note converts or is repaid. The interest is an expense each month.' };
		case 'warrant':
			return { classification: 'liability', plain: 'A liability until a person confirms its terms: some warrants settle in cash. A person decides for anything non-standard.' };
		default:
			return { classification: 'equity', plain: 'Equity: shares bought for cash. The money goes to stock and paid-in capital, never to income.' };
	}
}

/** When each SAFE or note's money arrived, read from approved funding receipts (`payload.fundedAt`). */
export function fundedDates(proposals: { kind: string; status: string; payloadJson: string }[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const p of proposals) {
		if (p.kind !== 'funding_receipt' || (p.status !== 'approved' && p.status !== 'amended')) continue;
		try {
			const j = JSON.parse(p.payloadJson) as { instrumentId?: string; fundedAt?: string };
			if (j.instrumentId && j.fundedAt && !out.has(j.instrumentId)) out.set(j.instrumentId, j.fundedAt);
		} catch {
			// a payload that is not JSON names no instrument
		}
	}
	return out;
}

export interface RoundPlanInput {
	/** Today's cap table; its fully diluted shares are the pre-round shares. */
	capTable: CapTableEntry[];
	/** The SAFEs and notes that convert in the round. */
	converting: Instrument[];
	holderName: (investorId: string) => string;
	/** When a note's money arrived; interest runs from then. A note not yet funded converts at principal. */
	fundedAt: (instrumentId: string) => string | undefined;
	preMoneyMinor: bigint;
	newMoneyMinor: bigint;
	/** The round's closing date, when conversion happens. */
	closeAt: string;
}

/** A priced round over today's cap table, with the given SAFEs and notes converting at the close. */
export function roundPlan(r: RoundPlanInput): PricedRoundResult {
	return pricedRound({
		preRoundShares: fullyDilutedShares(r.capTable),
		preMoneyMinor: r.preMoneyMinor,
		newMoneyMinor: r.newMoneyMinor,
		convertibles: r.converting.map((i) => toConvertible(i, r.holderName(i.investorId), i.kind === 'convertible_note' ? r.fundedAt(i.id) : undefined, r.closeAt))
	});
}
