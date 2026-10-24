/**
 * Read the live tables into ledger-core shapes so the pure engines can run on them. A snapshot is one subsidiary's
 * books: by default the root company (no parent, not the elimination subsidiary), whose close the worker agents run.
 * Accounts, customers, vendors, bank transactions, invoices and bills (through their customer or vendor), contracts,
 * schedule lines and journal lines are filtered to that subsidiary, so a second company's rows never enter its close.
 */
import type { Account, BankTransaction, Bill, Contract, ContractItem, Entity, FxRate, Invoice, JournalLine, Ym } from '@cafoo/ledger-core';
import { ymFromString } from '@cafoo/ledger-core';
import type { RoleConn } from './stdb';

const lower = <T extends string>(tag: string) => tag.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() as T;

export type Snapshot = ReturnType<typeof snapshot>;
type SubsidiaryRow = NonNullable<ReturnType<RoleConn['db']['subsidiary']['id']['find']>>;

/** Whether a subsidiary row is the group's elimination subsidiary (false on a database seeded before the column). */
export const isElimination = (s: SubsidiaryRow) => s.isElimination === true;

/** The root company: the subsidiary with no parent that is not an elimination subsidiary (lowest id if several). */
export function rootSubsidiary(c: RoleConn): SubsidiaryRow {
  const roots = [...c.db.subsidiary.iter()].filter(s => s.parentId === undefined && !isElimination(s)).sort((a, b) => Number(a.id - b.id));
  if (!roots[0]) throw new Error([...c.db.subsidiary.iter()].length ? 'No root subsidiary (one with no parent that is not an elimination subsidiary)' : 'No subsidiary seeded');
  return roots[0];
}

