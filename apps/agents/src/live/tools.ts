/**
 * In-process MCP tool servers, one per role. Each server is bound to that role's database connection,
 * so the module sees the true caller identity and the two-tier gate holds even if a prompt misbehaves.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  buildRevenueSchedule,
  detectMissingAccruals,
  findDuplicatePayments,
  formatMinor,
  scoreBankMatches,
  specificReserveReasons,
  targetAllowanceMinor,
  ymToString,
  type RiskTier,
} from '@cafoo/ledger-core';
import { CrsClient, createCrsMcpServer, runCascade } from '@cafoo/crs-mcp';
import { exactAmount, snapshot } from '../snapshot';
import { propose, type Cast, type RoleConn } from '../stdb';

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });
const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });
const readOnly = { annotations: { readOnlyHint: true } };
/**
 * A row id as the module stores it: "012" becomes "12". Payloads are compared as strings downstream (evals, the web
 * app, the scripted close), so every id a tool forwards is sent canonical. Throws on a non-numeric id.
 */
const id = (v: string) => BigInt(v).toString();
const optId = (v: string | undefined) => (v ? id(v) : undefined);

const lineSchema = z.object({
  accountCode: z.string().describe('Chart of accounts code, e.g. 1000 Cash, 1100 Accounts Receivable, 2000 Accounts Payable (the line needs vendorId), 2400 Deferred Revenue, 4000 Subscription Revenue (credited only in a recognition entry, the line needs customerId), 4100 Usage Revenue'),
  debitMinor: z.string().describe('Debit in minor units (cents) as a decimal string, "0" if credit'),
  creditMinor: z.string().describe('Credit in minor units as a decimal string, "0" if debit'),
  customerId: z.string().optional(),
  vendorId: z.string().optional(),
  memo: z.string().optional(),
});

