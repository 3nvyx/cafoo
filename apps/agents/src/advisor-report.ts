/** Read-side financial calculations shared by the Advisor's deterministic answers. */
import { accountBalances, consolidate, customerArr, groupCode, incomeStatement, translate, ymFromString } from '@luyten/ledger-core';
import { groupSnapshot, snapshot } from './snapshot';
import type { RoleConn } from './stdb';

export function advisorReport(conn: RoleConn, periodYm: string) {
  const group = groupSnapshot(conn);
  const throughYm = ymFromString(periodYm);
  const entities = group.entities.map(entity => {
    const books = snapshot(conn, periodYm, { subsidiaryId: entity.id });
    const balances = accountBalances(group.lines, group.accountsById, { subsidiaryId: entity.id, throughYm });
    const balance = (code: string) => balances.filter(row => groupCode(row.code) === code).reduce((sum, row) => sum + row.balanceMinor, 0n);
    const pnl = incomeStatement(group.lines, group.accountsById, { subsidiaryId: entity.id, fromYm: throughYm, toYm: throughYm });
    const revenueToDate = balances.filter(row => row.type === 'revenue').reduce((total, row) => total + row.balanceMinor, 0n);
    const arr = [...customerArr(books.contracts, books.items, throughYm).values()].reduce((total, amount) => total + amount, 0n);
    return { entity, books, balance, pnl, arr, revenueToDate };
  });
  const companies = entities.filter(company => !company.entity.isElimination);
  const consolidated = () => consolidate({ ...group, asOfYm: throughYm });
  const groupArr = () => companies.reduce((total, company) => total + (company.arr === 0n ? 0n : translate(company.arr, group.rates, company.entity.functionalCcy, group.reportingCcy, throughYm, 'closing')), 0n);
  const groupBalance = (code: string) => entities.reduce((total, company) => {
    const amount = company.balance(code);
    return total + (amount === 0n ? 0n : translate(amount, group.rates, company.entity.functionalCcy, group.reportingCcy, throughYm, 'closing'));
  }, 0n);
  return { group, throughYm, companies, consolidated, groupArr, groupBalance };
}
