"""Tests for the Cafoo Advisor uAgent: python -m unittest -v (the live tests need the Cafoo stack running)."""

from __future__ import annotations

import asyncio
import json
import os
import unittest

os.environ.setdefault("CAFOO_ADVISOR_SEED", "cafoo-advisor-unit-test-seed")

import cards  # noqa: E402
import ledger  # noqa: E402
import reports  # noqa: E402
from models import CashResponse, Item, Money, RevenueResponse  # noqa: E402
from replies import reply_to  # noqa: E402
from uagents_core.contrib.protocols.chat import MetadataContent, TextContent  # noqa: E402

STATUS = {"Sum": {"variants": [{"name": {"some": "open"}}, {"name": {"some": "awaiting_cfo"}}]}}
OPTION = {"Sum": {"variants": [{"name": {"some": "some"}}, {"name": {"some": "none"}}]}}


def card_of(msg) -> dict | None:
    meta = [c for c in msg.content if isinstance(c, MetadataContent)]
    return json.loads(meta[0].metadata["card_payload"]) if meta else None


def depth(node, level: int = 1) -> int:
    kids = list(node.get("children", [])) + [c for item in node.get("items", []) for c in item.get("children", [])]
    return max([level] + [depth(k, level + 1) for k in kids])


class Decode(unittest.TestCase):
    def test_enums_and_options_decode_to_names_and_values(self):
        result = {
            "schema": {"elements": [{"name": {"some": "id"}, "algebraic_type": {"U64": []}}, {"name": {"some": "status"}, "algebraic_type": STATUS}, {"name": {"some": "pid"}, "algebraic_type": OPTION}]},
            "rows": [[7, [1, []], [0, 42]], [8, [0, []], [1, []]]],
        }
        self.assertEqual(ledger.decode_rows(result), [{"id": 7, "status": "awaiting_cfo", "pid": 42}, {"id": 8, "status": "open", "pid": None}])

    def test_tags_compare_across_casings(self):
        self.assertTrue(ledger.same_tag("awaitingCfo", "awaiting_cfo"))
        self.assertFalse(ledger.same_tag("approved", "awaiting_cfo"))

    def test_money(self):
        self.assertEqual(ledger.money(4906500), "$49,065")
        self.assertEqual(ledger.money(-23956), "-$239.56")
        self.assertEqual(ledger.money(375000, "GBP"), "\u00a33,750")


SUBS = [{"id": 1, "name": "Cafoo Inc", "functional_ccy": "USD", "is_elimination": False}, {"id": 2, "name": "Cafoo Ltd", "functional_ccy": "GBP", "is_elimination": False}]


class Reports(unittest.TestCase):
    def test_cash_is_per_company_in_its_own_currency(self):
        accounts = [{"id": 10, "subsidiary_id": 1, "code": "1000"}, {"id": 20, "subsidiary_id": 2, "code": "1000-UK"}, {"id": 30, "subsidiary_id": 1, "code": "1100"}]
        lines = [{"account_id": 10, "debit_minor": 500, "credit_minor": 0}, {"account_id": 10, "debit_minor": 0, "credit_minor": 200}, {"account_id": 20, "debit_minor": 900, "credit_minor": 0}, {"account_id": 30, "debit_minor": 7, "credit_minor": 0}]
        bank = [{"ym": "2026-09", "amount_minor": 50, "ccy": "USD", "matched": False}, {"ym": "2026-10", "amount_minor": 60, "ccy": "USD", "matched": False}]
        bills = [{"vendor_id": 1, "amount_minor": 100, "status": "open"}, {"vendor_id": 2, "amount_minor": 40, "status": "overdue"}, {"vendor_id": 1, "amount_minor": 999, "status": "paid"}]
        vendors = [{"id": 1, "subsidiary_id": 1}, {"id": 2, "subsidiary_id": 2}]
        r = reports.cash_report(accounts, lines, SUBS, bank, bills, vendors, [], "2026-09")
        self.assertEqual([(i.label, i.amount.amount_minor, i.amount.ccy) for i in r.cash_by_company], [("Cafoo Inc", 300, "USD"), ("Cafoo Ltd", 900, "GBP")])
        self.assertEqual((r.unmatched_bank_lines, r.bills_due), (1, 2))
        self.assertEqual([(m.ccy, m.amount_minor) for m in r.bills_due_total], [("GBP", 40), ("USD", 100)])

    def test_receivables_never_add_pounds_to_dollars(self):
        customers = [{"id": 1, "subsidiary_id": 1}, {"id": 2, "subsidiary_id": 2}]
        invoices = [{"customer_id": 1, "amount_minor": 100, "status": "overdue"}, {"customer_id": 2, "amount_minor": 70, "status": "open"}]
        r = reports.revenue_report([], invoices, customers, SUBS, "2026-09")
        self.assertEqual([(m.ccy, m.amount_minor) for m in r.open_receivables], [("GBP", 70), ("USD", 100)])
        self.assertEqual(r.overdue_invoices, 1)


