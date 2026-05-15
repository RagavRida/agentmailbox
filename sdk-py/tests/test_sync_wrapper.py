"""Sync wrapper smoke tests."""

from __future__ import annotations

import uuid

from agentmail import AgentMailSync


def _ids() -> tuple[str, str]:
    s = uuid.uuid4().hex[:8]
    return f"syncA-{s}@demo", f"syncB-{s}@demo"


def test_sync_round_trip(agentmail_server: str) -> None:
    a_id, b_id = _ids()
    a = AgentMailSync(a_id, server=agentmail_server)
    a.connect()
    sent = a.send(
        b_id,
        {"task": "sync hello"},
        context_snapshot={"step": "kickoff"},
    )
    assert b_id in sent.delivered_to

    b = AgentMailSync(b_id, server=agentmail_server)
    b.connect()
    received = b.receive()
    assert len(received.messages) == 1
    assert received.messages[0].payload == {"task": "sync hello"}
    assert received.context.snapshot == {"step": "kickoff"}