/** Read-only view of the books for every agent. Bound to the advisor's cache (it subscribes to all tables). */
export function booksServer(cast: Cast) {
  const A = cast.advisor;
  return createSdkMcpServer({
    name: 'books',
    version: '1.0.0',
    tools: [
      tool(
        'close_snapshot',
        'Everything an agent needs to start the close for a month: period, close tasks, unmatched bank transactions, open invoices and bills, contracts missing schedules, unrecognized schedule lines, customers with open receivables and their guarantor persona ids, unverified vendors, chart of accounts, materiality threshold.',
        { periodYm: z.string().describe('YYYY-MM') },
        async ({ periodYm }) => {
          try {
            const s = snapshot(A, periodYm);
            const unmatched = s.bankTxRows.filter(t => !t.matched && t.ym === periodYm).map(t => ({ id: t.id, bookedAt: new Date(Number(t.bookedAt.microsSinceUnixEpoch / 1000n)).toISOString().slice(0, 10), amount: money(t.amountMinor), amountMinor: t.amountMinor, description: t.description, counterparty: t.counterparty }));
            const openInvoices = [...A.db.invoice.iter()].filter(i => i.status.tag !== 'Paid').map(i => ({ id: i.id, number: i.number, customerId: i.customerId, customer: s.customerName.get(i.customerId), ym: i.ym, amount: money(i.amountMinor), status: i.status.tag }));
            const openBills = [...A.db.bill.iter()].filter(b => b.status.tag !== 'Paid').map(b => ({ id: b.id, externalRef: b.externalRef, vendorId: b.vendorId, vendor: s.vendorName.get(b.vendorId), ym: b.ym, billedAt: new Date(Number(b.billedAt.microsSinceUnixEpoch / 1000n)).toISOString().slice(0, 10), amount: money(b.amountMinor), expenseAccountCode: b.expenseAccountCode }));
            const subItems = s.items.filter(i => i.kind === 'subscription');
            const missingSchedules = s.contractRows.filter(k => k.plan.tag === 'Annual' && !s.scheduleLines.some(sl => subItems.some(i => i.id === sl.contractItemId && i.contractId === k.id))).map(k => ({ contractId: k.id, code: k.code, customerId: k.customerId, customer: s.customerName.get(k.customerId), startYm: k.startYm, endYm: k.endYm, total: money(k.totalMinor) }));
            const unrecognized: Record<string, string> = {};
            for (const sl of s.scheduleLines) if (sl.ym === periodYm && !sl.recognized) unrecognized[`${sl.customerId}:${s.customerName.get(sl.customerId)}`] = money(sl.amountMinor);
            const openAr = new Map<bigint, bigint>();
            for (const i of s.invoices) if (i.status !== 'paid') openAr.set(i.customerId, (openAr.get(i.customerId) ?? 0n) + i.amountMinor);
            const exposure = s.customers.filter(c => (openAr.get(c.id) ?? 0n) > 0n).map(c => ({ customerId: c.id, name: c.name, guarantorPersonaId: c.guarantorPersonaId, guarantorName: c.guarantorName, openReceivables: money(openAr.get(c.id)!), openReceivablesMinor: openAr.get(c.id)!, currentTier: c.creditTier ?? null, currentAllowance: money(c.allowanceMinor), paymentTermsDays: c.paymentTermsDays }));
            const vendors = s.vendors.map(v => ({ vendorId: v.id, name: v.name, category: v.category, verification: v.verification.tag, ownerPersonaId: v.ownerPersonaId ?? null }));
            return ok({
              period: { id: period(s), ym: periodYm, status: s.period.status.tag },
              subsidiaryId: s.subsidiary.id,
              materialityThreshold: money(s.materiality),
              closeTasks: s.closeTasks.map(t => ({ id: t.id, title: t.title, ownerRole: t.ownerRole, status: t.status.tag })),
              accounts: s.accounts.map(a => `${a.code} ${a.name} (${a.type})`),
              unmatchedBankTransactions: unmatched,
              openInvoices,
              openBills,
              contractsMissingSchedules: missingSchedules,
              unrecognizedScheduleLinesThisMonth: unrecognized,
              customersWithOpenReceivables: exposure,
              vendors,
            });
          } catch (e) {
            return fail((e as Error).message);
          }
        },
        readOnly
      ),
      tool(
        'list_proposals',
        'Proposals for a month with their status, the Red Team critiques, and the Advisor ruling if any.',
        { periodYm: z.string(), status: z.enum(['Open', 'AwaitingCfo', 'SentBack', 'Approved', 'Rejected', 'Amended', 'all']).optional() },
        async ({ periodYm, status }) => {
          const p = [...A.db.period.iter()].find(x => x.ym === periodYm);
          if (!p) return fail(`No period ${periodYm}`);
          const msgs = [...A.db.agentMessage.iter()];
          const rows = [...A.db.proposal.iter()]
            .filter(x => x.periodId === p.id && (!status || status === 'all' || x.status.tag === status))
            .sort((a, b) => Number(a.id - b.id))
            .map(x => ({
              id: x.id,
              kind: x.kind.tag,
              status: x.status.tag,
              proposer: x.proposerRole,
              amount: money(x.amountMinor),
              summaryPlain: x.summaryPlain,
              rationale: x.rationale,
              payload: JSON.parse(x.payloadJson),
              critiques: msgs.filter(m => m.proposalId === x.id && m.kind.tag === 'Critique').map(m => m.body),
              cfoNotes: msgs.filter(m => m.proposalId === x.id && m.senderRole === 'cfo').map(m => m.body),
            }));
          return ok(rows);
        },
        readOnly
      ),
      tool(
        'score_bank_matches',
        'Score every unmatched bank transaction of the month against open invoices and bills. Returns candidates with confidence in basis points and bucket: auto (>=7500), review (5000-7499), unmatched. Only candidates whose bank amount equals the invoice or bill exactly are listed as candidates (a bank match must be exact); near-amount ones are listed separately for a journal entry or a human.',
        { periodYm: z.string() },
        async ({ periodYm }) => {
          const s = snapshot(A, periodYm);
          const txs = s.bankTxs.filter(t => !t.matched && s.bankTxRows.find(r => r.id === t.id)?.ym === periodYm);
          const scored = scoreBankMatches(txs, s.invoices, s.bills, { customers: s.customerName, vendors: s.vendorName });
          const c = scored.filter(x => x.bucket === 'unmatched' || exactAmount(x, s));
          const nearAmount = scored.filter(x => x.bucket !== 'unmatched' && !exactAmount(x, s));
          const dups = findDuplicatePayments(txs, s.bills);
          return ok({ candidates: c, nearAmount, duplicatePayments: dups, unexplained: txs.filter(t => !scored.some(x => x.bankTxId === t.id && x.bucket !== 'unmatched')).map(t => ({ id: t.id, amountMinor: t.amountMinor, description: t.description, counterparty: t.counterparty })) });
        },
        readOnly
      ),
      tool(
        'detect_missing_accruals',
        'Bills whose service month is the close month but which were billed after month end and have no accrual yet. Returns ready-to-propose accrual entries.',
        { periodYm: z.string() },
        async ({ periodYm }) => {
          const s = snapshot(A, periodYm);
          const byVendor = new Map<bigint, bigint>();
          for (const b of A.db.bill.iter()) {
            const acct = s.accountByCode.get(b.expenseAccountCode);
            if (acct) byVendor.set(b.vendorId, acct.id);
          }
          const acc = detectMissingAccruals(s.bills, s.close, { subsidiaryId: s.subsidiary.id, periodId: s.period.id, expenseAccountId: s.accountByCode.get('5600')!.id, accruedLiabilitiesAccountId: s.accountByCode.get('2100')!.id, expenseAccountByVendor: byVendor });
          return ok(acc.map(a => ({ billId: a.billId, externalRef: s.bills.find(b => b.id === a.billId)?.externalRef ?? null, reversesInYm: ymToString(a.reversesInYm), lines: a.lines.map(l => ({ accountCode: s.accountById.get(l.accountId)?.code, debitMinor: l.debitMinor, creditMinor: l.creditMinor, memo: l.memo })) })));
        },
        readOnly
      ),
      tool(
        'build_revenue_schedule',
        'Straight-line ASC 606 schedule for a contract code: one line per month of the term, remainder to the last month.',
        { contractCode: z.string() },
        async ({ contractCode }) => {
          const row = [...A.db.contract.iter()].find(k => k.code === contractCode);
          if (!row) return fail(`No contract ${contractCode}`);
          const s = snapshot(A, [...A.db.period.iter()].find(p => p.status.tag !== 'Closed')?.ym ?? row.startYm);
          const contract = s.contracts.find(k => k.id === row.id)!;
          const item = s.items.find(i => i.contractId === row.id && i.kind === 'subscription');
          if (!item) return fail('Contract has no subscription item');
          const sched = buildRevenueSchedule(item, contract);
          return ok({ contractItemId: item.id, customerId: row.customerId, lines: sched.map(l => ({ ym: ymToString(l.ym), amountMinor: l.amountMinor })) });
        },
        readOnly
      ),
      tool(
        'allowance_target',
        'Expected-credit-loss target for a customer given a risk tier (A 1%, B 5%, C 10%, D 50%, BLOCK 100%) and the delta from the current allowance.',
        { customerId: z.string(), tier: z.enum(['A', 'B', 'C', 'D', 'BLOCK']), reasonCode: z.string().optional() },
        async ({ customerId, tier, reasonCode }) => {
          const c = A.db.customer.id.find(BigInt(customerId));
          if (!c) return fail('Unknown customer');
          let ar = 0n;
          for (const i of A.db.invoice.iter()) if (i.customerId === c.id && i.status.tag !== 'Paid') ar += i.amountMinor;
          const target = targetAllowanceMinor(ar, tier as RiskTier);
          const allowanceAcct = [...A.db.account.iter()].find(x => x.code === '1150');
          let current = 0n;
          for (const l of A.db.journalLine.iter()) if (allowanceAcct && l.accountId === allowanceAcct.id && l.customerId === c.id) current += l.creditMinor - l.debitMinor;
          return ok({ customer: c.name, openReceivablesMinor: ar, targetMinor: target, currentMinor: current, deltaMinor: target - current, becauseClause: reasonCode && reasonCode in specificReserveReasons ? specificReserveReasons[reasonCode as keyof typeof specificReserveReasons] : null });
        },
        readOnly
      ),
    ],
  });
}

