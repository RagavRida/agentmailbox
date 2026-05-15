# AgentMail MCP

Exposes AgentMail to any MCP-aware client. Each MCP server instance
represents one agent identity.

## Install

```bash
cd ~/agentmail/mcp && npm install && npm run build
```

This builds the parent AgentMail SDK first (if not already built), then
the MCP adapter. `dist/index.js` is the executable entry.

## Configuration

Required:

- `AGENTMAIL_AGENT_ID` — the agent identity this MCP server represents
  (e.g. `claude@local`).

Optional:

- `AGENTMAIL_SERVER` — HTTP server URL, defaults to `http://localhost:3000`.
- `AGENTMAIL_API_KEY` — passed through as a Bearer token.

CLI flags mirror env vars and take precedence:

```bash
agentmail-mcp --agent-id claude@local --server http://localhost:3000
```

Make sure the AgentMail HTTP server is running first (`npm start` in
`~/agentmail`).

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentmail": {
      "command": "node",
      "args": ["/Users/you/agentmail/mcp/dist/index.js"],
      "env": {
        "AGENTMAIL_AGENT_ID": "claude@local",
        "AGENTMAIL_SERVER": "http://localhost:3000"
      }
    }
  }
}
```

## Cursor / Continue / other MCP clients

Same shape — point them at `node /path/to/mcp/dist/index.js` with
`AGENTMAIL_AGENT_ID` set.

## Available tools

| Tool                    | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `agentmail_send`        | Send a message to another agent; auto-creates a thread if needed.      |
| `agentmail_receive`     | Get unread messages with full thread context attached.                 |
| `agentmail_unread`      | List unread context frames without consuming them.                     |
| `agentmail_sync`        | Rejoin a thread with full assembled context.                           |
| `agentmail_threads`     | List all threads this agent is part of.                                |
| `agentmail_mark_read`   | Mark a thread as read for this agent.                                  |
| `agentmail_reply_all`   | Reply to every visible participant on a thread.                        |
| `agentmail_participants`| List visible participants on a thread with their roles (to/cc/bcc).    |

Two read-only MCP resources are also exposed:

- `agentmail://mailbox` — JSON listing of all threads.
- `agentmail://thread/{threadId}` — JSON with thread context and participants.

## Why MCP

A two-agent system used to require both agents to install the JS or
Python SDK. With this adapter, any MCP-aware client gets a mailbox for
free — no SDK, no glue code. Cross-tool context sync becomes a
config-file change.
