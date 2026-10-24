import { LedgerError } from './errors.js';
import { fromJsonMoney, toJsonMoney } from './money.js';
import type {
  Account, BankMatchCandidate, FxRevaluationItem, FxRevaluationPayload, IcBasis, IcEliminationPair, IcEliminationPayload,
  JournalEntryInput, JournalLineInput, JournalPurpose, ProposalPayload, RevenueScheduleLine, RiskTier, Ym,
} from './types.js';
import { ymToString } from './ym.js';

/** JSON wire form: every bigint (ids and money) is a base-10 string. */
export interface JournalLineJson {
  accountId: string;
  debitMinor: string;
  creditMinor: string;
  ccy: string;
  fxRateE6: string;
  customerId?: string;
  vendorId?: string;
  memo?: string;
}

export interface JournalEntryInputJson {
  subsidiaryId: string;
  periodId: string;
  memo: string;
  lines: JournalLineJson[];
}

export interface RevenueScheduleLineJson {
  contractItemId: string;
  ym: Ym;
  amountMinor: string;
  recognized: boolean;
}

export interface FxRevaluationItemJson {
  accountId: string;
  ccy: string;
  txnBalanceMinor: string;
  closingRateE6: string;
  bookedFunctionalMinor: string;
  targetFunctionalMinor: string;
  deltaMinor: string;
}

export interface IcEliminationPairJson {
  label: string;
  sourceSubsidiaryId: string;
  sourceAccountId: string;
  counterSubsidiaryId: string;
  counterAccountId: string;
  amountMinor: string;
  counterTranslatedMinor: string;
  differenceMinor: string;
}

export type ProposalPayloadJson =
  | (JournalEntryInputJson & { kind: 'journal_entry'; purpose?: JournalPurpose; reasonPlain?: string })
  | {
      kind: 'bank_match';
      bankTxId: string;
      targetKind: BankMatchCandidate['targetKind'];
      targetId: string;
      scoreBp: number;
      reasons: string[];
      bucket: BankMatchCandidate['bucket'];
    }
  | { kind: 'revenue_schedule'; contractItemId: string; lines: RevenueScheduleLineJson[] }
  | { kind: 'credit_decision'; customerId: string; tier: RiskTier; paymentTermsDays: number; summaryPlain: string }
  | (JournalEntryInputJson & { kind: 'accrual'; reversesInYm: Ym; billId?: string })
  | { kind: 'vendor_block'; vendorId: string; reasonPlain: string }
  | { kind: 'vendor_verify'; vendorId: string; creditCheckIds: string[]; reasonPlain?: string }
  | (JournalEntryInputJson & { kind: 'fx_revaluation'; periodYm: Ym; rateYm: Ym; items: FxRevaluationItemJson[] })
  | (JournalEntryInputJson & { kind: 'ic_elimination'; periodYm: Ym; basis: IcBasis; reversesInYm?: Ym; pairs: IcEliminationPairJson[] });

const s = toJsonMoney;

function lineToJson(l: JournalLineInput): JournalLineJson {
  const o: JournalLineJson = {
    accountId: s(l.accountId), debitMinor: s(l.debitMinor), creditMinor: s(l.creditMinor), ccy: l.ccy, fxRateE6: s(l.fxRateE6),
  };
  if (l.customerId !== undefined) o.customerId = s(l.customerId);
  if (l.vendorId !== undefined) o.vendorId = s(l.vendorId);
  if (l.memo !== undefined) o.memo = l.memo;
  return o;
}

function entryToJson(e: JournalEntryInput): JournalEntryInputJson {
  return { subsidiaryId: s(e.subsidiaryId), periodId: s(e.periodId), memo: e.memo, lines: e.lines.map(lineToJson) };
}

const ymCopy = (v: Ym): Ym => ({ year: v.year, month: v.month });

