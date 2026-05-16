"""Two-agent demo for the AgentMailbox Python SDK.

Mirrors examples/basic.ts. Run after starting the AgentMailbox server:

    cd ~/agentmailbox && npm run start
    python sdk-py/examples/basic.py
"""

from __future__ import annotations

import asyncio
import os

from agentmailbox import AgentMailbox


SERVER = os.environ.get("AGENTSMCP_SERVER", "http://localhost:3000")


async def main() -> None:
    # ResearchAgent
    async with AgentMailbox("researcher@demo", server=SERVER) as researcher:
        await researcher.connect()
        result = await researcher.send(
            "writer@demo",
            {"task": "summarize diffusion models", "papers": ["paper1", "paper2"]},
            context_snapshot={"step": "research_complete", "paper_count": 2},
        )
        thread_id = result.thread_id
        print(f"[researcher] sent on thread: {thread_id}")

    # WriterAgent — cold start, picks up full context
    async with AgentMailbox("writer@demo", server=SERVER) as writer:
        await writer.connect()
        inbound = await writer.receive()
        print(f"[writer] unread messages: {len(inbound.messages)}")
        print(f"[writer] context.snapshot: {inbound.context.snapshot}")
        assert inbound.context.snapshot == {
            "step": "research_complete",
            "paper_count": 2,
        }, "writer should pick up researcher's snapshot cold"

        reply = await writer.send(
            "researcher@demo",
            {"draft": "Diffusion models work by..."},
            thread_id=thread_id,
            context_snapshot={"step": "draft_complete", "word_count": 500},
        )
        print(f"[writer] reply sent: {reply.message_id}")
        await writer.mark_read(thread_id)

    # Researcher syncs updated context
    async with AgentMailbox("researcher@demo", server=SERVER) as researcher:
        await researcher.connect()
        context = await researcher.sync(thread_id)
        print(f"[researcher] synced snapshot: {context.snapshot}")
        assert context.snapshot == {"step": "draft_complete", "word_count": 500}
        print(
            "[researcher] recent payloads:",
            [m.payload for m in context.recent_messages],
        )


if __name__ == "__main__":
    asyncio.run(main())
