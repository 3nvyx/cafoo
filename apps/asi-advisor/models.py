"""Request and response models between the Cafoo Advisor (orchestrator) and its five specialist agents.

Every response carries ok and error, so the orchestrator can show what one specialist could not answer and still
render the rest. Money is in minor units (cents or pence) with its currency, never floats.
"""

from __future__ import annotations

from uagents import Model


class Money(Model):
    amount_minor: int
    ccy: str


class Item(Model):
    """One line a specialist reports: a label, an optional amount, and an optional reference (a Proposal id)."""

    label: str
    amount: Money | None = None
    ref: str = ""


# Bookkeeper: cash and the bank


class CashRequest(Model):
    period_ym: str


class CashResponse(Model):
    ok: bool
    error: str = ""
    cash_by_company: list[Item] = []
    unmatched_bank_lines: int = 0
    unmatched_total: list[Money] = []
    bills_due: int = 0
    bills_due_total: list[Money] = []
    pending_bank_matches: int = 0


# Revenue: recognition and receivables


class RevenueRequest(Model):
    period_ym: str


class RevenueResponse(Model):
    ok: bool
    error: str = ""
    recognized_this_month: list[Money] = []
    still_to_recognize: list[Money] = []
    open_receivables: list[Money] = []
    overdue_receivables: list[Money] = []
    overdue_invoices: int = 0


# Credit & Risk: who is behind each customer and vendor


class CreditRequest(Model):
    top: int = 5


class CreditResponse(Model):
    ok: bool
    error: str = ""
    tiers: list[Item] = []
    total_allowance: list[Money] = []
    top_exposures: list[Item] = []
    blocked_vendors: list[str] = []


# Consolidation: the group in more than one currency


class GroupRequest(Model):
    period_ym: str


class GroupResponse(Model):
    ok: bool
    error: str = ""
    companies: list[str] = []
    rates: list[str] = []
    group_entries: list[Item] = []


# Red Team: what the second model challenged


class ReviewRequest(Model):
    proposal_ids: list[int] = []


class ReviewResponse(Model):
    ok: bool
    error: str = ""
    critiques: list[Item] = []
