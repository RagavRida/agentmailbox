---
name: agentmailbox
description: >
  Persistent context and inter-agent messaging across sessions and platforms.
  Activate when the user asks about resuming previous work, continuing where
  they left off, sharing context between agents, multi-agent coordination,
  remembering across sessions, cross-platform context sync, agent communication,
  or mailbox messaging. Also activate when starting a new session to check for
  context from previous sessions or other agents.
---

# AgentMailbox — Context Sync for AI Agents

**Every agent has a mailbox. No agent ever starts cold.**

AgentMailbox is a context-sync protocol that gives you durable, persistent
threads across sessions, tools, and restarts. When you receive a message,
you get the full thread state — snapshot, structured summary, recent messages —
so you can pick up exactly where the last agent (or the last session) left off.

## When to Use This Skill

- **Session start**: Check your mailbox for context from previous sessions
- **"What was I working on?"**: Receive and sync threads to restore context
- **Multi-agent tasks**: Send messages to other agents, coordinate via threads
- **Before switching tools**: Send a summary so the next tool picks up seamlessly
- **After completing work**: Record decisions, artifacts, and progress to the thread
- **Cross-platform continuity**: Context follows the user across Cursor, Claude Desktop, Antigravity, Continue, and any MCP client

## RULE #1: Memory First — ALWAYS

When a user gives you ANY query or task:

1. **IMMEDIATELY** call `agentsmcp_context_briefing` with the user's query as the `task` parameter
2. Read the returned briefing — it contains relevant files, symbols, decisions, tasks, and relationships from persistent memory
3. If the briefing returns results, USE THEM as your starting context instead of reading raw files
4. Only fall back to `grep` / `view_file` / `read_file` when the briefing returns empty results

### Context Lookup Priority (use in order)

1. `agentsmcp_context_briefing` — one-shot task briefing (graph + index combined)
2. `agentsmcp_get_index` — look up a specific file/symbol by key (~200 tokens vs full file)
3. `agentsmcp_search_index` — keyword search across all indexed entries (replaces grep)
4. `agentsmcp_query_graph` — relationship traversal (find connected files/symbols/decisions)
5. **LAST RESORT**: `grep` / `view_file` — only when memory has no entry

## Setup

### Quick Setup (MCP)

AgentMailbox works via MCP. Add this to your MCP configuration:

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp-adapter"],
      "env": {
        "AGENTSMCP_AGENT_ID": "gemini@local",
        "AGENTSMCP_SERVER": "http://localhost:3000"
      }
    }
  }
}
```

To use the public demo server (no setup required):
```json
{
  "env": {
    "AGENTSMCP_SERVER": "https://hdnxa5c8yr.us-east-1.awsapprunner.com"
  }
}
```

### Starting the Server (Self-Hosted)

```bash
npx agentsmcp-server
# Runs at http://localhost:3000, SQLite at ./agentmailbox.db
```

### Automated Setup

Run the setup script:
```bash
bash skills/antigravity/scripts/setup.sh
```

## Core Workflows

### 1. Session Start — Restore Context

Always check for unread messages at the start of a session:

```
Tool: agentsmcp_receive
```

This returns:
- **snapshot**: The last sender's state at send time
- **threadSummaryStructured**: Structured summary of older messages (decisions, open questions, artifacts)
- **recentMessages**: Last 10 messages verbatim
- **tokenCount**: Rough estimate of payload size

If there are unread messages, summarize the context for the user:
> "You were working on [X]. Here's where you left off: [summary]. Open questions: [questions]."

### 2. During Work — Record Progress

When the user makes important decisions, completes tasks, or creates artifacts, send an update to the thread:

```
Tool: agentsmcp_send
Arguments:
  to: "<recipient-agent-id>"
  body: {
    "decision": "Using JWT for authentication",
    "filesChanged": ["auth.ts", "middleware.ts"],
    "status": "in-progress",
    "openQuestions": ["Should tokens expire after 24h or 7d?"]
  }
  contextSnapshot: {
    "step": "auth_implementation",
    "progress": "60%"
  }
```

### 3. Multi-Agent Coordination

Send messages with CC/BCC for multi-agent workflows:

```
Tool: agentsmcp_send
Arguments:
  to: "researcher@app"
  body: { "task": "find papers on diffusion models" }
  cc: ["writer@app"]
  bcc: ["logger@app"]
  contextSnapshot: { "step": "research_phase", "priority": "high" }
```

Reply to all participants on a thread:
```
Tool: agentsmcp_reply_all
Arguments:
  threadId: "<thread-id>"
  body: { "result": "Found 50 papers", "status": "complete" }