/** Proposal tools bound to a worker's own identity. */
export function workerServer(worker: RoleConn, cast: Cast, extraTools: ReturnType<typeof tool>[] = []) {
  const A = cast.advisor;
  const common = { rationale: z.string().describe('Technical rationale with the evidence'), summaryPlain: z.string().describe('One sentence for a non-technical CFO: no account codes, amounts spelled out'), periodYm: z.string(), closeTaskId: z.string().optional() };
  const kindTool = (kind: 'journal_entry' | 'accrual', name: string, desc: string) =>
    tool(
      name,
      desc,
      { ...common, memo: z.string(), lines: z.array(lineSchema).min(2), amountMinor: z.string().describe('Total of the debits, minor units'), bankTxIds: z.array(z.string()).optional().describe('Bank transactions this entry explains; they get marked matched'), recognizeScheduleYm: z.string().optional().describe("Recognition entries only, and required for any net credit to 4000: the month (no later than periodYm) whose unrecognized subscription schedule lines this entry flips. Credit 4000 for each customer exactly that customer's unrecognized subscription lines through this month, tag every 4000 line with customerId, and leave out any customer whose revenue schedule proposal is still waiting for a ruling."), reversesInYm: z.string().optional().describe('Accruals only: a later open month in which the accrual reverses') },
      async a => {
        try {
          const s = snapshot(A, a.periodYm);
          const p = await propose(worker, A, { kind, payload: { subsidiaryId: s.subsidiary.id.toString(), periodYm: a.periodYm, memo: a.memo, lines: a.lines.map(l => ({ ...l, customerId: optId(l.customerId), vendorId: optId(l.vendorId), ccy: 'USD', fxRateE6: '1000000' })), bankTxIds: a.bankTxIds?.map(id), recognizeScheduleYm: a.recognizeScheduleYm, reversesInYm: a.reversesInYm }, rationale: a.rationale, summaryPlain: a.summaryPlain, amountMinor: BigInt(a.amountMinor), periodYm: a.periodYm, closeTaskId: a.closeTaskId ? BigInt(a.closeTaskId) : undefined });
          return ok({ proposalId: p.id, status: p.status.tag });
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    );
  const tools = [
    kindTool('journal_entry', 'propose_journal_entry', 'Propose a balanced journal entry for an open month (periodYm). It never posts by itself: the Advisor rules, and material amounts wait for the CFO. Every 2000 line names vendorId; a net credit to 4000 only in a recognition entry (recognizeScheduleYm); usage revenue goes to 4100; nothing may pay or settle a blocked vendor.'),
    kindTool('accrual', 'propose_accrual', 'Propose an accrual entry for work done this month but billed later; reversesInYm is a later open month, usually the following one. Every 2000 line names vendorId.'),
    tool(
      'propose_bank_match',
      'Propose matches between bank transactions and invoices or bills. Each match pays its invoice or bill to the cent, never a blocked vendor\'s bill; a bank transaction in another currency needs a recorded rate for its month first. Put all auto-confidence matches in one proposal; put each review-confidence match in its own proposal.',
      { ...common, matches: z.array(z.object({ bankTxId: z.string(), targetKind: z.enum(['invoice', 'bill']), targetId: z.string(), scoreBp: z.number().int() })).min(1) },
      async a => {
        try {
          const p = await propose(worker, A, { kind: 'bank_match', payload: { matches: a.matches.map(m => ({ ...m, bankTxId: id(m.bankTxId), targetId: id(m.targetId) })) }, rationale: a.rationale, summaryPlain: a.summaryPlain, amountMinor: 0n, periodYm: a.periodYm, closeTaskId: a.closeTaskId ? BigInt(a.closeTaskId) : undefined });
          return ok({ proposalId: p.id });
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    ),
    tool(
      'propose_revenue_schedule',
      "Propose recognition schedule lines for a contract item (from build_revenue_schedule): the customer's own subscription item, and never a month that item already has a line for.",
      { ...common, contractItemId: z.string(), customerId: z.string(), lines: z.array(z.object({ ym: z.string(), amountMinor: z.string() })).min(1), totalMinor: z.string() },
      async a => {
        try {
          const p = await propose(worker, A, { kind: 'revenue_schedule', payload: { lines: a.lines.map(l => ({ contractItemId: id(a.contractItemId), customerId: id(a.customerId), ym: l.ym, amountMinor: l.amountMinor })) }, rationale: a.rationale, summaryPlain: a.summaryPlain, amountMinor: BigInt(a.totalMinor), periodYm: a.periodYm, closeTaskId: a.closeTaskId ? BigInt(a.closeTaskId) : undefined });
          return ok({ proposalId: p.id });
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    ),
    tool(
      'propose_credit_decision',
      'Propose a customer risk tier and payment terms (no ledger impact; the allowance is a separate journal entry proposal).',
      { ...common, customerId: z.string(), tier: z.enum(['A', 'B', 'C', 'D', 'BLOCK']), paymentTermsDays: z.number().int(), creditCheckRequestIds: z.array(z.string()).optional() },
      async a => {
        try {
          const p = await propose(worker, A, { kind: 'credit_decision', payload: { customerId: id(a.customerId), tier: a.tier, paymentTermsDays: a.paymentTermsDays, creditCheckIds: a.creditCheckRequestIds ?? [] }, rationale: a.rationale, summaryPlain: a.summaryPlain, amountMinor: 0n, periodYm: a.periodYm, closeTaskId: a.closeTaskId ? BigInt(a.closeTaskId) : undefined });
          return ok({ proposalId: p.id });
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    ),
    tool(
      'propose_vendor_block',
      'Propose blocking all payments to a vendor whose owner fails identity or fraud checks.',
      { ...common, vendorId: z.string(), reasonPlain: z.string(), exposureMinor: z.string().describe('Open bills at risk, minor units') },
      async a => {
        try {
          const p = await propose(worker, A, { kind: 'vendor_block', payload: { vendorId: id(a.vendorId), reasonPlain: a.reasonPlain }, rationale: a.rationale, summaryPlain: a.summaryPlain, amountMinor: BigInt(a.exposureMinor), periodYm: a.periodYm, closeTaskId: a.closeTaskId ? BigInt(a.closeTaskId) : undefined });
          return ok({ proposalId: p.id });
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    ),
    tool(
      'propose_vendor_verify',
      "Propose a vendor check: mark a vendor verified so its bills can be paid, citing the request ids of its owner's identity (tu_identity_verification) and fraud (fraud_finder) checks recorded with APPROVE at tier A or B.",
      {
        ...common,
        vendorId: z.string(),
        creditCheckRequestIds: z.array(z.string()).min(1).describe("Request ids of the owner's recorded checks"),
        reasonPlain: z.string().optional().describe('One plain sentence on why the vendor can be paid'),
        exposureMinor: z.string().optional().describe('Unpaid bills this releases, minor units (the module computes it either way)'),
      },
      async a => {
        try {
          const p = await propose(worker, A, { kind: 'vendor_verify', payload: { vendorId: id(a.vendorId), creditCheckIds: a.creditCheckRequestIds, ...(a.reasonPlain ? { reasonPlain: a.reasonPlain } : {}) }, rationale: a.rationale, summaryPlain: a.summaryPlain, amountMinor: BigInt(a.exposureMinor ?? '0'), periodYm: a.periodYm, closeTaskId: a.closeTaskId ? BigInt(a.closeTaskId) : undefined });
          return ok({ proposalId: p.id });
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    ),
    // Not marked read-only on purpose: the CLI runs it serially, so its PostToolUse lands in the harness history
    // before the next call (a credit decision citing it) is judged.
    tool(
      'record_credit_check',
      'Store one credit-check evidence row (product, request id, summary) for a customer or vendor.',
      { subjectKind: z.enum(['customer', 'vendor']), subjectId: z.string(), personaId: z.string(), product: z.string(), requestId: z.string(), summaryJson: z.string(), tier: z.string(), decision: z.string() },
      async a => {
        try {
          await worker.reducers.recordCreditCheck({ ...a, subjectId: BigInt(a.subjectId) });
          return ok('recorded');
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    ),
    tool(
      'run_credit_cascade',
      'Run the full credit cascade (identity, fraud, three bureaus, public records) for a persona id and return tier, decision, terms, evidence with request ids, and allowance reason codes. Records nothing by itself.',
      { personaId: z.string(), subjectKind: z.enum(['customer_guarantor', 'vendor_owner']) },
      async ({ personaId, subjectKind }) => {
        try {
          const r = await runCascade(new CrsClient(), personaId, { subjectKind });
          return ok(r);
        } catch (e) {
          return fail((e as Error).message);
        }
      },
      readOnly
    ),
    tool(
      'post_message',
      'Say something in the close thread or on a proposal thread (statement or question).',
      { threadId: z.string().describe('close:YYYY-MM or proposal:<id>'), body: z.string(), summaryPlain: z.string(), kind: z.enum(['statement', 'question']).default('statement'), proposalId: z.string().optional() },
      async a => {
        try {
          await worker.reducers.postAgentMessage({ threadId: a.threadId, kind: a.kind, body: a.body, summaryPlain: a.summaryPlain, proposalId: a.proposalId ? BigInt(a.proposalId) : undefined });
          return ok('posted');
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    ),
    tool(
      'update_close_task',
      'Move a close task to in_progress or blocked (only the Advisor or CFO can mark done).',
      { taskId: z.string(), status: z.enum(['todo', 'in_progress', 'blocked']), note: z.string() },
      async a => {
        try {
          await worker.reducers.updateCloseTask({ taskId: BigInt(a.taskId), status: a.status, note: a.note });
          return ok('updated');
        } catch (e) {
          return fail((e as Error).message);
        }
      }
    ),
    ...extraTools,
  ];
  return createSdkMcpServer({ name: worker.role, version: '1.0.0', tools });
}

export function advisorServer(cast: Cast) {
  const A = cast.advisor;
  return createSdkMcpServer({
    name: 'advisor',
    version: '1.0.0',
    tools: [
      tool(
        'approve_proposal',
        'Approve a proposal (optionally with an amended payload). Below the materiality threshold it posts now; at or above, it waits for the CFO.',
        { proposalId: z.string(), rationale: z.string(), summaryPlain: z.string(), amendedPayloadJson: z.string().optional() },
        async a => {
          try {
            await A.reducers.approveProposal({ proposalId: BigInt(a.proposalId), rationale: a.rationale, summaryPlain: a.summaryPlain, amendedPayloadJson: a.amendedPayloadJson });
            const p = A.db.proposal.id.find(BigInt(a.proposalId));
            return ok({ status: p?.status.tag });
          } catch (e) {
            return fail((e as Error).message);
          }
        }
      ),
      tool('reject_proposal', 'Reject a proposal with a rationale.', { proposalId: z.string(), rationale: z.string(), summaryPlain: z.string() }, async a => {
        try {
          await A.reducers.rejectProposal({ proposalId: BigInt(a.proposalId), rationale: a.rationale, summaryPlain: a.summaryPlain });
          return ok('rejected');
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
      tool('post_ruling', 'Post a ruling or coordination message in the close thread.', { threadId: z.string(), body: z.string(), summaryPlain: z.string(), proposalId: z.string().optional() }, async a => {
        try {
          await A.reducers.postAgentMessage({ threadId: a.threadId, kind: 'ruling', body: a.body, summaryPlain: a.summaryPlain, proposalId: a.proposalId ? BigInt(a.proposalId) : undefined });
          return ok('posted');
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
      tool('update_close_task', 'Set a close task status (done allowed for the Advisor).', { taskId: z.string(), status: z.enum(['todo', 'in_progress', 'blocked', 'done']), note: z.string() }, async a => {
        try {
          await A.reducers.updateCloseTask({ taskId: BigInt(a.taskId), status: a.status, note: a.note });
          return ok('updated');
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
      tool('request_period_lock', 'Ask the CFO to lock the month. Fails while any proposal is open or awaiting the CFO.', { periodYm: z.string(), rationale: z.string(), summaryPlain: z.string() }, async a => {
        try {
          await A.reducers.requestPeriodLock(a);
          return ok('lock requested; the CFO confirms in the app');
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
    ],
  });
}

export function crsServer() {
  return createCrsMcpServer();
}

function period(s: ReturnType<typeof snapshot>) {
  return s.period.id;
}