class Selections(unittest.TestCase):
    def test_json_selection_from_a_direct_mention(self):
        self.assertEqual(cards.parse_selection('{"action": "explain", "proposal_id": "5", "source": "cafoo_advisor"}')["proposal_id"], "5")

    def test_prose_selection_from_the_planner(self):
        self.assertEqual(cards.parse_selection("The user tapped Why? on proposal_id 12."), {"action": "explain", "proposal_id": "12"})

    def test_plain_questions_are_not_selections(self):
        self.assertIsNone(cards.parse_selection("how much cash do we have?"))


class Cards(unittest.TestCase):
    def test_every_card_is_a_valid_custom_card(self):
        p = ledger.Proposal(1, "bankMatch", "awaiting_cfo", 4906500, "Match 9 vendor payments.", "x" * 5000, "bookkeeper", "proposal:1")
        cash = CashResponse(ok=True, cash_by_company=[Item(label="Cafoo Ltd", amount=Money(amount_minor=-23956, ccy="GBP"))], unmatched_bank_lines=2)
        rev = RevenueResponse(ok=False, error="ledger offline")
        msgs = [
            cards.menu_message(),
            cards.needs_ok_message([p] * 20),
            cards.needs_ok_message([]),
            cards.explain_message(p, {"summary_plain": "Approved."}, ["Check the dates."]),
            cards.health_message("2026-09", cash, rev, None, None, [p] * 3),
            cards.topic_message("Cash", "intro", cards.cash_block(cash)),
        ]
        for msg in msgs:
            meta = [c for c in msg.content if isinstance(c, MetadataContent)][0].metadata
            self.assertEqual((meta["card_protocol_version"], meta["card_kind"]), ("1", "custom"))
            self.assertLess(len(meta["card_payload"].encode()), 64 * 1024)
            self.assertLessEqual(depth(card_of(msg)["root"]), 8)
            self.assertTrue(any(isinstance(c, TextContent) and c.text for c in msg.content))


async def no_answer(desk, request, response_type):
    """A specialist that never answers in time."""
    return None


def stack_up() -> bool:
    try:
        asyncio.run(ledger.sql("SELECT id FROM period"))
        return True
    except ledger.LedgerError:
        return False


@unittest.skipUnless(stack_up(), "the Cafoo ledger is not running")
class Live(unittest.TestCase):
    def test_greeting_shows_the_menu_card(self):
        self.assertEqual(card_of(asyncio.run(reply_to("hi", no_answer)))["root"]["title"], "Cafoo Advisor")

    def test_health_check_still_renders_when_no_specialist_answers(self):
        root = card_of(asyncio.run(reply_to('{"action": "health"}', no_answer)))["root"]
        self.assertTrue(root["title"].startswith("Financial health, "))
        self.assertIn("could not answer", json.dumps(root))

    def test_needs_ok_lists_what_waits_for_the_cfo(self):
        waiting = asyncio.run(ledger.waiting_for_cfo())
        root = card_of(asyncio.run(reply_to('{"action": "needs_ok"}', no_answer)))["root"]
        self.assertIn(f": {len(waiting)}", root["title"]) if waiting else self.assertEqual(root["title"], "Cafoo Advisor")

    def test_explain_reads_a_real_proposal(self):
        first = asyncio.run(ledger.proposals())[0]
        root = card_of(asyncio.run(reply_to(json.dumps({"action": "explain", "proposal_id": str(first.id)}), no_answer)))["root"]
        self.assertEqual(root["title"], f"Proposal {first.id}")

    def test_a_question_goes_to_the_advisor(self):
        msg = asyncio.run(reply_to("how much cash do we have?", no_answer))
        self.assertIsNone(card_of(msg))
        self.assertTrue(msg.content[0].text)


if __name__ == "__main__":
    unittest.main()
