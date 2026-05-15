"""CC / BCC / replyAll visibility tests."""

from __future__ import annotations

import uuid

import pytest

from agentmailbox import AgentMailbox


def _ids() -> tuple[str, str, str, str]:
    s = uuid.uuid4().hex[:8]
    return (
        f"orch-{s}@demo",
        f"researcher-{s}@demo",
        f"writer-{s}@demo",
        f"logger-{s}@demo",
    )


@pytest.mark.asyncio
async def test_cc_visible_bcc_hidden(agentmailbox_server: str) -> None:
    orch, researcher, writer, logger = _ids()

    async with AgentMailbox(orch, server=agentmailbox_server) as o:
        await o.connect()
        sent = await o.send(
            researcher,
            {"task": "find 50 papers"},
            cc=[writer],
            bcc=[logger],
            context_snapshot={"step": "dispatch"},
        )
        thread_id = sent.thread_id
        assert set(sent.delivered_to) == {researcher, writer, logger}

    async with AgentMailbox(researcher, server=agentmailbox_server) as r:
        await r.connect()
        unread = await r.unread()
        assert len(unread) == 1
        frame = unread[0]
        assert frame.cc == [writer]
        # bcc must be stripped from researcher's view
        assert frame.bcc is None

        reply = await r.reply_all(
            thread_id,
            {"result": "found"},
            context_snapshot={"step": "research_done"},
        )
        # reply_all goes to visible participants minus sender
        assert set(reply.delivered_to) == {orch, writer}

    async with AgentMailbox(logger, server=agentmailbox_server) as l:
        await l.connect()
        unread = await l.unread()
        assert len(unread) == 1
        # logger sees the message but not the bcc field
        assert unread[0].bcc is None


@pytest.mark.asyncio
async def test_participants_filtering(agentmailbox_server: str) -> None:
    orch, researcher, writer, logger = _ids()

    async with AgentMailbox(orch, server=agentmailbox_server) as o:
        await o.connect()
        sent = await o.send(
            researcher,
            {"task": "x"},
            cc=[writer],
            bcc=[logger],
        )
        thread_id = sent.thread_id

        # Orchestrator (sender of the bcc) should see logger.
        roles = await o.participants(thread_id)
        ids = {p.agent_id for p in roles}
        assert logger in ids

    async with AgentMailbox(writer, server=agentmailbox_server) as w:
        await w.connect()
        roles = await w.participants(thread_id)
        ids = {p.agent_id for p in roles}
        assert logger not in ids

    async with AgentMailbox(logger, server=agentmailbox_server) as l:
        await l.connect()
        roles = await l.participants(thread_id)
        ids = {p.agent_id for p in roles}
        # bcc'd agent can see themselves
        assert logger in ids
