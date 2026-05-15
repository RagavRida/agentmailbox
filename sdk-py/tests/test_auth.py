"""API-key auth tests against a server with AGENTMAIL_API_KEY set."""

from __future__ import annotations

import uuid

import pytest

from agentmail import AgentMail, AgentMailError


def _id() -> str:
    return f"auth-{uuid.uuid4().hex[:8]}@demo"


@pytest.mark.asyncio
async def test_missing_api_key_returns_401(
    agentmail_server_with_auth: tuple[str, str],
) -> None:
    url, _ = agentmail_server_with_auth
    async with AgentMail(_id(), server=url) as client:
        with pytest.raises(AgentMailError) as exc_info:
            await client.connect()
        assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_correct_api_key_works(
    agentmail_server_with_auth: tuple[str, str],
) -> None:
    url, key = agentmail_server_with_auth
    async with AgentMail(_id(), server=url, api_key=key) as client:
        await client.connect()
        # one round-trip to confirm authenticated requests work end-to-end
        peer = _id()
        sent = await client.send(peer, {"hello": "auth"})
        assert peer in sent.delivered_to
