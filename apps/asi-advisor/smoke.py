"""End-to-end check before a demo: a test client chats with the orchestrator, which really calls its specialists.

Runs the orchestrator, the five specialists and a client in one local Bureau (port 8019) against the running Luyten
ledger and gateway, sends a few chat messages and checks each reply's card. Exits 0 when every step passes.

    .venv/bin/python smoke.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from uuid import uuid4

from uagents import Agent, Bureau, Context, Protocol
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, MetadataContent, TextContent, chat_protocol_spec

from agent import advisor
from desks import DESKS

STEPS = [
    ('{"action": "health", "source": "luyten_advisor"}', lambda root, text: root["title"].startswith("Financial health, ") and "could not answer" not in json.dumps(root)),
    ('{"action": "credit", "source": "luyten_advisor"}', lambda root, text: root["title"] == "Credit risk" and "could not answer" not in json.dumps(root)),
    ('{"action": "needs_ok", "source": "luyten_advisor"}', lambda root, text: root["title"].startswith(("Needs the CFO's OK", "Luyten"))),
    ('{"action": "explain", "proposal_id": "1", "source": "luyten_advisor"}', lambda root, text: root["title"] == "Proposal 1"),
    ("how much cash do we have?", lambda root, text: root is None and bool(text)),
]

client = Agent(name="luyten-smoke-client", seed=f"{os.environ['LUYTEN_ADVISOR_SEED']}/smoke-client")
proto = Protocol(spec=chat_protocol_spec)
state = {"step": 0, "failed": 0}


def chat(text: str) -> ChatMessage:
    return ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=[TextContent(type="text", text=text)])


@client.on_event("startup")
async def start(ctx: Context):
    await ctx.send(advisor.address, chat(STEPS[0][0]))


@proto.on_message(ChatMessage)
async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = "".join(c.text for c in msg.content if isinstance(c, TextContent))
    meta = [c for c in msg.content if isinstance(c, MetadataContent)]
    root = json.loads(meta[0].metadata["card_payload"])["root"] if meta else None
    sent, check = STEPS[state["step"]]
    ok = check(root, text)
    state["failed"] += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {sent[:60]!r} -> {root['title'] if root else text[:80]!r}", flush=True)
    if not ok and root:
        print("   ", [m for m in json.dumps(root).split('"value": ') if "could not answer" in m][:3], flush=True)
    state["step"] += 1
    if state["step"] < len(STEPS):
        await ctx.send(advisor.address, chat(STEPS[state["step"]][0]))
    else:
        print(f"{len(STEPS) - state['failed']}/{len(STEPS)} steps passed", flush=True)
        os._exit(1 if state["failed"] else 0)


@proto.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


client.include(proto)

if __name__ == "__main__":
    bureau = Bureau(port=8019)
    for a in (advisor, client, *DESKS.values()):
        bureau.add(a)
    try:
        bureau.run()
    finally:
        sys.exit(1)
