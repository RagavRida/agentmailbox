# Changelog

## 0.4.0 — 2026-05-28

### Changed (breaking)

- **MCP adapter merged into the main package.** `npx agentsmcp` now
  starts the MCP stdio adapter — no separate `agentsmcp-adapter`
  package needed. One package, one command, zero friction.
- **`agentsmcp-adapter` deprecated.** The package still works (it's now
  a thin shim that delegates to `agentsmcp`), but all documentation
  points to `npx agentsmcp` as the primary entry point.
- **Legacy `AGENTMAILBOX_*` env vars removed.** As announced in the 0.3.3
  changelog, the old env var names are no longer read by the MCP adapter.
  Use `AGENTSMCP_AGENT_ID`, `AGENTSMCP_SERVER`, `AGENTSMCP_API_KEY`.

### Added

- New bin `agentsmcp` in the main package — starts the MCP adapter in
  stdio mode. This is what MCP clients (Cursor, Claude Desktop,
  Windsurf, Continue, etc.) should point at.
- `buildMcpServer`, `listToolDefs`, and `runTool` are now exported from
  the main barrel for programmatic embedding of the MCP server.
- `@modelcontextprotocol/sdk` and `zod-to-json-schema` moved into the
  main package's dependencies (previously only in the adapter).
- **7 new MCP tools** (15 total, up from 8):
  - `agentsmcp_upsert_node` — register a context graph node
  - `agentsmcp_add_edge` — connect two graph nodes with a typed edge
  - `agentsmcp_query_graph` — keyword search the context graph
  - `agentsmcp_upsert_index` — register a codebase index entry
  - `agentsmcp_get_index` — look up an index entry by key
  - `agentsmcp_search_index` — keyword search the codebase index
  - `agentsmcp_context_briefing` — targeted context briefing for a task
- **Context graph + codebase index exported** from the main barrel:
  `GraphNode`, `GraphEdge`, `GraphNodeType`, `CodebaseIndexEntry`,
  `IndexCategory`.
- **26 new tests** covering the entire MCP layer (tools, resources,
  server) in `tests/mcp-tools.test.ts`, `tests/mcp-resources.test.ts`,
  and `tests/mcp-server.test.ts`.
- **E2E smoke test** (`scripts/smoke-e2e.js`) — run via
  `npm run smoke:e2e`. Boots a real server, exercises 12 steps
  end-to-end against the compiled `dist/`.

### Fixed

- `mcp/src/tools.ts`: Replaced `require("zod-to-json-schema")` with
  proper `import` statement (lint fix).
- `check_mailbox.ts`: Replaced `catch (err: any)` with
  `catch (err: unknown)` and proper type narrowing (lint fix).
- `GraphNode.metadata`, `CodebaseIndexEntry.metadata`, and
  `GraphEdge.weight` are now **optional** in the interface — callers no
  longer need to pass `metadata: {}` boilerplate.
- `tests/cloud-auth.test.ts`: Fixed a flaky test where
  `safeHashEquals` would spuriously pass (~1/16 runs) when the
  generated SHA-256 hash happened to end with `"0"`. Now uses a
  deterministic flip instead of regex substitution.


### Migration

```diff
 {
   "mcpServers": {
     "agentsmcp": {
       "command": "npx",
-      "args": ["-y", "agentsmcp-adapter"],
+      "args": ["-y", "agentsmcp"],
       "env": {
-        "AGENTMAILBOX_AGENT_ID": "cursor@local",
-        "AGENTMAILBOX_SERVER": "http://localhost:3000"
+        "AGENTSMCP_AGENT_ID": "cursor@local",
+        "AGENTSMCP_SERVER": "http://localhost:3000"
       }
     }
   }
 }
```

## 0.3.7 — 2026-05-16

### Added

- 7 mock-based unit tests for `ClaudeCompressor` covering JSON
  parsing, code-fence stripping, malformed-response handling, type
  filtering, prev-summary union, no-op short-circuit, and prompt
  shape. The compressor remains untested against a real Anthropic
  API call; the live gap is now flagged in the JSDoc and the README's
  Contributing section.

## 0.3.6 — 2026-05-16

### Added