function itemToJson(i: FxRevaluationItem): FxRevaluationItemJson {
  return {
    accountId: s(i.accountId), ccy: i.ccy, txnBalanceMinor: s(i.txnBalanceMinor), closingRateE6: s(i.closingRateE6),
    bookedFunctionalMinor: s(i.bookedFunctionalMinor), targetFunctionalMinor: s(i.targetFunctionalMinor), deltaMinor: s(i.deltaMinor),
  };
}

function pairToJson(x: IcEliminationPair): IcEliminationPairJson {
  return {
    label: x.label, sourceSubsidiaryId: s(x.sourceSubsidiaryId), sourceAccountId: s(x.sourceAccountId),
    counterSubsidiaryId: s(x.counterSubsidiaryId), counterAccountId: s(x.counterAccountId), amountMinor: s(x.amountMinor),
    counterTranslatedMinor: s(x.counterTranslatedMinor), differenceMinor: s(x.differenceMinor),
  };
}

/** Bigint payload to its JSON-safe object (stable key order). */
export function toJsonPayload(p: ProposalPayload): ProposalPayloadJson {
  switch (p.kind) {
    case 'journal_entry': {
      const o: ProposalPayloadJson = { kind: 'journal_entry', ...entryToJson(p) };
      if (p.purpose !== undefined) o.purpose = p.purpose;
      if (p.reasonPlain !== undefined) o.reasonPlain = p.reasonPlain;
      return o;
    }
    case 'accrual': {
      const o: ProposalPayloadJson = { kind: 'accrual', ...entryToJson(p), reversesInYm: { year: p.reversesInYm.year, month: p.reversesInYm.month } };
      if (p.billId !== undefined) o.billId = s(p.billId);
      return o;
    }
    case 'bank_match':
      return {
        kind: 'bank_match', bankTxId: s(p.bankTxId), targetKind: p.targetKind, targetId: s(p.targetId),
        scoreBp: p.scoreBp, reasons: [...p.reasons], bucket: p.bucket,
      };
    case 'revenue_schedule':
      return {
        kind: 'revenue_schedule',
        contractItemId: s(p.contractItemId),
        lines: p.lines.map((l: RevenueScheduleLine) => ({
          contractItemId: s(l.contractItemId), ym: { year: l.ym.year, month: l.ym.month }, amountMinor: s(l.amountMinor), recognized: l.recognized,
        })),
      };
    case 'credit_decision':
      return { kind: 'credit_decision', customerId: s(p.customerId), tier: p.tier, paymentTermsDays: p.paymentTermsDays, summaryPlain: p.summaryPlain };
    case 'vendor_block':
      return { kind: 'vendor_block', vendorId: s(p.vendorId), reasonPlain: p.reasonPlain };
    case 'vendor_verify':
      return { kind: 'vendor_verify', vendorId: s(p.vendorId), creditCheckIds: [...p.creditCheckIds], ...(p.reasonPlain !== undefined ? { reasonPlain: p.reasonPlain } : {}) };
    case 'fx_revaluation':
      return { kind: 'fx_revaluation', ...entryToJson(p), periodYm: ymCopy(p.periodYm), rateYm: ymCopy(p.rateYm), items: p.items.map(itemToJson) };
    case 'ic_elimination': {
      const o: ProposalPayloadJson = { kind: 'ic_elimination', ...entryToJson(p), periodYm: ymCopy(p.periodYm), basis: p.basis, pairs: p.pairs.map(pairToJson) };
      if (p.reversesInYm !== undefined) o.reversesInYm = ymCopy(p.reversesInYm);
      return o;
    }
  }
}

export function serializeProposalPayload(p: ProposalPayload): string {
  return JSON.stringify(toJsonPayload(p));
}

// ---- parsing ----

type Obj = Record<string, unknown>;

function fail(path: string, what: string): never {
  throw new LedgerError('invalid_payload', `Proposal payload field "${path}" ${what}.`);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  return v as Obj;
}

function str(o: Obj, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== 'string') fail(`${path}${k}`, 'must be a string');
  return v;
}

