// Demo behaviour for Financing: the Seed 2026 round's paperwork and wires, and what keeps arriving from the cap table
// tool. The Funding desk matches money to investors; the Capital accountant keeps the instrument register, the
// classification and the cap table. Raising money is never income: SAFEs and notes are liabilities, shares are equity.
import type { BankTransaction, Commitment, UploadedDocument } from '../../types';
import { formatMoney, toBig } from '../../money';
import { SUBSIDIARY_ID } from '../seed';
import type { ScriptLine } from '../script';
import type { LiveTicker, MockContext, UploadHandler } from './types';
import { accruedInterestMinor, classify, daysBetween, formatPriceE4, fullyDilutedShares, fundedDates, parValueMinor, roundPlan } from '../../../financing';

const UK = 'sub-uk';
const SEED = 'rd-seed-2026';
const SERIES_A = 'rd-series-a-2026';
/** The first close: the day the tracker's wires landed. Interest on the note runs from here. */
const FIRST_CLOSE = '2026-10-01T00:00:00Z';
/** The Series A closing date on the term sheet; SAFEs and the note convert then. */
const SERIES_A_CLOSE = '2026-12-15T00:00:00Z';
const SERIES_A_PRE_MONEY = 6_000_000_000n;
const SERIES_A_NEW_MONEY = 1_200_000_000n;
/** The fair value report's SAFE value as a share of the purchase amount, 106.2%. */
const SAFE_FV_BP = 10_620n;

const money = (minor: string | bigint, ccy = 'USD') => {
	const m = toBig(String(minor));
	return formatMoney(m.toString(), { whole: m % 100n === 0n, currency: ccy });
};
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const L = (account: string, debitMinor: string | bigint, creditMinor: string | bigint): ScriptLine => ({ account, debitMinor: String(debitMinor), creditMinor: String(creditMinor) });

// ---------------------------------------------------------------------------------------------------------------
// Reading the live tables

const inv = (ctx: MockContext, id: string) => ctx.t.investor.find((i) => i.id === id);
const nameOf = (ctx: MockContext, investorId: string) => inv(ctx, investorId)?.name ?? investorId;
const cm = (ctx: MockContext, instrumentId: string) => ctx.t.commitment.find((c) => c.instrumentId === instrumentId);
const ins = (ctx: MockContext, id: string) => ctx.t.instrument.find((i) => i.id === id);

/** An account's balance on its natural side: credits less debits for liabilities and equity, debits less credits for the rest. */
function balance(ctx: MockContext, code: string, creditNormal = true): bigint {
	const id = `acc-${code}`;
	let t = 0n;
	for (const l of ctx.t.journal_line) if (l.accountId === id) t += toBig(l.creditMinor) - toBig(l.debitMinor);
	return creditNormal ? t : -t;
}

/** GBP to USD at the open month's closing rate (1.28 in the demo). */
function gbpToUsd(ctx: MockContext, minor: bigint): bigint {
	const ym = ctx.openPeriodId() ?? ctx.now().slice(0, 7);
	const r = ctx.t.fx_rate.find((x) => x.fromCcy === 'GBP' && x.toCcy === 'USD' && x.ym === ym && x.kind === 'closing') ?? ctx.t.fx_rate.findLast((x) => x.fromCcy === 'GBP' && x.toCcy === 'USD');
	return (minor * toBig(r?.rateE6 ?? '1280000')) / 1_000_000n;
}

/** Proposals already raised for a key (so a second upload of the same file proposes nothing twice). */
const alreadyProposed = (ctx: MockContext, kind: string, key: string) =>
	ctx.t.proposal.some((p) => p.kind === kind && !['rejected', 'superseded', 'sent_back'].includes(p.status) && p.payloadJson.includes(`"key":"${key}"`));

/** Statuses in which a Proposal still counts: in debate, waiting for the CFO, or approved. */
const LIVE = ['open', 'awaiting_cfo', 'approved', 'amended'];
const APPROVED = ['approved', 'amended'];
type Payload = Record<string, unknown> & { instrumentId?: string; roundId?: string; to?: string; adjustments?: Record<string, string> };
const payloadOf = (json: string): Payload => {
	try {
		return JSON.parse(json) as Payload;
	} catch {
		return {};
	}
};
const proposalsOf = (ctx: MockContext, kind: string, statuses: string[]) => ctx.t.proposal.filter((p) => p.kind === kind && statuses.includes(p.status)).map((p) => ({ p, payload: payloadOf(p.payloadJson) }));