- `OpenAICompressor` — second LLM-backed `Compressor` implementation.
  Uses the `openai` SDK (declared as an optional peer dependency)
  with `response_format: { type: "json_object" }` so the model is
  forced to return valid JSON for structured extraction. Defaults to
  `gpt-4o-mini`. Constructor signature mirrors `ClaudeCompressor`.
- `scripts/smoke-openai-compressor.ts` — runnable end-to-end smoke
  validating live compression against the real OpenAI API. Sends 25
  messages on a research-decision thread, hits `/sync`, asserts the
  structured summary has text, decisions, openQuestions, and a
  populated artifacts map. Not part of `npm test`; gated on
  `OPENAI_API_KEY`.

### Notes

- Shipping a second adapter proves the `Compressor` interface is
  provider-agnostic — the design wasn't shaped around Claude's quirks.
- ClaudeCompressor still does not have a live smoke. Untested against
  a real Anthropic API call yet.

## 0.3.5 — 2026-05-16

### Fixed

- **NoopCompressor lost message coverage across successive threshold
  crossings.** The default compressor returned only the new batch in
  `coversMessageIds` instead of unioning with the prior summary's
  coverage. Effect: after the second compression on a thread, the
  cache forgot earlier messages and triggered unnecessary
  recompressions on every subsequent read. `ClaudeCompressor` was
  already doing this correctly; only the default was wrong.
- **JS SDK `receive()` was still hand-picking fields.** The 0.3.2 fix
  added `tokenCount` and a conditional for `threadSummaryStructured`
  but kept the field-list pattern, so any future optional field on
  `ThreadContext` would silently drop again. Now uses
  `{ ...last.context }` spread.

### Added

- Regression test exercising two threshold crossings with a read
  between them — the only scenario in which the NoopCompressor
  coverage bug manifests. Single-call tests can't reproduce it.

## 0.3.4 — 2026-05-16

### Changed

- Server log prefix is now `[agentsmcp]` instead of `[agentmailbox]`
  for consistency with the package name. Purely cosmetic; appears on
  every server startup and in error logs.

## 0.3.3 — 2026-05-16

### Added

- New env var names matching the package name:
  - `AGENTSMCP_API_KEY` (was `AGENTMAILBOX_API_KEY`)
  - `AGENTSMCP_DB` (was `AGENTMAILBOX_DB`)
  - `AGENTSMCP_SERVER` (used by the MCP adapter and examples; was `AGENTMAILBOX_SERVER`)
  - `AGENTSMCP_AGENT_ID` (used by the MCP adapter; was `AGENTMAILBOX_AGENT_ID`)
- New CLI bin `agentsmcp-server` pointing at the same compiled
  entrypoint as `agentmailbox-server`.

### Deprecated

- Legacy `AGENTMAILBOX_*` env vars and the `agentmailbox-server` bin
  name continue to work for one minor version. The server warns once
  on stderr when a legacy env var is read. Both will be removed in
  0.4.0.

### Migration

```diff
-AGENTMAILBOX_API_KEY=s3cret npx agentmailbox-server
+AGENTSMCP_API_KEY=s3cret npx agentsmcp-server
```

```diff
 {
   "mcpServers": {
     "agentsmcp": {
       "command": "npx",
       "args": ["-y", "agentsmcp-adapter"],
       "env": {
-        "AGENTMAILBOX_AGENT_ID": "claude@local",
-        "AGENTMAILBOX_SERVER": "http://localhost:3000"
+        "AGENTSMCP_AGENT_ID": "claude@local",
+        "AGENTSMCP_SERVER": "http://localhost:3000"
       }
     }
   }
 }
```

## 0.3.2 — 2026-05-16

### Fixed

- JS SDK was the client-side mirror of the 0.3.1 `/sync` server bug:
  `AgentMailbox.sync()` and `AgentMailbox.receive()` both stripped
  `threadSummaryStructured` and `tokenCount` from the context they
  returned, even though the server has been sending those fields since
  0.3.0. Any code calling the JS SDK was therefore blind to the
  compression feature. `ReceiveResult.context` now declares both
  fields (`tokenCount` and optional `threadSummaryStructured`), and
  both methods pass them through. Found while building the
  `examples/research-bench/` demo — the synthesizer needed structured
  summaries from `sync()` to extend rather than regenerate.

