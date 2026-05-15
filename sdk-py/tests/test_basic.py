"""Connect + send + receive + sync round-trip tests."""

from __future__ import annotations

import uuid

import pytest

from agentmail import AgentMail


def _ids() -> tuple[str, str]:
    suffix = uuid.uuid4().hex[:8]
    return f"a-{suffix}@demo", f"b-{suffix}@demo"


@pytest.mark.asyncio
async def test_round_trip(agentmail_server: str) -> None:
    a_id, b_id = _ids()
    async with AgentMail(a_id, server=agentmail_server) as a:
        await a.connect()
        sent = await a.send(
            b_id,
            {"task": "summarize"},
            context_snapshot={"step": "kickoff"},
        )
        assert isinstance(sent.thread_id, str)
        assert b_id in sent.delivered_to

    async with AgentMail(b_id, server=agentmail_server) as b:
        await b.connect()
        received = await b.receive()
        assert len(received.messages) == 1
        frame = received.messages[0]
        assert frame.from_agent == a_id
        assert frame.payload == {"task": "summarize"}
        assert received.context.snapshot == {"step": "kickoff"}


@pytest.mark.asyncio
async def test_cold_sync_returns_same_snapshot(agentmail_server: str) -> None:
    a_id, b_id = _ids()
    async with AgentMail(a_id, server=agentmail_server) as a:
        await a.connect()
        sent = await a.send(
            b_id,
            {"task": "draft"},
            context_snapshot={"step": "ready", "count": 3},
        )
        thread_id = sent.thread_id

    # Cold-start a new client for b and rejoin via sync().
    async with AgentMail(b_id, server=agentmail_server) as cold_b:
        await cold_b.connect()
        ctx = await cold_b.sync(thread_id)
        assert ctx.snapshot == {"step": "ready", "count": 3}
        assert len(ctx.recent_messages) == 1
        assert ctx.recent_messages[0].payload == {"task": "draft"}
