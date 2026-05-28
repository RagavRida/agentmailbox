"""AgentMailbox Python SDK.

Context-sync protocol for AI agents. Every agent has a mailbox.
No agent ever starts cold.
"""

from .client import AgentMailbox, AgentMailboxSync
from .exceptions import (
    AgentMailboxError,
    ConnectionError,
    NotFoundError,
    ServerError,
)
from .types import (
    CodebaseIndexEntry,
    Context,
    ContextFrame,
    GraphEdge,
    GraphNode,
    GraphNodeType,
    GraphQueryResult,
    IndexCategory,
    Message,
    ParticipantRole,
    ReceiveResult,
    Role,
    SendResult,
    Thread,
    ThreadSummary,
)

__version__ = "0.1.3"

__all__ = [
    "AgentMailbox",
    "AgentMailboxSync",
    "AgentMailboxError",
    "ConnectionError",
    "NotFoundError",
    "ServerError",
    # messaging
    "Context",
    "ContextFrame",
    "Message",
    "ParticipantRole",
    "ReceiveResult",
    "Role",
    "SendResult",
    "Thread",
    "ThreadSummary",
    # context graph
    "GraphNode",
    "GraphEdge",
    "GraphNodeType",
    "GraphQueryResult",
    # codebase index
    "CodebaseIndexEntry",
    "IndexCategory",
    "__version__",
]
