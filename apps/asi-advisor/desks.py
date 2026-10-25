"""The five specialist agents the Luyten orchestrates, each behind its own request and response models.

Each one reads its part of the live ledger and answers in its response model; none of them writes. The answers are
pure functions of the ledger rows (reports.py), so they are tested without a running ledger.
"""

from __future__ import annotations

import os

from uagents import Agent, Context, Protocol

import ledger
from models import (
    CashRequest,
    CashResponse,
    CreditRequest,
    CreditResponse,
    GroupRequest,
    GroupResponse,
    RevenueRequest,
    RevenueResponse,
    ReviewRequest,
    ReviewResponse,
)
from reports import cash_report, credit_report, group_report, review_report, revenue_report

def _seed(role: str) -> str:
    return f"{os.environ['LUYTEN_ADVISOR_SEED']}/{role}"


def _desk(name: str, role: str) -> tuple[Agent, Protocol]:
    return Agent(name=name, seed=_seed(role)), Protocol(name=f"luyten-{role}", version="0.1.0")


bookkeeper, _bk = _desk("Luyten Bookkeeper", "bookkeeper")
revenue, _rev = _desk("Luyten Revenue", "revenue")
credit, _cr = _desk("Luyten Credit & Risk", "credit")
consolidation, _cons = _desk("Luyten Consolidation", "consolidation")
redteam, _rt = _desk("Luyten Red Team", "redteam")


async def _answer(ctx: Context, sender: str, response_type, build):
    try:
        await ctx.send(sender, await build())
    except ledger.LedgerError as e:
        await ctx.send(sender, response_type(ok=False, error=str(e)))
    except Exception as e:  # a specialist must always answer, or the orchestrator waits for its timeout
        ctx.logger.exception("specialist failed")
        await ctx.send(sender, response_type(ok=False, error=f"{e.__class__.__name__}: {e}"))


@_bk.on_message(CashRequest, replies=CashResponse)
async def on_cash(ctx: Context, sender: str, req: CashRequest):
    async def build():
        return cash_report(
            await ledger.sql("SELECT id, subsidiary_id, code FROM account"),
            await ledger.sql("SELECT account_id, debit_minor, credit_minor FROM journal_line"),
            await ledger.sql("SELECT id, name, functional_ccy, is_elimination FROM subsidiary"),
            await ledger.sql("SELECT ym, amount_minor, ccy, matched FROM bank_transaction"),
            await ledger.sql("SELECT vendor_id, amount_minor, status FROM bill"),
            await ledger.sql("SELECT id, subsidiary_id FROM vendor"),
            await ledger.proposals(),
            req.period_ym,
        )

    await _answer(ctx, sender, CashResponse, build)


@_rev.on_message(RevenueRequest, replies=RevenueResponse)
async def on_revenue(ctx: Context, sender: str, req: RevenueRequest):
    async def build():
        return revenue_report(
            await ledger.sql("SELECT customer_id, ym, amount_minor, recognized FROM revenue_schedule_line"),
            await ledger.sql("SELECT customer_id, amount_minor, status FROM invoice"),
            await ledger.sql("SELECT id, subsidiary_id FROM customer"),
            await ledger.sql("SELECT id, functional_ccy FROM subsidiary"),
            req.period_ym,
        )

    await _answer(ctx, sender, RevenueResponse, build)


@_cr.on_message(CreditRequest, replies=CreditResponse)
async def on_credit(ctx: Context, sender: str, req: CreditRequest):
    async def build():
        return credit_report(
            await ledger.sql("SELECT id, subsidiary_id, name, credit_tier, allowance_minor FROM customer"),
            await ledger.sql("SELECT name, verification FROM vendor"),
            await ledger.sql("SELECT customer_id, amount_minor, status FROM invoice"),
            await ledger.sql("SELECT id, functional_ccy FROM subsidiary"),
            max(1, min(req.top, 10)),
        )

    await _answer(ctx, sender, CreditResponse, build)


@_cons.on_message(GroupRequest, replies=GroupResponse)
async def on_group(ctx: Context, sender: str, req: GroupRequest):
    async def build():
        return group_report(
            await ledger.sql("SELECT id, name, functional_ccy, is_elimination FROM subsidiary"),
            await ledger.sql("SELECT from_ccy, to_ccy, ym, rate_e_6, kind FROM fx_rate"),
            await ledger.proposals(),
            req.period_ym,
        )

    await _answer(ctx, sender, GroupResponse, build)


@_rt.on_message(ReviewRequest, replies=ReviewResponse)
async def on_review(ctx: Context, sender: str, req: ReviewRequest):
    async def build():
        return review_report(await ledger.sql("SELECT thread_id, kind, summary_plain FROM agent_message"), await ledger.proposals(), req.proposal_ids)

    await _answer(ctx, sender, ReviewResponse, build)


for _agent, _proto in ((bookkeeper, _bk), (revenue, _rev), (credit, _cr), (consolidation, _cons), (redteam, _rt)):
    _agent.include(_proto, publish_manifest=False)

DESKS = {"bookkeeper": bookkeeper, "revenue": revenue, "credit": credit, "consolidation": consolidation, "redteam": redteam}
