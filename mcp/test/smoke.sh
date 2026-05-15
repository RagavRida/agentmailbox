#!/usr/bin/env bash
# Smoke test for agentmailbox-mcp.
#
# 1. Boots the AgentMailbox HTTP server on a private port + db.
# 2. Registers a peer agent so there is someone to talk to.
# 3. Drives the MCP server over stdio with JSON-RPC: initialize,
#    tools/list, resources/list, resources/templates/list, and
#    tools/call(agentmailbox_send).
# 4. Verifies the message landed in the peer's mailbox via HTTP.
#
# Exits 0 on success, non-zero on failure.

set -euo pipefail

PORT=3300
DB="$(mktemp -t agentmailbox-mcp-smoke.XXXXXX.db)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(cd "$ROOT/.." && pwd)"
SERVER_LOG="$(mktemp -t agentmailbox-mcp-server.XXXXXX.log)"
MCP_OUT="$(mktemp -t agentmailbox-mcp-out.XXXXXX.json)"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$DB" "$SERVER_LOG" "$MCP_OUT"
}
trap cleanup EXIT

echo "[smoke] building parent + mcp"
(cd "$PARENT" && npm install --no-audit --no-fund --silent >/dev/null && npm run build --silent >/dev/null)
(cd "$ROOT" && npm install --no-audit --no-fund --silent >/dev/null && npm run build --silent >/dev/null)

echo "[smoke] starting AgentMailbox server on :$PORT"
(
  cd "$PARENT"
  PORT="$PORT" AGENTMAILBOX_DB="$DB" node dist/server.js
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# wait for the server to come up
for i in $(seq 1 50); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  if curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "[smoke] FAIL: server failed to start"
  cat "$SERVER_LOG" >&2
  exit 1
fi

echo "[smoke] registering peer agent other@demo"
curl -sf -X POST "http://localhost:$PORT/agents/register" \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"other@demo"}' >/dev/null

echo "[smoke] driving MCP over stdio"
REQUESTS=$(cat <<'JSON'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"resources/list"}
{"jsonrpc":"2.0","id":4,"method":"resources/templates/list"}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"agentmailbox_send","arguments":{"to":"other@demo","payload":{"text":"hello from mcp smoke"}}}}
JSON
)

AGENTMAILBOX_AGENT_ID="claude@smoke" \
AGENTMAILBOX_SERVER="http://localhost:$PORT" \
  node "$ROOT/dist/index.js" <<<"$REQUESTS" >"$MCP_OUT" 2>"$SERVER_LOG.mcp" || {
    echo "[smoke] FAIL: mcp exited non-zero"
    cat "$SERVER_LOG.mcp" >&2 || true
    exit 1
  }

# verify responses
node - "$MCP_OUT" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split("\n").filter(Boolean);
const byId = new Map();
for (const line of lines) {
  try {
    const msg = JSON.parse(line);
    if (msg && typeof msg.id !== "undefined") byId.set(msg.id, msg);
  } catch { /* ignore non-json log lines */ }
}
function need(id, predicate, label) {
  const m = byId.get(id);
  if (!m || m.error) {
    console.error(`[smoke] FAIL: ${label}: missing or errored`, m && m.error);
    process.exit(1);
  }
  if (!predicate(m.result)) {
    console.error(`[smoke] FAIL: ${label}: predicate failed`, JSON.stringify(m));
    process.exit(1);
  }
}
need(1, (r) => r && r.protocolVersion, "initialize");
need(2, (r) => Array.isArray(r.tools) && r.tools.length === 8, "tools/list returns 8 tools");
need(3, (r) => Array.isArray(r.resources) && r.resources.length >= 1, "resources/list");
need(4, (r) => Array.isArray(r.resourceTemplates) && r.resourceTemplates.length >= 1, "resources/templates/list");
need(5, (r) => {
  if (!r || !Array.isArray(r.content) || r.content.length === 0) return false;
  const payload = JSON.parse(r.content[0].text);
  return typeof payload.messageId === "string"
      && typeof payload.threadId === "string"
      && Array.isArray(payload.deliveredTo);
}, "tools/call(agentmailbox_send)");
console.log("[smoke] MCP responses OK");
NODE

echo "[smoke] verifying peer mailbox via HTTP"
UNREAD=$(curl -sf "http://localhost:$PORT/mailbox/other%40demo/unread")
echo "$UNREAD" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!Array.isArray(d.messages) || d.messages.length < 1) {
    console.error("[smoke] FAIL: no unread messages for other@demo");
    process.exit(1);
  }
  const m = d.messages[d.messages.length - 1];
  if (m.from !== "claude@smoke") {
    console.error("[smoke] FAIL: unexpected sender", m.from);
    process.exit(1);
  }
  console.log("[smoke] peer mailbox OK");
'

echo "[smoke] PASS"