/** The day after the demo clock's date: an accrual booked today runs through today. */
const bookingEnd = (ctx: MockContext) => {
	const d = new Date(`${ctx.now().slice(0, 10)}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
};

/** Interest approved on a note so far, and the date it runs to (exclusive). */
function bookedInterest(ctx: MockContext, instrumentId: string): { total: bigint; to?: string } {
	let total = 0n;
	let to: string | undefined;
	for (const { p, payload } of proposalsOf(ctx, 'interest_accrual', APPROVED)) {
		if (payload.instrumentId !== instrumentId) continue;
		total += toBig(p.amountMinor);
		if (payload.to && (!to || payload.to > to)) to = payload.to;
	}
	return { total, to };
}

/** Fair-value changes on each SAFE from valuation-report Proposals in the given statuses. */
function fairValueAdjustments(ctx: MockContext, statuses: string[]): Map<string, bigint> {
	const out = new Map<string, bigint>();
	for (const { payload } of proposalsOf(ctx, 'journal_entry', statuses)) {
		for (const [id, minor] of Object.entries(payload.adjustments ?? {})) out.set(id, (out.get(id) ?? 0n) + toBig(minor));
	}
	return out;
}

/** Interest a note earns from where its booked interest stops (or its funding date) through today. */
function interestDue(ctx: MockContext, note: { id: string; principalMinor: string; interestBp?: number }): { from: string; to: string; days: number; minor: bigint } | null {
	const funded = fundedDates(ctx.t.proposal).get(note.id);
	if (!funded) return null;
	const from = bookedInterest(ctx, note.id).to ?? funded.slice(0, 10);
	const to = bookingEnd(ctx);
	const days = daysBetween(from, to);
	return { from, to, days, minor: accruedInterestMinor(toBig(note.principalMinor), note.interestBp ?? 0, from, to) };
}

function attach(ctx: MockContext, instrumentId: string, doc: UploadedDocument) {
	const i = ins(ctx, instrumentId);
	if (i && !i.documentIds.includes(doc.id)) {
		i.documentIds = [...i.documentIds, doc.id];
		ctx.update('instrument', i);
	}
}

/** Money for an instrument has landed: the commitment, the register and the cap table catch up. */
function funded(ctx: MockContext, instrumentId: string, receivedMinor: bigint, status: Commitment['status'], notePlain?: string) {
	const c = cm(ctx, instrumentId);
	if (c) {
		c.receivedMinor = (toBig(c.receivedMinor) + receivedMinor).toString();
		c.status = status;
		if (notePlain) c.notePlain = notePlain;
		ctx.update('commitment', c);
	}
	const i = ins(ctx, instrumentId);
	if (!i) return;
	if (i.status === 'draft') {
		i.status = 'outstanding';
		ctx.update('instrument', i);
	}
	const security = i.kind === 'convertible_note' ? 'note' : 'safe';
	if (!ctx.t.cap_table_entry.some((e) => e.investorId === i.investorId && (e.security === security || e.security === 'preferred'))) {
		ctx.insert('cap_table_entry', { id: ctx.id('ct'), holderName: nameOf(ctx, i.investorId), investorId: i.investorId, security, shares: 0, investedMinor: i.principalMinor, ccy: i.ccy, asOf: ctx.now() });
	}
}

function wire(ctx: MockContext, row: Omit<BankTransaction, 'id' | 'matched' | 'ym'>): BankTransaction {
	return ctx.insert('bank_transaction', { ...row, id: ctx.id('bt'), ym: row.bookedAt.slice(0, 7), matched: false });
}
function matchWire(ctx: MockContext, btId: string) {
	const b = ctx.t.bank_transaction.find((x) => x.id === btId);
	if (b && !b.matched) {
		b.matched = true;
		ctx.update('bank_transaction', b);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Closing tracker: the first close's wires

/** What the tracker says arrived on October 1, and who has not paid. */
function trackerState(ctx: MockContext) {
	const due = (id: string) => {
		const c = cm(ctx, id);
		return c && toBig(c.receivedMinor) === 0n && c.status !== 'withdrawn';
	};
	return { harrow: due('ins-harrow'), orrin: due('ins-orrin'), fenwick: due('ins-fenwick'), fenwickSigned: cm(ctx, 'ins-fenwick')?.status !== 'committed' };
}

const closingTracker: UploadHandler = {
	kind: 'closing_tracker',
	fileName: 'Luyten Seed 2026 closing tracker, first close.xlsx',
	sizeBytes: 48_212,
	readByRole: 'funding',
	read(ctx) {
		const s = trackerState(ctx);
		const flags: string[] = [];
		if (s.harrow) flags.push('Harrow Lane Capital sent $999,965 against a $1,000,000 SAFE. A bank on the way took a $35 wire fee; the $35 is still owed by them, so someone should ask for it or agree to waive it.');
		if (s.fenwick) flags.push("Fenwick Row Ventures paid £156,250 into Cafoo Ltd's pound account, but the SAFE is Cafoo Inc's. Cafoo Ltd now owes that money to Cafoo Inc until it is moved.");
		if (s.fenwick && !s.fenwickSigned) flags.push("Fenwick Row's money arrived before their signed SAFE is on file. Upload the signed SAFE so the register has its terms.");
		flags.push('Brightwater Family Office promised its $250,000 by 30 September and has not sent it.');
		const arrived = [s.harrow && 'Harrow Lane', s.orrin && 'Orrin', s.fenwick && 'Fenwick Row'].filter(Boolean);
		return {
			extracted: {
				round: 'Seed 2026',
				close: 'First close, 1 October 2026',
				rows: [
					{ investor: 'Harrow Lane Capital', instrument: 'Post-money SAFE', committed: '1,000,000.00 USD', received: '999,965.00 USD', payer: 'HLC FUND II', note: 'Intermediary fee 35.00' },
					{ investor: 'Orrin Strategic Partners', instrument: 'Convertible note 6%', committed: '1,000,000.00 USD', received: '1,000,000.00 USD', payer: 'Orrin Strategic Partners Inc' },
					{ investor: 'Fenwick Row Ventures', instrument: 'Post-money SAFE', committed: '200,000.00 USD (156,250.00 GBP)', received: '156,250.00 GBP to Cafoo Ltd', payer: 'Fenwick Row Ventures Ltd' },
					{ investor: 'Tidewater Angels', instrument: 'Post-money SAFE', committed: '550,000.00 USD', received: '0.00', note: 'SPV closing 7 Oct' },
					{ investor: 'Brightwater Family Office', instrument: 'Post-money SAFE', committed: '250,000.00 USD', received: '0.00', note: 'Overdue since 30 Sep' }
				]
			},
			summaryPlain: arrived.length
				? `The tracker shows money from ${arrived.join(', ')} on October 1. The Funding desk matched each wire to its investor and proposes recording it as money owed back in shares, not income.`
				: 'The tracker matches what is already recorded. Nothing new arrived.',
			flagsPlain: flags
		};
	},
	apply(ctx) {
		const s = trackerState(ctx);
		const ids: string[] = [];
		const at = '2026-10-01T15:20:00Z';
		const b = ctx.t.commitment.find((c) => c.id === 'cm-brightwater');
		if (b && toBig(b.receivedMinor) === 0n && b.status !== 'overdue') {
			b.status = 'overdue';
			b.notePlain = 'Wire promised by 30 September and not yet arrived.';
			ctx.update('commitment', b);
		}

		if (s.harrow && !alreadyProposed(ctx, 'funding_receipt', 'ins-harrow')) {
			const bt = wire(ctx, { subsidiaryId: SUBSIDIARY_ID, bookedAt: at, amountMinor: '99996500', ccy: 'USD', description: 'INCOMING WIRE HLC FUND II REF SEED SAFE CAFOO', counterparty: 'HLC FUND II' });
			ids.push(
				ctx.propose({
					kind: 'funding_receipt',
					proposerRole: 'funding',
					amountMinor: '100000000',
					summaryPlain: "Record Harrow Lane Capital's $1,000,000 SAFE: $999,965 arrived, and the $35 a bank took on the way is still owed by them. It is money we may owe back in shares, not income.",
					rationale: "Payer HLC FUND II is on file for Harrow Lane Capital. Received 999,965.00 against 1,000,000.00 committed; the 35.00 gap is an intermediary bank fee, held as subscription receivable until collected or waived.",
					payload: { key: 'ins-harrow', instrumentId: 'ins-harrow', fundedAt: FIRST_CLOSE, commitmentId: 'cm-harrow', bankTransactionId: bt.id, memo: 'Harrow Lane Capital SAFE received, $35 short after a wire fee', lines: [L('1000', '99996500', '0'), L('1060', '3500', '0'), L('2600', '0', '100000000')] },
					body: `${bt.id} +999,965.00 'HLC FUND II' matched to cm-harrow (payer name on file). Shortfall 35.00 = intermediary fee. Dr 1000 999,965.00 / Dr 1060 Subscriptions receivable 35.00 / Cr 2600 SAFEs 1,000,000.00.`,
					critique: { summary: 'The Red Team asked whether the $35 should just be expensed.', body: 'Why carry 35.00 as a receivable instead of expensing it to 6400? The SAFE says the purchase amount is 1,000,000.00; if the investor never tops up, the receivable is overstated.' },
					onApproved: (c) => {
						matchWire(c, bt.id);
						funded(c, 'ins-harrow', 99_996_500n, 'short', '$35 short: a bank took a wire fee on the way. Ask Harrow Lane to top up or waive it.');
					}
				})
			);
		}

		if (s.orrin && !alreadyProposed(ctx, 'funding_receipt', 'ins-orrin')) {
			const bt = wire(ctx, { subsidiaryId: SUBSIDIARY_ID, bookedAt: at, amountMinor: '100000000', ccy: 'USD', description: 'FEDWIRE CREDIT ORRIN STRATEGIC PARTNERS INC NOTE PURCHASE', counterparty: 'Orrin Strategic Partners Inc' });
			ids.push(
				ctx.propose({
					kind: 'funding_receipt',
					proposerRole: 'funding',
					amountMinor: '100000000',
					summaryPlain: "Record Orrin Strategic Partners' $1,000,000 convertible note. It is a loan that turns into shares later, not income; interest starts today.",
					rationale: 'Exact amount from the payer on file. The note is a liability at amortized cost; 6% simple interest accrues from the funding date.',
					payload: { key: 'ins-orrin', instrumentId: 'ins-orrin', fundedAt: FIRST_CLOSE, commitmentId: 'cm-orrin', bankTransactionId: bt.id, memo: 'Orrin Strategic Partners convertible note received', lines: [L('1000', '100000000', '0'), L('2650', '0', '100000000')] },
					body: `${bt.id} +1,000,000.00 'Orrin Strategic Partners Inc' matched to cm-orrin. Dr 1000 / Cr 2650 Convertible notes 1,000,000.00. Interest from 2026-10-01.`,
					onApproved: (c) => {
						matchWire(c, bt.id);
						funded(c, 'ins-orrin', 100_000_000n, 'funded', 'Funded 1 October. 6% a year, matures 1 October 2028.');
					}
				})
			);
		}

		if (s.fenwick && !alreadyProposed(ctx, 'funding_receipt', 'ins-fenwick-uk')) {
			const usd = gbpToUsd(ctx, 15_625_000n);
			const bt = wire(ctx, { subsidiaryId: UK, bookedAt: at, amountMinor: '15625000', ccy: 'GBP', description: 'FPS CREDIT FENWICK ROW VENTURES LTD CAFOO SAFE', counterparty: 'Fenwick Row Ventures Ltd' });
			ids.push(
				ctx.propose({
					kind: 'funding_receipt',
					proposerRole: 'funding',
					amountMinor: usd.toString(),
					summaryPlain: "Record the £156,250 Fenwick Row Ventures paid into Cafoo Ltd's account as money Cafoo Ltd holds for Cafoo Inc, whose SAFE it bought.",
					rationale: 'The SAFE is issued by Cafoo Inc; the investor paid in pounds to the UK account. Cafoo Ltd books the cash and an intercompany payable; Cafoo Inc books the SAFE.',
					payload: { key: 'ins-fenwick-uk', instrumentId: 'ins-fenwick', commitmentId: 'cm-fenwick', bankTransactionId: bt.id, memo: 'Fenwick Row SAFE money received in pounds for Cafoo Inc', lines: [L('1000-UK', '15625000', '0'), L('2900-UK', '0', '15625000')] },
					body: `${bt.id} +156,250.00 GBP 'Fenwick Row Ventures Ltd' to Cafoo Ltd. Dr 1000-UK / Cr 2900-UK Due to Cafoo Inc 156,250.00 GBP (= ${money(usd).slice(1)} USD at 1.2800).`,
					onApproved: (c) => matchWire(c, bt.id)
				})
			);
		}
		if (s.fenwick && !alreadyProposed(ctx, 'funding_receipt', 'ins-fenwick')) {
			ids.push(
				ctx.propose({
					kind: 'funding_receipt',
					proposerRole: 'funding',
					amountMinor: '20000000',
					summaryPlain: "Record Fenwick Row Ventures' $200,000 SAFE in Cafoo Inc, with the money held for it by Cafoo Ltd. Not income.",
					rationale: 'Purchase amount 200,000.00 USD per the SAFE, settled as 156,250.00 GBP at 1.2800. Cafoo Inc records the SAFE and a receivable from Cafoo Ltd; the pair eliminates on consolidation.',
					payload: { key: 'ins-fenwick', instrumentId: 'ins-fenwick', fundedAt: FIRST_CLOSE, commitmentId: 'cm-fenwick', memo: 'Fenwick Row SAFE, money held by Cafoo Ltd', lines: [L('1900', '20000000', '0'), L('2600', '0', '20000000')] },
					body: 'Dr 1900 Due from Cafoo Ltd 200,000.00 / Cr 2600 SAFEs 200,000.00. Pairs with the Cafoo Ltd entry above.',
					onApproved: (c) => funded(c, 'ins-fenwick', 15_625_000n, 'funded', "Paid £156,250 into Cafoo Ltd's account; Cafoo Ltd owes it to Cafoo Inc.")
				})
			);
		}
		return ids;
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Wire confirmation: the SPV's money under a name we did not have

const PAYER = 'TWA SERIES 14 LLC';
const wireConfirmation: UploadHandler = {
	kind: 'wire_confirmation',
	fileName: 'Wire confirmation TWA SERIES 14 LLC 550,000.00 USD.pdf',
	sizeBytes: 91_544,
	readByRole: 'funding',
	read(ctx) {
		const known = inv(ctx, 'inv-tidewater')?.payerNames.includes(PAYER);
		const c = cm(ctx, 'ins-tidewater');
		const done = c && toBig(c.receivedMinor) > 0n;
		return {
			extracted: { sender: PAYER, senderBank: 'First Meridian Trust', amount: '550,000.00 USD', charges: 'OUR (sender paid all fees)', valueDate: '2026-10-02', reference: 'TIDEWATER ANGELS SPV / CAFOO SEED SAFE', beneficiary: 'Cafoo Inc' },
			summaryPlain: done
				? "Tidewater Angels' wire is already recorded."
				: "A $550,000 wire from TWA Series 14 LLC, the SPV Tidewater Angels invests through. The Funding desk matched it to Tidewater's SAFE by amount and reference.",
			flagsPlain: done || known ? [] : [`The money came from "${PAYER}", a name not on file for Tidewater Angels. The reference and the exact amount point to them; a person should confirm the SPV is theirs before it is recorded.`]
		};
	},
	apply(ctx) {
		const c = cm(ctx, 'ins-tidewater');
		if (!c || toBig(c.receivedMinor) > 0n || alreadyProposed(ctx, 'funding_receipt', 'ins-tidewater')) return [];
		const bt = wire(ctx, { subsidiaryId: SUBSIDIARY_ID, bookedAt: '2026-10-02T14:05:00Z', amountMinor: '55000000', ccy: 'USD', description: `INCOMING WIRE ${PAYER} REF TIDEWATER ANGELS SPV`, counterparty: PAYER });
		return [
			ctx.propose({
				kind: 'funding_receipt',
				proposerRole: 'funding',
				amountMinor: '55000000',
				summaryPlain: "Record Tidewater Angels' $550,000 SAFE, paid through their SPV under the name TWA Series 14 LLC. Money owed back in shares, not income.",
				rationale: `Payer ${PAYER} is not on file. Matched on exact amount (550,000.00 = commitment), the reference "TIDEWATER ANGELS SPV", and the closing tracker's note that the SPV closes this week. Sender paid all fees.`,
				payload: { key: 'ins-tidewater', instrumentId: 'ins-tidewater', fundedAt: '2026-10-02T00:00:00Z', commitmentId: c.id, bankTransactionId: bt.id, payerName: PAYER, memo: 'Tidewater Angels SAFE received via TWA Series 14 LLC', lines: [L('1000', '55000000', '0'), L('2600', '0', '55000000')] },
				body: `${bt.id} +550,000.00 '${PAYER}' -> cm-tidewater. Name mismatch; amount and reference exact. Dr 1000 / Cr 2600 SAFEs 550,000.00. Adds ${PAYER} to Tidewater's payer names once approved.`,
				critique: { summary: 'The Red Team checked the payer is really Tidewater.', body: `"${PAYER}" is not a payer name on file. Amount and reference match only one open commitment, so the risk of a wrong match is low, but a person should confirm the SPV before money from an unknown sender is booked to an investor.` },
				onApproved: (x) => {
					matchWire(x, bt.id);
					const i = inv(x, 'inv-tidewater');
					if (i && !i.payerNames.includes(PAYER)) {
						i.payerNames = [...i.payerNames, PAYER];
						x.update('investor', i);
					}
					funded(x, 'ins-tidewater', 55_000_000n, 'funded', `Funded 2 October through the SPV, ${PAYER}.`);
				}
			})
		];
	}
};

