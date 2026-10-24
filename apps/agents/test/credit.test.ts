import { describe, expect, it } from 'vitest';
import { checkCall, HARNESSES } from '../src/harness';
import { call, ruleSuite } from './helpers';

const h = HARNESSES.credit;
const base = { periodYm: '2026-09', rationale: 'Tier C from a thin file at two bureaus; evidence tu_identity_verification R-1001.' };
const decision = (input: Record<string, unknown> = {}) =>
  call('mcp__credit__propose_credit_decision', {
    ...base,
    customerId: '7',
    tier: 'C',
    paymentTermsDays: 15,
    creditCheckRequestIds: ['R-1001', 'R-1002'],
    summaryPlain: "Bluefin Labs: shorten payment terms to fifteen days because the guarantor's credit file is thin.",
    ...input,
  });
const reserve = (input: Record<string, unknown> = {}) =>
  call('mcp__credit__propose_journal_entry', {
    ...base,
    memo: 'Allowance for doubtful accounts: Bluefin Labs (tier C)',
    amountMinor: '206400',
    lines: [
      { accountCode: '5700', debitMinor: '206400', creditMinor: '0', customerId: '7' },
      { accountCode: '1150', debitMinor: '0', creditMinor: '206400', customerId: '7' },
    ],
    summaryPlain: "Set aside $2,064 against the customer's unpaid invoices because the guarantor's credit file is thin.",
    ...input,
  });
const block = (rationale: string) =>
  call('mcp__credit__propose_vendor_block', { ...base, vendorId: '9', reasonPlain: 'Owner fails identity checks.', exposureMinor: '450000', rationale, summaryPlain: 'Block payments to Quickship Freight: the owner could not be verified.' });
const record = (input: Record<string, unknown> = {}) => {
  const requestId = String(input.requestId ?? 'R-1001');
  const product = String(input.product ?? 'credit_report:tu');
  return call('mcp__credit__record_credit_check', { subjectKind: 'customer', subjectId: '7', personaId: 'P03', product, requestId, summaryJson: JSON.stringify({ product, requestId }), tier: 'C', decision: 'REVIEW', ...input });
};
/** A run in which the agent recorded the gate products for customer 7 (and a BLOCK for vendor 9's owner). */
const recorded = [
  record({ product: 'tu_identity_verification', requestId: 'R-1001' }),
  record({ product: 'fraud_finder', requestId: 'R-1002' }),
  record({ product: 'credit_report:tu', requestId: 'R-1003' }),
  record({ subjectKind: 'vendor', subjectId: '9', personaId: 'P17', product: 'tu_identity_verification', requestId: 'R-2001', tier: 'BLOCK', decision: 'DECLINE' }),
];

const vendorCheck = (input: Record<string, unknown> = {}) =>
  call('mcp__credit__propose_vendor_verify', {
    ...base,
    rationale: "Owner identity passes and fraud is low; evidence tu_identity_verification R-3001, fraud_finder R-3002.",
    vendorId: '12',
    creditCheckRequestIds: ['R-3001', 'R-3002'],
    reasonPlain: "The owner's identity checks out and nothing looks like fraud.",
    summaryPlain: 'Mark Lumen Analytics as checked so their bills can be paid because the owner checks out.',
    ...input,
  });
const vendorRecord = (product: string, requestId: string, tier = 'A', decision = 'APPROVE', vendorId = '12') => record({ subjectKind: 'vendor', subjectId: vendorId, personaId: 'P01', product, requestId, tier, decision });
/** A clean owner check of vendor 12, plus a third-party product and a dirty check of vendor 13. */
const vendorRecorded = [
  vendorRecord('tu_identity_verification', 'R-3001'),
  vendorRecord('fraud_finder', 'R-3002'),
  vendorRecord('credit_report:tu', 'R-3003', 'B'),
  vendorRecord('tu_identity_verification', 'R-4001', 'C', 'REVIEW', '13'),
  vendorRecord('fraud_finder', 'R-4002', 'C', 'REVIEW', '13'),
];

