// What a worker agent can honestly do with a CFO's send-back note in Demo mode. The note is plain text, so the demo only
// acts on what it states in numbers: a percentage for an Allowance entry (recomputed from the open invoices), or a dollar
// amount for a plain entry (the lines scaled to it). Anything else is declined in words; it is never resubmitted as if
// it had been addressed.
import { KIND } from '../../labels';
import { formatMoney, toBig } from '../money';
import { parsePayload, type Raw } from '../payload';
import type { Minor, Proposal } from '../types';

export interface SendBackContext {
	/** What a customer owes on unpaid invoices, in minor units. */
	openReceivable: (customerId: string) => bigint;
	customerName: (customerId: string) => string;
	/** The CFO's materiality threshold, in minor units. */
	materiality: bigint;
}

export interface Revision {
	payload: Raw;
	amountMinor: Minor;
	summaryPlain: string;
	rationale: string;
	/** The worker's statement on the revised Proposal. */
	body: string;
	critique: { body: string; summary: string };
}

export type SendBackOutcome = { ok: true; revision: Revision } | { ok: false; reason: string };

interface Figure {
	/** Basis points for a percentage, minor units for a dollar amount. */
	value: bigint;
	/** The note rejects this figure ("not 75%", "instead of $10,000") rather than asking for it. */
	rejected: boolean;
}

const REJECTING = /\b(?:not|than|instead of|from|was|currently|now|rather than)\s*(?:at\s+|the\s+|a\s+|about\s+)?(?:rate\s+of\s+)?$/;

function figuresIn(note: string, pattern: RegExp, toValue: (m: RegExpExecArray) => bigint): Figure[] {
	return [...note.matchAll(pattern)].map((m) => ({
		value: toValue(m as RegExpExecArray),
		rejected: REJECTING.test(note.slice(Math.max(0, m.index - 24), m.index).toLowerCase())
	}));
}

/** "50%", "37.5 percent": basis points. */
export function percentsIn(note: string): Figure[] {
	return figuresIn(note, /(\d+(?:\.\d{1,2})?)\s*(?:%|percent|per cent)/gi, (m) => BigInt(Math.round(Number(m[1]) * 100)));
}

/** "$10,000", "$10k", "10,000 dollars": minor units. */
export function dollarsIn(note: string): Figure[] {
	const toMinor = (digits: string, k: string | undefined) => BigInt(Math.round(Number(digits.replace(/,/g, '')) * (k ? 100_000 : 100)));
	return [
		...figuresIn(note, /\$\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k\b)?/gi, (m) => toMinor(m[1]!, m[2])),
		...figuresIn(note, /(?<!\$\s?)(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|usd)\b/gi, (m) => toMinor(m[1]!, undefined))
	];
}

/** The one figure the note asks for, or why it cannot be told. `current` figures are the ones already on the Proposal. */
function requested(figures: Figure[], current: bigint[], what: string): { value: bigint; rejected: bigint[] } | string {
	const rejected = figures.filter((f) => f.rejected).map((f) => f.value);
	let asked = [...new Set(figures.filter((f) => !f.rejected).map((f) => f.value))];
	if (asked.length > 1) asked = asked.filter((v) => !current.includes(v));
	if (asked.length === 1) return { value: asked[0]!, rejected };
	return asked.length ? `the note names more than one ${what}` : `the note only says which ${what} not to use`;
}

const pct = (bp: bigint) => `${Number(bp) / 100}%`;
const usd = (minor: Minor | bigint) => formatMoney(minor.toString());
const joinNames = (names: string[]) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const mulDiv = (n: bigint, num: bigint, den: bigint) => (n * num * 2n + den) / (den * 2n);

interface Line {
	account: string;
	debitMinor: Minor;
	creditMinor: Minor;
	customerId?: string;
	vendorId?: string;
}

/** An Allowance entry sets aside a share of what customers owe: credits on 1150 per customer, offset on 6500. */
function isAllowance(p: Proposal, lines: Line[]): boolean {
	return p.kind === 'journal_entry' && lines.some((l) => l.account === '1150' && l.customerId) && lines.some((l) => l.account === '6500');
}

export function reviseForNote(p: Proposal, noteRaw: string, ctx: SendBackContext): SendBackOutcome {
	const note = noteRaw.trim();
	const payload = parsePayload(p.payloadJson);
	const lines = (Array.isArray(payload?.lines) ? (payload.lines as Line[]) : []).filter((l) => l && typeof l === 'object');
	const percents = percentsIn(note);
	const dollars = dollarsIn(note);
	if (!payload || lines.length < 2) return { ok: false, reason: `this ${KIND[p.kind].toLowerCase()} carries no journal lines I could change` };
	if (isAllowance(p, lines) && percents.length) return recomputeAllowance(p, note, payload, lines, percents, ctx);
	if (dollars.length) return scaleToAmount(p, note, payload, lines, dollars, ctx);
	if (percents.length) return { ok: false, reason: `a percentage only means something to me for the Allowance, and this is a ${KIND[p.kind].toLowerCase()}` };
	return { ok: false, reason: 'the note gives no percentage or dollar amount, and I will not guess a number from a judgement' };
}

