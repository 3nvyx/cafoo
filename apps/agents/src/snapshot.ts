/** Read the live tables into ledger-core shapes so the pure engines can run on them. */
import type { Account, BankTransaction, Bill, Contract, ContractItem, Invoice, Ym } from '@cafoo/ledger-core';
import { ymFromString } from '@cafoo/ledger-core';
import type { RoleConn } from './stdb';

const lower = <T extends string>(tag: string) => tag.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() as T;

export type Snapshot = ReturnType<typeof snapshot>;

export function snapshot(c: RoleConn, closeYm: string) {
  const db = c.db;
  const close: Ym = ymFromString(closeYm);
  const period = [...db.period.iter()].find(p => p.ym === closeYm);
  if (!period) throw new Error(`No period ${closeYm}`);
  const subsidiary = [...db.subsidiary.iter()][0];
  if (!subsidiary) throw new Error('No subsidiary seeded');

  const accounts: Account[] = [...db.account.iter()].map(a => ({
    id: a.id,
    subsidiaryId: a.subsidiaryId,
    code: a.code,
    name: a.name,
    type: lower<Account['type']>(a.accountType.tag),
    isIntercompany: a.isIntercompany,
  }));
  const accountByCode = new Map(accounts.map(a => [a.code, a]));
  const accountById = new Map(accounts.map(a => [a.id, a]));

  const customers = [...db.customer.iter()];
  const vendors = [...db.vendor.iter()];
  const customerName = new Map(customers.map(x => [x.id, x.name]));
  const vendorName = new Map(vendors.map(x => [x.id, x.name]));

  const invoices: Invoice[] = [...db.invoice.iter()].map(i => ({
    id: i.id,
    customerId: i.customerId,
    ym: ymFromString(i.ym),
    amountMinor: i.amountMinor,
    dueAt: i.dueAt.microsSinceUnixEpoch,
    status: lower<Invoice['status']>(i.status.tag),
  }));
  const bills: Bill[] = [...db.bill.iter()].map(b => ({
    id: b.id,
    vendorId: b.vendorId,
    ym: ymFromString(b.ym),
    amountMinor: b.amountMinor,
    dueAt: b.dueAt.microsSinceUnixEpoch,
    billedAt: b.billedAt.microsSinceUnixEpoch,
    status: lower<Bill['status']>(b.status.tag),
    externalRef: b.externalRef,
  }));
  const bankTxs: BankTransaction[] = [...db.bankTransaction.iter()].map(t => ({
    id: t.id,
    bookedAt: t.bookedAt.microsSinceUnixEpoch,
    amountMinor: t.amountMinor,
    ccy: t.ccy,
    description: t.description,
    counterparty: t.counterparty,
    matched: t.matched,
  }));
  const bankTxRows = [...db.bankTransaction.iter()];
  const contracts: Contract[] = [...db.contract.iter()].map(k => ({
    id: k.id,
    customerId: k.customerId,
    startYm: ymFromString(k.startYm),
    endYm: ymFromString(k.endYm),
    totalMinor: k.totalMinor,
    plan: lower<Contract['plan']>(k.plan.tag),
  }));
  const contractRows = [...db.contract.iter()];
  const items: ContractItem[] = [...db.contractItem.iter()].map(i => ({
    id: i.id,
    contractId: i.contractId,
    kind: lower<ContractItem['kind']>(i.kind.tag),
    priceMinor: i.priceMinor,
    qty: i.qty,
    sspMinor: i.sspMinor,
  }));
  const scheduleLines = [...db.revenueScheduleLine.iter()];
  const journalLines = [...db.journalLine.iter()];
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