ruleSuite(h, {
  'credit.may.1': {
    allow: [{ call: decision() }, { call: vendorCheck() }, { call: reserve() }, { call: reserve({ memo: 'Allowance for Doubtful Accounts: Bluefin Labs (tier C)' }) }, { call: block('2 open bill(s) worth $4,500 must not be paid.') }],
    deny: [
      { call: call('mcp__credit__propose_accrual', { ...base, memo: 'x', lines: [], amountMinor: '0' }), why: /vendor blocks, vendor checks and nothing else, not accruals/ },
      { call: reserve({ memo: 'Bad debt top-up' }), why: /reserves only/ },
      { call: reserve({ lines: [{ accountCode: '5700', debitMinor: '1', creditMinor: '0' }, { accountCode: '1100', debitMinor: '0', creditMinor: '1' }] }), why: /5700 and 1150/ },
    ],
  },
  'credit.never.1': {
    allow: [{ call: reserve() }],
    deny: [{ call: call('mcp__advisor__approve_proposal', { proposalId: '8' }), why: /posts to the ledger/ }],
  },
  'credit.never.2': {
    allow: [
      { call: call('mcp__credit__run_credit_cascade', { personaId: 'P20', subjectKind: 'vendor_owner' }) },
      { call: call('mcp__crs__crs_identity_verify', { personaId: 'p07' }) },
      { call: record() },
      { call: decision() },
      { call: decision(), ctx: { history: recorded } },
      // Ids compare as numbers: "07" is customer 7.
      { call: decision({ customerId: '07' }), ctx: { history: recorded } },
    ],
    deny: [
      { call: call('mcp__credit__run_credit_cascade', { personaId: 'Jane Doe 123-45-6789', subjectKind: 'customer_guarantor' }), why: /only persona ids/ },
      { call: call('mcp__crs__crs_cascade', { personaId: 'P21', subjectKind: 'customer_guarantor' }), why: /P21/ },
      { call: record({ requestId: '' }), why: /requestId is empty/ },
      { call: record({ summaryJson: JSON.stringify({ requestId: 'R-9' }) }), why: /must equal requestId R-1001/ },
      { call: record({ summaryJson: 'not json' }), why: /as JSON/ },
      { call: decision({ creditCheckRequestIds: [] }), why: /cites the request ids/ },
      { call: record({ personaId: 'p03' }), why: /upper case/ },
      { call: record({ subjectId: 'cust-7' }), why: /numeric customer or vendor id; got "cust-7"/ },
      { call: decision({ customerId: 'bluefin' }), why: /numeric customer id/ },
      { call: decision({ creditCheckRequestIds: ['R-1001', 'R-9999'] }), ctx: { history: recorded }, why: /not recorded: R-9999/ },
      { call: decision({ customerId: '8', creditCheckRequestIds: ['R-1001'] }), ctx: { history: recorded }, why: /for customer 8; not recorded: R-1001/ },
      { call: decision({ creditCheckRequestIds: ['R-1003'] }), ctx: { history: recorded.slice(2) }, why: /missing tu_identity_verification, fraud_finder/ },
    ],
  },
  'credit.never.4': {
    allow: [
      { call: block('2 open bill(s) worth $4,500 must not be paid.'), ctx: { history: recorded } },
      { call: call('mcp__credit__propose_vendor_block', { vendorId: '009', rationale: '1 open bill.' }), ctx: { history: recorded } },
      { call: block('1 open bill.') },
      { call: decision(), ctx: { history: [] } },
    ],
    deny: [
      { call: block('2 open bill(s) worth $4,500 must not be paid.'), ctx: { history: [] }, why: /tier BLOCK/ },
      { call: call('mcp__credit__propose_vendor_block', { vendorId: 'quickship', rationale: '1 open bill.' }), why: /numeric vendor id/ },
      { call: block('2 open bill(s) must not be paid.'), ctx: { history: [record({ subjectKind: 'vendor', subjectId: '9', personaId: 'P01', tier: 'A', decision: 'APPROVE' })] }, why: /vendor 9/ },
    ],
  },
  'credit.never.6': {
    allow: [
      { call: vendorCheck(), ctx: { history: vendorRecorded } },
      { call: vendorCheck({ vendorId: '012', creditCheckRequestIds: ['R-3001', 'R-3002', 'R-3003'] }), ctx: { history: vendorRecorded } },
      { call: vendorCheck() },
      { call: block('1 open bill.'), ctx: { history: [] } },
    ],
    deny: [
      { call: vendorCheck({ vendorId: 'lumen' }), why: /numeric vendor id/ },
      { call: vendorCheck({ creditCheckRequestIds: [] }), why: /cites the request ids/ },
      { call: vendorCheck(), ctx: { history: [] }, why: /not recorded: R-3001, R-3002/ },
      { call: vendorCheck({ creditCheckRequestIds: ['R-3001'] }), ctx: { history: vendorRecorded }, why: /missing fraud_finder for vendor 12/ },
      { call: vendorCheck({ vendorId: '13', creditCheckRequestIds: ['R-4001', 'R-4002'] }), ctx: { history: vendorRecorded }, why: /APPROVE at tier A or B; cited tu_identity_verification REVIEW at tier C/ },
      { call: vendorCheck({ vendorId: '13' }), ctx: { history: vendorRecorded }, why: /for vendor 13; not recorded: R-3001/ },
    ],
  },
  'credit.never.5': {
    allow: [{ call: call('mcp__credit__update_close_task', { taskId: '6', status: 'in_progress', note: 'running cascades' }) }],
    deny: [
      { call: call('mcp__advisor__approve_proposal', { proposalId: '8' }), why: /only the Advisor rules/ },
      { call: call('mcp__advisor__request_period_lock', { periodYm: '2026-09' }), why: /lock/ },
    ],
  },
  'credit.escalates.2': {
    allow: [{ call: block('Owner fails identity and fraud. 2 open bill(s) worth $4,500 must not be paid.') }, { call: block('Owner fails fraud. No payment has gone out yet.') }, { call: decision() }],
    deny: [{ call: block('Owner fails identity and fraud checks.'), why: /open bills/ }],
  },
  'credit.plain': {
    allow: [{ call: decision() }],
    deny: [
      { call: decision({ summaryPlain: 'Tier C: two tradelines and a FICO under 600.' }), why: /bureau jargon "tradelines"/ },
      { call: call('mcp__credit__propose_vendor_block', { vendorId: '9', reasonPlain: 'The owner came back as identity_fail.', summaryPlain: 'Block payments to Quickship Freight.' }), why: /reasonPlain: .*machine reason code/ },
    ],
  },
});

describe('credit harness as a whole', () => {
  it('lets well-formed calls through every rule', () => {
    for (const c of [decision(), reserve(), block('1 open bill worth $4,500 must not be paid.'), record(), call('mcp__crs__crs_personas', {})]) expect(checkCall(h, c, { history: recorded })).toEqual({ allow: true });
    expect(checkCall(h, vendorCheck(), { history: vendorRecorded })).toEqual({ allow: true });
  });
  it('keeps the CRS tools, which only Credit & Risk has', () => {
    expect(h.tools).toContain('mcp__crs__crs_cascade');
    expect(HARNESSES.bookkeeper.tools.some(t => t.startsWith('mcp__crs__'))).toBe(false);
  });
});
