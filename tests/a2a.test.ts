import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer, type TestServer } from "./setup";

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

type AgentCardLike = {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: Record<string, boolean>;
  skills?: Array<{ id: string; name: string; inputSchema: unknown; outputSchema: unknown }>;
  provider: { organization: string; url: string };
  securitySchemes: Record<string, { type: string; scheme: string }>;
  authentication: "required" | "none";
  agentId?: string;
  threadCount?: number;
  unreadCount?: number;
  endpoints?: Record<string, string>;
};

describe("A2A Agent Card (no auth)", () => {
  let server: TestServer;
  beforeEach(async () => { server = await startServer(); });
  afterEach(async () => { await server.close(); });

  it("GET /.well-known/agent-card.json returns a valid Agent Card with no auth", async () => {
    const res = await getJson(`${server.url}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = res.data as AgentCardLike;

    expect(card.name).toBe("AgentMailbox");
    expect(typeof card.description).toBe("string");
    expect(card.url.startsWith("http://")).toBe(true);
    expect(typeof card.version).toBe("string");
    expect(card.version.length).toBeGreaterThan(0);

    expect(card.capabilities.messaging).toBe(true);
    expect(card.capabilities.threading).toBe(true);
    expect(card.capabilities.contextCompression).toBe(true);
    expect(card.capabilities.coldRestart).toBe(true);
    expect(card.capabilities.multiAgent).toBe(true);

    const skillIds = (card.skills ?? []).map((s) => s.id).sort();
    expect(skillIds).toEqual(
      ["receive-messages", "reply-all", "send-message", "sync-thread"]
    );
    for (const s of card.skills ?? []) {
      expect(s.inputSchema).toBeTypeOf("object");
      expect(s.outputSchema).toBeTypeOf("object");
    }

    expect(card.provider.organization).toBe("AgentMailbox");
    expect(card.provider.url).toContain("github.com/RagavRida");
    expect(card.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
    expect(card.authentication).toBe("none");
  });

  it("per-agent card returns 404 for unregistered agents", async () => {
    const res = await getJson(
      `${server.url}/.well-known/agent-card/${encodeURIComponent("ghost@x")}`
    );
    expect(res.status).toBe(404);
  });

  it("per-agent card returns a valid card for a registered agent", async () => {
    await postJson(`${server.url}/agents/register`, { agentId: "alice@x" });
    // give alice a thread so threadCount > 0
    await postJson(`${server.url}/messages/send`, {
      from: "alice@x",
      to: "bob@x",
      payload: { hello: "world" },
    });

    const res = await getJson(
      `${server.url}/.well-known/agent-card/${encodeURIComponent("alice@x")}`
    );
    expect(res.status).toBe(200);
    const card = res.data as AgentCardLike;
    expect(card.name).toBe("alice@x");
    expect(card.agentId).toBe("alice@x");
    expect(card.capabilities.messaging).toBe(true);
    expect(card.capabilities.threading).toBe(true);
    expect(card.threadCount).toBeGreaterThanOrEqual(1);
    expect(card.endpoints?.mailbox).toContain("/mailbox/");
    expect(card.endpoints?.unread).toContain("/unread");
    expect(card.endpoints?.markRead).toContain("/read");
    expect(card.authentication).toBe("none");
  });
});

describe("A2A Agent Card (with API key)", () => {
  let server: TestServer;
  beforeEach(async () => { server = await startServer({ apiKey: "secret-key" }); });
  afterEach(async () => { await server.close(); });

  it("server card is publicly discoverable and reflects authentication=required", async () => {
    const res = await getJson(`${server.url}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = res.data as AgentCardLike;
    expect(card.authentication).toBe("required");
    expect(card.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
  });

  it("per-agent card is publicly discoverable (no bearer needed)", async () => {
    // Registering requires the key
    await postJson(
      `${server.url}/agents/register`,
      { agentId: "carol@x" },
      { authorization: "Bearer secret-key" }
    );

    const res = await getJson(
      `${server.url}/.well-known/agent-card/${encodeURIComponent("carol@x")}`
    );
    expect(res.status).toBe(200);
    const card = res.data as AgentCardLike;
    expect(card.agentId).toBe("carol@x");
    expect(card.authentication).toBe("required");
  });
});
