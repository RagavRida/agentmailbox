import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentsmcpSaver } from "../src";
import { startServer, type TestServer } from "./setup";

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.close();
});

const baseCheckpoint = (id: string, channelValues: Record<string, unknown> = {}) => ({
  v: 1,
  id,
  ts: new Date().toISOString(),
  channel_values: channelValues,
  channel_versions: {},
  versions_seen: {},
  pending_sends: [],
});

describe("AgentsmcpSaver", () => {
  it("getTuple returns undefined for a thread that has never been written", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver.connect();
    const result = await saver.getTuple({
      configurable: { thread_id: "nope" },
    });
    expect(result).toBeUndefined();
  });

  it("put then getTuple round-trips a checkpoint", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver.connect();

    const cp = baseCheckpoint("01HXXX-FIRST", { count: 1 });
    const config = { configurable: { thread_id: "t1" } };
    const newConfig = await saver.put(
      config,
      cp,
      { source: "input", step: 0, writes: {}, parents: {} },
      {}
    );
    expect(newConfig.configurable?.checkpoint_id).toBe("01HXXX-FIRST");

    const got = await saver.getTuple(config);
    expect(got).toBeDefined();
    expect(got!.checkpoint.id).toBe("01HXXX-FIRST");
    expect(got!.checkpoint.channel_values).toEqual({ count: 1 });
    expect(got!.metadata?.step).toBe(0);
  });

  it("getTuple with no checkpoint_id returns the LATEST checkpoint", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver.connect();

    for (let i = 0; i < 3; i++) {
      const cp = baseCheckpoint(`01HX-${i}`, { count: i });
      await saver.put(
        { configurable: { thread_id: "t-latest" } },
        cp,
        { source: "loop", step: i, writes: {}, parents: {} },
        {}
      );
    }
    const got = await saver.getTuple({ configurable: { thread_id: "t-latest" } });
    expect(got!.checkpoint.id).toBe("01HX-2");
    expect(got!.checkpoint.channel_values).toEqual({ count: 2 });
  });

  it("getTuple with explicit checkpoint_id returns that specific one", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver.connect();

    for (let i = 0; i < 3; i++) {
      const cp = baseCheckpoint(`01HX-${i}`, { count: i });
      await saver.put(
        { configurable: { thread_id: "t-pick" } },
        cp,
        { source: "loop", step: i, writes: {}, parents: {} },
        {}
      );
    }
    const got = await saver.getTuple({
      configurable: { thread_id: "t-pick", checkpoint_id: "01HX-1" },
    });
    expect(got!.checkpoint.id).toBe("01HX-1");
    expect(got!.checkpoint.channel_values).toEqual({ count: 1 });
  });

  it("list yields checkpoints newest-first and respects limit", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver.connect();
    for (let i = 0; i < 5; i++) {
      await saver.put(
        { configurable: { thread_id: "t-list" } },
        baseCheckpoint(`01HX-${i}`, { count: i }),
        { source: "loop", step: i, writes: {}, parents: {} },
        {}
      );
    }
    const ids: string[] = [];
    for await (const t of saver.list(
      { configurable: { thread_id: "t-list" } },
      { limit: 3 }
    )) {
      ids.push(t.checkpoint.id);
    }
    expect(ids).toEqual(["01HX-4", "01HX-3", "01HX-2"]);
  });

  it("putWrites attaches pending writes to the named checkpoint", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver.connect();
    const cp = baseCheckpoint("01HX-W", { count: 0 });
    await saver.put(
      { configurable: { thread_id: "t-writes" } },
      cp,
      { source: "input", step: 0, writes: {}, parents: {} },
      {}
    );
    await saver.putWrites(
      { configurable: { thread_id: "t-writes", checkpoint_id: "01HX-W" } },
      [["chan_a", { payload: "hello" }]],
      "task-1"
    );
    const got = await saver.getTuple({ configurable: { thread_id: "t-writes" } });
    expect(got!.pendingWrites).toHaveLength(1);
    const [taskId, channel, value] = got!.pendingWrites![0];
    expect(taskId).toBe("task-1");
    expect(channel).toBe("chan_a");
    expect(value).toEqual({ payload: "hello" });
  });

  it("resumes after a fresh saver instance (cold-restart by construction)", async () => {
    const saver1 = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver1.connect();
    await saver1.put(
      { configurable: { thread_id: "t-resume" } },
      baseCheckpoint("01HX-A", { count: 42 }),
      { source: "input", step: 0, writes: {}, parents: {} },
      {}
    );

    // Brand-new saver instance — empty in-memory cache.
    const saver2 = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver2.connect();
    const got = await saver2.getTuple({ configurable: { thread_id: "t-resume" } });
    expect(got).toBeDefined();
    expect(got!.checkpoint.channel_values).toEqual({ count: 42 });
  });

  it("isolates checkpoint_ns within the same thread_id", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@test" });
    await saver.connect();
    await saver.put(
      { configurable: { thread_id: "t-ns", checkpoint_ns: "" } },
      baseCheckpoint("01HX-root", { from: "root" }),
      { source: "input", step: 0, writes: {}, parents: {} },
      {}
    );
    await saver.put(
      { configurable: { thread_id: "t-ns", checkpoint_ns: "sub:child" } },
      baseCheckpoint("01HX-child", { from: "child" }),
      { source: "input", step: 0, writes: {}, parents: {} },
      {}
    );
    const root = await saver.getTuple({
      configurable: { thread_id: "t-ns", checkpoint_ns: "" },
    });
    const child = await saver.getTuple({
      configurable: { thread_id: "t-ns", checkpoint_ns: "sub:child" },
    });
    expect(root!.checkpoint.channel_values).toEqual({ from: "root" });
    expect(child!.checkpoint.channel_values).toEqual({ from: "child" });
  });
});

