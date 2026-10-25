/**
 * Exports of the books as plain tables: the month's ledger lines, the consolidated Board Pack, and what waits for the
 * CFO. One shape feeds both the CSV download and the Google Slides deck (slides.ts), so the two never disagree.
 * Amounts are decimal major units of the stated currency ("1234.56"), computed from the same engines as the app.
 */
import { ymFromString } from '@luyten/ledger-core';
import { advisorReport } from './advisor-report';
import type { RoleConn } from './stdb';

export const DATASETS = ['ledger', 'board-pack', 'cfo-queue'] as const;
export type Dataset = (typeof DATASETS)[number];
export type Table = { title: string; header: string[]; rows: string[][] };

export const isDataset = (x: string): x is Dataset => (DATASETS as readonly string[]).includes(x);

/** Minor units as a decimal string with two places, sign first: -123456n → "-1234.56". */
export function decimal(minor: bigint): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}

type LineRow = NonNullable<ReturnType<RoleConn['db']['journalLine']['id']['find']>>;

const day = (t: { microsSinceUnixEpoch: bigint }) => new Date(Number(t.microsSinceUnixEpoch / 1000n)).toISOString().slice(0, 10);

/** Every journal line posted to the month, in posting order. The first eight columns are the ones a slide shows. */
function ledger(A: RoleConn, ym: string): Table[] {
  const period = [...A.db.period.iter()].find(p => p.ym === ym);
  if (!period) throw new Error(`There is no ${ym} period in the books.`);
  const subs = new Map([...A.db.subsidiary.iter()].map(s => [s.id, s]));
  const entries = [...A.db.journalEntry.iter()].filter(e => e.periodId === period.id).sort((a, b) => Number(a.id - b.id));
  const byEntry = new Map<bigint, LineRow[]>();
  for (const l of A.db.journalLine.iter()) {
    const list = byEntry.get(l.jeId);
    if (list) list.push(l);
    else byEntry.set(l.jeId, [l]);
  }
  const rows: string[][] = [];
  for (const e of entries) {
    for (const l of (byEntry.get(e.id) ?? []).sort((a, b) => Number(a.id - b.id))) {
      rows.push([
        String(e.id), day(e.postedAt), subs.get(e.subsidiaryId)?.name ?? String(e.subsidiaryId), l.accountCode, l.memo || e.memo,
        decimal(l.debitMinor), decimal(l.creditMinor), l.ccy,
        (Number(l.fxRateE6) / 1e6).toFixed(6), l.customerId === undefined ? '' : String(l.customerId), l.vendorId === undefined ? '' : String(l.vendorId),
        e.source.tag, e.proposalId === undefined ? '' : String(e.proposalId), e.memo, e.postedByRole,
      ]);
    }
  }
  return [{
    title: `Ledger, ${ym}`,
    header: ['Entry', 'Posted', 'Company', 'Account', 'Memo', 'Debit', 'Credit', 'Currency', 'FX rate', 'Customer id', 'Vendor id', 'Source', 'Proposal', 'Entry memo', 'Posted by'],
    rows,
  }];
}

/** The consolidated P&L for the month and the Balance Sheet at its end, one column per company, in the Reporting currency. */
function boardPack(A: RoleConn, ym: string): Table[] {
  if (![...A.db.period.iter()].some(p => p.ym === ym)) throw new Error(`There is no ${ym} period in the books.`);
  const c = advisorReport(A, ym).consolidated();
  const ccy = c.reportingCcy;
  const header = ['Code', 'Account', ...c.entities.map(e => e.name), 'Eliminations', `Group (${ccy})`];
  const row = (r: { groupCode: string; name: string; byEntity: Map<bigint, bigint>; eliminationsMinor: bigint; consolidatedMinor: bigint }) => [
    r.groupCode, r.name, ...c.entities.map(e => decimal(r.byEntity.get(e.id) ?? 0n)), decimal(r.eliminationsMinor), decimal(r.consolidatedMinor),
  ];
  const total = (label: string, byEntity: Map<bigint, bigint>, group: bigint) => ['', label, ...c.entities.map(e => decimal(byEntity.get(e.id) ?? 0n)), '', decimal(group)];
  const is = c.incomeStatement;
  const bs = c.balanceSheet;
  return [
    { title: `Profit and loss, ${ym} (${ccy})`, header, rows: [...is.month.map(row), total('Net income', is.netIncomeMonthByEntity, is.netIncomeMonthMinor)] },
    {
      title: `Balance sheet at the end of ${ym} (${ccy})`,
      header,
      rows: [
        ...bs.rows.map(row),
        total('Retained earnings', bs.retainedEarningsByEntity, bs.retainedEarningsMinor),
        // Computed when the books are translated, never posted (ADR 0008).
        total('Cumulative translation adjustment (computed)', bs.ctaByEntity, bs.ctaMinor),
      ],
    },
  ];
}

/** Everything waiting for the CFO's confirmation, oldest first. */
function cfoQueue(A: RoleConn, ym: string): Table[] {
  ymFromString(ym);
  const periods = new Map([...A.db.period.iter()].map(p => [p.id, p.ym]));
  const rows = [...A.db.proposal.iter()]
    .filter(p => p.status.tag === 'AwaitingCfo' && (p.periodId === undefined || (periods.get(p.periodId) ?? '') <= ym))
    .sort((a, b) => Number(a.id - b.id))
    .map(p => [String(p.id), p.periodId === undefined ? '' : periods.get(p.periodId) ?? '', p.kind.tag, p.proposerRole, p.summaryPlain, decimal(p.amountMinor), day(p.createdAt)]);
  return [{ title: `Waiting for the CFO, through ${ym}`, header: ['Proposal', 'Period', 'Kind', 'Proposed by', 'Summary', 'Amount', 'Proposed'], rows }];
}

export function exportTables(A: RoleConn, dataset: Dataset, ym: string): Table[] {
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('period must be YYYY-MM');
  if (dataset === 'ledger') return ledger(A, ym);
  if (dataset === 'board-pack') return boardPack(A, ym);
  return cfoQueue(A, ym);
}

/**
 * RFC 4180 CSV. Several tables are separated by a blank line, each under a title row. A text cell that a spreadsheet
 * would run as a formula (=, +, -, @, tab, CR) gets a leading apostrophe; plain numbers such as "-12.50" stay numbers.
 */
export function toCsv(tables: Table[]): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(?:\.\d+)?$/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const line = (cells: string[]) => cells.map(cell).join(',');
  const one = (t: Table) => [...(tables.length > 1 ? [line([t.title])] : []), line(t.header), ...t.rows.map(line)].join('\r\n');
  return tables.map(one).join('\r\n\r\n') + '\r\n';
}
