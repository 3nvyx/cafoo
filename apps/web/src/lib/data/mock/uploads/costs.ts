// Demo behaviour for Cost of service and Batches: the September cloud bill and model-usage export, the October spend
// meters streaming from AWS, Vercel, OpenAI and Anthropic, credit packs being used up, and expiries that turn into
// breakage revenue or inventory write-offs. Rows here are operating records; anything that touches the books is a
// Proposal through ctx.propose.
import { serviceEngineering, unusedValue, type RateE6 } from '../../../costs';
import { formatMoney, toBig } from '../../money';
import type { Batch, CloudCost, CostCategory, CostProvider } from '../../types';
import type { ScriptLine } from '../script';
import type { LiveTicker, MockContext, UploadHandler } from './types';

const usd = (minor: bigint | string) => formatMoney(minor.toString(), { whole: false });
const L = (account: string, debitMinor: bigint | string, creditMinor: bigint | string, extra: Partial<ScriptLine> = {}): ScriptLine => ({
	account,
	debitMinor: debitMinor.toString(),
	creditMinor: creditMinor.toString(),
	...extra
});

/** `ym` when that Period exists and is not locked, so a September item joins the September close; else the open month. */
function periodFor(ctx: MockContext, ym: string): string | undefined {
	const p = ctx.t.period.find((x) => x.id === ym);
	return p && p.status !== 'closed' ? ym : undefined;
}

/** Whether a live (not rejected or superseded) Proposal already carries this payload source. */
function alreadyProposed(ctx: MockContext, source: string): boolean {
	return ctx.t.proposal.some((p) => p.status !== 'rejected' && p.status !== 'superseded' && p.payloadJson.includes(`"source":"${source}"`));
}

/** Average rates to US dollars from the recorded FX table. */
function rateFrom(ctx: MockContext): RateE6 {
	return (ccy, ym) => {
		if (ccy === 'USD') return 1_000_000n;
		const r = ctx.t.fx_rate.find((x) => x.fromCcy === ccy && x.toCcy === 'USD' && x.ym === ym && x.kind === 'average') ?? ctx.t.fx_rate.filter((x) => x.fromCcy === ccy && x.toCcy === 'USD').at(-1);
		return r ? BigInt(r.rateE6) : 1_000_000n;
	};
}

interface BillLine {
	provider: CostProvider;
	service: string;
	environment: CloudCost['environment'];
	category: CostCategory;
	amountMinor: string;
	usageQuantity: number;
	usageUnit: string;
	product?: string;
}

/** Inserts the bill's lines for month `ym`, or tags the matching rows already synced from the connected tool. */
function upsertLines(ctx: MockContext, ym: string, lines: BillLine[], documentId: string) {
	for (const l of lines) {
		const row = ctx.t.cloud_cost.find((r) => r.ym === ym && r.provider === l.provider && r.service === l.service && r.environment === l.environment);
		if (row) {
			Object.assign(row, { ...l, documentId });
			ctx.update('cloud_cost', row);
		} else {
			ctx.insert('cloud_cost', { id: ctx.id('cc'), subsidiaryId: 'sub-us', ym, ccy: 'USD', documentId, ...l });
		}
	}
}

const total = (lines: { amountMinor: string }[]) => lines.reduce((t, l) => t + toBig(l.amountMinor), 0n);

// ---------- Uploads ----------

const CUR_FILE = 'aws-cur-research-2026-09.csv';
/** September's direct research account: staging, experiments and datasets. Production runs through Brightline's bill (5000). */
const CUR_LINES: BillLine[] = [
	{ provider: 'aws', service: 'GPU experiments (p4d spot)', environment: 'development', category: 'r_and_d', amountMinor: '214000', usageQuantity: 505, usageUnit: 'GPU-hours' },
	{ provider: 'aws', service: 'EKS staging cluster', environment: 'staging', category: 'r_and_d', amountMinor: '70000', usageQuantity: 1520, usageUnit: 'instance-hours' },
	{ provider: 'aws', service: 'S3 training datasets', environment: 'development', category: 'r_and_d', amountMinor: '31000', usageQuantity: 13500, usageUnit: 'GB-month' }
];