function optStr(o: Obj, k: string, path: string): string | undefined {
  return o[k] === undefined ? undefined : str(o, k, path);
}

function big(o: Obj, k: string, path: string): bigint {
  const v = o[k];
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) fail(`${path}${k}`, 'must be a whole number written as a string');
  return fromJsonMoney(v);
}

function optBig(o: Obj, k: string, path: string): bigint | undefined {
  return o[k] === undefined ? undefined : big(o, k, path);
}

function int(o: Obj, k: string, path: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(`${path}${k}`, 'must be a whole number');
  return v;
}

function bool(o: Obj, k: string, path: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') fail(`${path}${k}`, 'must be true or false');
  return v;
}

function oneOf<T extends string>(o: Obj, k: string, path: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(`${path}${k}`, `must be one of ${allowed.join(', ')}`);
  return v as T;
}

function arr(o: Obj, k: string, path: string): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) fail(`${path}${k}`, 'must be a list');
  return v;
}

function ymOf(o: Obj, k: string, path: string): Ym {
  const y = obj(o[k], `${path}${k}`);
  const year = int(y, 'year', `${path}${k}.`);
  const month = int(y, 'month', `${path}${k}.`);
  if (month < 1 || month > 12) fail(`${path}${k}.month`, 'must be between 1 and 12');
  return { year, month };
}

function lineFrom(v: unknown, path: string): JournalLineInput {
  const o = obj(v, path);
  const p = `${path}.`;
  const l: JournalLineInput = {
    accountId: big(o, 'accountId', p),
    debitMinor: big(o, 'debitMinor', p),
    creditMinor: big(o, 'creditMinor', p),
    ccy: str(o, 'ccy', p),
    fxRateE6: big(o, 'fxRateE6', p),
  };
  const c = optBig(o, 'customerId', p);
  if (c !== undefined) l.customerId = c;
  const vd = optBig(o, 'vendorId', p);
  if (vd !== undefined) l.vendorId = vd;
  const m = optStr(o, 'memo', p);
  if (m !== undefined) l.memo = m;
  return l;
}

function entryFrom(o: Obj): JournalEntryInput {
  return {
    subsidiaryId: big(o, 'subsidiaryId', ''),
    periodId: big(o, 'periodId', ''),
    memo: str(o, 'memo', ''),
    lines: arr(o, 'lines', '').map((l, i) => lineFrom(l, `lines[${i}]`)),
  };
}

function itemFrom(v: unknown, path: string): FxRevaluationItem {
  const o = obj(v, path);
  const p = `${path}.`;
  return {
    accountId: big(o, 'accountId', p),
    ccy: str(o, 'ccy', p),
    txnBalanceMinor: big(o, 'txnBalanceMinor', p),
    closingRateE6: big(o, 'closingRateE6', p),
    bookedFunctionalMinor: big(o, 'bookedFunctionalMinor', p),
    targetFunctionalMinor: big(o, 'targetFunctionalMinor', p),
    deltaMinor: big(o, 'deltaMinor', p),
  };
}

function pairFrom(v: unknown, path: string): IcEliminationPair {
  const o = obj(v, path);
  const p = `${path}.`;
  return {
    label: str(o, 'label', p),
    sourceSubsidiaryId: big(o, 'sourceSubsidiaryId', p),
    sourceAccountId: big(o, 'sourceAccountId', p),
    counterSubsidiaryId: big(o, 'counterSubsidiaryId', p),
    counterAccountId: big(o, 'counterAccountId', p),
    amountMinor: big(o, 'amountMinor', p),
    counterTranslatedMinor: big(o, 'counterTranslatedMinor', p),
    differenceMinor: big(o, 'differenceMinor', p),
  };
}

function nonEmpty<T>(list: T[], path: string, what: string): T[] {
  if (list.length === 0) fail(path, `must list at least one ${what}`);
  return list;
}

