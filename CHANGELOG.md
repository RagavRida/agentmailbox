# Changelog

## 0.1.0 — unreleased

> Note: renamed from `agentmail` to `agentmailbox` before first publish
> because the original name was taken on npm and PyPI by another project.

### Added

- Core context-sync protocol (HTTP server + SQLite storage).
- JavaScript SDK (`agentmailbox`).
- Python SDK (`agentmailbox` on PyPI), async + sync wrapper.
- MCP adapter (`agentmailbox-mcp`) exposing the protocol as MCP tools.
- CC / BCC / ReplyAll multi-agent threads.
- Optional API-key auth via `AGENTMAILBOX_API_KEY`.
- Vitest test suite for JS, pytest suite for Python.
- GitHub Actions CI matrix.
- Research+Writer demo app showing cold-restart context recovery.
