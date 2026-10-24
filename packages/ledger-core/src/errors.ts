export type LedgerErrorCode =
  | 'too_few_lines'
  | 'invalid_line'
  | 'unbalanced'
  | 'period_not_open'
  | 'wrong_period'
  | 'unknown_account'
  | 'wrong_subsidiary'
  | 'invalid_money'
  | 'invalid_ym'
  | 'invalid_payload'
  | 'invalid_input';

/** Every engine failure. `message` is plain English, safe to show the CFO. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}
