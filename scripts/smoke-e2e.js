#!/usr/bin/env node
/**
 * E2E smoke test: boots a server, connects two agents, sends a message,
 * receives it, uses context graph + codebase index, then tears down.
 *
 * Usage:
 *   npm run build && node scripts/smoke-e2e.js
 *
 * Exit 0 on success, non-zero on failure.
 */

const { createServer } = require("../dist/server");
const { AgentMailbox } = require("../dist/agentmailbox");
const { listToolDefs, runTool } = require("../dist/mcp/tools");
const { buildMcpServer } = require("../dist/mcp/server");
const { mkdtempSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");

let httpServer;
let tmpDir;

function log(msg) {
  process.stderr.write(`[smoke-e2e] ${msg}\n`);
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function main() {
  // 1. Boot server
  tmpDir = mkdtempSync(join(tmpdir(), "agentsmcp-smoke-"));
  const dbPath = join(tmpDir, "smoke.db");
  const { app, ready } = createServer(dbPath);
  await ready;
  const server = await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  log(`server listening at ${server}`);

  // 2. Connect agents
  const alice = new AgentMailbox({ agentId: "alice@smoke", server });
  const bob = new AgentMailbox({ agentId: "bob@smoke", server });
  await alice.connect();
  await bob.connect();
  log("agents connected: alice, bob");

  // 3. Send + receive
  const { threadId, messageId } = await alice.send("bob@smoke", {
    task: "smoke test",
    data: [1, 2, 3],
  });
  assert(threadId, "send returned threadId");
  assert(messageId, "send returned messageId");
  log(`sent message ${messageId} on thread ${threadId}`);

  const { messages, context } = await bob.receive();
  assert(messages.length === 1, `bob received 1 message, got ${messages.length}`);
  assert(messages[0].from === "alice@smoke", "message is from alice");
  log("bob received message from alice");

  // 4. Sync
  const { context: syncCtx } = await alice.sync(threadId);
  assert(syncCtx.recentMessages.length === 1, "sync has 1 recent message");
  log("sync context verified");

  // 5. Threads
  const threads = await alice.threads();
  assert(threads.length === 1, "alice has 1 thread");
  log("threads listing verified");

  // 6. Mark read
  await bob.markRead(threadId);
  const afterRead = await bob.unread();
  assert(afterRead.length === 0, "bob has 0 unread after mark_read");
  log("mark_read verified");

  // 7. Reply all
  const reply = await bob.replyAll(threadId, { answer: "smoke reply" });
  assert(reply.deliveredTo.includes("alice@smoke"), "reply delivered to alice");
  log("reply_all verified");

  // 8. MCP tools listing
  const tools = listToolDefs();
  assert(tools.length === 15, `expected 15 tools, got ${tools.length}`);
  log(`MCP tools: ${tools.length} listed`);

  // 9. Context graph via runTool
  await runTool(alice, "agentsmcp_upsert_node", {
    id: "file:smoke.ts",
    type: "file",
    name: "smoke.ts",
    description: "Smoke test file",
  });
  const graph = await runTool(alice, "agentsmcp_query_graph", {
    query: "smoke",
  });
  assert(graph.nodes.length >= 1, "graph query returned nodes");
  log("context graph verified");

  // 10. Codebase index via runTool
  await runTool(alice, "agentsmcp_upsert_index", {
    key: "file:smoke.ts",
    category: "file",
    summary: "E2E smoke test file",
  });
  const entry = await runTool(alice, "agentsmcp_get_index", {
    key: "file:smoke.ts",
  });
  assert(entry.found === true, "index entry found");
  assert(entry.summary.includes("smoke"), "index summary matches");
  log("codebase index verified");

  // 11. buildMcpServer creates without error
  const mcpServer = buildMcpServer(alice);
  assert(typeof mcpServer.connect === "function", "MCP server has connect()");
  log("buildMcpServer verified");

  // 12. Context briefing
  const briefing = await runTool(alice, "agentsmcp_context_briefing", {
    task: "Fix the smoke test file",
  });
  assert(briefing.task === "Fix the smoke test file", "briefing has correct task");
  assert(Array.isArray(briefing.relevantNodes), "briefing has nodes");
  assert(Array.isArray(briefing.indexEntries), "briefing has index entries");
  log("context briefing verified");

  log("ALL CHECKS PASSED ✓");
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    log(`FAILED: ${err.message}`);
    log(err.stack);
    cleanup();
    process.exit(1);
  });

function cleanup() {
  if (httpServer) {
    try {
      httpServer.close();
    } catch {}
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}
