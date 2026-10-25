"""ASI:One interactive cards for Luyten.

Each reply is a text bubble plus one `custom` card (element tree), sent as MetadataContent on the chat protocol. A
button's `action.selection` comes back as a follow-up ChatMessage: a JSON object when the user @mentions the agent,
or prose when the ASI:One planner routes the click, so parse_selection accepts both.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from uagents_core.contrib.protocols.chat import ChatMessage, MetadataContent, TextContent

from ledger import Proposal, money

SOURCE = "luyten_advisor"
KIND_LABEL = {
    "journalentry": "Journal entry",
    "bankmatch": "Bank match",
    "revenueschedule": "Revenue schedule",
    "creditdecision": "Credit decision",
    "accrual": "Accrual",
    "vendorblock": "Vendor block",
    "vendorverify": "Vendor check",
    "fxrevaluation": "Revaluation",
    "icelimination": "Elimination",
}


def kind_label(kind: str) -> str:
    return KIND_LABEL.get(kind.replace("_", "").lower(), kind)


def _button(label: str, selection: dict[str, Any], primary: bool = False) -> dict[str, Any]:
    return {"type": "button", "label": label, "primary": primary, "action": {"selection": {**selection, "source": SOURCE}}}


def _message(text: str, root: dict[str, Any] | None = None) -> ChatMessage:
    content: list[Any] = [TextContent(type="text", text=text)]
    if root is not None:
        content.append(
            MetadataContent(
                type="metadata",
                metadata={
                    "card_protocol_version": "1",
                    "requires_card_interaction": "true",
                    "card_kind": "custom",
                    "card_payload": json.dumps({"root": root}),
                },
            )
        )
    return ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=content)


def text_message(text: str) -> ChatMessage:
    return _message(text)


def menu_root() -> dict[str, Any]:
    return {
        "type": "section",
        "title": "Luyten",
        "subtitle": "Automated finance for growth startups",
        "children": [
            {
                "type": "text",
                "style": "body",
                "value": "Worker agents propose every change to the books, a Red Team on a second model critiques them, "
                "I rule on each one with a written reason, and anything material waits for the CFO.",
            },
            {
                "type": "group",
                "direction": "column",
                "gap": 8,
                "children": [
                    _button("Financial health check", {"action": "health"}, primary=True),
                    _button("What needs the CFO's OK?", {"action": "needs_ok"}),
                    _button("Cash and the bank", {"action": "cash"}),
                    _button("Revenue and receivables", {"action": "revenue"}),
                    _button("Credit risk", {"action": "credit"}),
                    _button("The group and FX", {"action": "group"}),
                    _button("Start the close", {"action": "start_close"}),
                ],
            },
        ],
    }


def menu_message(intro: str | None = None) -> ChatMessage:
    return _message(intro or "Here is what I can do for you. Pick one, or ask me anything about the books.", menu_root())


def needs_ok_message(items: list[Proposal]) -> ChatMessage:
    if not items:
        return _message(
            "Nothing is waiting for the CFO right now. Material items appear here once the Advisor approves them.",
            menu_root(),
        )
    total = sum(p.amount_minor for p in items)
    rows = [
        {
            "children": [
                {
                    "type": "group",
                    "direction": "column",
                    "gap": 6,
                    "children": [
                        {"type": "heading", "level": 3, "value": p.summary},
                        {
                            "type": "group",
                            "direction": "row",
                            "gap": 6,
                            "children": [
                                {"type": "badge", "label": money(p.amount_minor), "variant": "warning"},
                                {"type": "badge", "label": kind_label(p.kind), "variant": "info"},
                            ],
                        },
                    ],
                },
                _button("Why?", {"action": "explain", "proposal_id": str(p.id)}),
            ]
        }
        for p in items[:12]
    ]
    root = {
        "type": "section",
        "title": f"Needs the CFO's OK: {len(items)}",
        "subtitle": f"{money(total)} in total. The CFO confirms these in the Luyten app.",
        "children": [{"type": "list", "items": rows}],
    }
    more = f" Showing the 12 largest of {len(items)}." if len(items) > 12 else ""
    return _message(f"{len(items)} material items wait for the CFO, {money(total)} in total.{more}", root)


def explain_message(p: Proposal, ruling: dict[str, Any] | None, critiques: list[str]) -> ChatMessage:
    children: list[dict[str, Any]] = [
        {"type": "text", "style": "emphasis", "value": p.summary},
        {
            "type": "group",
            "direction": "row",
            "gap": 6,
            "children": [
                {"type": "badge", "label": money(p.amount_minor), "variant": "warning"},
                {"type": "badge", "label": kind_label(p.kind), "variant": "info"},
                {"type": "badge", "label": f"proposed by {p.proposer}", "variant": "neutral"},
            ],
        },
        {"type": "divider"},
        {"type": "heading", "level": 3, "value": "Why it was proposed"},
        {"type": "text", "style": "body", "value": p.rationale[:1200]},
    ]
    if critiques:
        children += [{"type": "divider"}, {"type": "heading", "level": 3, "value": "Red Team"}]
        children += [{"type": "text", "style": "muted", "value": c} for c in critiques[:3]]
    if ruling:
        children += [
            {"type": "divider"},
            {"type": "heading", "level": 3, "value": "Advisor's ruling"},
            {"type": "text", "style": "body", "value": ruling["summary_plain"]},
        ]
    children.append(_button("Back to the list", {"action": "needs_ok"}))
    root = {"type": "section", "title": f"Proposal {p.id}", "children": children}
    return _message(f"Here is why Proposal {p.id} exists and how it was ruled.", root)


_ID_PROSE = re.compile(r"proposal[_\s-]?id[\s:=\"']*(\d+)", re.IGNORECASE)
_ACTIONS = ("needs_ok", "explain", "start_close", "ask", "menu", "health", "cash", "revenue", "credit", "group")


def parse_selection(text: str) -> dict[str, str] | None:
    """A card selection from inbound text: a JSON object (direct @mention) or prose (routed by the planner)."""
    stripped = (text or "").strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict) and data.get("action") in _ACTIONS:
            return {k: str(v) for k, v in data.items() if isinstance(v, (str, int))}
    lowered = stripped.lower()
    match = _ID_PROSE.search(stripped)
    if match:
        return {"action": "explain", "proposal_id": match.group(1)}
    for action in _ACTIONS:
        if action in lowered.replace(" ", "_") and SOURCE in lowered.replace(" ", "_"):
            return {"action": action}
    return None


# ---------- orchestrated cards (built from the specialists' responses) ----------


def amounts(ms) -> str:
    return " + ".join(money(m.amount_minor, m.ccy) for m in ms) if ms else "nothing"


def _unavailable(who: str, r) -> dict[str, Any]:
    reason = getattr(r, "error", "") or "no answer in time"
    return {"type": "text", "style": "muted", "value": f"The {who} could not answer: {reason}"}


def _rows(pairs: list[tuple[str, str]]) -> list[dict[str, Any]]:
    return [
        {"type": "group", "direction": "row", "gap": 8, "children": [{"type": "text", "style": "muted", "value": k}, {"type": "text", "style": "emphasis", "value": v}]}
        for k, v in pairs
    ]


def cash_block(r) -> list[dict[str, Any]]:
    if r is None or not r.ok:
        return [_unavailable("Bookkeeper", r)]
    return _rows(
        [(f"Cash, {i.label}", money(i.amount.amount_minor, i.amount.ccy)) for i in r.cash_by_company]
        + [("Unmatched bank lines", f"{r.unmatched_bank_lines} ({amounts(r.unmatched_total)})"), ("Unpaid bills", f"{r.bills_due} ({amounts(r.bills_due_total)})")]
    )


def revenue_block(r) -> list[dict[str, Any]]:
    if r is None or not r.ok:
        return [_unavailable("Revenue agent", r)]
    return _rows(
        [
            ("Recognized this month", amounts(r.recognized_this_month)),
            ("Still to recognize", amounts(r.still_to_recognize)),
            ("Owed by customers", amounts(r.open_receivables)),
            ("Overdue", f"{amounts(r.overdue_receivables)} on {r.overdue_invoices} invoices"),
        ]
    )


def credit_block(r) -> list[dict[str, Any]]:
    if r is None or not r.ok:
        return [_unavailable("Credit & Risk agent", r)]
    pairs = [("Customers by tier", ", ".join(f"{t.label}: {t.ref}" for t in r.tiers)), ("Reserved for bad debt", amounts(r.total_allowance))]
    pairs += [(f"Owes us: {e.label}", money(e.amount.amount_minor, e.amount.ccy)) for e in r.top_exposures[:3]]
    if r.blocked_vendors:
        pairs.append(("Blocked vendors", ", ".join(r.blocked_vendors)))
    return _rows(pairs)


def group_block(r) -> list[dict[str, Any]]:
    if r is None or not r.ok:
        return [_unavailable("Consolidation agent", r)]
    pairs = [("Companies", ", ".join(r.companies)), ("Rates this month", "; ".join(r.rates) or "none recorded")]
    pairs += [("Group entry", e.label) for e in r.group_entries[:3]]
    return _rows(pairs)


def advice(cash, rev, credit, waiting: list[Proposal]) -> list[str]:
    """Plain next steps from what the specialists reported."""
    tips: list[str] = []
    if waiting:
        tips.append(f"Confirm or send back the {len(waiting)} items waiting for you ({money(sum(p.amount_minor for p in waiting))}) in the Luyten app, largest first.")
    if rev is not None and rev.ok and rev.overdue_invoices:
        tips.append(f"Chase {rev.overdue_invoices} overdue invoices worth {amounts(rev.overdue_receivables)}.")
    if cash is not None and cash.ok and cash.unmatched_bank_lines:
        tips.append(f"{cash.unmatched_bank_lines} bank lines are still unexplained; the Bookkeeper proposes matches as the feed brings them in.")
    if credit is not None and credit.ok and credit.blocked_vendors:
        tips.append(f"Do not pay {', '.join(credit.blocked_vendors)}: their owners failed identity or fraud checks.")
    return tips or ["Nothing needs attention right now. The books for this month are in order."]


def health_message(period_ym: str, cash, rev, credit, group, waiting: list[Proposal]) -> ChatMessage:
    tips = advice(cash, rev, credit, waiting)
    root = {
        "type": "section",
        "title": f"Financial health, {period_ym}",
        "subtitle": "From the Bookkeeper, Revenue, Credit & Risk and Consolidation agents",
        "children": [
            {"type": "heading", "level": 3, "value": "Cash and the bank"},
            *cash_block(cash),
            {"type": "divider"},
            {"type": "heading", "level": 3, "value": "Revenue and receivables"},
            *revenue_block(rev),
            {"type": "divider"},
            {"type": "heading", "level": 3, "value": "Credit risk"},
            *credit_block(credit),
            {"type": "divider"},
            {"type": "heading", "level": 3, "value": "The group"},
            *group_block(group),
            {"type": "divider"},
            {"type": "heading", "level": 3, "value": "What I advise"},
            *[{"type": "text", "style": "body", "value": t} for t in tips],
            {
                "type": "group",
                "direction": "row",
                "gap": 8,
                "children": [_button("What needs my OK?", {"action": "needs_ok"}, primary=True), _button("Menu", {"action": "menu"})],
            },
        ],
    }
    return _message(f"Here is the state of the books for {period_ym}. {tips[0]}", root)


def topic_message(title: str, intro: str, blocks: list[dict[str, Any]]) -> ChatMessage:
    root = {"type": "section", "title": title, "children": [*blocks, _button("Full health check", {"action": "health"}, primary=True), _button("Menu", {"action": "menu"})]}
    return _message(intro, root)
