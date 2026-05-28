"""Tests for context graph and codebase index methods (v0.1.3+)."""

from __future__ import annotations

import pytest

from agentmailbox import (
    AgentMailbox,
    CodebaseIndexEntry,
    GraphNode,
    GraphQueryResult,
)


@pytest.mark.asyncio
async def test_upsert_node_and_query_graph(agentmailbox_server: str) -> None:
    async with AgentMailbox("py-graph@test", server=agentmailbox_server) as agent:
        await agent.connect()

        await agent.upsert_node(
            id="file:server.py",
            type="file",
            name="server.py",
            description="Main FastAPI server module",
            metadata={"lineCount": 240},
        )

        result = await agent.query_graph("server.py")
        assert isinstance(result, GraphQueryResult)
        assert any(n.id == "file:server.py" for n in result.nodes)


@pytest.mark.asyncio
async def test_upsert_node_without_optional_fields(agentmailbox_server: str) -> None:
    """metadata and description are optional — must work with bare minimum."""
    async with AgentMailbox("py-graph-min@test", server=agentmailbox_server) as agent:
        await agent.connect()

        # Should not raise
        await agent.upsert_node(id="sym:run", type="symbol", name="run")

        result = await agent.query_graph("run")
        assert any(n.id == "sym:run" for n in result.nodes)


@pytest.mark.asyncio
async def test_add_edge_appears_in_query(agentmailbox_server: str) -> None:
    async with AgentMailbox("py-edge@test", server=agentmailbox_server) as agent:
        await agent.connect()

        await agent.upsert_node(id="file:app.py", type="file", name="app.py")
        await agent.upsert_node(id="sym:create_app", type="symbol", name="create_app")
        await agent.add_edge("file:app.py", "sym:create_app", "contains")

        result = await agent.query_graph("create_app")
        assert len(result.edges) >= 1


@pytest.mark.asyncio
async def test_query_graph_empty_for_no_match(agentmailbox_server: str) -> None:
    async with AgentMailbox("py-graph-empty@test", server=agentmailbox_server) as agent:
        await agent.connect()

        result = await agent.query_graph("zzz-nothing-matches-zzz")
        assert result.nodes == []
        assert result.edges == []


@pytest.mark.asyncio
async def test_upsert_and_get_index(agentmailbox_server: str) -> None:
    async with AgentMailbox("py-index@test", server=agentmailbox_server) as agent:
        await agent.connect()

        await agent.upsert_index(
            key="file:auth.py",
            category="file",
            summary="JWT authentication middleware with refresh token support",
            metadata={"exports": ["require_auth", "refresh_token"]},
        )

        entry = await agent.get_index("file:auth.py")
        assert entry is not None
        assert isinstance(entry, CodebaseIndexEntry)
        assert entry.key == "file:auth.py"
        assert entry.category == "file"
        assert "JWT" in entry.summary


@pytest.mark.asyncio
async def test_get_index_returns_none_for_missing_key(agentmailbox_server: str) -> None:
    async with AgentMailbox("py-index-miss@test", server=agentmailbox_server) as agent:
        await agent.connect()

        entry = await agent.get_index("nonexistent:key")
        assert entry is None


@pytest.mark.asyncio
async def test_search_index_by_keyword(agentmailbox_server: str) -> None:
    async with AgentMailbox("py-search@test", server=agentmailbox_server) as agent:
        await agent.connect()

        await agent.upsert_index(
            key="api:POST /token",
            category="api",
            summary="Issues a signed JWT access token",
        )
        await agent.upsert_index(
            key="file:jwt_utils.py",
            category="file",
            summary="Helper functions for JWT encoding and decoding",
        )

        results = await agent.search_index("JWT")
        assert len(results) >= 1
        assert all(isinstance(e, CodebaseIndexEntry) for e in results)


@pytest.mark.asyncio
async def test_search_index_filters_by_category(agentmailbox_server: str) -> None:
    async with AgentMailbox("py-search-cat@test", server=agentmailbox_server) as agent:
        await agent.connect()

        await agent.upsert_index(key="file:x.py",   category="file",   summary="Python async helpers")
        await agent.upsert_index(key="api:GET /x",  category="api",    summary="Python-based API endpoint")
        await agent.upsert_index(key="sym:x_fn",    category="symbol", summary="Python utility function x_fn")

        api_results = await agent.search_index("Python", category="api")
        assert all(e.category == "api" for e in api_results)


@pytest.mark.asyncio
async def test_upsert_index_without_metadata(agentmailbox_server: str) -> None:
    """metadata is optional — bare minimum should work."""
    async with AgentMailbox("py-index-bare@test", server=agentmailbox_server) as agent:
        await agent.connect()

        await agent.upsert_index(
            key="arch:overview",
            category="architecture",
            summary="Layered architecture: HTTP → service → storage",
        )
        entry = await agent.get_index("arch:overview")
        assert entry is not None
        assert entry.summary.startswith("Layered")
