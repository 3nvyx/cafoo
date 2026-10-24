import { ccyKey } from './fx.js';
import { absMinor, formatMinor } from './money.js';
import { functionalAmounts } from './posting.js';
import type { Account, BankTransaction, FxRevaluationPayload, IcEliminationPayload, JournalEntryInput, ProposalPayload, RiskTier, Ym } from './types.js';
import { dateLabel, monthName, ymAdd, ymLabel } from './ym.js';

/** A subsidiary as summaries name it. Pass parentId and isElimination so a revaluation can name the counterparty. */
export interface PlainSubsidiary {
  name: string;
  functionalCcy: string;
  parentId?: bigint | null;
  isElimination?: boolean;
}

/** Lookups that let summaries use names instead of ids. All optional; ids are the fallback. */
export interface PlainContext {
  customers?: ReadonlyMap<bigint, string>;
  vendors?: ReadonlyMap<bigint, string>;
  accounts?: ReadonlyMap<bigint, Account>;
  bankTxs?: ReadonlyMap<bigint, BankTransaction>;
  /** Period id -> month, for "for September 2026". */
  periods?: ReadonlyMap<bigint, Ym>;
  /** Currency for amounts when an entry mixes currencies. Default USD. */
  functionalCcy?: string;
  /** Subsidiary id -> name and currency, for consolidation summaries. */
  subsidiaries?: ReadonlyMap<bigint, PlainSubsidiary>;
}

const TIER_WORDS: Readonly<Record<RiskTier, string>> = {
  A: 'very low risk',
  B: 'low risk',
  C: 'moderate risk',
  D: 'high risk',
  BLOCK: 'too risky for credit',
};

function money(v: bigint, ccy: string): string {
  return formatMinor(v, ccy, { trimZeroCents: true });
}

function clause(s: string): string {
  return s.trim().replace(/[.!?\s]+$/, '');
}

