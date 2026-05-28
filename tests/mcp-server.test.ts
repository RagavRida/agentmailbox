import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer, type TestServer } from "./setup";
import { AgentMailbox } from "../src/agentmailbox";
import { buildMcpServer } from "../src/mcp/server";

let server: TestServer;
let agent: AgentMailbox;

describe("buildMcpServer", () => {
  beforeEach(async () => {
    server = await startServer();
    agent = new AgentMailbox({ agentId: "alice@test", server: server.url });
    await agent.connect();
  });
  afterEach(async () => {
    await server.close();
  });

  it("creates a server instance with tools and resources capabilities", () => {
    const mcpServer = buildMcpServer(agent);
    expect(mcpServer).toBeDefined();
    // The server should be an instance of @modelcontextprotocol/sdk Server
    expect(typeof mcpServer.connect).toBe("function");
    expect(typeof mcpServer.close).toBe("function");
  });

  it("can be created for different agents independently", () => {
    const bob = new AgentMailbox({ agentId: "bob@test", server: server.url });
    const server1 = buildMcpServer(agent);
    const server2 = buildMcpServer(bob);

    // Both should be independent instances
    expect(server1).not.toBe(server2);
  });
});