const cloudBill: UploadHandler = {
	kind: 'cloud_bill',
	fileName: CUR_FILE,
	sizeBytes: 184_320,
	readByRole: 'bookkeeper',
	read: () => ({
		extracted: { provider: 'aws', account: 'Research (direct AWS account)', ym: '2026-09', ccy: 'USD', lines: CUR_LINES, totalMinor: total(CUR_LINES).toString() },
		summaryPlain: `AWS cost and usage report for September's research account: ${usd(total(CUR_LINES))} of staging, experiments and datasets, all R&D. The Bookkeeper books it and moves the service share of engineering pay to cost of revenue.`,
		flagsPlain: ['The $310.00 S3 training datasets line has no environment tag; booked as development (R&D).']
	}),
	apply(ctx, doc) {
		upsertLines(ctx, '2026-09', CUR_LINES, doc.id);
		const ids: string[] = [];
		const period = periodFor(ctx, '2026-09');
		if (!alreadyProposed(ctx, CUR_FILE)) {
			const amt = total(CUR_LINES);
			ids.push(
				ctx.propose({
					kind: 'cost_allocation',
					proposerRole: 'bookkeeper',
					amountMinor: amt.toString(),
					periodId: period,
					summaryPlain: `Book September's ${usd(amt)} research cloud bill as R&D, not cost of revenue.`,
					rationale: 'CUR lines are tagged staging and development; none serve customers. AWS invoices on the 3rd, so accrue it.',
					payload: { source: CUR_FILE, documentId: doc.id, ym: '2026-09', memo: 'September research AWS usage (R&D)', lines: [L('6100', amt, 0n), L('2100', 0n, amt)] },
					body: `PROPOSE cost_allocation from ${CUR_FILE}: ${CUR_LINES.length} lines, total ${usd(amt)}, environments staging/development. Dr 6100 / Cr 2100 ${usd(amt)}. Production hosting is on BCH-0920 (5000) and ties out.`,
					critique: {
						body: 'S3 training datasets (310.00) has no environment tag. Bucket prefix is research/; development is the right reading. No objection.',
						summary: 'Red Team checked the untagged storage line and agreed it belongs to R&D.'
					}
				})
			);
		}
		const svc = serviceEngineering(ctx.t.employee, '2026-09', rateFrom(ctx));
		const svcAmt = toBig(svc.totalMinor);
		if (svcAmt > 0n && !alreadyProposed(ctx, 'service-share-2026-09')) {
			ids.push(
				ctx.propose({
					kind: 'cost_allocation',
					proposerRole: 'bookkeeper',
					amountMinor: svcAmt.toString(),
					periodId: period,
					summaryPlain: `Move ${usd(svcAmt)} of September engineering and support pay to cost of revenue: the time ${svc.people.length} people spent running the live service.`,
					rationale: 'Each person’s service share (on-call, support, infrastructure) times their September employer cost, from the people records.',
					payload: {
						source: 'service-share-2026-09',
						ym: '2026-09',
						people: svc.people.map((p) => ({ employeeId: p.employee.id, serviceShareBp: p.employee.serviceShareBp, serviceMinor: p.serviceMinor })),
						memo: 'September service share of engineering pay',
						lines: [L('5250', svcAmt, 0n), L('6000', 0n, svcAmt)]
					},
					body: `PROPOSE cost_allocation: sum(employer cost x serviceShareBp) over ${svc.people.length} people for 2026-09 = ${usd(svcAmt)}. Dr 5250 / Cr 6000.`
				})
			);
		}
		return ids;
	}
};

