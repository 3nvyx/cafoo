/**
 * Domain types for the Cafoo ledger engine.
 * Ids are bigint, money is bigint minor units, FX rates are bigint scaled by 1e6.
 */

export interface Ym {
  year: number;
  /** 1..12 */
  month: number;
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalBalance = 'debit' | 'credit';

export interface Account {
  id: bigint;
  subsidiaryId: bigint;
  code: string;
  name: string;
  type: AccountType;
  isIntercompany: boolean;
}

export type PeriodStatus = 'open' | 'closing' | 'closed';

export interface Period {
  id: bigint;
  subsidiaryId: bigint;
  year: number;
  month: number;
  status: PeriodStatus;
}

export interface JournalLineInput {
  accountId: bigint;
  debitMinor: bigint;
  creditMinor: bigint;
  ccy: string;
  /** Transaction currency to functional currency, scaled by 1e6. 1_000_000n means 1:1. */
  fxRateE6: bigint;
  customerId?: bigint;
  vendorId?: bigint;
  memo?: string;
}

export interface JournalEntryInput {
  subsidiaryId: bigint;
  periodId: bigint;
  memo: string;
  lines: JournalLineInput[];
}

/** A posted line. `ym` is the period month, denormalized so reports need no period lookup. */
export interface JournalLine extends JournalLineInput {
  id: bigint;
  jeId: bigint;
  ym: Ym;
  /** Microseconds since the Unix epoch. */
  postedAt: bigint;
  source: string;
}

export interface JournalEntry extends Omit<JournalEntryInput, 'lines'> {
  id: bigint;
  ym: Ym;
  postedAt: bigint;
  source: string;
  lines: JournalLine[];
}

export interface Contract {
  id: bigint;
  customerId: bigint;
  startYm: Ym;
  /** Inclusive. */
  endYm: Ym;
  totalMinor: bigint;
  plan: 'annual' | 'usage';
}

export interface ContractItem {
  id: bigint;
  contractId: bigint;
  kind: 'subscription' | 'usage';
  /** Subscription: price per unit per month. Usage: list price per unit (informational). */
  priceMinor: bigint;
  qty: bigint;
  /** Standalone selling price of the whole item line, used as its allocation weight. */
  sspMinor: bigint;
}

export interface UsageRecord {
  contractItemId: bigint;
  ym: Ym;
  quantity: bigint;
  unitPriceMinor: bigint;
}

export interface RevenueScheduleLine {
  contractItemId: bigint;
  ym: Ym;
  amountMinor: bigint;
  recognized: boolean;
}

export type DocumentStatus = 'open' | 'paid' | 'overdue';

export interface Invoice {
  id: bigint;
  customerId: bigint;
  ym: Ym;
  amountMinor: bigint;
  /** Microseconds since the Unix epoch. */
  dueAt: bigint;
  status: DocumentStatus;
}

export interface Bill {
  id: bigint;
  vendorId: bigint;
  /** Service period the cost belongs to. */
  ym: Ym;
  amountMinor: bigint;
  dueAt: bigint;
  status: DocumentStatus;
  externalRef: string;
  /** Bill date (micros). Optional; accrual detection falls back to `dueAt` when absent. */
  billedAt?: bigint;
}

export interface BankTransaction {
  id: bigint;
  bookedAt: bigint;
  /** Negative = outflow (debit on the statement). */
  amountMinor: bigint;
  ccy: string;
  description: string;
  counterparty: string;
  matched: boolean;
}

export type MatchBucket = 'auto' | 'review' | 'unmatched';
export type MatchTargetKind = 'invoice' | 'bill' | 'je';

export interface BankMatchCandidate {
  bankTxId: bigint;
  targetKind: MatchTargetKind;
  targetId: bigint;
  /** 0..10000 */
  scoreBp: number;
  reasons: string[];
  bucket: MatchBucket;
}

export type RiskTier = 'A' | 'B' | 'C' | 'D' | 'BLOCK';

/** Why a journal_entry proposal exists; lets the plain summary speak about intent. */
export type JournalPurpose =
  | 'general'
  | 'allowance'
  | 'reversal'
  | 'duplicate_payment'
  | 'revenue_recognition';

export interface JournalEntryPayload extends JournalEntryInput {
  kind: 'journal_entry';
  purpose?: JournalPurpose;
  reasonPlain?: string;
}

export interface BankMatchPayload extends BankMatchCandidate {
  kind: 'bank_match';
}

export interface RevenueSchedulePayload {
  kind: 'revenue_schedule';
  contractItemId: bigint;
  lines: RevenueScheduleLine[];
}

export interface CreditDecisionPayload {
  kind: 'credit_decision';
  customerId: bigint;
  tier: RiskTier;
  paymentTermsDays: number;
  summaryPlain: string;
}

export interface AccrualPayload extends JournalEntryInput {
  kind: 'accrual';
  reversesInYm: Ym;
  billId?: bigint;
}

export interface VendorBlockPayload {
  kind: 'vendor_block';
  vendorId: bigint;
  reasonPlain: string;
}

/** In-memory (bigint) proposal payload. Use serializeProposalPayload for the wire. */
export type ProposalPayload =
  | JournalEntryPayload
  | BankMatchPayload
  | RevenueSchedulePayload
  | CreditDecisionPayload
  | AccrualPayload
  | VendorBlockPayload;

export type ProposalKind = ProposalPayload['kind'];
