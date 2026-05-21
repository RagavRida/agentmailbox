---
name: agentmailbox-claude-code
description: >
  Persistent context and inter-agent messaging for Claude Code CLI. Activate
  when the user asks about resuming previous work, continuing where they left
  off, sharing context between agents, multi-agent coordination, remembering
  across terminal sessions, or agent communication. Also activate on session
  start to check for context from previous sessions or other tools.
---

# AgentMailbox — Context Sync for Claude Code

**Your context follows you across terminal sessions and tools.**

AgentMailbox gives Claude Code persistent memory across sessions. Combined
with `CLAUDE.md` for static project context, AgentMailbox provides dynamic,
evolving context that tracks decisions, progress, and open questions across
every session and every tool.

## Setup

### 1. Add MCP to Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp-adapter"],
      "env": {
        "AGENTSMCP_AGENT_ID": "claude-code@local",
        "AGENTSMCP_SERVER": "http://localhost:3000"
      }
    }
  }
}
```

### 2. Start the Server

```bash
npx agentsmcp-server
# Runs at http://localhost:3000
```

Or use the demo server:
```
AGENTSMCP_SERVER=https://hdnxa5c8yr.us-east-1.awsapprunner.com
```

## How It Works with CLAUDE.md

| Layer | Purpose | Persistence |
|:------|:--------|:------------|
| **CLAUDE.md** | Static project context (coding standards, architecture, conventions) | File-based, manual |
| **AgentMailbox** | Dynamic session context (decisions, progress, open questions, handoffs) | Server-backed, automatic |

Use both together:
- `CLAUDE.md` for _what the project is_
- AgentMailbox for _what happened and what's next_

## Workflows

### Session Start

```
Tool: agentsmcp_receive
```

Check for context from previous sessions or messages from other agents/tools.

### After Terminal Work

Record what you accomplished:

```
Tool: agentsmcp_send
Arguments:
  to: "claude-code@local"
  body: {
    "session": "Terminal session summary",
    "commands": ["npm test — all passing", "npm run build — clean"],
    "decisions": ["Migrated to ESM modules"],
    "filesChanged": ["package.json", "tsconfig.json", "src/index.ts"],
    "remainingTasks": ["Update CI config for ESM"]
  }
```

### Handoff to GUI Tools

When the user wants to continue in Cursor or Claude Desktop:

```
Tool: agentsmcp_send
Arguments:
  to: "cursor@local"
  body: {
    "handoff": "ESM migration 80% complete",
    "remainingWork": "Update CI pipeline, fix 2 failing integration tests",
    "context": "See thread for full migration log"
  }
```

## Tool Reference

| Tool | Purpose |
|:-----|:--------|
| `agentsmcp_receive` | Get unread messages with full context |
| `agentsmcp_send` | Send a message / record progress |
| `agentsmcp_sync` | Rejoin a thread with full context |
| `agentsmcp_threads` | List all threads |
| `agentsmcp_mark_read` | Mark a thread as read |
| `agentsmcp_reply_all` | Reply to all participants |

## Links

- **GitHub**: https://github.com/RagavRida/agentsmcp
- **npm**: https://www.npmjs.com/package/agentsmcp