function sentence(s: string): string {
  return clause(s.replace(/\s+/g, ' ')) + '.';
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function customerName(id: bigint | undefined, ctx: PlainContext): string {
  if (id === undefined) return 'the customer';
  return ctx.customers?.get(id) ?? `customer ${id}`;
}

function vendorName(id: bigint | undefined, ctx: PlainContext): string {
  if (id === undefined) return 'the supplier';
  return ctx.vendors?.get(id) ?? `supplier ${id}`;
}

/** Entry size: transaction-currency debits when all lines share one currency, else functional debits. */
function entryTotal(e: JournalEntryInput, ctx: PlainContext): string {
  const ccys = new Set(e.lines.map((l) => l.ccy));
  if (ccys.size === 1) {
    return money(e.lines.reduce((s, l) => s + l.debitMinor, 0n), e.lines[0]!.ccy);
  }
  return money(e.lines.reduce((s, l) => s + functionalAmounts(l).debitMinor, 0n), ctx.functionalCcy ?? 'USD');
}

const LOWERABLE = new Set(['the', 'their', 'they', 'there', 'our', 'we', 'no', 'a', 'an', 'it', 'this', 'its', 'owner', 'both', 'all']);

/** Lowercase a leading common word so a sentence can follow "because"; names and acronyms keep their case. */
function asClause(s: string): string {
  const c = clause(s);
  const first = c.split(/\s/, 1)[0] ?? '';
  return LOWERABLE.has(first.toLowerCase()) ? c.charAt(0).toLowerCase() + c.slice(1) : c;
}

function because(reason: string | undefined): string {
  const c = reason ? asClause(reason) : '';
  return c ? ` because ${c}` : '';
}

const CCY_WORDS: Readonly<Record<string, string>> = { USD: 'dollar', GBP: 'pound', EUR: 'euro' };

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function subsidiaryName(id: bigint, ctx: PlainContext): string {
  return ctx.subsidiaries?.get(id)?.name ?? `subsidiary ${id}`;
}

/** The one other trading company keeping its books in `ccy` (else the parent, if it does); undefined when unclear. */
function counterpartyIn(ccy: string, selfId: bigint, ctx: PlainContext): string | undefined {
  if (!ctx.subsidiaries) return undefined;
  const others = [...ctx.subsidiaries.entries()].filter(([id, x]) => id !== selfId && !x.isElimination && ccyKey(x.functionalCcy) === ccy);
  if (others.length === 1) return others[0]![1].name;
  const parentId = ctx.subsidiaries.get(selfId)?.parentId;
  return others.find(([id]) => id === parentId)?.[1].name;
}

function revaluationSummary(p: FxRevaluationPayload, ctx: PlainContext): string {
  const name = subsidiaryName(p.subsidiaryId, ctx);
  const functional = ctx.subsidiaries?.get(p.subsidiaryId)?.functionalCcy ?? p.lines[0]?.ccy ?? ctx.functionalCcy ?? 'USD';
  const gain = p.items.reduce((s, i) => s + i.deltaMinor, 0n);
  const result = gain === 0n ? 'with no overall gain or loss' : `a ${money(absMinor(gain), functional)} ${gain > 0n ? 'gain' : 'loss'}`;
  const at = `${monthName(p.rateYm)}'s closing rate`;
  const ccys = [...new Set(p.items.map((i) => ccyKey(i.ccy)))];
  if (ccys.length !== 1) return sentence(`Restate ${possessive(name)} foreign-currency balances at ${at}, ${result}`);
  const ccy = ccys[0]!;
  const amt = money(p.items.reduce((s, i) => s + absMinor(i.txnBalanceMinor), 0n), ccy);
  const other = counterpartyIn(ccy, p.subsidiaryId, ctx);
  if (other && p.items.every((i) => i.txnBalanceMinor < 0n)) return sentence(`Restate the ${amt} ${name} owes ${other} at ${at}, ${result}`);
  if (other && p.items.every((i) => i.txnBalanceMinor > 0n)) return sentence(`Restate the ${amt} ${other} owes ${name} at ${at}, ${result}`);
  return sentence(`Restate ${possessive(name)} ${amt} of ${CCY_WORDS[ccy] ?? ccy} balances at ${at}, ${result}`);
}

function eliminationSummary(p: IcEliminationPayload, ctx: PlainContext): string {
  const ccy = p.lines[0]?.ccy ?? ctx.subsidiaries?.get(p.subsidiaryId)?.functionalCcy ?? ctx.functionalCcy ?? 'USD';
  const amt = money(p.pairs.reduce((s, x) => s + x.amountMinor, 0n), ccy);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const sources = uniq(p.pairs.map((x) => subsidiaryName(x.sourceSubsidiaryId, ctx)));
  const counters = uniq(p.pairs.map((x) => subsidiaryName(x.counterSubsidiaryId, ctx)));
  const names = uniq([...sources, ...counters]);
  if (p.basis === 'balance') {
    const rev = p.reversesInYm ? `; it reverses in ${monthName(p.reversesInYm)}` : '';
    return sentence(`Remove the ${amt} ${joinNames(names)} owe each other from the group's combined balance sheet${rev}`);
  }
  const what = joinNames(uniq(p.pairs.map((x) => x.label.toLowerCase())));
  const who = sources.length === 1 && counters.length === 1 ? `${sources[0]} charged ${counters[0]}` : `between ${joinNames(names)}`;
  return sentence(`Remove the ${amt} of ${what} ${who} in ${monthName(p.periodYm)} from the group's combined results`);
}

function allowanceIsIncrease(e: JournalEntryInput, ctx: PlainContext): boolean {
  if (ctx.accounts) {
    const debited = e.lines.find((l) => l.debitMinor > 0n);
    const acct = debited && ctx.accounts.get(debited.accountId);
    if (acct) return acct.type === 'expense';
  }
  return !/^release/i.test(e.memo);
}

/**
 * One plain-English sentence for the CFO: no account codes, no debit/credit wording,
 * amounts via formatMinor (whole amounts drop ".00"). Deterministic for a given payload and context.
 */
export function plainSummary(payload: ProposalPayload, ctx: PlainContext = {}): string {
  switch (payload.kind) {
    case 'journal_entry': {
      const amt = entryTotal(payload, ctx);
      const customerId = payload.lines.find((l) => l.customerId !== undefined)?.customerId;
      const vendorId = payload.lines.find((l) => l.vendorId !== undefined)?.vendorId;
      const reason = because(payload.reasonPlain);
      switch (payload.purpose) {
        case 'allowance': {
          const who = possessive(customerName(customerId, ctx));
          return allowanceIsIncrease(payload, ctx)
            ? sentence(`Set aside ${amt} against ${who} unpaid invoices${reason}`)
            : sentence(`Release ${amt} previously set aside against ${who} unpaid invoices${reason}`);
        }
        case 'reversal':
          return sentence(`Undo an earlier ${amt} entry${reason || ' so the books show it never happened'}`);
        case 'duplicate_payment':
          return sentence(`Treat the second ${amt} payment to ${vendorName(vendorId, ctx)} as money they owe us back${reason || ' because the same bill was paid twice'}`);
        case 'revenue_recognition': {
          const ym = ctx.periods?.get(payload.periodId);
          return sentence(`Count ${amt} of already-billed revenue as earned${ym ? ` in ${ymLabel(ym)}` : ''}${reason}`);
        }
        default: {
          const memo = clause(payload.memo);
          return sentence(memo ? `Record ${amt} for ${memo}${reason}` : `Record a ${amt} adjustment${reason}`);
        }
      }
    }
    case 'accrual': {
      const amt = entryTotal(payload, ctx);
      const vendorId = payload.lines.find((l) => l.vendorId !== undefined)?.vendorId;
      const serviceYm = ctx.periods?.get(payload.periodId) ?? ymAdd(payload.reversesInYm, -1);
      return sentence(
        `Count ${amt} of ${possessive(vendorName(vendorId, ctx))} ${ymLabel(serviceYm)} costs now, before their bill arrives, ` +
          `and undo it automatically in ${ymLabel(payload.reversesInYm)}`,
      );
    }
    case 'bank_match': {
      const pct = Math.floor(payload.scoreBp / 100);
      const target = payload.targetKind === 'invoice' ? `invoice ${payload.targetId}` : payload.targetKind === 'bill' ? `bill ${payload.targetId}` : `entry ${payload.targetId}`;
      const tx = ctx.bankTxs?.get(payload.bankTxId);
      if (!tx) return sentence(`Link bank transaction ${payload.bankTxId} to ${target} (${pct}% confident)`);
      const amt = money(tx.amountMinor < 0n ? -tx.amountMinor : tx.amountMinor, tx.ccy);
      const dir = tx.amountMinor < 0n ? 'to' : 'from';
      const who = tx.counterparty.trim() ? ` ${dir} ${tx.counterparty.trim()}` : '';
      return sentence(`Mark the ${amt} payment${who} on ${dateLabel(tx.bookedAt)} as settling ${target} (${pct}% confident)`);
    }
    case 'revenue_schedule': {
      const lines = payload.lines;
      if (lines.length === 0) return sentence(`Clear the revenue plan for contract item ${payload.contractItemId}`);
      const total = lines.reduce((s, l) => s + l.amountMinor, 0n);
      const amt = money(total, ctx.functionalCcy ?? 'USD');
      const first = lines[0]!.ym;
      const last = lines[lines.length - 1]!.ym;
      if (lines.length === 1) {
        return sentence(`Count ${amt} of revenue from contract item ${payload.contractItemId} in ${ymLabel(first)}`);
      }
      const head = lines.slice(0, -1);
      const even = head.every((l) => l.amountMinor === head[0]!.amountMinor) && lines[lines.length - 1]!.amountMinor >= head[0]!.amountMinor;
      return sentence(
        `Spread ${amt} of revenue from contract item ${payload.contractItemId} ${even ? 'evenly ' : ''}across ${lines.length} months, ` +
          `${ymLabel(first)} through ${ymLabel(last)}`,
      );
    }
    case 'credit_decision': {
      const name = customerName(payload.customerId, ctx);
      const lead =
        payload.tier === 'BLOCK' || payload.paymentTermsDays === 0
          ? `Ask ${name} to pay up front`
          : `Give ${name} ${payload.paymentTermsDays}-day payment terms`;
      return sentence(`${lead} (${TIER_WORDS[payload.tier]})${because(payload.summaryPlain)}`);
    }
    case 'vendor_block':
      return sentence(`Stop all payments to ${vendorName(payload.vendorId, ctx)}${because(payload.reasonPlain)}`);
    case 'vendor_verify':
      return sentence(`Mark ${vendorName(payload.vendorId, ctx)} as checked so their bills can be paid${because(payload.reasonPlain)}`);
    case 'fx_revaluation':
      return revaluationSummary(payload, ctx);
    case 'ic_elimination':
      return eliminationSummary(payload, ctx);
  }
}
