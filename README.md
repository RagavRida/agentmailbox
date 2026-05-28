# AgentMailbox

**A context-sync protocol for AI agents.** Every agent has a mailbox. No
agent ever starts cold.

🌐 **Website:** [agentmailbox.vercel.app](https://agentmailbox.vercel.app)
☁️ **Cloud API:** [hdnxa5c8yr.us-east-1.awsapprunner.com](https://hdnxa5c8yr.us-east-1.awsapprunner.com)

[![npm](https://img.shields.io/npm/v/agentsmcp.svg?label=npm%20agentsmcp)](https://www.npmjs.com/package/agentsmcp)
[![PyPI](https://img.shields.io/pypi/v/agentsmcp.svg?label=PyPI%20agentsmcp)](https://pypi.org/project/agentsmcp/)
[![npm langgraph](https://img.shields.io/npm/v/agentsmcp-langgraph.svg?label=npm%20agentsmcp-langgraph)](https://www.npmjs.com/package/agentsmcp-langgraph)
[![skills.sh](https://skills.sh/b/RagavRida/agentsmcp)](https://skills.sh/RagavRida/agentsmcp)
[![CI](https://github.com/RagavRida/agentsmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RagavRida/agentsmcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

Agents today lose context between runs, restarts, and handoffs. Every
agent framework reinvents persistence, and none of them interoperate.
AgentMailbox solves this with a single primitive: **every message
carries the thread's full state**. Any agent, any framework, any
restart picks up exactly where the last one left off.

The protocol is implemented as an HTTP server with SDKs in JavaScript
and Python, plus a Model Context Protocol adapter that exposes it to
Claude Desktop, Cursor, Continue, and every other MCP-aware client.

## Quick Start (Cloud)

```bash
# 1. Get your free API key (no credit card)
curl -X POST https://hdnxa5c8yr.us-east-1.awsapprunner.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'

# Returns: { "apiKey": "sk_live_xxx...", "userId": "..." }

# 2. Add it to your AI tool (platform guides below).
# 3. Your agents now have persistent context across sessions.
```

The hosted API is multi-tenant: your agents, threads, and messages are
isolated to your user. Free tier limits are below.

## Platform Integration Guides

Replace `sk_live_YOUR_KEY` with the key from step 1 in every snippet
below.

### Cursor

Add to your MCP settings (**Settings → MCP → Add**):

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp"],
      "env": {
        "AGENTSMCP_AGENT_ID": "cursor@local",
        "AGENTSMCP_SERVER": "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
        "AGENTSMCP_API_KEY": "sk_live_YOUR_KEY"
      }
    }
  }
}
```

That's it. Cursor now syncs context across sessions automatically.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp"],
      "env": {
        "AGENTSMCP_AGENT_ID": "claude@desktop",
        "AGENTSMCP_SERVER": "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
        "AGENTSMCP_API_KEY": "sk_live_YOUR_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. It now has access to all 15 agentsmcp tools.

### Antigravity / Gemini CLI

```bash
npx skills add RagavRida/agentsmcp
```

Or add MCP config manually in your settings.

### Claude Code

```bash
claude mcp add agentsmcp -- npx -y agentsmcp
```

Set environment variables:

```
AGENTSMCP_AGENT_ID=claude-code@local
AGENTSMCP_SERVER=https://hdnxa5c8yr.us-east-1.awsapprunner.com
AGENTSMCP_API_KEY=sk_live_YOUR_KEY
```

### Any MCP Client (Continue, Cline, Windsurf, …)

AgentMailbox works with any MCP-compatible client. Add the same config
shape (`command: npx`, `args: ["-y", "agentsmcp"]`) with the
three env vars: `AGENTSMCP_AGENT_ID`, `AGENTSMCP_SERVER`,
`AGENTSMCP_API_KEY`.

### Python

```bash
pip install agentsmcp
```

```python
from agentmailbox import AgentMailbox

agent = AgentMailbox(
    agent_id="my-agent@app",
    server="https://hdnxa5c8yr.us-east-1.awsapprunner.com",
    api_key="sk_live_YOUR_KEY",
)

# Send
await agent.send("other-agent@app", {"task": "analyze data"})

# Receive (with full thread context)
messages = await agent.receive()

# Context graph — persist relationships across restarts
await agent.upsert_node(id="file:main.py", type="file", name="main.py",
                        description="Entrypoint")
await agent.add_edge("file:main.py", "sym:run", "contains")
result = await agent.query_graph("main")

# Codebase index — fast lookup without re-reading files
await agent.upsert_index(key="file:main.py", category="file",
                         summary="FastAPI entrypoint with lifespan handlers")
entry = await agent.get_index("file:main.py")
hits  = await agent.search_index("FastAPI", category="file")
```

> The PyPI package name is `agentsmcp`; the import path stays
> `agentmailbox` for historical reasons.

### JavaScript / TypeScript

```bash
npm install agentsmcp
```

```ts
import { AgentMailbox } from "agentsmcp";

const agent = new AgentMailbox({
  agentId: "my-agent@app",
  server: "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
  apiKey: "sk_live_YOUR_KEY",
});

await agent.send("other@app", { task: "done", result: data });
const { messages } = await agent.receive();

// Context graph
await agent.upsertNode({ id: "file:server.ts", type: "file", name: "server.ts" });
await agent.addEdge({ sourceId: "file:server.ts", targetId: "sym:createApp", type: "contains" });
const { nodes, edges } = await agent.queryGraph("server");

// Codebase index
await agent.upsertIndex({ key: "api:POST /invoke", category: "api",
                           summary: "Invokes the compiled graph" });
const entry  = await agent.getIndex("api:POST /invoke");
const hits   = await agent.searchIndex("invoke", "api");
```

### LangGraph (JavaScript)

```bash
npm install agentsmcp-langgraph @langchain/langgraph
```

```ts
import { AgentsmcpSaver } from "agentsmcp-langgraph";

const checkpointer = new AgentsmcpSaver({
  server: "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
  agentId: "langgraph@my-app",
  apiKey: "sk_live_YOUR_KEY",
});
await checkpointer.connect();

// LangGraph checkpointing — survives restarts, cross-machine
const graph = workflow.compile({ checkpointer });
await graph.invoke(input, { configurable: { thread_id: "session-abc" } });

// Context graph on the same saver instance (v0.2.0+)
await checkpointer.upsertNode({ id: "file:agent.ts", type: "file", name: "agent.ts" });
await checkpointer.upsertIndex({ key: "file:agent.ts", category: "file",
                                  summary: "LangGraph state machine" });
```

### REST API (Any Language)

Works from any language that can make HTTP calls.

```bash
# Register agent
curl -X POST https://hdnxa5c8yr.us-east-1.awsapprunner.com/agents/register \
  -H "Authorization: Bearer sk_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"my-agent@app"}'

# Send message (with optional CC/BCC)
curl -X POST https://hdnxa5c8yr.us-east-1.awsapprunner.com/messages/send \
  -H "Authorization: Bearer sk_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "agent-a@app",
    "to": "agent-b@app",
    "payload": {"task": "analyze", "data": [1, 2, 3]},
    "cc": ["observer@app"]
  }'

# Context graph — upsert a node
curl -X POST https://hdnxa5c8yr.us-east-1.awsapprunner.com/mailbox/my-agent@app/graph/nodes \
  -H "Authorization: Bearer sk_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"file:main.py","type":"file","name":"main.py"}'

# Codebase index — upsert an entry
curl -X POST https://hdnxa5c8yr.us-east-1.awsapprunner.com/mailbox/my-agent@app/index \
  -H "Authorization: Bearer sk_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"file:main.py","category":"file","summary":"FastAPI entrypoint"}'

# Get unread messages (with full thread context)
curl https://hdnxa5c8yr.us-east-1.awsapprunner.com/mailbox/my-agent@app/unread \
  -H "Authorization: Bearer sk_live_YOUR_KEY"
```

## Self-Hosted

Free, unlimited, MIT-licensed. SQLite by default, Postgres when you
need it.

```bash
# SQLite (zero config — single file at ./agentmailbox.db)
npx agentsmcp-server

# Postgres
AGENTSMCP_DB=postgresql://user:pass@localhost:5432/agentsmcp \
  npx agentsmcp-server

# RDS (or any Postgres requiring SSL)
AGENTSMCP_DB=postgresql://user:pass@host:5432/db \
AGENTSMCP_DB_SSL=true \
  npx agentsmcp-server

# Single-key auth (everyone uses the same Bearer token)
AGENTSMCP_API_KEY=your-secret npx agentsmcp-server

# LLM-backed context compression
ANTHROPIC_API_KEY=sk-ant-xxx npx agentsmcp-server
```

Self-hosting skips all per-user auth and plan caps — point your SDKs at
your own server and you're done. See [deploy/AWS.md](./deploy/AWS.md)
for a step-by-step Docker + App Runner walkthrough, or
[infra/README.md](./infra/README.md) for the Postgres + VPC connector
production layout.

## MCP Tools (v0.4.0 — 15 tools)

When connected via MCP, your AI coding assistant gets 15 tools:

| Tool | Description |
|:---|:---|
| `agentsmcp_send` | Send a message to another agent |
| `agentsmcp_receive` | Get unread messages with full thread context |
| `agentsmcp_list_threads` | List all threads for this agent |
| `agentsmcp_get_thread` | Get messages on a specific thread |
| `agentsmcp_sync_thread` | Sync full context for a thread |
| `agentsmcp_mark_read` | Mark a thread as read |
| `agentsmcp_reply_all` | Reply to all participants on a thread |
| `agentsmcp_get_participants` | Get participants and roles on a thread |
| `agentsmcp_upsert_node` | Register a context graph node (file, symbol, decision…) |
| `agentsmcp_add_edge` | Connect two graph nodes with a typed edge |
| `agentsmcp_query_graph` | Keyword-search the context graph |
| `agentsmcp_upsert_index` | Register or update a codebase index entry |
| `agentsmcp_get_index` | Exact-key lookup in the codebase index |
| `agentsmcp_search_index` | Keyword-search the codebase index |
| `agentsmcp_context_briefing` | Get a targeted context briefing for a task |

## API Reference

### Messaging

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| POST | `/auth/register` | None | Sign up, get API key |
| GET | `/auth/me` | Bearer | Your account + current usage |
| GET | `/auth/keys` | Bearer | List your active API keys |
| POST | `/auth/keys` | Bearer | Mint an additional key |
| DELETE | `/auth/keys/:keyId` | Bearer | Revoke a key |
| POST | `/agents/register` | Bearer | Register an agent |
| POST | `/messages/send` | Bearer | Send message (TO / CC / BCC) |
| POST | `/messages/reply-all` | Bearer | Reply to every visible participant |
| GET | `/mailbox/:agentId` | Bearer | List threads |
| GET | `/mailbox/:agentId/unread` | Bearer | Unread messages + full context |
| POST | `/mailbox/:agentId/read` | Bearer | Mark thread as read |
| GET | `/threads/:threadId` | Bearer | Thread detail |
| GET | `/threads/:threadId/sync` | Bearer | Assembled context frame |
| GET | `/threads/:threadId/participants` | Bearer | Participants with roles |
| GET | `/usage/:identifier` | None | Rate-limit usage (cloud only) |
| GET | `/health` | None | Health check |
| GET | `/.well-known/agent-card.json` | None | A2A v1.0 Agent Card |
| GET | `/.well-known/agent-card/:agentId` | None | Per-agent A2A card |

### Context Graph

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| POST | `/mailbox/:agentId/graph/nodes` | Bearer | Upsert a graph node |
| DELETE | `/mailbox/:agentId/graph/nodes/:nodeId` | Bearer | Delete a node + its edges |
| POST | `/mailbox/:agentId/graph/edges` | Bearer | Add a directed edge |
| DELETE | `/mailbox/:agentId/graph/edges` | Bearer | Remove an edge |
| GET | `/mailbox/:agentId/graph/query?q=…` | Bearer | Keyword search + 2-hop traversal |

### Codebase Index

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| POST | `/mailbox/:agentId/index` | Bearer | Upsert an index entry |
| GET | `/mailbox/:agentId/index?q=…[&category=…]` | Bearer | Keyword search |
| GET | `/mailbox/:agentId/index/:key` | Bearer | Exact-key lookup |
| DELETE | `/mailbox/:agentId/index/:key` | Bearer | Delete an entry |

`Bearer` = `Authorization: Bearer sk_live_xxx` (cloud) or
`Authorization: Bearer <AGENTSMCP_API_KEY>` (self-hosted, when set).

## Free Tier

The hosted cloud API is free with soft limits:

| Resource | Limit |
|:---|:---|
| Agents | 10 |
| Messages / day | 500 |
| Threads | 100 |
| Retention | 7 days |
| API keys per account | 2 |

Hit a limit and the offending request returns `403 plan_limit` with the
current/limit values. Need more? [Self-host](#self-hosted) for unlimited
— same code, MIT licensed.

## What you get

- **Durable, addressable threads.** Send a message to `writer@app`;
  the server creates the thread, persists it, and fans it out to every
  recipient (`to`, `cc`, `bcc`).
- **Cold-restart by construction.** An agent process can crash mid-task
  and resume on restart by reading the thread — no local state, no
  checkpointing logic to write.
- **Structured context compression.** Threads stay joinable forever:
  older messages fold into a structured summary (`decisions`,
  `openQuestions`, `artifacts`) the moment they cross a configurable
  threshold. Default is zero-config; opt in to Claude-backed
  compression with one constructor argument.
- **Context graph.** Persist a knowledge graph of code relationships
  (files → symbols → decisions) that survives restarts and is
  searchable by any agent or MCP tool.
- **Codebase index.** Register summarised descriptions of files,
  symbols, APIs, and architecture notes for fast lookup — no re-reading
  full source on every run.
- **Cross-tool peer participation.** Any MCP-aware client becomes a
  peer in the conversation without writing SDK code.
- **Multi-agent semantics.** TO / CC / BCC roles work the way email
  does, with full context propagated to every recipient.
- **A2A v1.0 discoverable.** Every deploy ships a public Agent Card at
  `/.well-known/agent-card.json` so other agent frameworks can find
  and connect to it without prior knowledge.
- **LangGraph checkpointer.** `AgentsmcpSaver` stores graph state in
  agentsmcp threads — survives restarts, works cross-machine, readable
  from any SDK. Context graph and codebase index methods ship on the
  same object (v0.2.0+).

## Multi-agent threads

CC, BCC, and ReplyAll work the way email does — but with full context
propagated to every recipient on every message.

| Role | Visibility | Can reply |
|---|---|---|
| `to` | Primary recipient, context owner | Yes |
| `cc` | Active participant | Yes |
| `bcc` | Silent participant; invisible to others | Yes |

The `bcc` field is stripped from every message view except the original
sender's.

```ts
const { threadId } = await orchestrator.send(
  "researcher@demo",
  { task: "find 50 papers on diffusion models" },
  {
    cc: ["writer@demo"],
    bcc: ["logger@demo"],
    contextSnapshot: { step: "task_dispatched", priority: "high" },
  }
);

await researcher.replyAll(threadId, { result: "found 50 papers" });
```

## Context compression

Threads grow without bound; the verbatim window does not. The server
folds older messages into a structured `ThreadSummary` and caches it.

```ts
import { createServer, ClaudeCompressor } from "agentsmcp";

const { app, ready } = createServer("./db.sqlite", {
  compressor: new ClaudeCompressor(),     // reads ANTHROPIC_API_KEY
  compressionThreshold: 20,               // default
});
await ready;
app.listen(3000);
```

`ClaudeCompressor` calls Claude Haiku and extracts `{ text, decisions,
openQuestions, artifacts, coversMessageIds, generatedAt }`. The default
is `NoopCompressor` — keeps zero-config installs working without an LLM
dependency. The interface is provider-agnostic; additional compressors
(OpenAI, local models) can be added by implementing
`Compressor.compress()`.

## The headline demo

[`examples/research-bench/`](./examples/research-bench/README.md) — a
multi-agent research thread you can join from Claude Desktop. One
command boots a supervisor with two long-running agents; you drop in
via the MCP adapter and steer them. Kill any process and the system
keeps working.

It demonstrates, in one runnable artifact, the four things AgentMailbox
gives you that no other agent library does in a single page:

1. Cross-tool visibility — Claude Desktop reads agent threads via MCP.
2. Cross-tool steering — you are a peer participant, not just an
   observer.
3. Crash-survival — `coldResume()` on agent startup is the entire
   persistence story.
4. Compression in action — after ~30 messages, threads return a
   structured summary instead of raw history.

A minimal two-agent SDK-only pipeline is also available at
[`examples/research-writer/`](./examples/research-writer/README.md).

## How it works

Every message persisted by the server carries enough state for any
recipient — present or future — to reconstruct the thread without
local memory. On `receive()` or `sync()`, the server returns:

- `snapshot` — the sender's `contextSnapshot` from the last message
- `threadSummaryStructured` — a cached structured summary of older
  messages (populated once the compression threshold is crossed)
- `threadSummary` — the prose `text` field of the structured summary,
  for callers that just want a string
- `recentMessages` — last 10 messages verbatim
- `tokenCount` — rough estimate of the combined payload size

Storage is pluggable: SQLite by default, Postgres for production
deployments, with the `Storage` interface ready for additional adapters
(Redis, DynamoDB). Compression is pluggable through the `Compressor`
interface. Multi-tenant scoping is opt-in via `CLOUD_MODE=true` — when
unset, the server runs in single-key / open mode identical to v0.1.

## AI platform skills

Beyond MCP, AgentMailbox ships as a native skill for every major AI
coding platform. The skill teaches your AI agent to check for context
at session start, preserve it at session end, and sync across tools.

| Platform | Install | Details |
|:---|:---|:---|
| **Antigravity / Gemini CLI** | `npx skills add RagavRida/agentsmcp@antigravity` | [`skills/antigravity/`](./skills/antigravity/) |
| **Cursor** | Copy `skills/cursor/rules/` to `.cursor/rules/` | [`skills/cursor/`](./skills/cursor/) |
| **Claude Code** | Add MCP config to settings | [`skills/claude-code/`](./skills/claude-code/) |
| **Claude Desktop** | Add MCP config (see [Claude Desktop](#claude-desktop)) | Already works via `npx agentsmcp` |
| **Continue** | Add MCP config to Continue settings | Same adapter, different config path |

**Your context follows you, not the tool.** Start work in Cursor,
switch to Claude Desktop at lunch, open Antigravity at night — same
thread, same context, zero manual transfer.

See [`skills/README.md`](./skills/README.md) for details on all skills.

## Development

```bash
# Install + type-check + test (JS server, SDK, MCP — all in one package)
npm ci && npx tsc --noEmit && npm test

# End-to-end smoke test (boots real server, exercises 12 steps)
npm run smoke:e2e

# LangGraph adapter
cd langgraph && npm install && npm run build && npm test

# Python SDK
cd sdk-py && pip install -e ".[dev]" && pytest -q
```

The full test matrix (JS + LangGraph + Python 3.10/3.11/3.12) runs in
CI on every push to `main`.

## Contributing

Contributions are welcome. The protocol is small and the surface is
deliberately stable, but there is a lot of useful work still to do.

**Particularly wanted:**

- Additional `Compressor` adapters (Gemini, Bedrock, Ollama for local
  models — OpenAI and Claude already ship). The interface is small —
  ~80 lines per adapter.
- A live smoke test for `ClaudeCompressor`. The parsing path is covered
  by mock tests; the actual "does Haiku return valid JSON" gate hasn't
  been exercised. `scripts/smoke-openai-compressor.ts` is the template
  — same shape, swap the import.
- Additional `Storage` adapters (Redis, DynamoDB). The `Storage`
  interface is async-first and provider-agnostic; SQLite and Postgres
  are the reference implementations.
- Framework adapters (CrewAI task handoff, Vercel AI SDK middleware —
  LangGraph is already done).
- Real-world demos beyond `examples/research-bench`. Multi-day
  workflows, cross-language pipelines, agent-in-the-loop patterns.
- Documentation, tutorials, and integration recipes.

**Process:**

1. Open an issue describing what you want to build or change. Small
   PRs that fix bugs or add tests can skip this step.
2. Fork, branch, and submit a PR against `main`. Match the existing
   coding style (no formatter beyond TypeScript defaults; tests
   colocated with code under `tests/`).
3. CI must be green. Run the test matrix locally before pushing:
   ```bash
   npm ci && npx tsc --noEmit && npm test
   cd langgraph && npm install && npm run build && npm test
   cd sdk-py && pip install -e ".[dev]" && pytest -q
   ```
4. Include a CHANGELOG entry under the current unreleased version
   header for user-visible changes.

Bug reports, design discussion, and integration questions are all
welcome in [GitHub Issues](https://github.com/RagavRida/agentsmcp/issues).

## License

MIT — see [LICENSE](./LICENSE).
