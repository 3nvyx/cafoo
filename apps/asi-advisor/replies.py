"""Luyten's orchestration: what to answer, and which specialist agents to ask for it.

`call(desk, request, response_type)` sends one request to a specialist agent and returns its response, or None when it
did not answer in time; agent.py passes ctx.send_and_receive, and tests pass a stub. Independent specialists are
asked in parallel, and a missing answer only greys out its part of the card.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from uagents_core.contrib.protocols.chat import ChatMessage

import cards
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

Call = Callable[[str, Any, type], Awaitable[Any]]

GREETINGS = {"", "hi", "hello", "hey", "menu", "help", "start", "what can you do", "what can you do?"}
HEALTH_WORDS = ("health", "how are we doing", "how is the business", "overview", "summary", "how are the books")


async def _health(call: Call) -> ChatMessage:
    ym = await ledger.current_period()
    cash, rev, credit, group, waiting = await asyncio.gather(
        call("bookkeeper", CashRequest(period_ym=ym), CashResponse),
        call("revenue", RevenueRequest(period_ym=ym), RevenueResponse),
        call("credit", CreditRequest(top=5), CreditResponse),
        call("consolidation", GroupRequest(period_ym=ym), GroupResponse),
        ledger.waiting_for_cfo(),
    )
    return cards.health_message(ym, cash, rev, credit, group, waiting)


async def _topic(action: str, call: Call) -> ChatMessage:
    ym = await ledger.current_period()
    if action == "cash":
        r = await call("bookkeeper", CashRequest(period_ym=ym), CashResponse)
        return cards.topic_message(f"Cash and the bank, {ym}", "The Bookkeeper's view of cash and the bank.", cards.cash_block(r))
    if action == "revenue":
        r = await call("revenue", RevenueRequest(period_ym=ym), RevenueResponse)
        return cards.topic_message(f"Revenue and receivables, {ym}", "The Revenue agent's view of what we earned and what we are owed.", cards.revenue_block(r))
    if action == "credit":
        r = await call("credit", CreditRequest(top=5), CreditResponse)
        return cards.topic_message("Credit risk", "The Credit & Risk agent's view of who is behind our customers and vendors.", cards.credit_block(r))
    r = await call("consolidation", GroupRequest(period_ym=ym), GroupResponse)
    return cards.topic_message(f"The group, {ym}", "The Consolidation agent's view of the companies, rates and group entries.", cards.group_block(r))


async def _explain(pid: int, call: Call) -> ChatMessage:
    p = await ledger.proposal(pid)
    if p is None:
        return cards.menu_message(f"I could not find Proposal {pid} in the books.")
    ruling, review = await asyncio.gather(ledger.ruling(p.id), call("redteam", ReviewRequest(proposal_ids=[p.id]), ReviewResponse))
    critiques = [c.label for c in review.critiques] if review is not None and review.ok else ["The Red Team could not answer just now."]
    return cards.explain_message(p, ruling, critiques)


async def reply_to(text: str, call: Call) -> ChatMessage:
    """The reply to one inbound message: a card for a button, a greeting or a health question, else the Advisor's answer."""
    choice = cards.parse_selection(text)
    lowered = text.strip().lower()
    try:
        if choice is None and lowered in GREETINGS:
            return cards.menu_message()
        action = (choice or {}).get("action")
        if action is None and any(w in lowered for w in HEALTH_WORDS):
            action = "health"
        if action == "menu":
            return cards.menu_message()
        if action == "health":
            return await _health(call)
        if action in ("cash", "revenue", "credit", "group"):
            return await _topic(action, call)
        if action == "needs_ok":
            return cards.needs_ok_message(await ledger.waiting_for_cfo())
        if action == "explain":
            return await _explain(int(choice["proposal_id"]), call)
        if action == "start_close":
            return cards.text_message(await ledger.ask_advisor("start the close"))
        if action == "ask":
            return cards.text_message(await ledger.ask_advisor(choice.get("question", "")))
        return cards.text_message(await ledger.ask_advisor(text))
    except ledger.LedgerError as e:
        return cards.text_message(f"I can't reach the Luyten books right now: {e}. Try again in a moment.")
    except (KeyError, ValueError) as e:
        return cards.menu_message(f"I didn't understand that selection ({e.__class__.__name__}). Here is the menu.")
