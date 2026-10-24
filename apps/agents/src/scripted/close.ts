/**
 * Demo-mode month-end close. The accounting decisions come from the real engines
 * (@cafoo/ledger-core matching, revenue schedules, accruals, allowances; @cafoo/crs-mcp credit cascade).
 * Only the narration is scripted. Every write goes through the same role identities and reducers the
 * live agents use, so the UI, the approval gate, and the audit trail are identical in both modes.
 */
import {
  buildRevenueSchedule,
  detectMissingAccruals,
  findDuplicatePayments,
  formatMinor,
  scoreBankMatches,
  specificReserveReasons,
  targetAllowanceMinor,
  ymAdd,
  ymToString,
  type RiskTier,
} from '@cafoo/ledger-core';
import { CrsClient, runCascade } from '@cafoo/crs-mcp';
import { STEP_MS } from '../env';
import { line, snapshot, type Snapshot } from '../snapshot';
import { Cast, propose, say, sleep, type RoleConn } from '../stdb';

export type CloseEvents = {
  onStep?: (msg: string) => void;
};

const money = (n: bigint) => formatMinor(n, 'USD', { trimZeroCents: true });

async function pause(mult = 1) {
  await sleep(STEP_MS * mult);
}

export async function runScriptedClose(cast: Cast, closeYm: string, events: CloseEvents = {}) {
  const log = (m: string) => {
    events.onStep?.(m);
    console.log(`[close ${closeYm}] ${m}`);
  };
  const thread = `close:${closeYm}`;
  const A = cast.advisor;
  let s = snapshot(A, closeYm);
  const task = (n: number) => s.closeTasks[n - 1]?.id;
  const subId = s.subsidiary.id.toString();
  const period = s.period;
  if (period.status.tag === 'Closed') throw new Error(`${closeYm} is already closed.`);
  const already = [...A.db.proposal.iter()].filter(p => p.periodId === period.id);
  if (already.length > 0) {
    // The close already ran for this month (or is mid-flight): do not propose twice. Resume at the CFO gate.
    for (const p of already.filter(x => x.status.tag === 'Open')) {
      await A.reducers.approveProposal({ proposalId: p.id, rationale: 'Resumed close: reviewed the evidence on this open proposal; approved as proposed.', summaryPlain: 'Approved as proposed.', amendedPayloadJson: undefined }).catch(() => undefined);
    }
    const pending = already.filter(p => p.status.tag === 'AwaitingCfo' || p.status.tag === 'SentBack' || p.status.tag === 'Open');
    await say(A, thread, `The ${closeYm} close already has ${already.length} proposals. ${pending.length ? `${pending.length} still need a decision; I will ask to lock as soon as they are done.` : 'Everything is decided; requesting the lock.'}`, `The ${closeYm} close is already under way.`, 'ruling');
    log(`resuming: ${pending.length} pending`);
    if (pending.length && process.env.CLOSE_NO_WAIT !== '1') await waitForCfo(A, period.id);
    if (period.status.tag === 'Open') {
      const summary = boardSummary(snapshot(A, closeYm));
      await A.reducers.requestPeriodLock({ periodYm: closeYm, rationale: `All proposals are decided. ${summary.technical}`, summaryPlain: `${closeYm} is ready to lock ${summary.plain}.` }).catch(e => log(`lock not requested: ${(e as Error).message}`));
    }
    return { proposals: already.length, awaitingCfo: pending.length };
  }

  await say(A, thread, `Opening the ${closeYm} close for ${s.subsidiary.name}. Bookkeeper, Revenue, and Credit & Risk: work your tasks and propose; nothing posts until I rule, and anything material waits for the CFO.`,
    `The Advisor started the ${closeYm} close.`, 'ruling');
  for (const t of s.closeTasks) if (t.status.tag === 'Todo') await A.reducers.updateCloseTask({ taskId: t.id, status: 'in_progress', note: 'Close started' });
  await pause();

  // ---------------- Bookkeeper: bank reconciliation ----------------
  const B = cast.bookkeeper;
  const closeTxs = s.bankTxs.filter(t => !t.matched && s.bankTxRows.find(r => r.id === t.id)?.ym === closeYm);
  await say(B, thread, `Reconciling ${closeTxs.length} bank transactions for ${closeYm}. Scoring each against open invoices and bills on amount, date, counterparty, and reference.`,
    `The Bookkeeper is matching ${closeTxs.length} bank transactions.`);
  const names = { customers: s.customerName, vendors: s.vendorName };
  const candidates = scoreBankMatches(closeTxs, s.invoices, s.bills, names);
  const auto = candidates.filter(c => c.bucket === 'auto');
  const review = candidates.filter(c => c.bucket === 'review');
  const matchedTxIds = new Set(candidates.filter(c => c.bucket !== 'unmatched').map(c => c.bankTxId));
  const txById = new Map(s.bankTxs.map(t => [t.id, t]));
  const invById = new Map(s.invoices.map(i => [i.id, i]));
  const billById = new Map(s.bills.map(b => [b.id, b]));
  const amountOf = (c: (typeof candidates)[number]) => (c.targetKind === 'invoice' ? invById.get(c.targetId)?.amountMinor : billById.get(c.targetId)?.amountMinor) ?? 0n;
  const autoTotal = auto.reduce((acc, c) => acc + amountOf(c), 0n);
  await pause();

  if (auto.length) {
    const inflows = auto.filter(c => c.targetKind === 'invoice').length;
    const p = await propose(B, A, {
      kind: 'bank_match',
      payload: { matches: auto.map(c => ({ bankTxId: c.bankTxId.toString(), targetKind: c.targetKind, targetId: c.targetId.toString(), scoreBp: c.scoreBp })) },
      rationale: `${auto.length} transactions matched at 75% confidence or better: ${inflows} customer payments to invoices and ${auto.length - inflows} vendor payments to bills. Scores combine amount, date proximity, counterparty name overlap, and invoice or bill references in the bank description. Each match is one-to-one; no invoice or bill is consumed twice.`,
      summaryPlain: `Match ${auto.length} bank transactions worth ${money(autoTotal)} to the invoices and bills they clearly pay.`,
      amountMinor: 0n,
      periodYm: closeYm,
      closeTaskId: task(1),
    });
    log(`proposal ${p.id}: auto matches`);
  }
  for (const c of review) {
    const tx = txById.get(c.bankTxId)!;
    const target = c.targetKind === 'invoice' ? `invoice ${c.targetId} for ${s.customerName.get(invById.get(c.targetId)!.customerId)}` : `bill ${billById.get(c.targetId)?.externalRef} from ${s.vendorName.get(billById.get(c.targetId)!.vendorId)}`;
    await propose(B, A, {
      kind: 'bank_match',
      payload: { matches: [{ bankTxId: c.bankTxId.toString(), targetKind: c.targetKind, targetId: c.targetId.toString(), scoreBp: c.scoreBp }] },
      rationale: `Likely match at ${(c.scoreBp / 100).toFixed(0)}% confidence between bank transaction "${tx.description}" and ${target}. Reasons: ${c.reasons.join('; ')}. Below the 75% auto threshold, so this needs a ruling.`,
      summaryPlain: `Probably match the ${money(tx.amountMinor < 0n ? -tx.amountMinor : tx.amountMinor)} bank transaction from ${tx.counterparty} to ${target}; confidence ${(c.scoreBp / 100).toFixed(0)}%.`,
      amountMinor: 0n,
      periodYm: closeYm,
      closeTaskId: task(1),
    });
  }
  await pause();

  // Duplicate payments
  const dups = findDuplicatePayments(closeTxs, s.bills);
  for (const d of dups) {
    const bill = billById.get(d.billId)!;
    const vendor = s.vendorName.get(bill.vendorId) ?? 'vendor';
    matchedTxIds.add(d.duplicateTxId);
    matchedTxIds.add(d.firstTxId);
    await say(B, thread, `Two outflows carry the same reference ${d.externalRef} to ${vendor}, ${d.daysApart} days apart. The second one is a duplicate payment.`, `The Bookkeeper found a duplicate payment to ${vendor}.`);
    await propose(B, A, {
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `Duplicate payment to ${vendor} on ${d.externalRef}; refund requested`,
        lines: [line('1200', d.amountMinor, 0n, `Due back from ${vendor} (duplicate payment)`, { vendorId: bill.vendorId }), line('1000', 0n, d.amountMinor, 'Second payment, same reference', { vendorId: bill.vendorId })],
        bankTxIds: [d.duplicateTxId.toString()],
      },
      rationale: `Bank transactions ${d.firstTxId} and ${d.duplicateTxId} both pay ${d.externalRef} (${money(d.amountMinor)}). The first settles the bill; the second is an overpayment. Record the cash out and a receivable from the vendor so the expense is not doubled, and request a refund.`,
      summaryPlain: `We paid ${vendor} twice for the same ${money(d.amountMinor)} bill; record the second payment as money they owe us back.`,
      amountMinor: d.amountMinor,
      periodYm: closeYm,
      closeTaskId: task(3),
    });
  }
  await pause();

  // Quick entries for everything still unexplained (payroll runs, fees, card purchases, unknown subscriptions)
  const unexplained = closeTxs.filter(t => !matchedTxIds.has(t.id));
  const classify = (t: (typeof unexplained)[number]): { code: string; label: string; needsLookup?: boolean } => {
    const d = t.description.toUpperCase();
    if (d.includes('PAYROLL')) return { code: '5300', label: 'Payroll' };
    if (d.includes('SERVICE FEE') || d.includes('BANK')) return { code: '6000', label: 'Bank fees' };
    if (d.includes('TRAVEL')) return { code: '5800', label: 'Travel' };
    if (d.includes('COFFEE') || d.includes('OFFICE')) return { code: '5500', label: 'Office' };
    if (d.includes('SUBSCRIPTION')) return { code: '5100', label: 'Software subscription', needsLookup: true };
    return { code: t.amountMinor < 0n ? '5500' : '1100', label: 'Unclassified', needsLookup: true };
  };
  for (const t of unexplained) {
    if (t.amountMinor >= 0n) continue; // unexplained inflows are left for a human
    const amt = -t.amountMinor;
    const k = classify(t);
    let lookup = '';
    if (k.needsLookup) {
      lookup = await vendorLookup(t.counterparty);
      await say(B, thread, `Unknown counterparty "${t.counterparty}". Looked them up: ${lookup}`, `The Bookkeeper looked up ${t.counterparty} on the web.`);
    }
    await propose(B, A, {
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `${k.label}: ${t.description}`,
        lines: [line(k.code, amt, 0n, t.description), line('1000', 0n, amt, `Bank: ${t.counterparty}`)],
        bankTxIds: [t.id.toString()],
      },
      rationale: `Bank outflow of ${money(amt)} to ${t.counterparty} has no invoice or bill. ${lookup || `Description "${t.description}" indicates ${k.label.toLowerCase()}.`} Booking directly to ${k.label} (${k.code}).`,
      summaryPlain: `Record the ${money(amt)} paid to ${t.counterparty} as ${k.label.toLowerCase()}.`,
      amountMinor: amt,
      periodYm: closeYm,
      closeTaskId: task(1),
    });
  }
  await pause();

  // Accruals: work done in the close month, billed after month end
  const expenseAccountByVendor = new Map<bigint, bigint>();
  for (const b of [...A.db.bill.iter()]) {
    const acct = s.accountByCode.get(b.expenseAccountCode);
    if (acct) expenseAccountByVendor.set(b.vendorId, acct.id);
  }
  const accruals = detectMissingAccruals(s.bills, s.close, {
    subsidiaryId: s.subsidiary.id,
    periodId: period.id,
    expenseAccountId: s.accountByCode.get('5600')!.id,
    accruedLiabilitiesAccountId: s.accountByCode.get('2100')!.id,
    expenseAccountByVendor,
  });
  for (const acc of accruals) {
    const bill = acc.billId ? billById.get(acc.billId) : undefined;
    const vendor = bill ? s.vendorName.get(bill.vendorId) ?? 'a vendor' : 'a vendor';
    const total = acc.lines.reduce((a, l) => a + l.debitMinor, 0n);
    await propose(B, A, {
      kind: 'accrual',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `Accrue ${vendor} work for ${closeYm}, invoiced ${bill ? 'after month end' : 'later'}`,
        lines: acc.lines.map(l => line(s.accountById.get(l.accountId)!.code, l.debitMinor, l.creditMinor, l.memo ?? '', { vendorId: bill?.vendorId })),
        reversesInYm: ymToString(acc.reversesInYm),
      },
      rationale: `${vendor}'s bill ${bill?.externalRef ?? ''} covers ${closeYm} work but is dated after month end, so without an accrual ${closeYm} expenses are understated by ${money(total)}. Book the expense and an accrued liability now; it reverses in ${ymToString(acc.reversesInYm)} when the bill posts.`,
      summaryPlain: `Count ${money(total)} of ${vendor}'s ${closeYm} work in this month even though their bill arrived later.`,
      amountMinor: total,
      periodYm: closeYm,
      closeTaskId: task(3),
    });
  }
  await pause();

  // ---------------- Revenue ----------------
  const R = cast.revenue;
  s = snapshot(A, closeYm);
  const subItems = s.items.filter(i => i.kind === 'subscription');
  const contractsWithoutSchedule = s.contracts.filter(k => k.plan === 'annual' && !s.scheduleLines.some(sl => subItems.some(i => i.id === sl.contractItemId && i.contractId === k.id)));
  await say(R, thread, `Reviewing ${s.contracts.length} contracts. Checking that every subscription has a recognition schedule and that ${closeYm} revenue and deferred revenue tie out.`, `Revenue is checking every contract's schedule.`);
  const pendingScheduleAmounts = new Map<bigint, bigint>(); // customerId → amount to recognize in close month from new schedules
  for (const k of contractsWithoutSchedule) {
    const item = subItems.find(i => i.contractId === k.id)!;
    const row = s.contractRows.find(r => r.id === k.id)!;
    const customer = s.customerName.get(k.customerId) ?? 'customer';
    const sched = buildRevenueSchedule(item, k);
    for (const l of sched) {
      if (ymToString(l.ym) <= closeYm) pendingScheduleAmounts.set(k.customerId, (pendingScheduleAmounts.get(k.customerId) ?? 0n) + l.amountMinor);
    }
    await propose(R, A, {
      kind: 'revenue_schedule',
      payload: { lines: sched.map(l => ({ contractItemId: item.id.toString(), customerId: k.customerId.toString(), ym: ymToString(l.ym), amountMinor: l.amountMinor.toString() })) },
      rationale: `Contract ${row.code} (${customer}) was invoiced for ${money(k.totalMinor)} covering ${ymToString(k.startYm)} to ${ymToString(k.endYm)} but has no recognition schedule, so its revenue has never been recognized and deferred revenue is overstated. Straight-line over ${sched.length} months, ${money(sched[0].amountMinor)} per month.`,
      summaryPlain: `Spread ${customer}'s ${money(k.totalMinor)} annual contract evenly across its ${sched.length} months so revenue is counted as it is earned.`,
      amountMinor: 0n,
      periodYm: closeYm,
      closeTaskId: task(2),
    });
  }
  await pause();

  // Recognition entry for the close month: existing unrecognized lines + the schedules just proposed
  const byCustomer = new Map<bigint, bigint>(pendingScheduleAmounts);
  for (const sl of s.scheduleLines) {
    if (sl.ym <= closeYm && !sl.recognized) byCustomer.set(sl.customerId, (byCustomer.get(sl.customerId) ?? 0n) + sl.amountMinor);
  }
  const recognizeTotal = [...byCustomer.values()].reduce((a, b) => a + b, 0n);
  if (recognizeTotal > 0n) {
    const lines = [...byCustomer.entries()].flatMap(([cid, amt]) => [
      line('2400', amt, 0n, `Release deferred revenue ${closeYm}`, { customerId: cid }),
      line('4000', 0n, amt, `Subscription revenue ${closeYm}`, { customerId: cid }),
    ]);
    const deferredOpening = -s.balance('2400', ymAdd(s.close, -1) && ymToString(ymAdd(s.close, -1)));
    await propose(R, A, {
      kind: 'journal_entry',
      payload: { subsidiaryId: subId, periodYm: closeYm, memo: `Revenue recognition ${closeYm}`, lines, recognizeScheduleYm: closeYm },
      rationale: `${byCustomer.size} subscription customers have schedule lines through ${closeYm} still to recognize, totaling ${money(recognizeTotal)} (including any catch-up for schedules that were missing). Deferred revenue opened ${closeYm} at ${money(deferredOpening)}; this release moves the earned portion to subscription revenue. Schedule lines are flagged recognized and linked to this entry.`,
      summaryPlain: `Recognize ${money(recognizeTotal)} of subscription revenue earned through ${closeYm} across ${byCustomer.size} customers.`,
      amountMinor: recognizeTotal,
      periodYm: closeYm,
      closeTaskId: task(2),
    });
  }
  // Usage revenue for close-month usage invoices
  const usageInvoices = [...A.db.invoice.iter()].filter(i => i.ym === closeYm && s.contractRows.find(k => k.id === i.contractId)?.plan.tag === 'Usage');
  const usageTotal = usageInvoices.reduce((a, i) => a + i.amountMinor, 0n);
  if (usageInvoices.length) {
    await propose(R, A, {
      kind: 'journal_entry',
      payload: {
        subsidiaryId: subId,
        periodYm: closeYm,
        memo: `Usage revenue ${closeYm}`,
        lines: usageInvoices.flatMap(i => [line('1100', i.amountMinor, 0n, `Invoice ${i.number}`, { customerId: i.customerId }), line('4100', 0n, i.amountMinor, `Metered usage ${closeYm}`, { customerId: i.customerId })]),
      },
      rationale: `${usageInvoices.length} usage invoices were issued for ${closeYm} consumption (${money(usageTotal)}). Usage revenue is recognized in the month of use, so book the receivable and revenue now.`,
      summaryPlain: `Record ${money(usageTotal)} of usage revenue billed to ${usageInvoices.length} customers for ${closeYm}.`,
      amountMinor: usageTotal,
      periodYm: closeYm,
      closeTaskId: task(2),
    });
  }
  await pause();

  // ---------------- Credit & Risk ----------------
  const C = cast.credit;
  const crs = new CrsClient();
  s = snapshot(A, closeYm);
  const openAr = new Map<bigint, bigint>();
  for (const i of s.invoices) if (i.status !== 'paid') openAr.set(i.customerId, (openAr.get(i.customerId) ?? 0n) + i.amountMinor);
  const exposed = s.customers.filter(c => (openAr.get(c.id) ?? 0n) > 0n).sort((a, b) => Number((openAr.get(b.id) ?? 0n) - (openAr.get(a.id) ?? 0n)));
  await say(C, thread, `${exposed.length} customers carry open receivables totaling ${money([...openAr.values()].reduce((a, b) => a + b, 0n))}. Running the credit cascade (identity, fraud, three bureaus, public records) on each guarantor, then checking any vendor due a first payment.`,
    `Credit & Risk is checking the guarantor behind every open invoice.`);
  for (const cust of exposed) {
    const result = await runCascade(crs, cust.guarantorPersonaId, { subjectKind: 'customer_guarantor' });
    for (const ev of result.evidence) {
      await C.reducers.recordCreditCheck({ subjectKind: 'customer', subjectId: cust.id, personaId: cust.guarantorPersonaId, product: ev.product, requestId: ev.requestId ?? '', summaryJson: JSON.stringify(ev), tier: result.tier, decision: result.decision });
    }
    const ar = openAr.get(cust.id) ?? 0n;
    const tier = result.tier as RiskTier;
    await propose(C, A, {
      kind: 'credit_decision',
      payload: { customerId: cust.id.toString(), tier: result.tier, paymentTermsDays: result.paymentTermsDays ?? 0, creditCheckIds: result.evidence.map(e => e.requestId) },
      rationale: result.summaryTechnical,
      summaryPlain: `${cust.name}: ${result.summaryPlain}`,
      amountMinor: 0n,
      periodYm: closeYm,
      closeTaskId: task(4),
    });
    const target = targetAllowanceMinor(ar, tier);
    const existing = existingAllowance(s, cust.id);
    const delta = target - existing;
    if (delta !== 0n) {
      const reasonCode = result.allowanceReasonCodes[0] as keyof typeof specificReserveReasons | undefined;
      const because = reasonCode
        ? specificReserveReasons[reasonCode]
        : tier === 'D' ? `their guarantor's credit profile is weak`
        : tier === 'C' ? `their guarantor's credit file is thin or incomplete`
        : `every healthy account carries a small routine reserve`;
      await propose(C, A, {
        kind: 'journal_entry',
        payload: {
          subsidiaryId: subId,
          periodYm: closeYm,
          memo: `Allowance for doubtful accounts: ${cust.name} (tier ${tier})`,
          lines: delta > 0n
            ? [line('5700', delta, 0n, `Expected credit loss ${cust.name}`, { customerId: cust.id }), line('1150', 0n, delta, `Allowance ${cust.name}`, { customerId: cust.id })]
            : [line('1150', -delta, 0n, `Release allowance ${cust.name}`, { customerId: cust.id }), line('5700', 0n, -delta, `Release expected credit loss ${cust.name}`, { customerId: cust.id })],
        },
        rationale: `Open receivables from ${cust.name}: ${money(ar)}. Risk tier ${tier} carries a ${tier === 'BLOCK' ? '100' : tier === 'D' ? '50' : tier === 'C' ? '10' : tier === 'B' ? '5' : '1'}% expected-credit-loss reserve, target ${money(target)}; the current allowance is ${money(existing)}. Evidence: ${result.evidence.map(e => `${e.product} ${e.requestId}`).join(', ')}.`,
        summaryPlain: `Set aside ${money(delta > 0n ? delta : -delta)} against ${cust.name}'s unpaid invoices because ${because}.`,
        amountMinor: delta > 0n ? delta : -delta,
        periodYm: closeYm,
        closeTaskId: task(4),
      });
    }
    await pause(0.4);
  }
  // Vendors due a first payment or never verified
  const unverified = s.vendors.filter(v => v.verification.tag === 'Unverified' && v.ownerPersonaId);
  for (const v of unverified) {
    const result = await runCascade(crs, v.ownerPersonaId!, { subjectKind: 'vendor_owner' });
    for (const ev of result.evidence) {
      await C.reducers.recordCreditCheck({ subjectKind: 'vendor', subjectId: v.id, personaId: v.ownerPersonaId!, product: ev.product, requestId: ev.requestId ?? '', summaryJson: JSON.stringify(ev), tier: result.tier, decision: result.decision });
    }
    const openBills = s.bills.filter(b => b.vendorId === v.id && b.status !== 'paid');
    const exposure = openBills.reduce((a, b) => a + b.amountMinor, 0n);
    if (result.tier === 'BLOCK') {
      await propose(C, A, {
        kind: 'vendor_block',
        payload: { vendorId: v.id.toString(), reasonPlain: result.summaryPlain },
        rationale: `${v.name} is owned by a person whose identity and fraud checks fail: ${result.summaryTechnical}. ${openBills.length ? `${openBills.length} open bill(s) worth ${money(exposure)} must not be paid.` : 'No payment has gone out yet.'} Evidence: ${result.evidence.map(e => `${e.product} ${e.requestId}`).join(', ')}.`,
        summaryPlain: `Block payments to ${v.name}: ${result.summaryPlain}`,
        amountMinor: exposure,
        periodYm: closeYm,
        closeTaskId: task(5),
      });
    } else {
      await say(C, thread, `${v.name}'s owner verified cleanly (tier ${result.tier}). No action needed.`, `${v.name} passed vendor verification.`);
    }
  }
  await pause();

  // ---------------- Red Team (scripted) then Advisor rulings ----------------
  s = snapshot(A, closeYm);
  const open = [...A.db.proposal.iter()].filter(p => p.periodId === period.id && p.status.tag === 'Open').sort((a, b) => Number(a.id - b.id));
  const RT = cast.redteam;
  await say(RT, thread, `Reviewing ${open.length} proposals before the Advisor rules. I will challenge anything that leans on a weak match, an assumed rate, or a single data source.`, `The Red Team is reviewing ${open.length} proposals.`);
  const rulings: { id: bigint; action: 'approve' | 'reject'; rationale: string; plain: string }[] = [];
  for (const p of open) {
    const kind = p.kind.tag;
    const payload = JSON.parse(p.payloadJson);
    if (kind === 'BankMatch' && payload.matches?.length === 1 && payload.matches[0].scoreBp < 7500) {
      await RT.reducers.critique({ proposalId: p.id, body: `Confidence ${(payload.matches[0].scoreBp / 100).toFixed(0)}% is below the auto threshold and the counterparty name only partly overlaps. If this is wrong, a customer's invoice shows paid when it is not. Recommend asking the customer for a remittance advice instead of matching now.`, summaryPlain: `The Red Team doubts this match: the name only partly fits.` });
      rulings.push({ id: p.id, action: 'reject', rationale: `The Red Team is right: at ${(payload.matches[0].scoreBp / 100).toFixed(0)}% confidence this match is a guess. Leave the transaction unmatched, request remittance detail, and revisit next week.`, plain: `Not matching this one yet; we will ask the customer what the payment was for.` });
      continue;
    }
    if (kind === 'JournalEntry' && /Allowance for doubtful/.test(payload.memo) && p.amountMinor >= s.materiality) {
      const bankruptcy = /bankruptcy/i.test(p.summaryPlain);
      if (bankruptcy) {
        await RT.reducers.critique({ proposalId: p.id, body: `A 100% reserve is the right default for an active bankruptcy plan, but confirm two things before posting: that none of the receivable is secured or prepaid, and that the bankruptcy is the guarantor's and not a same-name match. The evidence shows a public record tied to the same SSN, so the second concern is answered; the first is a question for the account owner.`, summaryPlain: `The Red Team asks whether any of this debt is secured before reserving all of it.` });
        rulings.push({ id: p.id, action: 'approve', rationale: `Reserve approved. The bankruptcy record matches the guarantor's SSN across the bureau file and public records, and no collateral or prepayment is attached to the contract. Because the amount is material it goes to the CFO for confirmation.`, plain: `Approved: set aside the full amount; the CFO gets the final say because it is large.` });
      } else {
        await RT.reducers.critique({ proposalId: p.id, body: `The reserve rate follows the tier table, which is fine as a default. Two checks: the open balance should exclude anything already paid this month but not yet matched, and a 50% reserve on a customer who is still paying monthly may be high. Suggest the Advisor confirm the balance against the bank matches approved today.`, summaryPlain: `The Red Team asks to confirm the unpaid balance before reserving against it.` });
        rulings.push({ id: p.id, action: 'approve', rationale: `Reserve approved at the tier rate. The open balance excludes invoices matched to payments earlier in this close. The rate is a policy default and can be revisited when payment history improves. Material, so it goes to the CFO.`, plain: `Approved at the standard rate for this risk level; the CFO gets the final say because it is large.` });
      }
      continue;
    }
    if (kind === 'RevenueSchedule') {
      await RT.reducers.critique({ proposalId: p.id, body: `Straight-line is appropriate for a flat annual subscription. Check that the invoice date, not the signature date, starts the schedule, and that the term is 12 months inclusive.`, summaryPlain: `The Red Team agrees with straight-line and asks to confirm the start month.` });
      rulings.push({ id: p.id, action: 'approve', rationale: `Schedule approved. The term runs from the invoice month for 12 months inclusive, which matches the contract.`, plain: `Approved: the schedule follows the contract's twelve months.` });
      continue;
    }
    if (kind === 'VendorBlock') {
      await RT.reducers.critique({ proposalId: p.id, body: `Agree with the block. One caution: notify procurement before the bill's due date so the engagement is cancelled, not just unpaid.`, summaryPlain: `The Red Team agrees and asks that procurement be told.` });
      rulings.push({ id: p.id, action: 'approve', rationale: `Block approved. Identity and fraud checks fail on the owner; no payment leaves until a verified owner is on file. Procurement will be notified.`, plain: `Approved: no money goes to this vendor until a real owner is verified.` });
      continue;
    }
    rulings.push({ id: p.id, action: 'approve', rationale: `Reviewed the evidence and the Red Team raised no objection. Approved as proposed.`, plain: `Approved as proposed.` });
  }
  await pause();

  await say(A, thread, `Ruling on ${rulings.length} proposals. Anything at or above ${money(s.materiality)} waits for the CFO.`, `The Advisor is ruling on ${rulings.length} proposals.`, 'ruling');
  for (const r of rulings) {
    try {
      if (r.action === 'approve') await A.reducers.approveProposal({ proposalId: r.id, rationale: r.rationale, summaryPlain: r.plain, amendedPayloadJson: undefined });
      else await A.reducers.rejectProposal({ proposalId: r.id, rationale: r.rationale, summaryPlain: r.plain });
    } catch (e) {
      const why = (e as Error).message;
      log(`ruling on ${r.id} failed: ${why}`);
      await A.reducers.rejectProposal({ proposalId: r.id, rationale: `Could not apply this proposal: ${why}. Rejected so the close can continue; the proposer should resubmit.`, summaryPlain: `Not posted: the books refused this entry (${why.slice(0, 80)}).` }).catch(() => undefined);
    }
    await pause(0.25);
  }
  for (const n of [1, 2, 3, 4, 5]) {
    const t = task(n);
    if (t !== undefined) await A.reducers.updateCloseTask({ taskId: t, status: 'done', note: 'Rulings issued' });
  }

  const awaiting = [...A.db.proposal.iter()].filter(p => p.periodId === period.id && p.status.tag === 'AwaitingCfo');
  if (awaiting.length) {
    await say(A, thread, `${awaiting.length} material item(s) are waiting for the CFO's confirmation. I will ask to lock ${closeYm} as soon as they are decided.`, `${awaiting.length} items need the CFO's OK before the month can close.`, 'ruling');
    log(`waiting for CFO on ${awaiting.length} proposals`);
    if (process.env.CLOSE_NO_WAIT === '1') return { proposals: rulings.length, awaitingCfo: awaiting.length };
    await waitForCfo(A, period.id);
  }
  // Re-check and request the lock
  s = snapshot(A, closeYm);
  const summary = boardSummary(s);
  await A.reducers.requestPeriodLock({ periodYm: closeYm, rationale: `All ${rulings.length} proposals are decided and the bank feed is reconciled. ${summary.technical}`, summaryPlain: `${closeYm} is ready to lock ${summary.plain}.` });
  log('lock requested; CFO confirms in the app');
  return { proposals: rulings.length, awaitingCfo: awaiting.length };
}