describe("AgentsmcpSaver — context graph", () => {
  it("upsertNode + queryGraph round-trip", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@graph" });
    await saver.connect();

    await saver.upsertNode({
      id: "file:graph-runner.ts",
      type: "file",
      name: "graph-runner.ts",
      description: "LangGraph state machine entrypoint",
      metadata: { exports: ["runGraph"] },
    });

    const result = await saver.queryGraph("graph-runner");
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes.some((n) => n.id === "file:graph-runner.ts")).toBe(true);
  });

  it("addEdge links two nodes and appears in queryGraph result", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@graph" });
    await saver.connect();

    await saver.upsertNode({ id: "file:agent.ts", type: "file", name: "agent.ts" });
    await saver.upsertNode({ id: "symbol:runAgent", type: "symbol", name: "runAgent" });
    await saver.addEdge({
      sourceId: "file:agent.ts",
      targetId: "symbol:runAgent",
      type: "contains",
      weight: 1.0,
    });

    const result = await saver.queryGraph("runAgent");
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it("queryGraph returns empty arrays for no match", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@graph" });
    await saver.connect();

    const result = await saver.queryGraph("zzz-nonexistent-zzz");
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

describe("AgentsmcpSaver — codebase index", () => {
  it("upsertIndex + getIndex round-trip", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@index" });
    await saver.connect();

    await saver.upsertIndex({
      key: "file:state-machine.ts",
      category: "file",
      summary: "LangGraph state machine with parallel node execution",
      metadata: { lineCount: 320 },
    });

    const entry = await saver.getIndex("file:state-machine.ts");
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe("file:state-machine.ts");
    expect(entry!.category).toBe("file");
    expect(entry!.summary).toContain("LangGraph");
  });

  it("getIndex returns null for a missing key", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@index" });
    await saver.connect();

    const entry = await saver.getIndex("nonexistent:key");
    expect(entry).toBeNull();
  });

  it("searchIndex finds entries by keyword", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@index" });
    await saver.connect();

    await saver.upsertIndex({
      key: "api:POST /invoke",
      category: "api",
      summary: "Invokes the compiled LangGraph graph with input state",
    });
    await saver.upsertIndex({
      key: "file:graph.ts",
      category: "file",
      summary: "Graph definition and node wiring for the LangGraph pipeline",
    });

    const results = await saver.searchIndex("LangGraph");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("searchIndex filters by category", async () => {
    const saver = new AgentsmcpSaver({ server: server.url, agentId: "lg@index" });
    await saver.connect();

    await saver.upsertIndex({ key: "file:x.ts",   category: "file",   summary: "LangGraph file entry" });
    await saver.upsertIndex({ key: "api:POST /x", category: "api",    summary: "LangGraph API entry" });
    await saver.upsertIndex({ key: "sym:x",       category: "symbol", summary: "LangGraph symbol entry" });

    const apiOnly = await saver.searchIndex("LangGraph", "api");
    expect(apiOnly.every((e) => e.category === "api")).toBe(true);
  });
});