const USAGE_FILE = 'model-usage-2026-09.csv';
const USAGE_LINES: BillLine[] = [
	{ provider: 'anthropic', service: 'Claude Sonnet chat', environment: 'production', category: 'cost_of_revenue', amountMinor: '528000', usageQuantity: 660, usageUnit: 'M tokens', product: 'Copilot' },
	{ provider: 'openai', service: 'GPT mini chat', environment: 'production', category: 'cost_of_revenue', amountMinor: '163800', usageQuantity: 1260, usageUnit: 'M tokens', product: 'Copilot' },
	{ provider: 'anthropic', service: 'Claude Haiku reminders', environment: 'production', category: 'cost_of_revenue', amountMinor: '90000', usageQuantity: 450, usageUnit: 'M tokens', product: 'Scheduling' },
	{ provider: 'openai', service: 'Embeddings', environment: 'production', category: 'cost_of_revenue', amountMinor: '27000', usageQuantity: 2700, usageUnit: 'M tokens', product: 'Insights' },
	{ provider: 'openai', service: 'Evals and fine-tuning', environment: 'development', category: 'r_and_d', amountMinor: '112000', usageQuantity: 260, usageUnit: 'M tokens' },
	{ provider: 'anthropic', service: 'Claude evals', environment: 'development', category: 'r_and_d', amountMinor: '76000', usageQuantity: 95, usageUnit: 'M tokens' }
];

const modelUsage: UploadHandler = {
	kind: 'model_usage',
	fileName: USAGE_FILE,
	sizeBytes: 96_256,
	readByRole: 'bookkeeper',
	read: () => {
		const prod = total(USAGE_LINES.filter((l) => l.category === 'cost_of_revenue'));
		const rd = total(USAGE_LINES.filter((l) => l.category === 'r_and_d'));
		return {
			extracted: { providers: ['openai', 'anthropic'], ym: '2026-09', ccy: 'USD', lines: USAGE_LINES, productionMinor: prod.toString(), rAndDMinor: rd.toString() },
			summaryPlain: `OpenAI and Anthropic usage for September by API key: ${usd(prod)} served customers (model inference) and ${usd(rd)} was evals and fine-tuning (R&D).`
		};
	},
	apply(ctx, doc) {
		upsertLines(ctx, '2026-09', USAGE_LINES, doc.id);
		if (alreadyProposed(ctx, USAGE_FILE)) return [];
		const prod = total(USAGE_LINES.filter((l) => l.category === 'cost_of_revenue'));
		const rd = total(USAGE_LINES.filter((l) => l.category === 'r_and_d'));
		const tokens = USAGE_LINES.filter((l) => l.category === 'cost_of_revenue' && l.product === 'Copilot').reduce((t, l) => t + l.usageQuantity, 0);
		const copilot = total(USAGE_LINES.filter((l) => l.category === 'cost_of_revenue' && l.product === 'Copilot'));
		return [
			ctx.propose({
				kind: 'cost_allocation',
				proposerRole: 'bookkeeper',
				amountMinor: (prod + rd).toString(),
				periodId: periodFor(ctx, '2026-09'),
				summaryPlain: `Book September's model usage: ${usd(prod)} to model inference (cost of revenue) and ${usd(rd)} of evals to R&D.`,
				rationale: 'Usage export split by API key: production keys serve Copilot, Scheduling and Insights; the eval keys are R&D. Billed in arrears, so accrued.',
				payload: {
					source: USAGE_FILE,
					documentId: doc.id,
					ym: '2026-09',
					copilotCostPerMMinor: ((copilot * 1000n) / BigInt(Math.round(tokens * 1000))).toString(),
					memo: 'September model usage (OpenAI, Anthropic)',
					lines: [L('5200', prod, 0n), L('6100', rd, 0n), L('2100', 0n, prod + rd)]
				},
				body: `PROPOSE cost_allocation from ${USAGE_FILE}: production keys ${usd(prod)} -> 5200, eval keys ${usd(rd)} -> 6100, Cr 2100 ${usd(prod + rd)}. Copilot ${tokens}M tokens at ${usd((copilot * 1000n) / BigInt(Math.round(tokens * 1000)))}/M.`,
				critique: {
					body: 'Embeddings (270.00) are production but serve Insights, not Copilot. Still cost of revenue, so 5200 holds; only the per-product view changes. No objection.',
					summary: 'Red Team checked which product each key serves and agreed with the split.'
				}
			})
		];
	}
};

