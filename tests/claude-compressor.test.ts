/**
 * Mock-based tests for ClaudeCompressor. These cover the parsing,
 * coercion, and prev-summary-extension paths without making a real
 * Anthropic API call. The live path (Haiku actually returning valid
 * JSON for the structured-extraction prompt) is unverified; see
 * scripts/smoke-openai-compressor.ts for the equivalent live test
 * against OpenAI, which has been run successfully.
 */
import { describe, expect, it, vi } from "vitest";
import { v4 as uuidv4 } from "uuid";

import { ClaudeCompressor } from "../src/compression";
import { Message, ThreadSummary } from "../src/types";

function makeMessage(n: number): Message {
  return {
    id: uuidv4(),
    threadId: "t",
    from: "a@x",
    to: "b@x",
    payload: { n },
    contextSnapshot: { step: `s${n}` },
    timestamp: n,
  };
}

interface MockClientOptions {
  responseText: string;
  capture?: (req: unknown) => void;
}

function mockClient({ responseText, capture }: MockClientOptions) {
  return {
    messages: {
      create: vi.fn(async (req: unknown) => {
        capture?.(req);
        return {
          content: [{ type: "text", text: responseText }],
        };
      }),
    },
  };
}

describe("ClaudeCompressor", () => {
  it("parses a clean JSON response", async () => {
    const client = mockClient({
      responseText: JSON.stringify({
        text: "Three angles considered.",
        decisions: ["picked Llama"],
        openQuestions: ["how to evaluate?"],
        artifacts: { eval_harness: "lm-eval" },
      }),
    });
    const compressor = new ClaudeCompressor({ client, apiKey: "fake" });
    const messages = [makeMessage(1), makeMessage(2)];
    const summary = await compressor.compress(messages);

    expect(summary.text).toBe("Three angles considered.");
    expect(summary.decisions).toEqual(["picked Llama"]);
    expect(summary.openQuestions).toEqual(["how to evaluate?"]);
    expect(summary.artifacts).toEqual({ eval_harness: "lm-eval" });
    expect(summary.coversMessageIds).toEqual(messages.map((m) => m.id));
    expect(summary.generatedAt).toBeGreaterThan(0);
  });

  it("strips ```json code fences", async () => {
    const client = mockClient({
      responseText:
        "Here you go:\n```json\n" +
        JSON.stringify({ text: "fenced", decisions: [], openQuestions: [], artifacts: {} }) +
        "\n```\nLet me know if you need anything else.",
    });
    const compressor = new ClaudeCompressor({ client, apiKey: "fake" });
    const summary = await compressor.compress([makeMessage(1)]);
    expect(summary.text).toBe("fenced");
  });

  it("returns safe empty defaults on unparseable response", async () => {
    const client = mockClient({ responseText: "I cannot do that" });
    const compressor = new ClaudeCompressor({ client, apiKey: "fake" });
    const summary = await compressor.compress([makeMessage(1)]);
    expect(summary.text).toBe("");
    expect(summary.decisions).toEqual([]);
    expect(summary.openQuestions).toEqual([]);
    expect(summary.artifacts).toEqual({});
    expect(summary.coversMessageIds).toHaveLength(1);
  });

  it("filters non-string entries in decisions/openQuestions arrays", async () => {
    const client = mockClient({
      responseText: JSON.stringify({
        text: "x",
        decisions: ["valid", 42, null, "also valid"],
        openQuestions: [true, "q1"],
        artifacts: ["nope, not an object"], // arrays are not artifact maps
      }),
    });
    const compressor = new ClaudeCompressor({ client, apiKey: "fake" });
    const summary = await compressor.compress([makeMessage(1)]);
    expect(summary.decisions).toEqual(["valid", "also valid"]);
    expect(summary.openQuestions).toEqual(["q1"]);
    expect(summary.artifacts).toEqual({}); // array rejected
  });

  it("unions coversMessageIds with prev summary's coverage", async () => {
    const prev: ThreadSummary = {
      text: "before",
      decisions: ["d0"],
      openQuestions: ["q0"],
      artifacts: { a: 1 },
      coversMessageIds: ["m-old-1", "m-old-2"],
      generatedAt: 100,
    };
    const client = mockClient({
      responseText: JSON.stringify({ text: "extended", decisions: [], openQuestions: [], artifacts: {} }),
    });
    const compressor = new ClaudeCompressor({ client, apiKey: "fake" });
    const newMsg = makeMessage(1);
    const summary = await compressor.compress([newMsg], prev);
    expect(summary.coversMessageIds).toEqual(["m-old-1", "m-old-2", newMsg.id]);
  });

  it("short-circuits when given no messages and a prev summary exists", async () => {
    const captured: unknown[] = [];
    const client = mockClient({
      responseText: "{}",
      capture: (req) => captured.push(req),
    });
    const prev: ThreadSummary = {
      text: "x",
      decisions: ["a"],
      openQuestions: ["b"],
      artifacts: {},
      coversMessageIds: ["m1"],
      generatedAt: 1,
    };
    const compressor = new ClaudeCompressor({ client, apiKey: "fake" });
    const summary = await compressor.compress([], prev);
    // No API call should have been made.
    expect(captured).toHaveLength(0);
    // prev's payload is returned, with a refreshed generatedAt.
    expect(summary.text).toBe("x");
    expect(summary.decisions).toEqual(["a"]);
    expect(summary.coversMessageIds).toEqual(["m1"]);
  });

  it("passes a prev block in the prompt when prev is provided", async () => {
    const captured: Array<{ messages: Array<{ content: string }> }> = [];
    const client = mockClient({
      responseText: JSON.stringify({ text: "x", decisions: [], openQuestions: [], artifacts: {} }),
      capture: (req) => captured.push(req as { messages: Array<{ content: string }> }),
    });
    const prev: ThreadSummary = {
      text: "earlier summary",
      decisions: ["d"],
      openQuestions: [],
      artifacts: {},
      coversMessageIds: ["m1"],
      generatedAt: 1,
    };
    const compressor = new ClaudeCompressor({ client, apiKey: "fake" });
    await compressor.compress([makeMessage(1)], prev);
    expect(captured).toHaveLength(1);
    const userContent = captured[0].messages[0].content;
    expect(userContent).toContain("earlier summary");
    expect(userContent).toContain("extend, don't regenerate");
  });
});
