#!/usr/bin/env node
// agentsmcp-adapter is deprecated — use "npx agentsmcp" directly.
// This shim exists so existing MCP configs keep working.
process.stderr.write(
  "agentsmcp-adapter: DEPRECATED — use \"npx agentsmcp\" instead. " +
    "This shim delegates to the main package.\n"
);
require("agentsmcp/dist/mcp/index.js");
