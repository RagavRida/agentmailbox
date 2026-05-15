"""Multi-agent (CC/BCC/ReplyAll) demo for the AgentMailbox Python SDK.

Mirrors examples/multi-agent.ts. Run after starting the AgentMailbox server.
"""

from __future__ import annotations

import asyncio
import os

from agentmailbox import AgentMailbox


SERVER = os.environ.get("AGENTMAILBOX_SERVER", "http://localhost:3000")


async def main() -> None:
    # Orchestrator sends to Researcher.
    # CC: Writer (watching, will jump in).
    # BCC: Logger (silent audit trail).
    async with AgentMailbox("orchestrator@demo", server=SERVER) as orchestrator:
        await orchestrator.connect()
        sent = await orchestrator.send(
            "researcher@demo",
            {"task": "find 50 papers on diffusion models"},
            cc=["writer@demo"],
            bcc=["logger@demo"],
            context_snapshot={"step": "task_dispatched", "priority": "high"},
        )
        thread_id = sent.thread_id
        print(f"[orchestrator] sent on thread: {thread_id}")
        print(f"[orchestrator] delivered to: {sent.delivered_to}")
        assert set(sent.delivered_to) == {
            "researcher@demo",
            "writer@demo",
            "logger@demo",
        }

    # Researcher picks up — sees writer in CC, does NOT see logger in bcc.
    async with AgentMailbox("researcher@demo", server=SERVER) as researcher:
        await researcher.connect()
        inbound = await researcher.receive()
        print(f"[researcher] unread: {len(inbound.messages)}")
        print(f"[researcher] context.snapshot: {inbound.context.snapshot}")
        assert inbound.context.snapshot == {
            "step": "task_dispatched",
            "priority": "high",
        }
        first = inbound.messages[0]
        print(f"[researcher] cc: {first.cc}")
        print(f"[researcher] bcc (must be None): {first.bcc}")
        assert first.cc == ["writer@demo"]
        assert first.bcc is None, "bcc must be stripped from non-sender's view"

        replied = await researcher.reply_all(
            thread_id,
            {"result": "found 50 papers", "papers": ["paper1", "paper2"]},
            context_snapshot={"step": "research_complete", "paper_count": 50},
        )
        print(f"[researcher] replyAll delivered to: {replied.delivered_to}")
        assert set(replied.delivered_to) == {"orchestrator@demo", "writer@demo"}

    # Writer was CC'd — picks up full updated context.
    async with AgentMailbox("writer@demo", server=SERVER) as writer:
        await writer.connect()
        writer_inbox = await writer.receive()
        print(f"[writer] context.snapshot: {writer_inbox.context.snapshot}")
        print(f"[writer] unread: {len(writer_inbox.messages)}")
        assert writer_inbox.context.snapshot == {
            "step": "research_complete",
            "paper_count": 50,
        }

    # Logger was BCC'd — silently received the original message.
    async with AgentMailbox("logger@demo", server=SERVER) as logger:
        await logger.connect()
        logger_unread = await logger.unread()
        print(f"[logger] unread: {len(logger_unread)}")
        assert len(logger_unread) == 1, "logger should have received exactly one msg"
        only = logger_unread[0]
        print(f"[logger] bcc stripped from view: {only.bcc is None}")
        print(f"[logger] payload: {only.payload}")
        assert only.bcc is None
        assert only.payload == {"task": "find 50 papers on diffusion models"}

    # Participants endpoint — orchestrator (the bcc'er) sees logger.
    async with AgentMailbox("orchestrator@demo", server=SERVER) as orchestrator:
        await orchestrator.connect()
        orch_view = await orchestrator.participants(thread_id)
        print(
            "[orchestrator] participants:",
            [(p.agent_id, p.role) for p in orch_view],
        )
        assert any(p.agent_id == "logger@demo" and p.role == "bcc" for p in orch_view)

    # Writer (CC'd, not the bcc'er) does NOT see logger.
    async with AgentMailbox("writer@demo", server=SERVER) as writer:
        writer_view = await writer.participants(thread_id)
        print("[writer] participants:", [(p.agent_id, p.role) for p in writer_view])
        assert not any(p.agent_id == "logger@demo" for p in writer_view)

    # Logger sees themselves.
    async with AgentMailbox("logger@demo", server=SERVER) as logger:
        logger_view = await logger.participants(thread_id)
        print("[logger] participants:", [(p.agent_id, p.role) for p in logger_view])
        assert any(p.agent_id == "logger@demo" for p in logger_view)

    print("\nAll CC/BCC/ReplyAll assertions passed.")


if __name__ == "__main__":
    asyncio.run(main())
