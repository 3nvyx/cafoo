"""Luyten on Agentverse: the orchestrator ASI:One users talk to, and the five specialist agents it calls.

All six run in one Bureau, so the orchestrator reaches the specialists locally. Only the orchestrator has a mailbox:
Agentverse relays ASI:One messages to it, it asks the Bookkeeper, Revenue, Credit & Risk, Consolidation and Red Team
agents for their part (each with its own request and response models), and answers with interactive cards. Nothing
here confirms or posts anything: the human CFO does that in the Luyten app.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv()

from uagents import Agent, Bureau, Context, Protocol  # noqa: E402  (load .env before reading settings)
from uagents_core.contrib.protocols.chat import (  # noqa: E402
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

import cards  # noqa: E402
import ledger  # noqa: E402
from desks import DESKS  # noqa: E402
from replies import reply_to  # noqa: E402

DESK_TIMEOUT_SECONDS = int(os.getenv("DESK_TIMEOUT_SECONDS", "20"))

advisor = Agent(
    name=os.getenv("AGENT_NAME", "Luyten"),
    seed=os.environ["LUYTEN_ADVISOR_SEED"],
    mailbox=True,
    publish_agent_details=True,
)
chat = Protocol(spec=chat_protocol_spec)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = "".join(item.text for item in msg.content if isinstance(item, TextContent))

    async def call(desk: str, request, response_type):
        """Ask one specialist; None when it does not answer in time, so its part of the card is greyed out."""
        response, status = await ctx.send_and_receive(DESKS[desk].address, request, response_type=response_type, timeout=DESK_TIMEOUT_SECONDS)
        if not isinstance(response, response_type):
            ctx.logger.warning(f"{desk} did not answer: {status}")
            return None
        return response

    try:
        reply = await reply_to(text, call)
    except Exception:
        ctx.logger.exception("Unexpected error answering a chat message")
        reply = cards.text_message("Something went wrong on my side. Please try again.")
    await ctx.send(sender, reply)


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


advisor.include(chat, publish_manifest=True)


@advisor.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"Luyten address: {advisor.address}")
    for name, desk in DESKS.items():
        ctx.logger.info(f"  specialist {name}: {desk.address}")
    ctx.logger.info(f"Ledger: {ledger.LEDGER_URL}/{ledger.LEDGER_DB}  Gateway: {ledger.GATEWAY_URL}")


bureau = Bureau(port=int(os.getenv("AGENT_PORT", "8010")))
bureau.add(advisor)
for desk in DESKS.values():
    bureau.add(desk)

if __name__ == "__main__":
    bureau.run()