const PURPOSES: readonly JournalPurpose[] = ['general', 'allowance', 'reversal', 'duplicate_payment', 'revenue_recognition'];
const TIERS: readonly RiskTier[] = ['A', 'B', 'C', 'D', 'BLOCK'];

/** Validate a JSON-safe object (already parsed) and convert it back to the bigint payload. Shape only: balancing is validateEntry's job. */
export function fromJsonPayload(v: unknown): ProposalPayload {
  const o = obj(v, 'payload');
  const kind = oneOf(o, 'kind', '', ['journal_entry', 'bank_match', 'revenue_schedule', 'credit_decision', 'accrual', 'vendor_block', 'vendor_verify', 'fx_revaluation', 'ic_elimination'] as const);
  switch (kind) {
    case 'journal_entry': {
      const p: ProposalPayload = { kind, ...entryFrom(o) };
      if (o['purpose'] !== undefined) p.purpose = oneOf(o, 'purpose', '', PURPOSES);
      const r = optStr(o, 'reasonPlain', '');
      if (r !== undefined) p.reasonPlain = r;
      return p;
    }
    case 'accrual': {
      const p: ProposalPayload = { kind, ...entryFrom(o), reversesInYm: ymOf(o, 'reversesInYm', '') };
      const b = optBig(o, 'billId', '');
      if (b !== undefined) p.billId = b;
      return p;
    }
    case 'bank_match': {
      const scoreBp = int(o, 'scoreBp', '');
      if (scoreBp < 0 || scoreBp > 10000) fail('scoreBp', 'must be between 0 and 10000');
      return {
        kind,
        bankTxId: big(o, 'bankTxId', ''),
        targetKind: oneOf(o, 'targetKind', '', ['invoice', 'bill', 'je'] as const),
        targetId: big(o, 'targetId', ''),
        scoreBp,
        reasons: arr(o, 'reasons', '').map((r, i) => {
          if (typeof r !== 'string') fail(`reasons[${i}]`, 'must be a string');
          return r;
        }),
        bucket: oneOf(o, 'bucket', '', ['auto', 'review', 'unmatched'] as const),
      };
    }
    case 'revenue_schedule':
      return {
        kind,
        contractItemId: big(o, 'contractItemId', ''),
        lines: arr(o, 'lines', '').map((l, i) => {
          const lo = obj(l, `lines[${i}]`);
          const p = `lines[${i}].`;
          return { contractItemId: big(lo, 'contractItemId', p), ym: ymOf(lo, 'ym', p), amountMinor: big(lo, 'amountMinor', p), recognized: bool(lo, 'recognized', p) };
        }),
      };
    case 'credit_decision': {
      const paymentTermsDays = int(o, 'paymentTermsDays', '');
      if (paymentTermsDays < 0) fail('paymentTermsDays', 'cannot be negative');
      return { kind, customerId: big(o, 'customerId', ''), tier: oneOf(o, 'tier', '', TIERS), paymentTermsDays, summaryPlain: str(o, 'summaryPlain', '') };
    }
    case 'vendor_block':
      return { kind, vendorId: big(o, 'vendorId', ''), reasonPlain: str(o, 'reasonPlain', '') };
    case 'vendor_verify': {
      const creditCheckIds = arr(o, 'creditCheckIds', '').map((x, i) => {
        if (typeof x !== 'string' || x === '') fail(`creditCheckIds[${i}]`, 'must be a non-empty request id string');
        return x as string;
      });
      if (creditCheckIds.length === 0) fail('creditCheckIds', 'must cite at least one credit check');
      const p: ProposalPayload = { kind, vendorId: big(o, 'vendorId', ''), creditCheckIds };
      const r = optStr(o, 'reasonPlain', '');
      if (r !== undefined) p.reasonPlain = r;
      return p;
    }
    case 'fx_revaluation':
      return {
        kind,
        ...entryFrom(o),
        periodYm: ymOf(o, 'periodYm', ''),
        rateYm: ymOf(o, 'rateYm', ''),
        items: nonEmpty(arr(o, 'items', '').map((x, i) => itemFrom(x, `items[${i}]`)), 'items', 'restated balance'),
      };
    case 'ic_elimination': {
      const basis = oneOf(o, 'basis', '', ['balance', 'activity'] as const);
      const p: IcEliminationPayload = {
        kind,
        ...entryFrom(o),
        periodYm: ymOf(o, 'periodYm', ''),
        basis,
        pairs: nonEmpty(arr(o, 'pairs', '').map((x, i) => pairFrom(x, `pairs[${i}]`)), 'pairs', 'intercompany pair'),
      };
      if (basis === 'balance') {
        if (o['reversesInYm'] === undefined) fail('reversesInYm', 'is required when basis is balance');
        p.reversesInYm = ymOf(o, 'reversesInYm', '');
      } else if (o['reversesInYm'] !== undefined) {
        fail('reversesInYm', 'must be left out when basis is activity');
      }
      return p;
    }
  }
}