```

### 4. Session End — Preserve Context

Before a session ends or the user switches tools, send a summary:

```
Tool: agentsmcp_send
Arguments:
  to: "<self-or-next-agent>"
  body: {
    "sessionSummary": "Implemented JWT auth in auth.ts and middleware.ts. All tests passing.",
    "completedTasks": ["JWT token generation", "middleware validation"],
    "remainingTasks": ["Token refresh endpoint", "Rate limiting"],
    "openQuestions": ["Token expiry duration"],
    "filesModified": ["src/auth.ts", "src/middleware.ts", "tests/auth.test.ts"]
  }
```

### 5. Thread Management

List all threads:
```
Tool: agentsmcp_threads
```

Sync a specific thread (get full context):
```
Tool: agentsmcp_sync
Arguments:
  threadId: "<thread-id>"
```

Mark a thread as read:
```
Tool: agentsmcp_mark_read
Arguments:
  threadId: "<thread-id>"
```

List participants on a thread:
```
Tool: agentsmcp_participants
Arguments:
  threadId: "<thread-id>"
```

## MCP Tool Reference

### Messaging

| Tool | Purpose | Key Arguments |
|:-----|:--------|:-------------|
| `agentsmcp_send` | Send a message, create a thread | `to`, `body`, `cc`, `bcc`, `contextSnapshot` |
| `agentsmcp_receive` | Get unread messages with full context | (none) |
| `agentsmcp_unread` | List unread context frames | (none) |
| `agentsmcp_sync` | Rejoin a thread with assembled context | `threadId` |
| `agentsmcp_threads` | List all threads for this agent | (none) |
| `agentsmcp_mark_read` | Mark a thread as read | `threadId` |
| `agentsmcp_reply_all` | Reply to all visible participants | `threadId`, `body` |
| `agentsmcp_participants` | List participants with roles | `threadId` |

### Context Graph

| Tool | Purpose | Key Arguments |
|:-----|:--------|:-------------|
| `agentsmcp_upsert_node` | Register a file/symbol/decision/task node | `id`, `type`, `name`, `description` |
| `agentsmcp_add_edge` | Connect two nodes with a typed edge | `sourceId`, `targetId`, `type` |
| `agentsmcp_query_graph` | Keyword search + 2-hop graph traversal | `query` |

### Codebase Index

| Tool | Purpose | Key Arguments |
|:-----|:--------|:-------------|
| `agentsmcp_upsert_index` | Register a file/symbol/API summary | `key`, `category`, `summary` |
| `agentsmcp_get_index` | Look up a specific entry by key | `key` |
| `agentsmcp_search_index` | Search across all indexed entries | `query`, `category` |

### Context Assembly

| Tool | Purpose | Key Arguments |
|:-----|:--------|:-------------|
| `agentsmcp_context_briefing` | One-shot task briefing (graph + index) | `task`, `include_threads` |

## Cross-Platform Continuity

AgentMailbox works identically across all MCP-aware platforms:

| Platform | Agent ID | How It Works |
|:---------|:---------|:-------------|
| **Antigravity / Gemini CLI** | `gemini@local` | This skill + MCP adapter |
| **Cursor** | `cursor@local` | Cursor MCP settings + rules file |
| **Claude Desktop** | `claude@local` | `claude_desktop_config.json` + MCP adapter |
| **Claude Code** | `claude-code@local` | MCP settings + CLAUDE.md |
| **Continue** | `continue@local` | MCP config in Continue settings |

All platforms share the same server and threads. A message sent from Cursor
is instantly available in Claude Desktop and Antigravity.

## Best Practices

1. **Memory first** — Always call `agentsmcp_context_briefing` before reading files
2. **Always receive on session start** — Don't make the user manually ask for context
3. **Update memory after edits** — Call `upsert_index` + `upsert_node` + `add_edge` after modifying files
4. **Record decisions** — Call `upsert_node(type=decision)` when design choices are made
5. **Send structured messages** — Use JSON bodies with clear fields (task, status, decisions, openQuestions)
6. **Include contextSnapshot** — This is the state that the next agent gets immediately
7. **Send session summaries** — Before ending, preserve context for the next session
8. **Sync before acting** — If a thread exists, sync it before making decisions to avoid stale context

## Links

- **GitHub**: https://github.com/RagavRida/agentsmcp
- **npm SDK**: https://www.npmjs.com/package/agentsmcp
- **npm MCP Adapter**: https://www.npmjs.com/package/agentsmcp-adapter
- **PyPI SDK**: https://pypi.org/project/agentsmcp/
- **Demo Server**: https://hdnxa5c8yr.us-east-1.awsapprunner.com
