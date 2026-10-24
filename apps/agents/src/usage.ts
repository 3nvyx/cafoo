/**
 * The month's usage invoices, which the Revenue agent's usage entry books (Dr 1100 receivable / Cr 4100 usage revenue,
 * per invoice and customer). Every usage invoice of the month counts, whether the seed loaded it or the live feed
 * ingested it: the feed books no receivable at ingest, so this entry is where a feed invoice's receivable comes from,
 * and its receipt (a bank match settling 1100) nets against it.
 */
type InvoiceRow = { contractId?: bigint; ym: string };
type ContractRow = { id: bigint; plan: { tag: string } };

export function usageInvoices<T extends InvoiceRow>(invoices: Iterable<T>, contracts: readonly ContractRow[], ym: string): T[] {
  const usage = new Set(contracts.filter(k => k.plan.tag === 'Usage').map(k => k.id));
  return [...invoices].filter(i => i.ym === ym && i.contractId !== undefined && usage.has(i.contractId));
}
