/** Bookkeeper harness: bank matches, journal entries and accruals, each citing the bank rows or bills it explains. */
import { PLAIN_RULE, BOOKS_TOOLS, allow, arr, baseName, deny, idKey, kindAllowed, mcp, noCritiqueOrRulingMessage, noPosting, noRulings, obj, plainSummaryRule, rule, str } from './rules';
import type { Harness } from './types';

/** Batch bank matches need every match at or above this confidence, in basis points (score_bank_matches "auto"). */
export const BATCH_MIN_SCORE_BP = 7500;

const ENTRY_TOOLS = new Set(['propose_journal_entry', 'propose_accrual']);
/** The accrual evidence pattern the eval uses (the rationale names the bill reference it anticipates), any case. */
const BILL_REF = /\bbill [A-Z0-9][A-Z0-9-]{2,}/i;
const LOOKED_UP = /\blooked (them|it) up\b/i;

export const bookkeeper: Harness = {
  role: 'bookkeeper',
  charterFile: 'bookkeeper.md',
  fallbackPrompt: `You are the Bookkeeper. You reconcile the bank feed and keep payables right. Start with close_snapshot and score_bank_matches. Propose one bank_match proposal for all auto-confidence matches and one per review-confidence match. Book duplicate payments as money due back from the vendor (account 1250 Receivable from Vendors). For unexplained outflows propose quick journal entries (payroll 5300, bank fees 6000, travel 5800, office 5500, software 5100) with the bankTxIds they explain. Use detect_missing_accruals and propose accruals. You never post; you only propose. ${PLAIN_RULE}`,
  description: 'Bank reconciliation, duplicate payments, quick entries, accruals. Proposes only.',
  model: { env: 'WORKER_MODEL', default: 'sonnet' },
  tools: ['SendMessage', ...mcp('bookkeeper', ['propose_bank_match', 'propose_journal_entry', 'propose_accrual', 'post_message', 'update_close_task']), ...mcp('books', BOOKS_TOOLS)],
  proposalKinds: ['bank_match', 'journal_entry', 'accrual'],
  maxTurns: 40,
  rules: [
    rule('bookkeeper.may.1', 'May 1', call => {
      const kind = kindAllowed(call, bookkeeper.proposalKinds);
      if (!kind.allow || baseName(call.tool) !== 'propose_accrual') return kind;
      // An accrual books this month's cost now and reverses when the bill posts, so in a later month.
      const reverses = str(call.input.reversesInYm);
      return /^\d{4}-\d{2}$/.test(reverses) && reverses > str(call.input.periodYm) ? allow : deny(`an accrual reverses in a later month than ${str(call.input.periodYm)}; reversesInYm is "${reverses}"`);
    }, { format: 'Propose only bank matches, journal entries and accruals, each for an open month (periodYm); an accrual\'s reversesInYm is a later open month. Never propose paying or settling a blocked vendor\'s bill (close_snapshot vendors shows each verification). A bank match pays its invoice or bill to the cent: propose only score_bank_matches `candidates`; a `nearAmount` candidate is a short or partial payment: say so in the close thread and leave it for a person (incoming money always; an outgoing one may instead be a journal entry with its bankTxIds).' }),
    rule('bookkeeper.may.2', 'May 2', call => {
      if (baseName(call.tool) !== 'propose_bank_match') return allow;
      const matches = arr(call.input.matches).map(obj);
      if (matches.length < 2) return allow;
      const weak = matches.filter(m => !(Number(m.scoreBp) >= BATCH_MIN_SCORE_BP));
      return weak.length ? deny(`a batch of ${matches.length} matches holds ${weak.length} below 75% confidence (${weak.map(m => `${str(m.bankTxId)} at ${Number(m.scoreBp) / 100}%`).join(', ')}); propose each of those on its own`) : allow;
    }, { format: 'propose_bank_match with two or more matches: every scoreBp is at least 7500; propose each weaker match in its own propose_bank_match. A bank transaction in another currency is matched only once a rate for its month is recorded.' }),
    rule('bookkeeper.may.3', 'May 3', call => {
      if (baseName(call.tool) !== 'post_message') return allow;
      // The eval's trigger (bookkeeper-counterparty-lookup): a body reporting that the Bookkeeper looked them or it up.
      return LOOKED_UP.test(str(call.input.body)) && !/^close:\d{4}-\d{2}$/.test(str(call.input.threadId)) ? deny('say what a counterparty lookup found in the close thread (threadId close:YYYY-MM)') : allow;
    }, {
      format: 'A post_message whose body says you "looked them up" or "looked it up" goes to threadId close:YYYY-MM: say there what the counterparty lookup found, and cite the finding in the rationale of the entry that classifies the payment.',
      partial: { scenario: 'bookkeeper-counterparty-lookup.yaml', rest: 'the lookup happens before the payment is classified: the classifying entry cites what it found' },
    }),
    noPosting('bookkeeper.never.1', 'Must never 1'),
    noRulings('bookkeeper.never.2', 'Must never 2'),
    rule('bookkeeper.never.3', 'Must never 3', call => {
      const name = baseName(call.tool);
      if (name === 'propose_bank_match') {
        const matches = arr(call.input.matches).map(obj);
        return matches.length && matches.every(m => str(m.bankTxId).length > 0) ? allow : deny('every match must cite its bank transaction (bankTxId)');
      }
      if (!ENTRY_TOOLS.has(name)) return allow;
      // A payable is evidence of whom it is owed to: every 2000 Accounts Payable line names its vendor.
      const unnamed = arr(call.input.lines).map(obj).filter(l => str(l.accountCode) === '2000' && !idKey(l.vendorId)).length;
      if (unnamed) return deny(`every line on 2000 Accounts Payable names its vendor (vendorId); ${unnamed} line(s) do not`);
      if (arr(call.input.bankTxIds).some(id => str(id).length > 0)) return allow;
      if (name === 'propose_accrual' && BILL_REF.test(str(call.input.rationale))) return allow;
      return deny(name === 'propose_accrual' ? 'cite the bill the accrual anticipates ("bill <reference>" in the rationale) or the bankTxIds it explains' : 'cite the bank transactions this entry explains (bankTxIds)');
    }, {
      format: 'Every propose_bank_match match has its bankTxId; every propose_journal_entry has bankTxIds; every line on 2000 Accounts Payable names its vendorId; a propose_accrual has bankTxIds or names the bill as "bill <externalRef>" in the rationale (detect_missing_accruals returns each externalRef).',
    }),
    noCritiqueOrRulingMessage('bookkeeper.never.4', 'Must never 4'),
    rule('bookkeeper.escalates.1', 'Escalates 1', call => {
      if (!ENTRY_TOOLS.has(baseName(call.tool)) || arr(call.input.bankTxIds).length === 0) return allow;
      const cashIn = arr(call.input.lines).map(obj).some(l => str(l.accountCode) === '1000' && !/^0*$/.test(str(l.debitMinor)));
      return cashIn ? deny('this entry books incoming money to cash; leave unexplained incoming money for a human instead of guessing which customer paid') : allow;
    }, { format: 'An entry with bankTxIds never debits 1000 Cash: leave unexplained incoming money for a human.' }),
    rule('bookkeeper.escalates.2', 'Escalates 2', call => {
      if (!ENTRY_TOOLS.has(baseName(call.tool)) || !/^duplicate payment/i.test(str(call.input.memo))) return allow;
      const [first, second] = arr(call.input.lines).map(obj);
      return str(first?.accountCode) === '1250' && str(second?.accountCode) === '1000' ? allow : deny('record a duplicate payment as money the vendor owes back: first line 1250 Receivable from Vendors, second line 1000 Cash, never an expense');
    }, {
      format: 'A duplicate payment is a propose_journal_entry with memo starting "Duplicate payment", first line 1250 Receivable from Vendors (debit), second line 1000 Cash (credit), and its bankTxIds.',
      partial: { scenario: 'bookkeeper-duplicate-payments.yaml', rest: 'every duplicate is proposed, and announced in the close thread' },
    }),
    plainSummaryRule('bookkeeper.plain'),
  ],
  evalOnly: [
    { charter: 'Escalates 3', scenario: 'advisor-material-waits.yaml', why: 'the wait for the CFO happens in the approval reducer after the Advisor rules; the summary half is the Plain summary rule' },
  ],
};