function recomputeAllowance(p: Proposal, note: string, payload: Raw, lines: Line[], percents: Figure[], ctx: SendBackContext): SendBackOutcome {
	const tiers = (payload.tiers ?? {}) as Record<string, string>;
	const ratesBp = { ...((payload.ratesBp ?? {}) as Record<string, number>) };
	const rateOf = (l: Line, open: bigint): bigint => {
		const tier = l.customerId ? tiers[l.customerId] : undefined;
		return tier && ratesBp[tier] !== undefined ? BigInt(ratesBp[tier]!) : open > 0n ? mulDiv(toBig(l.creditMinor), 10_000n, open) : 0n;
	};
	const reserve = lines.filter((l) => l.account === '1150' && l.customerId);
	const current = reserve.map((l) => rateOf(l, ctx.openReceivable(l.customerId!)));
	const asked = requested(percents, current, 'rate');
	if (typeof asked === 'string') return { ok: false, reason: asked };
	const rate = asked.value;
	if (rate <= 0n) return { ok: false, reason: 'a 0% rate would remove the reserve altogether, which is not a change I can make on my own' };
	if (rate > 10_000n) return { ok: false, reason: `${pct(rate)} is more than the whole balance owed` };

	// Without a rate to replace ("not 75%"), every reserve below a full 100% moves; a full reserve is a decision about one customer.
	const replaces = (old: bigint) => (asked.rejected.length ? asked.rejected.includes(old) : old < 10_000n);
	const changes: { customer: string; open: bigint; from: bigint; to: bigint; rate: bigint }[] = [];
	const next = lines.map((l) => {
		if (!(l.account === '1150' && l.customerId)) return l;
		const open = ctx.openReceivable(l.customerId);
		const old = rateOf(l, open);
		if (open <= 0n || old === rate || !replaces(old)) return l;
		const to = mulDiv(open, rate, 10_000n);
		changes.push({ customer: ctx.customerName(l.customerId), open, from: toBig(l.creditMinor), to, rate: old });
		const tier = tiers[l.customerId];
		if (tier) ratesBp[tier] = Number(rate);
		return { ...l, creditMinor: to.toString() };
	});
	if (!changes.length) {
		return { ok: false, reason: asked.rejected.length ? `no reserve line is at ${pct(asked.rejected[0]!)}` : `every reserve line is already at ${pct(rate)} or is a full reserve I will not cut` };
	}
	const debits = next.filter((l) => toBig(l.debitMinor) > 0n);
	if (debits.length !== 1 || debits[0]!.account !== '6500') return { ok: false, reason: 'the entry has a shape I cannot rewrite safely' };
	const total = next.reduce((s, l) => s + toBig(l.creditMinor), 0n);
	const was = toBig(p.amountMinor);
	if (total === was) return { ok: false, reason: `${pct(rate)} gives the same ${usd(was)} as before` };
	if (total <= 0n) return { ok: false, reason: 'that rate would leave nothing to set aside' };
	debits[0]!.debitMinor = total.toString();

	const kept = reserve.length - changes.length;
	const sum = changes.map((c) => `${c.customer} ${usd(c.open)} x ${pct(rate)} = ${usd(c.to)} (was ${usd(c.from)} at ${pct(c.rate)})`).join('; ');
	const unchanged = kept ? ` ${kept} customer${kept === 1 ? ' stays' : 's stay'} at the rate it had.` : '';
	const lighter = total < was;
	const memoBase = typeof payload.memo === 'string' ? payload.memo : 'Allowance for credit losses';
	const material = total >= ctx.materiality;
	const limit = formatMoney(ctx.materiality.toString(), { whole: true });
	const customers = reserve.length;
	return {
		ok: true,
		revision: {
			payload: { ...payload, ratesBp, memo: `${memoBase} (revised to ${pct(rate)})`, lines: next, revisedFrom: p.id },
			amountMinor: total.toString(),
			summaryPlain: `Set aside ${usd(total)} instead of ${usd(was)} for invoices that ${customers === 1 ? 'a customer is' : `${customers} customers are`} unlikely to pay, using the ${pct(rate)} rate you asked for.`,
			rationale: `Revised after CFO note "${note}". Rate ${joinNames([...new Set(changes.map((c) => pct(c.rate)))])} became ${pct(rate)} for ${joinNames(changes.map((c) => c.customer))}. Amount was ${usd(was)}, now ${usd(total)}.${unchanged}`,
			body: `Resubmission of ${p.id} after CFO note: "${note}". Recomputed the Allowance from the open invoices: ${sum}.${unchanged} Total ${usd(total)}, was ${usd(was)}. Dr 6500 / Cr 1150.`,
			critique: {
				body: `Recomputed from the open invoices and the arithmetic holds: ${sum}. Total ${usd(total)} against ${usd(was)} before. ${lighter ? `That reserves ${usd(was - total)} less, and the Risk Tier evidence (credit checks and past-due history) was what supported the higher rate, so the lighter rate is your judgement, not something the evidence shows.` : `That reserves ${usd(total - was)} more than before.`} One check I would still make: ${usd(total)} is ${material ? 'at or above' : 'under'} the ${limit} threshold, so ${material ? 'it should wait for your confirmation again' : 'the Advisor can post it without asking you again'}.`,
				summary: lighter ? `Red Team re-did the sums and they hold. The ${pct(rate)} rate reserves ${usd(was - total)} less than the evidence supported, so it is your call.` : `Red Team re-did the sums and they hold.`
			}
		}
	};
}