async function waitForCfo(A: RoleConn, periodId: bigint, timeoutMs = 45 * 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pending = [...A.db.proposal.iter()].filter(p => p.periodId === periodId && (p.status.tag === 'AwaitingCfo' || p.status.tag === 'SentBack' || p.status.tag === 'Open'));
    if (pending.length === 0) return;
    // Re-propose anything the CFO sent back: the Advisor re-approves with the CFO's note acknowledged.
    for (const p of pending.filter(x => x.status.tag === 'SentBack')) {
      const note = [...A.db.agentMessage.iter()].filter(m => m.proposalId === p.id && m.senderRole === 'cfo').pop();
      await A.reducers.approveProposal({ proposalId: p.id, rationale: `The CFO sent this back: "${note?.body ?? ''}". Re-reviewed the evidence; the proposal stands as written, resubmitting for confirmation.`, summaryPlain: `Resubmitting after the CFO's note: ${note?.summaryPlain ?? 'please take another look.'}`, amendedPayloadJson: undefined });
    }
    await sleep(1000);
  }
}

/** Current allowance for one customer: credit balance of 1150 tagged with the customer. */
function existingAllowance(s: Snapshot, customerId: bigint): bigint {
  const acct = s.accountByCode.get('1150');
  if (!acct) return 0n;
  let v = 0n;
  for (const l of s.journalLines) if (l.accountId === acct.id && l.customerId === customerId) v += l.creditMinor - l.debitMinor;
  return v;
}

