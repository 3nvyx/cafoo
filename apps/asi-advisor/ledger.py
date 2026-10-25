"""Read-only access to the Luyten ledger and the Advisor.

The ledger is the SpacetimeDB database the CFO app reads. Its public tables answer SQL over HTTP without a token, and
this agent only ever reads them. Questions in plain English go to the Advisor through the agent gateway's
OpenAI-compatible endpoint, the same one Open WebUI uses.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import aiohttp

LEDGER_URL = os.getenv("LUYTEN_LEDGER_URL", "http://localhost:3000").rstrip("/")
LEDGER_DB = os.getenv("LUYTEN_LEDGER_DB", "luyten")
GATEWAY_URL = os.getenv("LUYTEN_GATEWAY_URL", "http://127.0.0.1:8787").rstrip("/")
GATEWAY_API_KEY = os.getenv("LUYTEN_GATEWAY_API_KEY", "")
TIMEOUT = aiohttp.ClientTimeout(total=60)


class LedgerError(Exception):
    """The ledger or the gateway could not be reached or refused the request."""


def _variant(algebraic_type: dict[str, Any], index: int) -> str:
    """The name of a sum-type variant, from the column's schema."""
    variants = algebraic_type["Sum"]["variants"]
    return variants[index]["name"]["some"]


def decode_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn one SQL result ({schema, rows}) into dicts keyed by column name.

    Enum columns arrive as [variant index, payload] and become their variant name; option columns arrive as a sum of
    some/none and become the value or None.
    """
    columns = result["schema"]["elements"]
    out: list[dict[str, Any]] = []
    for row in result["rows"]:
        item: dict[str, Any] = {}
        for col, value in zip(columns, row):
            name = col["name"]["some"]
            kind = col["algebraic_type"]
            if "Sum" in kind and isinstance(value, list) and len(value) == 2 and isinstance(value[0], int):
                tag = _variant(kind, value[0])
                if tag == "some":
                    item[name] = value[1]
                elif tag == "none":
                    item[name] = None
                else:
                    item[name] = tag
            else:
                item[name] = value
        out.append(item)
    return out


def same_tag(tag: str, want: str) -> bool:
    """Compare enum tags whatever their casing (awaiting_cfo, awaitingCfo, AwaitingCfo)."""
    return tag.replace("_", "").lower() == want.replace("_", "").lower()


@dataclass
class Proposal:
    id: int
    kind: str
    status: str
    amount_minor: int
    summary: str
    rationale: str
    proposer: str
    thread_id: str


async def sql(query: str) -> list[dict[str, Any]]:
    """Run one read query against the ledger."""
    try:
        async with aiohttp.ClientSession(timeout=TIMEOUT) as s:
            async with s.post(f"{LEDGER_URL}/v1/database/{LEDGER_DB}/sql", data=query) as r:
                if r.status != 200:
                    raise LedgerError(f"the ledger answered {r.status}: {(await r.text())[:200]}")
                results = await r.json(content_type=None)
    except aiohttp.ClientError as e:
        raise LedgerError(f"the ledger at {LEDGER_URL} is not reachable ({e.__class__.__name__})") from e
    return decode_rows(results[0]) if results else []


async def proposals() -> list[Proposal]:
    rows = await sql("SELECT id, kind, status, amount_minor, summary_plain, rationale, proposer_role, thread_id FROM proposal")
    return [
        Proposal(r["id"], r["kind"], r["status"], int(r["amount_minor"]), r["summary_plain"], r["rationale"], r["proposer_role"], r["thread_id"])
        for r in rows
    ]


async def waiting_for_cfo() -> list[Proposal]:
    """Material Proposals the Advisor approved that wait for the CFO's one click, largest first."""
    return sorted((p for p in await proposals() if same_tag(p.status, "awaiting_cfo")), key=lambda p: -p.amount_minor)


async def proposal(pid: int) -> Proposal | None:
    return next((p for p in await proposals() if p.id == pid), None)


async def ruling(pid: int) -> dict[str, Any] | None:
    rows = await sql(f"SELECT decision, rationale, summary_plain FROM approval WHERE proposal_id = {int(pid)}")
    return rows[0] if rows else None


async def critiques(thread_id: str) -> list[dict[str, Any]]:
    """The Red Team's critiques on one Proposal's thread."""
    safe = thread_id.replace("'", "''")
    rows = await sql(f"SELECT sender_role, kind, summary_plain, body FROM agent_message WHERE thread_id = '{safe}'")
    return [r for r in rows if same_tag(r["kind"], "critique")]


async def current_period() -> str:
    """The month being reported: the latest one whose close has started or finished, else the first open one."""
    periods = await sql("SELECT ym, status FROM period")
    started = sorted(p["ym"] for p in periods if not same_tag(p["status"], "open"))
    return started[-1] if started else min(p["ym"] for p in periods)


async def ask_advisor(question: str) -> str:
    """Ask the Advisor in plain English; it answers from the books and can start a close when asked to."""
    headers = {"content-type": "application/json"}
    if GATEWAY_API_KEY:
        headers["authorization"] = f"Bearer {GATEWAY_API_KEY}"
    body = {"model": "luyten", "stream": False, "messages": [{"role": "user", "content": question}]}
    try:
        async with aiohttp.ClientSession(timeout=TIMEOUT) as s:
            async with s.post(f"{GATEWAY_URL}/v1/chat/completions", json=body, headers=headers) as r:
                data = await r.json(content_type=None)
                if r.status != 200:
                    message = (data.get("error") or {}).get("message") if isinstance(data, dict) else None
                    raise LedgerError(f"the Advisor refused ({r.status}): {message or 'no detail'}")
    except aiohttp.ClientError as e:
        raise LedgerError(f"the Luyten agent gateway at {GATEWAY_URL} is not reachable ({e.__class__.__name__})") from e
    return str(data["choices"][0]["message"]["content"])


SYMBOL = {"USD": "$", "GBP": "\u00a3", "EUR": "\u20ac"}


def money(minor: int, ccy: str = "USD") -> str:
    """Minor units as currency, e.g. 4906500 -> $49,065 and (-23956, "GBP") -> -\u00a3239.56."""
    whole, cents = divmod(abs(int(minor)), 100)
    sign = "-" if minor < 0 else ""
    symbol = SYMBOL.get(ccy, f"{ccy} ")
    return f"{sign}{symbol}{whole:,}" + (f".{cents:02d}" if cents else "")