## 0.3.1 — 2026-05-16

### Fixed

- `/threads/:id/sync` was hand-picking three fields from the assembled
  context and silently dropped the new `threadSummaryStructured` and
  `tokenCount`. MCP clients calling `agentsmcp_sync` therefore never
  saw structured summaries on 0.3.0. Now passes them through. Added a
  regression test that sends 30 messages and asserts the structured
  summary lands on `/sync`.

## 0.3.0 — 2026-05-16

### Added

- **LLM-based context compression.** New `Compressor` interface plus two
  implementations:
  - `NoopCompressor` (default) — empty summary, no LLM dependency,
    keeps zero-config installs working.
  - `ClaudeCompressor` — folds older messages into a structured summary
    (`{ text, decisions, openQuestions, artifacts }`) via Claude Haiku.
    `@anthropic-ai/sdk` is an optional peer dep — install it only if
    you use this compressor.
- `Storage` interface gains `getSummary` / `saveSummary`; SQLite adds a
  `thread_summaries` table (idempotent migration on `init()`).
- `assembleContext` is now async and accepts
  `{ threadId, storage, compressor, compressionThreshold }`. Older
  messages beyond the verbatim window are folded into a cached
  `ThreadSummary`. Default trigger: ≥20 uncovered older messages.
- `createServer({ compressor, compressionThreshold })` wires the
  compressor into the unread / sync routes.
- `ThreadContext` gains an optional `threadSummaryStructured` field for
  programmatic access; existing `threadSummary` string still populated
  from the structured summary's prose `text` (non-breaking).

### Removed (breaking)

- `AgentMailboxStorage` deprecated alias (announced in 0.2.0). Use
  `SqliteStorage` or `createStorage()` instead.

### Migration

If you were still importing the alias:

```diff
-import { AgentMailboxStorage } from "agentsmcp";
+import { SqliteStorage } from "agentsmcp";
-const storage = new AgentMailboxStorage("./db.sqlite");
+const storage = new SqliteStorage("./db.sqlite");
```

To opt into Claude-backed compression:

```ts
import { createServer, ClaudeCompressor } from "agentsmcp";
const { app, ready } = createServer("./db.sqlite", {
  compressor: new ClaudeCompressor(),     // reads ANTHROPIC_API_KEY
  compressionThreshold: 20,
});
```

## 0.2.1 — 2026-05-16

### Fixed

- `main` / `types` pointed at the client SDK file, so installs from npm
  only exposed `AgentMailbox` and `assembleContext` — `createServer`,
  `createStorage`, `SqliteStorage`, and the deprecated alias were
  unreachable. Now points at `dist/index.js` / `dist/index.d.ts`, the
  full barrel.

## 0.2.0 — 2026-05-16

### Changed (breaking)

- Storage layer is now pluggable. The concrete `AgentMailboxStorage` class
  is replaced by a `Storage` interface and a `SqliteStorage` adapter, both
  exported from `agentmailbox`. Every storage method is now `async` and
  returns a `Promise`.
- `createServer()` now returns `{ app, storage, ready }`. Callers must
  `await ready` before serving traffic so schema migrations finish first.
- New `createStorage(opts)` factory accepts a file path or a
  `StorageOptions` object — preferred entry point for new code. The
  Postgres branch is reserved but not yet implemented.

### Deprecated

- `AgentMailboxStorage` is re-exported as a `@deprecated` alias for
  `SqliteStorage`. Scheduled for removal in 0.3.0.

### Migration

```diff
-import { AgentMailboxStorage } from "agentmailbox";
-const storage = new AgentMailboxStorage("./db.sqlite");
-storage.init();
-const agent = storage.registerAgent("alice@demo");
+import { createStorage } from "agentmailbox";
+const storage = createStorage("./db.sqlite");
+await storage.init();
+const agent = await storage.registerAgent("alice@demo");
```

```diff
-const { app } = createServer("./db.sqlite");
-app.listen(3000);
+const { app, ready } = createServer("./db.sqlite");
+await ready;
+app.listen(3000);
```

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
