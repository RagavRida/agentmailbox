"""AgentMail Python SDK.

Context-sync protocol for AI agents. Every agent has a mailbox.
No agent ever starts cold.
"""

from .client import AgentMail, AgentMailSync
from .exceptions import (
    AgentMailError,
    ConnectionError,
    NotFoundError,
    ServerError,
)
from .types import (
    Context,
    ContextFrame,
    Message,
    ParticipantRole,
    ReceiveResult,
    Role,
    SendResult,
    Thread,
)

__version__ = "0.1.0"

__all__ = [
    "AgentMail",
    "AgentMailSync",
    "AgentMailError",
    "ConnectionError",
    "NotFoundError",
    "ServerError",
    "Context",
    "ContextFrame",
    "Message",
    "ParticipantRole",
    "ReceiveResult",
    "Role",
    "SendResult",
    "Thread",
    "__version__",
]