/** Parse JSON text (or an already-parsed object) into a validated bigint payload. Throws LedgerError. */
export function parseProposalPayload(input: string | unknown): ProposalPayload {
  if (typeof input === 'string') {
    let v: unknown;
    try {
      v = JSON.parse(input);
    } catch {
      throw new LedgerError('invalid_payload', 'Proposal payload is not valid JSON.');
    }
    return fromJsonPayload(v);
  }
  return fromJsonPayload(input);
}

// ---- module wire form for the consolidation kinds ----

function codeOf(accountsById: ReadonlyMap<bigint, Account>, id: bigint): string {
  const a = accountsById.get(id);
  if (!a) throw new LedgerError('unknown_account', `Account ${id} does not exist.`);
  return a.code;
}

/**
 * The SpacetimeDB module's JSON for an fx_revaluation or ic_elimination proposal: account codes instead of ids,
 * months as "YYYY-MM", money and ids as decimal strings, stable key order. Line memos and parties are not part of it.
 */
export function consolidationWireJson(
  p: FxRevaluationPayload | IcEliminationPayload,
  accountsById: ReadonlyMap<bigint, Account>,
): Record<string, unknown> {
  const code = (id: bigint) => codeOf(accountsById, id);
  const lines = p.lines.map((l) => ({
    accountCode: code(l.accountId), debitMinor: s(l.debitMinor), creditMinor: s(l.creditMinor), ccy: l.ccy, fxRateE6: s(l.fxRateE6),
  }));
  if (p.kind === 'fx_revaluation') {
    return {
      subsidiaryId: s(p.subsidiaryId),
      periodYm: ymToString(p.periodYm),
      rateYm: ymToString(p.rateYm),
      memo: p.memo,
      items: p.items.map((i) => ({
        accountCode: code(i.accountId), ccy: i.ccy, txnBalanceMinor: s(i.txnBalanceMinor), closingRateE6: s(i.closingRateE6),
        bookedFunctionalMinor: s(i.bookedFunctionalMinor), targetFunctionalMinor: s(i.targetFunctionalMinor), deltaMinor: s(i.deltaMinor),
      })),
      lines,
    };
  }
  return {
    subsidiaryId: s(p.subsidiaryId),
    periodYm: ymToString(p.periodYm),
    memo: p.memo,
    basis: p.basis,
    ...(p.reversesInYm !== undefined ? { reversesInYm: ymToString(p.reversesInYm) } : {}),
    pairs: p.pairs.map((x) => ({
      label: x.label, sourceSubsidiaryId: s(x.sourceSubsidiaryId), sourceAccountCode: code(x.sourceAccountId),
      counterSubsidiaryId: s(x.counterSubsidiaryId), counterAccountCode: code(x.counterAccountId), amountMinor: s(x.amountMinor),
      counterTranslatedMinor: s(x.counterTranslatedMinor), differenceMinor: s(x.differenceMinor),
    })),
    lines,
  };
}
