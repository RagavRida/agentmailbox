---
name: agentmailbox-cursor
description: >
  Persistent context and inter-agent messaging for Cursor AI. Activate when
  the user asks about resuming previous work, continuing where they left off,
  sharing context between agents or tools, multi-agent coordination,
  remembering across Composer sessions, cross-platform context sync, or
  agent communication. Also activate at session start to check for context.
---

# AgentMailbox — Context Sync for Cursor

**Your context follows you. Not the tool.**

AgentMailbox gives Cursor persistent memory across Composer sessions, tools,
and restarts. When a session starts, check your mailbox and pick up exactly
where the last session left off — including context from Claude Desktop,
Antigravity, Continue, or any other MCP-aware tool.

## Setup in Cursor

### 1. Add MCP Server

Go to **Cursor Settings → MCP** and add:

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp-adapter"],
      "env": {
        "AGENTSMCP_AGENT_ID": "cursor@local",
        "AGENTSMCP_SERVER": "http://localhost:3000"
      }
    }
  }
}
```

For the public demo server (no self-hosting required):
```json
{
  "env": {
    "AGENTSMCP_SERVER": "https://hdnxa5c8yr.us-east-1.awsapprunner.com"
  }
}
```

### 2. Install Rules (Optional)

Copy the rules file to your project for always-on context sync:

```bash
mkdir -p .cursor/rules
cp skills/cursor/rules/agentmailbox.mdc .cursor/rules/
```

### 3. Start the Server (Self-Hosted)

```bash
npx agentsmcp-server
```

## Workflows for Cursor

### Session Start — Restore Context

When opening a project or starting a new Composer session:

```
Tool: agentsmcp_receive
```

This returns the full context frame:
- **snapshot** — Last sender's state
- **threadSummaryStructured** — Decisions, open questions, artifacts from the thread
- **recentMessages** — Last 10 messages verbatim

Summarize for the user: _"You were working on [X]. Open questions: [Y]."_

### Composer Multi-File Edits

Before starting a multi-file edit in Composer, sync the relevant thread:

```
Tool: agentsmcp_sync
Arguments: { "threadId": "<thread-id>" }
```

After completing the edit, record what changed:

```
Tool: agentsmcp_send
Arguments:
  to: "cursor@local"
  body: {
    "composerEdit": "Refactored auth module",
    "filesChanged": ["src/auth.ts", "src/middleware.ts", "tests/auth.test.ts"],
    "decisions": ["Using JWT with 24h expiry", "Middleware validates on every route"],
    "status": "complete"
  }
```

### Cross-Platform Handoff

When the user mentions switching to another tool:

```
Tool: agentsmcp_send
Arguments:
  to: "claude@local"
  body: {
    "handoff": "Continuing auth work",
    "currentState": "JWT middleware implemented, tests passing",
    "remainingTasks": ["Token refresh endpoint", "Rate limiting"],
    "context": "See thread for full history"
  }
```

## MCP Tool Reference

| Tool | Purpose |
|:-----|:--------|
| `agentsmcp_receive` | Get unread messages with full context |
| `agentsmcp_send` | Send a message, create or continue a thread |
| `agentsmcp_sync` | Rejoin a thread with assembled context |
| `agentsmcp_threads` | List all threads for this agent |
| `agentsmcp_mark_read` | Mark a thread as read |
| `agentsmcp_reply_all` | Reply to all visible participants |
| `agentsmcp_unread` | List unread context frames |
| `agentsmcp_participants` | List participants with roles (to/cc/bcc) |

## Links

- **GitHub**: https://github.com/RagavRida/agentsmcp
- **npm**: https://www.npmjs.com/package/agentsmcp
- **MCP Adapter**: https://www.npmjs.com/package/agentsmcp-adapter