export const handlers: UploadHandler[] = [cloudBill, modelUsage];

// ---------- Live tickers ----------

/** A small, repeatable wobble so the meters do not tick by the same amount every time. */
let step = 0;
const wobble = (base: number) => {
	step = (step + 1) % 7;
	return base * (0.75 + step * 0.08);
};

/** Adds spend and usage to this month's row for a service, creating the row on the month's first tick. */
function meter(ctx: MockContext, provider: CostProvider, service: string, dollars: number, usage: number, unit: string, product: string) {
	const ym = ctx.now().slice(0, 7);
	let row = ctx.t.cloud_cost.find((r) => r.ym === ym && r.provider === provider && r.service === service && r.environment === 'production');
	if (!row) row = ctx.insert('cloud_cost', { id: ctx.id('cc'), subsidiaryId: 'sub-us', provider, service, ym, environment: 'production', category: 'cost_of_revenue', amountMinor: '0', ccy: 'USD', usageQuantity: 0, usageUnit: unit, product });
	row.amountMinor = (toBig(row.amountMinor) + BigInt(Math.round(wobble(dollars) * 100))).toString();
	row.usageQuantity = Math.round((row.usageQuantity + wobble(usage)) * 10) / 10;
	ctx.update('cloud_cost', row);
}

const spend = (name: string, integrationId: CostProvider, everyMs: number, lines: [string, number, number, string, string][]): LiveTicker => ({
	name,
	integrationId,
	everyMs,
	tick(ctx) {
		for (const [service, dollars, usage, unit, product] of lines) meter(ctx, integrationId, service, dollars, usage, unit, product);
		ctx.synced(integrationId, lines.length);
	}
});

/** A customer's Copilot use draws down one of the live credit packs each tick. */
let packTurn = 0;
const creditConsumption: LiveTicker = {
	name: 'credit-consumption',
	integrationId: 'stripe',
	everyMs: 4000,
	tick(ctx) {
		const now = Date.parse(ctx.now());
		const live = ctx.t.batch.filter((b) => b.kind === 'credit_pack' && b.remaining > 0 && (!b.expiresAt || Date.parse(b.expiresAt) > now));
		if (!live.length) return;
		const b = live[packTurn++ % live.length];
		b.remaining = Math.max(0, Math.round((b.remaining - 1) * 10) / 10);
		if (b.remaining === 0) b.status = 'depleted';
		ctx.update('batch', b);
		ctx.synced('stripe');
	}
};

/** Packs and lots past their expiry with something left: the pack's unused credits become breakage revenue, the lot is written off. */
const expiryWatch: LiveTicker = {
	name: 'batch-expiry',
	everyMs: 5000,
	tick(ctx) {
		const now = ctx.now();
		for (const b of ctx.t.batch) {
			if (!b.expiresAt || b.expiresAt > now || b.remaining <= 0 || b.status === 'expired') continue;
			b.status = 'expired';
			ctx.update('batch', b);
			if (b.kind === 'credit_pack') proposeBreakage(ctx, b);
			else proposeWriteoff(ctx, b);
		}
	}
};

