/** Bank and audit rows normalized at the database or UI boundary. */
export type BankExceptionRow = Readonly<{
  id: string;
  subsidiaryId: string;
  ym: string;
  bookedAt: string;
  amountMinor: string;
  ccy: string;
  description: string;
  counterparty: string;
  matched: boolean;
}>;

export type BankExceptionAudit = Readonly<{
  id: string;
  actorRole: string;
  action: string;
  targetTable: string;
  targetId: string;
  detail: string;
  at: string;
}>;

type BankExceptionsInput = Readonly<{
  periodYm: string;
  bankRows: readonly BankExceptionRow[];
  auditEvents: readonly BankExceptionAudit[];
}>;

export function isBankReconciliationTask(task: { ownerRole: string; sortOrder: number; title: string }): boolean {
  return task.ownerRole === 'bookkeeper' && (task.sortOrder === 1 || /bank.*reconcil|reconcil.*bank/i.test(task.title));
}

export function currentBankExceptions({ periodYm, bankRows }: Pick<BankExceptionsInput, 'periodYm' | 'bankRows'>): BankExceptionRow[] {
  return bankRows.filter(row => !row.matched && row.ym <= periodYm).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Every recorded bank/ledger change invalidates old consent, even if rows later return to identical values. */
export function bankExceptionSnapshot(input: BankExceptionsInput): string {
  const revision = input.auditEvents
    .filter(event => ['bank_transaction', 'bank_match', 'journal_entry', 'journal_line'].includes(event.targetTable)
      || ['approve_approve', 'approve_amend', 'cfo_confirm', 'unlock_period', 'reset_demo'].includes(event.action))
    .map(event => ({ id: event.id, at: event.at }))
    .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const exceptions = currentBankExceptions(input).map(row => ({
    id: row.id, subsidiaryId: row.subsidiaryId, ym: row.ym, bookedAt: row.bookedAt,
    amountMinor: row.amountMinor, ccy: row.ccy, description: row.description, counterparty: row.counterparty,
  }));
  return JSON.stringify({ version: 1, periodYm: input.periodYm, revision, exceptions });
}

export type BankExceptionAcceptance = { accepted: false } | { accepted: true; reasonPlain: string; auditId: string; at: string };

export function bankExceptionAcceptance(input: BankExceptionsInput): BankExceptionAcceptance {
  const snapshot = bankExceptionSnapshot(input);
  const candidates = input.auditEvents
    .filter(event => event.action === 'accept_bank_exceptions' && event.actorRole === 'cfo')
    .sort((a, b) => a.at > b.at ? -1 : a.at < b.at ? 1 : a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
  for (const event of candidates) {
    try {
      const detail: unknown = JSON.parse(event.detail);
      if (typeof detail !== 'object' || detail === null || !('periodYm' in detail) || !('snapshot' in detail) || !('reasonPlain' in detail)) continue;
      if (detail.periodYm === input.periodYm && detail.snapshot === snapshot && typeof detail.reasonPlain === 'string' && detail.reasonPlain.trim()) {
        return { accepted: true, reasonPlain: detail.reasonPlain, auditId: event.id, at: event.at };
      }
    } catch {
      // Unreadable historical evidence never authorizes a lock.
    }
  }
  return { accepted: false };
}
