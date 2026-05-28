#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AgentMailbox } from "../agentmailbox";

import { buildMcpServer } from "./server";

interface Config {
  agentId: string;
  server: string;
  apiKey?: string;
}

function parseArgs(argv: string[]): Partial<Config> {
  const out: Partial<Config> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      i += 1;
      return v;
    };
    if (a === "--agent-id") out.agentId = next();
    else if (a === "--server") out.server = next();
    else if (a === "--api-key") out.apiKey = next();
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printUsage(): void {
  process.stderr.write(
    "usage: agentsmcp [--agent-id ID] [--server URL] [--api-key KEY]\n" +
      "env: AGENTSMCP_AGENT_ID, AGENTSMCP_SERVER, AGENTSMCP_API_KEY\n"
  );
}

function die(msg: string): never {
  process.stderr.write(`agentsmcp: ${msg}\n`);
  process.exit(1);
}

function readEnv(name: string): string | undefined {
  const val = process.env[name];
  if (val !== undefined && val !== "") return val;
  return undefined;
}

function resolveConfig(): Config {
  const args = parseArgs(process.argv.slice(2));
  const agentId =
    args.agentId ?? readEnv("AGENTSMCP_AGENT_ID") ?? "";
  const server =
    args.server ??
    readEnv("AGENTSMCP_SERVER") ??
    "http://localhost:3000";
  const apiKey =
    args.apiKey ?? readEnv("AGENTSMCP_API_KEY");
  if (!agentId) {
    die(
      "AGENTSMCP_AGENT_ID is required (or pass --agent-id). " +
        "This identifies the agent this MCP server represents."
    );
  }
  return { agentId, server, apiKey };
}

async function main(): Promise<void> {
  const cfg = resolveConfig();
  const agent = new AgentMailbox({
    agentId: cfg.agentId,
    server: cfg.server,
    apiKey: cfg.apiKey,
  });

  try {
    await agent.connect();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`cannot reach AgentMailbox server at ${cfg.server}: ${msg}`);
  }

  const server = buildMcpServer(agent);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`agentsmcp: ${signal} received, shutting down\n`);
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  process.stderr.write(
    `agentsmcp: connected as ${cfg.agentId} -> ${cfg.server}\n`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agentsmcp: fatal: ${msg}\n`);
  process.exit(1);
});