// ---------------------------------------------------------------------------------------------------------------
// SAFE: Fenwick Row's signed post-money SAFE, paid in pounds

const safe: UploadHandler = {
	kind: 'safe',
	fileName: 'Fenwick Row Ventures post-money SAFE, Cafoo Inc, signed.pdf',
	sizeBytes: 214_903,
	readByRole: 'capital',
	read() {
		return {
			extracted: { form: 'Post-money valuation cap SAFE (standard form)', company: 'Cafoo Inc', investor: 'Fenwick Row Ventures Ltd', purchaseAmount: '200,000.00 USD', paymentTerms: 'Payable in GBP at the spot rate on the payment date, to an account the Company names', valuationCap: '24,000,000.00 USD post-money', discount: 'None', mfn: 'No', proRata: 'Yes (side letter)', signedAt: '2026-10-01', governingLaw: 'Delaware', counselFees: '8,400.00 USD (company counsel, SAFE paperwork for the round)' },
			summaryPlain: "Fenwick Row's $200,000 post-money SAFE at a $24M cap. The Capital accountant records it as a liability, because a SAFE can pay out cash if the company is sold first, and the lawyers' bill for the SAFEs as an expense.",
			flagsPlain: ["The SAFE is in dollars but lets Fenwick Row pay in pounds into an account Luyten names. They paid into Cafoo Ltd's account, so the two companies owe each other $200,000 until it is moved. A person should decide when to move it."]
		};
	},
	apply(ctx, doc) {
		attach(ctx, 'ins-fenwick', doc);
		const ids: string[] = [];
		if (!alreadyProposed(ctx, 'instrument_record', 'safe-ins-fenwick')) {
			const k = classify('safe_post_money');
			ids.push(
				ctx.propose({
					kind: 'instrument_record',
					proposerRole: 'capital',
					amountMinor: '20000000',
					summaryPlain: "Add Fenwick Row's $200,000 SAFE to the register as a liability. No money moves with this; it records the terms.",
					rationale: `Standard post-money SAFE, $24M cap, no discount. ${k.plain}`,
					payload: { key: 'safe-ins-fenwick', instrumentId: 'ins-fenwick', documentId: doc.id, classification: k.classification, valuationCapMinor: '2400000000' },
					body: 'ins-fenwick: safe_post_money, principal 200,000.00 USD, cap 24,000,000.00 post, discountBp 0, proRata true. ASC 480-10: obligation to transfer assets on a liquidity event -> liability at fair value. No journal lines.',
					onApproved: (c) => {
						const i = ins(c, 'ins-fenwick');
						if (i) {
							Object.assign(i, { signedAt: '2026-10-01T00:00:00Z', proRata: true, classification: k.classification, classificationPlain: k.plain });
							c.update('instrument', i);
						}
						const m = cm(c, 'ins-fenwick');
						if (m && m.status === 'committed') {
							m.status = 'signed';
							c.update('commitment', m);
						}
					}
				})
			);
		}
		if (!alreadyProposed(ctx, 'journal_entry', 'safe-counsel-fees')) {
			ids.push(
				ctx.propose({
					kind: 'journal_entry',
					proposerRole: 'capital',
					amountMinor: '840000',
					summaryPlain: "Expense the lawyers' $8,400 bill for the seed SAFE paperwork. Because SAFEs are carried at fair value, what it costs to issue them is an expense now, not a cut to what was raised.",
					rationale: 'Issuance costs of instruments measured at fair value through earnings are expensed as incurred (ASC 825-10-25-3). Accrued until the bill is paid.',
					payload: { key: 'safe-counsel-fees', memo: 'Counsel fees for the Seed 2026 SAFEs', lines: [L('6400', '840000', '0'), L('2100', '0', '840000')] },
					body: 'Issuance costs, SAFE paperwork Seed 2026: Dr 6400 Professional fees 8,400.00 / Cr 2100 Accrued expenses 8,400.00.'
				})
			);
		}
		return ids;
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Convertible note: Orrin's note, its terms and October's interest

const convertibleNote: UploadHandler = {
	kind: 'convertible_note',
	fileName: 'Orrin Strategic Partners convertible promissory note, USD 1,000,000.pdf',
	sizeBytes: 302_118,
	readByRole: 'capital',
	read(ctx) {
		const isFunded = ins(ctx, 'ins-orrin')?.status === 'outstanding';
		const held = isFunded && inPendingConversion(ctx).has('ins-orrin');
		return {
			extracted: { holder: 'Orrin Strategic Partners Inc', principal: '1,000,000.00 USD', interest: '6.00% simple, actual/365', maturity: '2028-10-01 (24 months)', valuationCap: '24,000,000.00 USD', discount: '20%', qualifiedFinancing: 'Equity round of at least 5,000,000.00 USD', atMaturity: 'Holder may convert at the cap or demand repayment', changeOfControl: '2x principal in cash, or conversion at the cap, at the holder’s choice' },
			summaryPlain: held
				? "Orrin's $1M note at 6% a year for 24 months. A conversion is waiting; interest is included in it, so none is booked separately."
				: isFunded
				? "Orrin's $1M note at 6% a year for 24 months. It stays a liability until it converts; October's interest is an expense, not a reduction of what was raised."
				: "Orrin's $1M note at 6% a year for 24 months. Interest starts when the money arrives; upload the closing tracker to record it.",
			flagsPlain: ['On a sale of the company before conversion, Orrin can take twice its principal in cash. That premium may need to be valued on its own; Luyten will not invent a number. Upload the valuation report, and a person decides.']
		};
	},
	apply(ctx, doc) {
		attach(ctx, 'ins-orrin', doc);
		const ids: string[] = [];
		const k = classify('convertible_note');
		if (!alreadyProposed(ctx, 'instrument_record', 'note-ins-orrin')) {
			ids.push(
				ctx.propose({
					kind: 'instrument_record',
					proposerRole: 'capital',
					amountMinor: '100000000',
					summaryPlain: "Add Orrin's $1,000,000 note to the register as a liability, with its 2x payout on a sale flagged for a person. No money moves with this.",
					rationale: `${k.plain} Change-of-control 2x premium flagged as a possible embedded derivative pending a fair value.`,
					payload: { key: 'note-ins-orrin', instrumentId: 'ins-orrin', documentId: doc.id, classification: k.classification },
					body: 'ins-orrin: convertible_note 1,000,000.00, 600 bp simple, maturity 2028-10-01, cap 24,000,000.00, discount 2000 bp. Liability at amortized cost; CoC 2x put flagged under ASC 815-15 for bifurcation review.',
					onApproved: (c) => {
						const i = ins(c, 'ins-orrin');
						if (i) {
							i.sideTermsPlain = 'On a sale of the company before conversion, Orrin can take twice its principal in cash.';
							i.classificationPlain = k.plain;
							c.update('instrument', i);
						}
					}
				})
			);
		}
		// Interest accrues to the day it is booked, never ahead of it. Nothing new while an accrual is still in debate.
		const note = ins(ctx, 'ins-orrin');
		const pending = proposalsOf(ctx, 'interest_accrual', ['open', 'awaiting_cfo']).some((x) => x.payload.instrumentId === 'ins-orrin');
		// A pending conversion already carries the note's interest through the day it was proposed.
		const due = note?.status === 'outstanding' && !pending && !inPendingConversion(ctx).has(note.id) ? interestDue(ctx, note) : null;
		if (due && due.minor > 0n && !alreadyProposed(ctx, 'interest_accrual', `interest-ins-orrin-${due.to}`)) {
			ids.push(
				ctx.propose({
					kind: 'interest_accrual',
					proposerRole: 'capital',
					amountMinor: due.minor.toString(),
					summaryPlain: `Book ${money(due.minor)} of interest Orrin's note has earned so far: ${due.days} day${due.days === 1 ? '' : 's'} since ${day(due.from)}. It is owed, not yet paid, and is an expense. The rest of the month is booked as it is earned.`,
					rationale: `1,000,000.00 x 6% x ${due.days} / 365, from ${due.from} up to ${due.to} (through today). Simple interest, paid or converted at the end; no interest is booked ahead of the day it is earned.`,
					payload: { key: `interest-ins-orrin-${due.to}`, instrumentId: 'ins-orrin', from: due.from, to: due.to, days: due.days, memo: `Interest on the Orrin note to ${due.to}`, lines: [L('7200', due.minor, '0'), L('2660', '0', due.minor)] },
					body: `Accrual ${due.from}..${due.to}: ${due.days}d x 600bp x 1,000,000.00 / 365 = ${money(due.minor).slice(1)}. Dr 7200 Interest expense / Cr 2660 Accrued interest on notes.`
				})
			);
		}
		return ids;
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Side letter: Brightwater's MFN

const sideLetter: UploadHandler = {
	kind: 'side_letter',
	fileName: 'Brightwater Family Office side letter, Seed 2026.pdf',
	sizeBytes: 88_730,
	readByRole: 'capital',
	read() {
		return {
			extracted: { investor: 'Brightwater Family Office', instrument: 'Post-money SAFE, 250,000.00 USD', mfn: 'If the Company issues another SAFE or convertible in this financing on better terms, the investor may elect those terms', proRata: 'Yes, in the next priced round', informationRights: 'Quarterly unaudited financials within 45 days of quarter end', other: 'Major investor status despite a check below the 500,000.00 threshold' },
			summaryPlain: "Brightwater's side letter gives them most-favoured-nation terms, a right to invest in the next round and quarterly financials. Nothing changes in the books; the register gets the extra rights.",
			flagsPlain: [
				"Most-favoured-nation clause: Orrin's note has a 20% discount the SAFEs don't. Brightwater may ask for the same discount, which would give them more shares at the Series A. A person should decide whether the note counts as a better SAFE.",
				'Brightwater is treated as a major investor although $250,000 is below the $500,000 threshold. A person should confirm the other investors were told.'
			]
		};
	},
	apply(ctx, doc) {
		attach(ctx, 'ins-brightwater', doc);
		if (alreadyProposed(ctx, 'instrument_record', 'side-ins-brightwater')) return [];
		const side = 'Most-favoured-nation: may take any better SAFE or convertible terms in this round (the note’s 20% discount is pending a person’s decision). Pro rata in the next round. Quarterly financials. Major investor status.';
		return [
			ctx.propose({
				kind: 'instrument_record',
				proposerRole: 'capital',
				amountMinor: '25000000',
				summaryPlain: "Note Brightwater's extra rights on their $250,000 SAFE: most-favoured-nation, pro rata and quarterly financials. No money moves; whether they get the note's 20% discount is left to a person.",
				rationale: 'Side letter terms recorded on the instrument. MFN does not change classification (still a liability). The election is not assumed: conversion maths keeps no discount until a person decides.',
				payload: { key: 'side-ins-brightwater', instrumentId: 'ins-brightwater', documentId: doc.id, mfn: true, proRata: true },
				body: 'ins-brightwater: mfn=true, proRata=true, info rights quarterly, major investor carve-out. MFN trigger candidate: ins-orrin discountBp 2000 > SAFE 0. Not applied; escalated to CFO.',
				onApproved: (c) => {
					const i = ins(c, 'ins-brightwater');
					if (i) {
						Object.assign(i, { mfn: true, proRata: true, sideTermsPlain: side });
						c.update('instrument', i);
					}
				}
			})
		];
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Valuation report: the 409A and the SAFEs' fair value

/** SAFEs and notes in the round's conversion that is in debate, waiting for the CFO or approved. */
function inPendingConversion(ctx: MockContext): Set<string> {
	const conv = conversionFor(ctx);
	const rows = conv ? ((payloadOf(conv.payloadJson).conversions as { instrumentId: string }[] | undefined) ?? []) : [];
	return new Set(rows.map((r) => r.instrumentId));
}

/** SAFEs on the books the report can restate: not restated already and not in a pending conversion (`held`). */
function restatable(ctx: MockContext) {
	const done = fairValueAdjustments(ctx, LIVE);
	const converting = inPendingConversion(ctx);
	const onBooks = ctx.t.instrument.filter((i) => i.roundId === SEED && i.kind === 'safe_post_money' && i.status === 'outstanding' && !done.has(i.id));
	return { fresh: onBooks.filter((i) => !converting.has(i.id)), held: onBooks.some((i) => converting.has(i.id)) };
}

const valuationReport: UploadHandler = {
	kind: 'valuation_report',
	fileName: 'Cafoo Inc 409A and SAFE fair value report, 2 October 2026.pdf',
	sizeBytes: 1_204_377,
	readByRole: 'capital',
	read(ctx) {
		const book = balance(ctx, '2600');
		const held = restatable(ctx).held;
		return {
			extracted: { preparer: 'Ashgrove Valuation Advisors', asOf: '2026-10-02', method: 'Probability-weighted expected return (Series A within 6 months 70%, later financing 20%, sale 10%)', commonFairValuePerShare: '$1.15', commonFairValuePerShareE4: '1150000', safeFairValueOfPurchaseAmount: '106.2%', safeFairValueBp: Number(SAFE_FV_BP), noteChangeOfControlPremium: '6,000.00 USD (management treats as immaterial)' },
			summaryPlain: held && !restatable(ctx).fresh.length
				? 'The report values the SAFEs at 106.2% of what was paid and common stock at $1.15 a share. The SAFEs on the books are in a conversion that is waiting, so they are not restated separately.'
				: book > 0n
				? `The report values the SAFEs at 106.2% of what was paid and common stock at $1.15 a share. The Capital accountant proposes moving the SAFEs on the books to that value; the change is a non-cash loss, not money out.`
				: 'The report values the SAFEs at 106.2% of what was paid and common stock at $1.15 a share. No SAFE money is on the books yet, so nothing to restate today.',
			flagsPlain: ["The report puts the note's 2x payout on a sale at $6,000 and calls it immaterial. Leaving it out of the books is a judgement a person should sign off."]
		};
	},
	apply(ctx, doc) {
		// Only SAFEs on the books that this report has not already restated.
		const { fresh } = restatable(ctx);
		const adjustments = Object.fromEntries(fresh.map((i) => [i.id, ((toBig(i.principalMinor) * (SAFE_FV_BP - 10_000n)) / 10_000n).toString()]));
		const delta = Object.values(adjustments).reduce((t, v) => t + toBig(v), 0n);
		const principal = fresh.reduce((t, i) => t + toBig(i.principalMinor), 0n);
		const key = `fv-${fresh.map((i) => i.id).join('+')}`;
		if (delta <= 0n || alreadyProposed(ctx, 'journal_entry', key)) return [];
		return [
			ctx.propose({
				kind: 'journal_entry',
				proposerRole: 'capital',
				amountMinor: delta.toString(),
				summaryPlain: `Restate ${fresh.length === 1 ? 'a SAFE' : `${fresh.length} SAFEs`} worth ${money(principal)} at the valuer's fair value, ${money(principal + delta)}. The ${money(delta)} increase is a non-cash loss on the P&L; no money moves.`,
				rationale: `Fair value from ${doc.fileName} (Ashgrove, 106.2% of purchase amount). SAFEs are liabilities at fair value through earnings; the change goes to 7300. Luyten does not estimate fair values itself.`,
				payload: { key, documentId: doc.id, instrumentIds: fresh.map((i) => i.id), adjustments, memo: 'SAFEs restated to fair value per the valuation report', lines: [L('7300', delta, '0'), L('2600', '0', delta)] },
				body: `${fresh.map((i) => `${i.id} ${money(i.principalMinor).slice(1)} x 1.062`).join('; ')}. Dr 7300 Change in fair value of SAFEs / Cr 2600 ${money(delta).slice(1)}.`
			})
		];
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Cap table export: one grant the register did not have

const capTable: UploadHandler = {
	kind: 'cap_table',
	fileName: 'Cafoo Inc cap table export 2026-10-02.csv',
	sizeBytes: 12_660,
	readByRole: 'capital',
	read(ctx) {
		const has = ctx.t.cap_table_entry.some((e) => e.employeeId === 'emp-08' && e.security === 'options_granted');
		const fd = fullyDilutedShares(ctx.t.cap_table_entry);
		return {
			extracted: { source: 'Cap table tool export', asOf: '2026-10-02', fullyDilutedShares: has ? Number(fd) : Number(fd), rowsAdded: has ? [] : [{ holder: 'Grace Liu', security: 'Options granted', shares: 25_000, boardConsent: '2026-09-30', strike: '$1.15' }] },
			summaryPlain: has
				? 'The export matches the register: same holders, classes and share counts.'
				: 'The export matches the register except one option grant: 25,000 options to Grace Liu, approved by the board on 30 September. The Capital accountant adds it out of the unallocated pool, so the fully diluted total does not change.',
			flagsPlain: has ? [] : ["Grace Liu's grant was approved by the board but never reached Luyten. A person should check the board consent is on file before her offer letter goes out."]
		};
	},
	apply(ctx) {
		if (ctx.t.cap_table_entry.some((e) => e.employeeId === 'emp-08' && e.security === 'options_granted')) return [];
		const pool = ctx.t.cap_table_entry.find((e) => e.security === 'option_pool');
		if (pool) {
			pool.shares = Math.max(0, pool.shares - 25_000);
			pool.asOf = ctx.now();
			ctx.update('cap_table_entry', pool);
		}
		ctx.insert('cap_table_entry', { id: ctx.id('ct'), holderName: 'Grace Liu', employeeId: 'emp-08', security: 'options_granted', shares: 25_000, investedMinor: '0', ccy: 'USD', asOf: '2026-09-30T00:00:00Z' });
		const e = ctx.t.employee.find((x) => x.id === 'emp-08');
		if (e && !e.optionsGranted) {
			e.optionsGranted = 25_000;
			ctx.update('employee', e);
		}
		ctx.message({ role: 'capital', kind: 'statement', body: 'Cap table export reconciled: +25,000 options_granted emp-08 (board consent 2026-09-30) from option_pool. Fully diluted unchanged.', summary: "Added Grace Liu's 25,000-option grant from the pool; the fully diluted total is unchanged." });
		return [];
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Term sheet: the Series A, and the SAFEs and note converting into it

/** Every Seed 2026 SAFE and note that will convert, priced on the term sheet's terms. */
function seriesAPlan(ctx: MockContext) {
	const converting = ctx.t.instrument.filter((i) => i.roundId === SEED && (i.status === 'outstanding' || i.status === 'draft'));
	const funded = fundedDates(ctx.t.proposal);
	const plan = roundPlan({
		capTable: ctx.t.cap_table_entry,
		converting,
		holderName: (id) => nameOf(ctx, id),
		fundedAt: (id) => funded.get(id),
		preMoneyMinor: SERIES_A_PRE_MONEY,
		newMoneyMinor: SERIES_A_NEW_MONEY,
		closeAt: SERIES_A_CLOSE
	});
	return { converting, plan, funded };
}

/** The round's conversion Proposal, if one is in debate, waiting for the CFO or approved. One per round. */
const conversionFor = (ctx: MockContext) => proposalsOf(ctx, 'instrument_conversion', LIVE).find((x) => x.payload.roundId === SERIES_A)?.p;

const termSheet: UploadHandler = {
	kind: 'term_sheet',
	fileName: 'Saltmarsh Partners Series A term sheet, Cafoo Inc.pdf',
	sizeBytes: 176_045,
	readByRole: 'capital',
	read(ctx) {
		const { plan } = seriesAPlan(ctx);
		return {
			extracted: { lead: 'Saltmarsh Partners', security: 'Series A preferred', investment: '12,000,000.00 USD', preMoney: '60,000,000.00 USD, including converting SAFEs and notes and the unallocated pool', liquidationPreference: '1x, non-participating', optionPool: 'Top up to 10% of post-money, inside the pre-money', board: 'One seat for Saltmarsh', legalFees: 'Company pays investor counsel up to 40,000.00 USD', expectedClose: '2026-12-15', pricePerShare: formatPriceE4(plan.roundPriceE4) },
			summaryPlain: `Saltmarsh Partners offers $12M at a $60M pre-money, about ${formatPriceE4(plan.roundPriceE4)} a share. The Seed SAFEs and note convert into Series A preferred at their $24M cap at the ${day(SERIES_A_CLOSE)} close. ${conversionFor(ctx) ? 'The conversion is already proposed; SAFEs funded since then convert at the close.' : 'The Capital accountant worked out the shares and proposes the conversion.'}`,
			flagsPlain: [
				'The term sheet tops the option pool up to 10% of the company after the round, counted inside the pre-money. That dilutes today’s holders, not Saltmarsh. Luyten has not modelled the top-up; a person should agree its size.',
				'Before the close the SAFEs must be valued again at the closing date. Luyten will not invent that fair value; upload the valuer’s update.',
				'Brightwater’s most-favoured-nation election on the note’s 20% discount is still open. The conversion assumes no discount for them.',
				'The company pays Saltmarsh’s legal fees up to $40,000. That is a cost of issuing the shares, set against paid-in capital, but nothing is booked until a bill arrives; a person should watch for it.'
			]
		};
	},
	apply(ctx, doc) {
		const { converting, plan } = seriesAPlan(ctx);
		let lead = inv(ctx, 'inv-saltmarsh');
		if (!lead) lead = ctx.insert('investor', { id: 'inv-saltmarsh', name: 'Saltmarsh Partners', kind: 'fund', country: 'US', payerNames: ['Saltmarsh Partners Fund III LP'], contactName: 'Imogen Tate' });
		let round = ctx.t.funding_round.find((r) => r.id === SERIES_A);
		if (!round) {
			round = ctx.insert('funding_round', { id: SERIES_A, subsidiaryId: SUBSIDIARY_ID, name: 'Series A 2026', targetMinor: SERIES_A_NEW_MONEY.toString(), ccy: 'USD', openedAt: ctx.now(), status: 'planned', leadInvestorId: lead.id, pricePerShareE4: plan.roundPriceE4.toString(), preMoneyMinor: SERIES_A_PRE_MONEY.toString() });
			ctx.insert('commitment', { id: 'cm-saltmarsh', roundId: SERIES_A, investorId: lead.id, amountMinor: SERIES_A_NEW_MONEY.toString(), ccy: 'USD', receivedMinor: '0', status: 'committed', expectedBy: SERIES_A_CLOSE, notePlain: 'Term sheet signed; closing documents in draft.' });
		} else {
			round.pricePerShareE4 = plan.roundPriceE4.toString();
			ctx.update('funding_round', round);
		}

		// One conversion per round. It books what is on the ledger now: SAFEs and notes whose money has arrived, each at its
		// own carrying amount (purchase amount plus approved fair-value changes; principal plus interest to today).
		const ready = converting.filter((i) => i.status === 'outstanding');
		if (!ready.length || conversionFor(ctx)) return [];
		const notesReady = ready.filter((i) => i.kind === 'convertible_note');
		if (proposalsOf(ctx, 'interest_accrual', ['open', 'awaiting_cfo']).some((x) => notesReady.some((n) => n.id === x.payload.instrumentId))) {
			ctx.message({ role: 'capital', kind: 'statement', body: 'Conversion held: an interest accrual on a converting note is still in debate.', summary: 'I will propose the conversion once the open interest accrual on the note is decided.' });
			return [];
		}
		const fvPending = fairValueAdjustments(ctx, ['open', 'awaiting_cfo']);
		if (ready.some((i) => fvPending.has(i.id))) {
			ctx.message({ role: 'capital', kind: 'statement', body: 'Conversion held: a fair-value restatement of a converting SAFE is still in debate.', summary: 'I will propose the conversion once the open fair-value change on the SAFEs is decided.' });
			return [];
		}
		const rows = plan.rows.filter((r) => ready.some((i) => i.id === r.id));
		const shares = rows.reduce((t, r) => t + r.shares, 0n);
		const fv = fairValueAdjustments(ctx, APPROVED);
		let safes = 0n;
		let notes = 0n;
		let accrued = 0n;
		let moreInterest = 0n;
		for (const i of ready) {
			if (i.kind === 'convertible_note') {
				notes += toBig(i.principalMinor);
				accrued += bookedInterest(ctx, i.id).total;
				const due = interestDue(ctx, i);
				if (due && due.minor > 0n) moreInterest += due.minor;
			} else {
				safes += toBig(i.principalMinor) + (fv.get(i.id) ?? 0n);
			}
		}
		const carrying = safes + notes + accrued + moreInterest;
		const par = parValueMinor(shares);
		const lines = [
			...(safes > 0n ? [L('2600', safes, '0')] : []),
			...(notes > 0n ? [L('2650', notes, '0')] : []),
			...(accrued > 0n ? [L('2660', accrued, '0')] : []),
			...(moreInterest > 0n ? [L('7200', moreInterest, '0')] : []),
			L('3200', '0', par),
			L('3300', '0', carrying - par)
		];
		const waiting = converting.filter((i) => i.status === 'draft').map((i) => nameOf(ctx, i.investorId));
		const nSafes = ready.length - notesReady.length;
		const what = [nSafes ? `${nSafes} SAFE${nSafes === 1 ? '' : 's'}` : '', notesReady.length ? `${notesReady.length === 1 ? 'the' : notesReady.length} note${notesReady.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
		return [
			ctx.propose({
				kind: 'instrument_conversion',
				proposerRole: 'capital',
				amountMinor: carrying.toString(),
				summaryPlain: `Convert ${what}, worth ${money(carrying)} on the books, into ${shares.toLocaleString('en-US')} Series A preferred shares. This would post at the ${day(SERIES_A_CLOSE)} close; what we owed becomes equity, and nothing here is income.${waiting.length ? ` ${waiting.join(' and ')} will convert at the close once their money arrives.` : ''}`,
				rationale: `Term sheet ${doc.fileName}: $60M pre-money including converting securities, price ${formatPriceE4(plan.roundPriceE4)}. Each converts at min(cap price, discounted price) = cap. Carrying amounts are as of today: interest only to today, fair values only as approved. In practice this posts on the closing date, ${SERIES_A_CLOSE.slice(0, 10)}; the demo books it when approved. Saltmarsh's legal fees are not booked until billed.`,
				payload: {
					key: `convert-${SERIES_A}`,
					roundId: SERIES_A,
					documentId: doc.id,
					priceE4: plan.roundPriceE4.toString(),
					conversions: rows.map((r) => ({ instrumentId: r.id, holder: r.holderName, amountMinor: r.amountMinor.toString(), priceE4: r.priceE4.toString(), basis: r.basis, shares: r.shares.toString() })),
					memo: 'Seed SAFEs and note converted into Series A preferred',
					lines
				},
				body: `Series A: V=60,000,000.00, C=${plan.capitalization.toLocaleString('en-US')} sh, P=${formatPriceE4(plan.roundPriceE4)}. ${rows.map((r) => `${r.id} ${money(r.amountMinor).slice(1)} @ ${formatPriceE4(r.priceE4)} (${r.basis}) = ${r.shares.toLocaleString('en-US')} sh`).join('; ')}. Carrying: SAFEs ${money(safes).slice(1)}, notes ${money(notes).slice(1)}, interest ${money(accrued + moreInterest).slice(1)}. Dr 2600/2650/2660${moreInterest > 0n ? '/7200' : ''}, Cr 3200 par ${money(par).slice(1)}, Cr 3300 remainder.`,
				critique: { summary: 'The Red Team questioned converting before the round closes.', body: 'Conversion happens at the Series A close, not at the term sheet. Posting now overstates equity and understates liabilities until 2026-12-15, and the SAFEs are not remeasured to fair value at the conversion date.' },
				onApproved: (c) => {
					for (const r of rows) {
						const i = ins(c, r.id);
						if (!i) continue;
						const k = classify(i.kind, 'converted');
						Object.assign(i, { status: 'converted', shares: Number(r.shares), classification: k.classification, classificationPlain: k.plain });
						c.update('instrument', i);
						const row = c.t.cap_table_entry.find((e) => e.investorId === i.investorId && (e.security === 'safe' || e.security === 'note'));
						if (row) {
							Object.assign(row, { security: 'preferred', shares: Number(r.shares), asOf: c.now() });
							c.update('cap_table_entry', row);
						}
					}
				}
			})
		];
	}
};

export const handlers: UploadHandler[] = [closingTracker, wireConfirmation, safe, convertibleNote, sideLetter, termSheet, capTable, valuationReport];

// ---------------------------------------------------------------------------------------------------------------
// Live: the cap table tool's closing tracker keeps moving. Status and notes only; money is never booked from here.

type Move = { when: (ctx: MockContext) => boolean; apply: (ctx: MockContext) => void };
const note = (ctx: MockContext, id: string, notePlain: string, status?: Commitment['status']) => {
	const c = ctx.t.commitment.find((x) => x.id === id);
	if (!c) return;
	c.notePlain = notePlain;
	if (status) c.status = status;
	ctx.update('commitment', c);
};
const unpaid = (ctx: MockContext, id: string) => {
	const c = ctx.t.commitment.find((x) => x.id === id);
	return !!c && toBig(c.receivedMinor) === 0n;
};
// Each move sets one commitment's note. A move is done once that note is showing, or once a later move for the same
// commitment is; the next tick plays the first move not done. Progress lives in the tables, so a reset starts clean.
type Step = Move & { id: string; notePlain: string };
const step = (id: string, notePlain: string, when: (ctx: MockContext) => boolean, status?: Commitment['status']): Step => ({ id, notePlain, when, apply: (c) => note(c, id, notePlain, status) });
const MOVES: Step[] = [
	step('cm-fenwick', 'Signed in the cap table tool; pounds to follow into Cafoo Ltd.', (c) => c.t.commitment.find((x) => x.id === 'cm-fenwick')?.status === 'committed', 'signed'),
	step('cm-tidewater', 'SPV capital call is 29 of 31 angels paid; wire expected 7 October.', (c) => unpaid(c, 'cm-tidewater')),
	step('cm-brightwater', "Brightwater's bank says the wire is queued for compliance review.", (c) => unpaid(c, 'cm-brightwater'), 'overdue'),
	step('cm-harrow', 'Harrow Lane will add the $35 fee to their next capital call.', (c) => c.t.commitment.find((x) => x.id === 'cm-harrow')?.status === 'short'),
	step('cm-saltmarsh', "Saltmarsh's counsel sent the first draft of the stock purchase agreement.", (c) => c.t.commitment.some((x) => x.id === 'cm-saltmarsh'), 'signed'),
	step('cm-tidewater', 'All 31 angels paid into the SPV; wire instructed from TWA Series 14 LLC.', (c) => unpaid(c, 'cm-tidewater'))
];
const stepDone = (ctx: MockContext, k: number) => {
	const showing = ctx.t.commitment.find((x) => x.id === MOVES[k].id)?.notePlain;
	return MOVES.some((m, j) => j >= k && m.id === MOVES[k].id && m.notePlain === showing);
};

export const tickers: LiveTicker[] = [
	{
		name: 'Closing tracker',
		everyMs: 22_000,
		integrationId: 'carta',
		tick(ctx) {
			const k = MOVES.findIndex((m, i) => !stepDone(ctx, i) && m.when(ctx));
			if (k < 0) return;
			MOVES[k].apply(ctx);
			ctx.synced('carta', 1);
		}
	}
];