export function snapshot(c: RoleConn, closeYm: string, opts: { subsidiaryId?: bigint } = {}) {
  const db = c.db;
  const close: Ym = ymFromString(closeYm);
  const period = [...db.period.iter()].find(p => p.ym === closeYm);
  if (!period) throw new Error(`No period ${closeYm}`);
  const subsidiary = opts.subsidiaryId === undefined ? rootSubsidiary(c) : db.subsidiary.id.find(opts.subsidiaryId);
  if (!subsidiary) throw new Error(`No subsidiary ${opts.subsidiaryId}`);
  const subId = subsidiary.id;

  const accounts: Account[] = [...db.account.iter()].filter(a => a.subsidiaryId === subId).map(a => ({
    id: a.id,
    subsidiaryId: a.subsidiaryId,
    code: a.code,
    name: a.name,
    type: lower<Account['type']>(a.accountType.tag),
    isIntercompany: a.isIntercompany,
  }));
  const accountByCode = new Map(accounts.map(a => [a.code, a]));
  const accountById = new Map(accounts.map(a => [a.id, a]));

  const customers = [...db.customer.iter()].filter(x => x.subsidiaryId === subId);
  const vendors = [...db.vendor.iter()].filter(x => x.subsidiaryId === subId);
  const customerName = new Map(customers.map(x => [x.id, x.name]));
  const vendorName = new Map(vendors.map(x => [x.id, x.name]));

  const invoices: Invoice[] = [...db.invoice.iter()].filter(i => customerName.has(i.customerId)).map(i => ({
    id: i.id,
    customerId: i.customerId,
    ym: ymFromString(i.ym),
    amountMinor: i.amountMinor,
    dueAt: i.dueAt.microsSinceUnixEpoch,
    status: lower<Invoice['status']>(i.status.tag),
  }));
  const bills: Bill[] = [...db.bill.iter()].filter(b => vendorName.has(b.vendorId)).map(b => ({
    id: b.id,
    vendorId: b.vendorId,
    ym: ymFromString(b.ym),
    amountMinor: b.amountMinor,
    dueAt: b.dueAt.microsSinceUnixEpoch,
    billedAt: b.billedAt.microsSinceUnixEpoch,
    status: lower<Bill['status']>(b.status.tag),
    externalRef: b.externalRef,
  }));
  const bankTxRows = [...db.bankTransaction.iter()].filter(t => t.subsidiaryId === subId);
  const bankTxs: BankTransaction[] = bankTxRows.map(t => ({
    id: t.id,
    bookedAt: t.bookedAt.microsSinceUnixEpoch,
    amountMinor: t.amountMinor,
    ccy: t.ccy,
    description: t.description,
    counterparty: t.counterparty,
    matched: t.matched,
  }));
  const contractRows = [...db.contract.iter()].filter(k => customerName.has(k.customerId));
  const contracts: Contract[] = contractRows.map(k => ({
    id: k.id,
    customerId: k.customerId,
    startYm: ymFromString(k.startYm),
    endYm: ymFromString(k.endYm),
    totalMinor: k.totalMinor,
    plan: lower<Contract['plan']>(k.plan.tag),
  }));
  const contractIds = new Set(contractRows.map(k => k.id));
  const items: ContractItem[] = [...db.contractItem.iter()].filter(i => contractIds.has(i.contractId)).map(i => ({
    id: i.id,
    contractId: i.contractId,
    kind: lower<ContractItem['kind']>(i.kind.tag),
    priceMinor: i.priceMinor,
    qty: i.qty,
    sspMinor: i.sspMinor,
  }));
  const scheduleLines = [...db.revenueScheduleLine.iter()].filter(l => customerName.has(l.customerId));
  const journalLines = [...db.journalLine.iter()].filter(l => accountById.has(l.accountId));
  const closeTasks = [...db.closeTask.iter()].filter(t => t.periodId === period.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const materiality = db.settings.key.find('materiality_threshold_minor')?.valueI64 ?? 1_000_000n;

  /** Net balance (debit positive) of an account across all posted lines, optionally only through a month. */
  function balance(code: string, throughYm?: string): bigint {
    const acct = accountByCode.get(code);
    if (!acct) return 0n;
    const jeYm = new Map<bigint, string>();
    if (throughYm) {
      const periodYmById = new Map([...db.period.iter()].map(p => [p.id, p.ym]));
      for (const je of db.journalEntry.iter()) jeYm.set(je.id, periodYmById.get(je.periodId) ?? '');
    }
    let v = 0n;
    for (const l of journalLines) {
      if (l.accountId !== acct.id) continue;
      if (throughYm && (jeYm.get(l.jeId) ?? '') > throughYm) continue;
      v += l.debitMinor - l.creditMinor;
    }
    return v;
  }

  return {
    close,
    closeYm,
    period,
    subsidiary,
    accounts,
    accountByCode,
    accountById,
    customers,
    vendors,
    customerName,
    vendorName,
    invoices,
    bills,
    bankTxs,
    bankTxRows,
    contracts,
    contractRows,
    items,
    scheduleLines,
    journalLines,
    closeTasks,
    materiality,
    balance,
  };
}

/**
 * The whole group in ledger-core shapes, for consolidation: every subsidiary, account, posted journal line (with its
 * entry's month) and recorded FX rate, and the reporting currency.
 */
export function groupSnapshot(c: RoleConn) {
  const db = c.db;
  const entities: Entity[] = [...db.subsidiary.iter()]
    .sort((a, b) => Number(a.id - b.id))
    .map(x => ({ id: x.id, code: x.code, name: x.name, functionalCcy: x.functionalCcy, parentId: x.parentId, isElimination: isElimination(x) }));
  const accounts: Account[] = [...db.account.iter()].map(a => ({ id: a.id, subsidiaryId: a.subsidiaryId, code: a.code, name: a.name, type: lower<Account['type']>(a.accountType.tag), isIntercompany: a.isIntercompany }));
  const periodYm = new Map([...db.period.iter()].map(p => [p.id, p.ym]));
  const entries = new Map([...db.journalEntry.iter()].map(e => [e.id, e]));
  const lines: JournalLine[] = [];
  for (const l of db.journalLine.iter()) {
    const je = entries.get(l.jeId);
    const ym = je ? periodYm.get(je.periodId) : undefined;
    if (!je || !ym) continue;
    lines.push({
      id: l.id,
      jeId: l.jeId,
      ym: ymFromString(ym),
      postedAt: je.postedAt.microsSinceUnixEpoch,
      source: lower<string>(je.source.tag),
      accountId: l.accountId,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
      ccy: l.ccy,
      fxRateE6: l.fxRateE6,
      customerId: l.customerId,
      vendorId: l.vendorId,
      memo: l.memo,
    });
  }
  lines.sort((a, b) => Number(a.id - b.id));
  const rates: FxRate[] = [...db.fxRate.iter()]
    .sort((a, b) => Number(a.id - b.id))
    .map(r => ({ fromCcy: r.fromCcy, toCcy: r.toCcy, ym: ymFromString(r.ym), rateE6: r.rateE6, kind: lower<FxRate['kind']>(r.kind.tag) }));
  const reportingCcy = db.settings.key.find('reporting_ccy')?.valueText || 'USD';
  const periodIdOf = (ym: string) => [...db.period.iter()].find(p => p.ym === ym)?.id;
  return { entities, accounts, accountsById: new Map(accounts.map(a => [a.id, a])), lines, rates, reportingCcy, periodIdOf };
}
export type GroupSnapshot = ReturnType<typeof groupSnapshot>;

export type ModuleLine = {
  accountCode: string;
  debitMinor: string;
  creditMinor: string;
  ccy?: string;
  fxRateE6?: string;
  customerId?: string;
  vendorId?: string;
  memo?: string;
};

export function line(accountCode: string, debit: bigint, credit: bigint, memo: string, ref: { customerId?: bigint; vendorId?: bigint } = {}): ModuleLine {
  return {
    accountCode,
    debitMinor: debit.toString(),
    creditMinor: credit.toString(),
    ccy: 'USD',
    fxRateE6: '1000000',
    customerId: ref.customerId?.toString(),
    vendorId: ref.vendorId?.toString(),
    memo,
  };
}

/**
 * Whether a bank match candidate pays its invoice or bill to the cent. The module settles an invoice or bill only for
 * exactly the bank amount; a short, partial or over-payment goes through a journal entry instead, so only exact
 * candidates may become bank_match proposals.
 */
export function exactAmount(c: { bankTxId: bigint; targetKind: string; targetId: bigint }, s: Pick<Snapshot, 'bankTxs' | 'invoices' | 'bills'>): boolean {
  const tx = s.bankTxs.find(t => t.id === c.bankTxId);
  const target = c.targetKind === 'invoice' ? s.invoices.find(i => i.id === c.targetId) : c.targetKind === 'bill' ? s.bills.find(b => b.id === c.targetId) : undefined;
  if (!tx || !target) return false;
  return (tx.amountMinor < 0n ? -tx.amountMinor : tx.amountMinor) === target.amountMinor;
}
