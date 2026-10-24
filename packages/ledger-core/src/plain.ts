import { formatMinor } from './money.js';
import { functionalAmounts } from './posting.js';
import type { Account, BankTransaction, JournalEntryInput, ProposalPayload, RiskTier, Ym } from './types.js';
import { dateLabel, ymAdd, ymLabel } from './ym.js';

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
  }
}
