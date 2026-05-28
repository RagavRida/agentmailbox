import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer, type TestServer } from "./setup";
import { AgentMailbox } from "../src/agentmailbox";
import {
  listResources,
  listResourceTemplates,
  readResource,
  MAILBOX_URI,
  THREAD_URI_PREFIX,
} from "../src/mcp/resources";

let server: TestServer;
let agent: AgentMailbox;

describe("MCP resources — static listings", () => {
  it("listResources returns mailbox resource", () => {
    const resources = listResources();
    expect(resources.length).toBe(1);
    expect(resources[0].uri).toBe(MAILBOX_URI);
    expect(resources[0].mimeType).toBe("application/json");
  });

  it("listResourceTemplates returns thread template", () => {
    const templates = listResourceTemplates();
    expect(templates.length).toBe(1);
    expect(templates[0].uriTemplate).toContain(THREAD_URI_PREFIX);
    expect(templates[0].mimeType).toBe("application/json");
  });
});

describe("MCP resources — readResource", () => {
  beforeEach(async () => {
    server = await startServer();
    agent = new AgentMailbox({ agentId: "alice@test", server: server.url });
    await agent.connect();
  });
  afterEach(async () => {
    await server.close();
  });

  it("reads mailbox resource (empty)", async () => {
    const content = await readResource(agent, MAILBOX_URI);
    expect(content.uri).toBe(MAILBOX_URI);
    expect(content.mimeType).toBe("application/json");

    const data = JSON.parse(content.text);
    expect(data.threads).toEqual([]);
  });

  it("reads mailbox resource with threads", async () => {
    const bob = new AgentMailbox({ agentId: "bob@test", server: server.url });
    await bob.connect();

    await agent.send("bob@test", { msg: "hello" });

    const content = await readResource(agent, MAILBOX_URI);
    const data = JSON.parse(content.text);
    expect(data.threads.length).toBe(1);
  });

  it("reads thread resource", async () => {
    const bob = new AgentMailbox({ agentId: "bob@test", server: server.url });
    await bob.connect();

    const { threadId } = await agent.send("bob@test", {
      msg: "thread-resource-test",
    });

    const threadUri = `${THREAD_URI_PREFIX}${encodeURIComponent(threadId)}`;
    const content = await readResource(agent, threadUri);
    expect(content.uri).toBe(threadUri);
    expect(content.mimeType).toBe("application/json");

    const data = JSON.parse(content.text);
    expect(data.threadId).toBe(threadId);
    expect(data.context).toBeDefined();
    expect(data.participants).toBeDefined();
    expect(data.context.recentMessages.length).toBe(1);
  });

  it("throws on unknown resource URI", async () => {
    await expect(
      readResource(agent, "agentsmcp://nonexistent")
    ).rejects.toThrow("unknown resource uri");
  });

  it("throws on empty thread ID", async () => {
    await expect(
      readResource(agent, THREAD_URI_PREFIX)
    ).rejects.toThrow("invalid thread resource uri");
  });
});