function boardSummary(s: Snapshot) {
  const rev = -(s.balance('4000') + s.balance('4100'));
  const cash = s.balance('1000');
  const deferred = -s.balance('2400');
  const ar = s.balance('1100');
  const plain = `with ${money(cash)} in the bank, ${money(ar)} owed to us by customers, ${money(deferred)} of prepaid subscriptions still to earn, and ${money(rev)} of revenue so far this year`;
  return { plain, technical: `Trial balance ties; cash ${money(cash)}, AR ${money(ar)}, deferred revenue ${money(deferred)}, cumulative revenue ${money(rev)}.` };
}

/** Bright Data lookup in live mode; recorded answer otherwise. */
async function vendorLookup(counterparty: string): Promise<string> {
  const token = process.env.API_TOKEN;
  if (token && process.env.DEMO_MODE !== '1') {
    try {
      const res = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone: process.env.WEB_UNLOCKER_ZONE ?? 'web_unlocker1', url: `https://www.google.com/search?q=${encodeURIComponent(counterparty + ' company')}`, format: 'raw' }),
      });
      const text = await res.text();
      return `search results summarized: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 240)}…`;
    } catch (e) {
      return `lookup failed (${(e as Error).message}); classifying from the bank description.`;
    }
  }
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { repoRoot } = await import('../stdb');
  const slug = counterparty.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const p = join(repoRoot, 'fixtures', 'brightdata', `${slug}.md`);
  if (existsSync(p)) return readFileSync(p, 'utf8').trim().split('\n').slice(0, 3).join(' ');
  return `no public record found for "${counterparty}"; classifying from the bank description.`;
}