function proposeBreakage(ctx: MockContext, b: Batch) {
	const amt = toBig(unusedValue(b));
	if (amt <= 0n) return;
	const customer = ctx.t.customer.find((c) => c.id === b.customerId)?.name ?? 'the customer';
	const dispute = ctx.t.support_ticket.find((t) => t.customerId === b.customerId && t.status !== 'solved' && /credit/i.test(t.subject));
	ctx.propose({
		kind: 'credit_breakage',
		proposerRole: 'revenue',
		amountMinor: amt.toString(),
		periodId: periodFor(ctx, b.expiresAt!.slice(0, 7)),
		summaryPlain: `${customer}'s credit pack expired with ${b.remaining}M of ${b.quantity}M tokens unused: recognize ${usd(amt)} as breakage revenue.`,
		rationale: 'The pack terms say unused credits lapse at expiry and are not refundable, so the remaining customer-credit liability is earned now.',
		payload: { batchId: b.id, customerId: b.customerId, remaining: b.remaining, quantity: b.quantity, memo: `Credit breakage: ${customer}, ${b.name}`, lines: [L('2450', amt, 0n, { customerId: b.customerId }), L('4300', 0n, amt, { customerId: b.customerId })] },
		body: `PROPOSE credit_breakage ${b.id}: expiresAt ${b.expiresAt}, remaining ${b.remaining}/${b.quantity} ${b.unit}, paid ${usd(b.amountMinor)}. Unused value ${usd(amt)}. Dr 2450 / Cr 4300.`,
		critique: dispute
			? {
					body: `${customer} has an open ticket "${dispute.subject}" (${dispute.id}). If support grants a goodwill credit, part of this reverses. Not a reason to hold it: the terms are clear.`,
					summary: 'Red Team noted an open support ticket about credits, but agreed the breakage stands under the pack terms.'
				}
			: undefined
	});
}

function proposeWriteoff(ctx: MockContext, b: Batch) {
	const amt = toBig(unusedValue(b));
	if (amt <= 0n) return;
	const vendor = ctx.t.vendor.find((v) => v.id === b.vendorId)?.name;
	ctx.propose({
		kind: 'inventory_writeoff',
		proposerRole: 'bookkeeper',
		amountMinor: amt.toString(),
		periodId: periodFor(ctx, b.expiresAt!.slice(0, 7)),
		summaryPlain: `${b.remaining} ${b.name.toLowerCase()} passed their shelf life unsold: write off their ${usd(amt)} cost.`,
		rationale: 'Expired consumables cannot be sold or used; their cost leaves inventory as an expense.',
		payload: { batchId: b.id, vendorId: b.vendorId, remaining: b.remaining, memo: `Inventory write-off: ${b.name}`, lines: [L('6900', amt, 0n), L('1300', 0n, amt, b.vendorId ? { vendorId: b.vendorId } : {})] },
		body: `PROPOSE inventory_writeoff ${b.id} (${b.sku}${vendor ? `, ${vendor}` : ''}): ${b.remaining}/${b.quantity} ${b.unit} left at expiry ${b.expiresAt}. Cost on hand ${usd(amt)}. Dr 6900 / Cr 1300.`
	});
}

export const tickers: LiveTicker[] = [
	spend('aws-spend', 'aws', 5000, [
		['EC2 app servers', 1.9, 13, 'instance-hours', 'Scheduling'],
		['GPU inference (g5)', 1.7, 1.4, 'GPU-hours', 'Copilot'],
		['RDS Postgres', 0.95, 1.2, 'instance-hours', 'Scheduling']
	]),
	spend('vercel-spend', 'vercel', 8000, [['Web app hosting', 1.2, 4.8, 'GB bandwidth', 'Scheduling']]),
	spend('openai-usage', 'openai', 6000, [
		['GPT mini chat', 0.78, 0.6, 'M tokens', 'Copilot'],
		['Embeddings', 0.12, 1.2, 'M tokens', 'Insights']
	]),
	spend('anthropic-usage', 'anthropic', 7000, [
		['Claude Sonnet chat', 2.4, 0.3, 'M tokens', 'Copilot'],
		['Claude Haiku reminders', 0.4, 0.2, 'M tokens', 'Scheduling']
	]),
	creditConsumption,
	expiryWatch
];
