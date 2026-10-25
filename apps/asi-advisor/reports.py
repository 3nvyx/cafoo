"""What each specialist reports, as pure functions of ledger rows (no network, no agents).

Every company keeps its books in its own currency, so totals are summed per currency and never across currencies.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable
from typing import Any

import ledger
from models import CashResponse, CreditResponse, GroupResponse, Item, Money, RevenueResponse, ReviewResponse

Rows = list[dict[str, Any]]


def group_code(code: str) -> str:
    """Account codes are unique across the group: 1000 at the root company, 1000-UK elsewhere."""
    return code.split("-")[0]


def totals(rows: Iterable[dict[str, Any]], ccy_of: Callable[[dict[str, Any]], str]) -> list[Money]:
    """Sum amount_minor per currency, in currency order."""
    by_ccy: dict[str, int] = defaultdict(int)
    for r in rows:
        by_ccy[ccy_of(r)] += int(r["amount_minor"])
    return [Money(amount_minor=v, ccy=c) for c, v in sorted(by_ccy.items())]


def _ccy_of_subsidiary(subsidiaries: Rows) -> dict[int, str]:
    return {s["id"]: s["functional_ccy"] for s in subsidiaries}


def _open(row: dict[str, Any]) -> bool:
    return not ledger.same_tag(row["status"], "paid")


def cash_report(accounts: Rows, lines: Rows, subsidiaries: Rows, bank: Rows, bills: Rows, vendors: Rows, proposals: list[ledger.Proposal], period_ym: str) -> CashResponse:
    ccy = _ccy_of_subsidiary(subsidiaries)
    names = {s["id"]: s["name"] for s in subsidiaries}
    cash_accounts = {a["id"]: a["subsidiary_id"] for a in accounts if group_code(a["code"]) == "1000"}
    balance: dict[int, int] = defaultdict(int)
    for line in lines:
        if line["account_id"] in cash_accounts:
            balance[cash_accounts[line["account_id"]]] += int(line["debit_minor"]) - int(line["credit_minor"])
    unmatched = [b for b in bank if not b["matched"] and b["ym"] <= period_ym]
    vendor_ccy = {v["id"]: ccy[v["subsidiary_id"]] for v in vendors}
    due = [b for b in bills if _open(b)]
    pending = ("open", "awaiting_cfo")
    return CashResponse(
        ok=True,
        cash_by_company=[Item(label=names[sid], amount=Money(amount_minor=v, ccy=ccy[sid])) for sid, v in sorted(balance.items())],
        unmatched_bank_lines=len(unmatched),
        unmatched_total=totals(unmatched, lambda b: b["ccy"]),
        bills_due=len(due),
        bills_due_total=totals(due, lambda b: vendor_ccy.get(b["vendor_id"], "USD")),
        pending_bank_matches=sum(1 for p in proposals if ledger.same_tag(p.kind, "bank_match") and any(ledger.same_tag(p.status, s) for s in pending)),
    )


def revenue_report(schedule: Rows, invoices: Rows, customers: Rows, subsidiaries: Rows, period_ym: str) -> RevenueResponse:
    ccy = _ccy_of_subsidiary(subsidiaries)
    customer_ccy = {c["id"]: ccy[c["subsidiary_id"]] for c in customers}
    of_customer = lambda r: customer_ccy.get(r["customer_id"], "USD")  # noqa: E731
    unpaid = [i for i in invoices if _open(i)]
    overdue = [i for i in unpaid if ledger.same_tag(i["status"], "overdue")]
    return RevenueResponse(
        ok=True,
        recognized_this_month=totals((s for s in schedule if s["ym"] == period_ym and s["recognized"]), of_customer),
        still_to_recognize=totals((s for s in schedule if not s["recognized"]), of_customer),
        open_receivables=totals(unpaid, of_customer),
        overdue_receivables=totals(overdue, of_customer),
        overdue_invoices=len(overdue),
    )


def credit_report(customers: Rows, vendors: Rows, invoices: Rows, subsidiaries: Rows, top: int) -> CreditResponse:
    ccy = _ccy_of_subsidiary(subsidiaries)
    tiers: dict[str, int] = defaultdict(int)
    for c in customers:
        tiers[c["credit_tier"] or "unrated"] += 1
    owed: dict[int, int] = defaultdict(int)
    for i in invoices:
        if _open(i):
            owed[i["customer_id"]] += int(i["amount_minor"])
    by_id = {c["id"]: c for c in customers}
    ranked = [(cid, v) for cid, v in sorted(owed.items(), key=lambda kv: -kv[1]) if cid in by_id][:top]
    return CreditResponse(
        ok=True,
        tiers=[Item(label="Unrated" if t == "unrated" else f"Tier {t}", ref=str(n)) for t, n in sorted(tiers.items())],
        total_allowance=totals(({"amount_minor": c["allowance_minor"], "subsidiary_id": c["subsidiary_id"]} for c in customers), lambda r: ccy[r["subsidiary_id"]]),
        top_exposures=[
            Item(
                label=f"{by_id[cid]['name']} (tier {by_id[cid]['credit_tier'] or 'unrated'})",
                amount=Money(amount_minor=v, ccy=ccy[by_id[cid]["subsidiary_id"]]),
                ref=str(cid),
            )
            for cid, v in ranked
        ],
        blocked_vendors=[v["name"] for v in vendors if ledger.same_tag(v["verification"], "blocked")],
    )


def group_report(subsidiaries: Rows, rates: Rows, proposals: list[ledger.Proposal], period_ym: str) -> GroupResponse:
    return GroupResponse(
        ok=True,
        companies=[f"{s['name']} ({s['functional_ccy']})" for s in subsidiaries if not s["is_elimination"]],
        rates=[f"{r['from_ccy']}/{r['to_ccy']} {r['kind']} {int(r['rate_e_6']) / 1_000_000:.4f}" for r in rates if r["ym"] == period_ym],
        group_entries=[
            Item(label=f"{p.summary} ({p.status.replace('_', ' ')})", amount=Money(amount_minor=p.amount_minor, ccy="USD"), ref=str(p.id))
            for p in proposals
            if ledger.same_tag(p.kind, "fx_revaluation") or ledger.same_tag(p.kind, "ic_elimination")
        ],
    )


def review_report(messages: Rows, proposals: list[ledger.Proposal], ids: list[int]) -> ReviewResponse:
    threads = {p.thread_id: p.id for p in proposals if not ids or p.id in ids}
    return ReviewResponse(
        ok=True,
        critiques=[
            Item(label=m["summary_plain"], ref=str(threads[m["thread_id"]]))
            for m in messages
            if m["thread_id"] in threads and ledger.same_tag(m["kind"], "critique")
        ],
    )
