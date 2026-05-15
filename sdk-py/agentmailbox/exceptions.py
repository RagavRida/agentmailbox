"""Exception hierarchy for the AgentMailbox Python SDK."""

from __future__ import annotations

from typing import Optional


class AgentMailboxError(Exception):
    """Base class for all AgentMailbox SDK errors."""

    def __init__(self, message: str, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code

    def __str__(self) -> str:
        if self.status_code is not None:
            return f"[{self.status_code}] {self.message}"
        return self.message


class NotFoundError(AgentMailboxError):
    """Raised on HTTP 404 responses (missing thread, agent, etc.)."""


class ServerError(AgentMailboxError):
    """Raised on HTTP 5xx responses from the AgentMailbox server."""


class ConnectionError(AgentMailboxError):
    """Raised when the SDK cannot reach the AgentMailbox server."""
