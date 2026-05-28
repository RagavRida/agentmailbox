# agentsmcp-langgraph

LangGraph checkpointer backed by [agentsmcp](https://www.npmjs.com/package/agentsmcp).
Drop-in `BaseCheckpointSaver` — your graph state lives in an AgentMailbox
thread, so it survives process restarts, runs across machines, and is
inspectable from any other agentsmcp client.

## Install

```bash
npm install agentsmcp-langgraph @langchain/langgraph
```

You'll also need an agentsmcp HTTP server reachable from your process.
Run it locally with `npx agentsmcp-server`, or point at any deployment.

## Usage

```ts
import { StateGraph } from "@langchain/langgraph";
import { AgentsmcpSaver } from "agentsmcp-langgraph";

const checkpointer = new AgentsmcpSaver({
  server: process.env.AGENTSMCP_SERVER ?? "http://localhost:3000",
  agentId: "langgraph@my-app",         // stable identity = stable threads
  apiKey: process.env.AGENTSMCP_API_KEY,
});
await checkpointer.connect();

const graph = workflow.compile({ checkpointer });

await graph.invoke(input, {
  configurable: { thread_id: "session-abc" },
});
```

Restart the process, invoke again with the same `thread_id`, and the
graph picks up exactly where it left off. Same property in another
process on another machine, as long as `agentId` and `thread_id` match.

## How it maps

| LangGraph | agentsmcp |
| --- | --- |
| `thread_id` (RunnableConfig) | One thread per `thread_id` |
| `checkpoint_id` (uuid6) | Stored in the message payload |
| `Checkpoint` bytes | Base64'd into `payload.checkpoint` |
| `CheckpointMetadata` bytes | Base64'd into `payload.metadata` |
| `pendingWrites` | Sibling messages of `kind: "writes"`, merged on read |
| `checkpoint_ns` | Filter tag inside the payload — subgraphs isolated |

The recipient on every message is the synthetic agent
`{thread_id}@checkpoints`. It's never real; it just gives the thread
a stable identity so cold-restart can look it up by participant.

## What you get vs `MemorySaver` / `SqliteSaver`

- **Cross-process** — write from one node, read from another. No file
  to share, no DB to provision; just an HTTP URL.
- **Inspectable** — every checkpoint is a message on a thread. Any
  agentsmcp client (the JS/Python SDK, the MCP adapter, `curl`) can
  read the state of your graph at any point in its history.
- **Compressed when long** — once a thread crosses the configured
  compression threshold (default 20 messages), the agentsmcp server
  folds older checkpoints into a structured summary that you can use
  alongside the verbatim recent window. Useful for very long graphs
  where re-reading every checkpoint is wasteful.

## Configuration

```ts
new AgentsmcpSaver({
  server,   // default: AGENTSMCP_SERVER env, then localhost:3000
  agentId,  // default: AGENTSMCP_AGENT_ID env, then `langgraph@<hostname>`
  apiKey,   // default: AGENTSMCP_API_KEY env
  serde,    // default: LangGraph's JsonPlusSerializer
});
```

If you want every process to share state, pin `agentId` to a stable
string. If you want each process to have its own slice, let it default
to the hostname.

## Context Graph (v0.4.0+)

Track relationships between code artifacts alongside your LangGraph state.
Nodes and edges are stored per-agent in agentsmcp and survive across restarts.

```ts
const checkpointer = new AgentsmcpSaver({ server, agentId: "langgraph@my-app" });
await checkpointer.connect();

// Register nodes (files, symbols, decisions, tasks, ...)
await checkpointer.upsertNode({
  id: "file:src/agent.ts",
  type: "file",
  name: "agent.ts",
  description: "Main LangGraph agent definition",
  metadata: { lineCount: 240 },
});
await checkpointer.upsertNode({
  id: "symbol:runGraph",
  type: "symbol",
  name: "runGraph",
});

// Connect nodes
await checkpointer.addEdge({
  sourceId: "file:src/agent.ts",
  targetId: "symbol:runGraph",
  type: "contains",
});

// Query by keywords — returns matching nodes + 2-hop neighbourhood
const { nodes, edges } = await checkpointer.queryGraph("agent");
```

Node types: `"file"` | `"symbol"` | `"decision"` | `"task"` | `"concept"`.  
Edge types: `"references"` | `"contains"` | `"resolves"` | `"depends_on"` | `"semantic"`.

## Codebase Index (v0.4.0+)

Persist summarised descriptions of files, symbols, APIs, configs, and
architecture notes so future graph invocations can look them up without
re-reading the full source.

```ts
// Upsert entries (key is your canonical identifier)
await checkpointer.upsertIndex({
  key: "file:src/agent.ts",
  category: "file",
  summary: "LangGraph state machine with conditional routing and tool calling",
  metadata: { exports: ["runGraph", "AgentState"] },
});
await checkpointer.upsertIndex({
  key: "api:POST /invoke",
  category: "api",
  summary: "Invokes the compiled graph; accepts { input, thread_id }",
});

// Exact lookup
const entry = await checkpointer.getIndex("file:src/agent.ts");
// { key, category, summary, metadata, updatedAt }

// Keyword search, optionally filtered by category
const results = await checkpointer.searchIndex("tool calling");
const apiResults = await checkpointer.searchIndex("invoke", "api");
```

Categories: `"file"` | `"symbol"` | `"api"` | `"config"` | `"architecture"`.

## Limitations (worth knowing)

- **`list()` reads the whole thread.** Fine for ~hundreds of
  checkpoints. For very long threads, lean on compression and accept
  that `list()` is paginated client-side.
- **No deduplication of repeat `put()`.** The agentsmcp server assigns
  message IDs server-side, so a re-put produces a duplicate row;
  `getTuple()` and `list()` dedupe by `checkpoint_id` on read.
- **Checkpoint writes are O(1) — but always a network round-trip.**
  If your graph checkpoints aggressively in a hot loop, that's a real
  cost; pair this saver with a local agentsmcp server for low latency.

## License

MIT — see [LICENSE](../LICENSE).