function scaleToAmount(p: Proposal, note: string, payload: Raw, lines: Line[], dollars: Figure[], ctx: SendBackContext): SendBackOutcome {
	if (p.kind !== 'journal_entry' && p.kind !== 'accrual') return { ok: false, reason: `the amount on a ${KIND[p.kind].toLowerCase()} comes from its evidence, not from a figure I can overwrite` };
	if ('bankTransactionId' in payload || 'bankTransactionIds' in payload) return { ok: false, reason: 'the amount comes from bank lines, and a bank line cannot change' };
	const was = lines.reduce((s, l) => s + toBig(l.debitMinor), 0n);
	if (was !== lines.reduce((s, l) => s + toBig(l.creditMinor), 0n) || was <= 0n) return { ok: false, reason: 'the entry does not balance, so I cannot scale it' };
	const asked = requested(dollars, [was], 'amount');
	if (typeof asked === 'string') return { ok: false, reason: asked };
	const target = asked.value;
	if (target <= 0n) return { ok: false, reason: 'a zero amount would remove the entry, which is not a change I can make on my own' };
	if (target === was) return { ok: false, reason: `${usd(target)} is the amount already proposed` };

	// Scale each side to the new total; the last line on each side takes the rounding so both sides still equal it.
	const scaleSide = (side: 'debitMinor' | 'creditMinor') => {
		const idx = lines.map((l, i) => (toBig(l[side]) > 0n ? i : -1)).filter((i) => i >= 0);
		let left = target;
		const out = new Map<number, string>();
		idx.forEach((i, n) => {
			const v = n === idx.length - 1 ? left : mulDiv(toBig(lines[i]![side]), target, was);
			left -= v;
			out.set(i, v.toString());
		});
		return out;
	};
	const dr = scaleSide('debitMinor');
	const cr = scaleSide('creditMinor');
	const next = lines.map((l, i) => ({ ...l, debitMinor: dr.get(i) ?? '0', creditMinor: cr.get(i) ?? '0' }));
	const memoBase = typeof payload.memo === 'string' ? payload.memo : KIND[p.kind];
	const { ratesBp: _rates, ...rest } = payload;
	return {
		ok: true,
		revision: {
			payload: { ...rest, memo: `${memoBase} (amount set by the CFO)`, lines: next, revisedFrom: p.id },
			amountMinor: target.toString(),
			summaryPlain: `${memoBase}: ${usd(target)} instead of ${usd(was)}, the amount you asked for.`,
			rationale: `Revised after CFO note "${note}". Amount was ${usd(was)}, now ${usd(target)}, with every line scaled in proportion. The ${usd(target)} is the CFO's figure; the original evidence supported ${usd(was)}: ${p.rationale}`,
			body: `Resubmission of ${p.id} after CFO note: "${note}". Amount changed from ${usd(was)} to ${usd(target)}, every line scaled in proportion. I have not found evidence for the new figure; it is yours.`,
			critique: {
				body: `The new amount ${usd(target)} is the CFO's figure and I cannot tie it to the source documents. The original ${usd(was)} rested on: ${p.rationale} Lines are scaled in proportion and the entry still balances. One check I would still make: keep the evidence for ${usd(target)} on file so it survives the audit. ${target >= ctx.materiality ? 'It is at or above' : 'It is under'} the ${formatMoney(ctx.materiality.toString(), { whole: true })} threshold.`,
				summary: `Red Team could not tie ${usd(target)} to the documents. The entry balances, and keeping the evidence for the new figure is on you.`
			}
		}
	};
}
