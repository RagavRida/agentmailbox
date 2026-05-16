/**
 * Live smoke test for OpenAICompressor. Boots an in-process server with
 * OpenAICompressor wired in, sends 25 messages about a research topic,
 * hits /sync, and asserts the structured summary has populated fields.
 *
 * Requires OPENAI_API_KEY in the environment. Not part of `npm test` —
 * run manually to validate end-to-end compression against a real model:
 *
 *   OPENAI_API_KEY=sk-... npx ts-node scripts/smoke-openai-compressor.ts
 */
import { createServer } from "../src";
import { OpenAICompressor } from "../src/compression";

const PORT = 43800;
const TOPICS = [
  "what model size do we need",
  "trade-offs between Llama and Mistral",
  "GPU vs CPU inference latency",
  "quantization losses at 4-bit",
  "context-window budget",
  "tokenizer choice matters more than you'd think",
  "vLLM vs TGI throughput",
  "batching strategies for streaming",
  "prefix caching cuts TTFT in half",
  "speculative decoding gains for small drafts",
  "RoPE scaling for long context",
  "fine-tuning vs prompt engineering ROI",
  "alignment regressions from RLHF",
  "evaluation harness — lm-eval-harness or in-house",
  "perplexity isn't enough — need task-specific evals",
  "data leakage in public benchmarks",
  "MMLU saturation",
  "reasoning eval gap",
  "safety filters cost 8% on helpfulness",
  "open question: how do we measure agent reliability",
  "decision: ship Llama-3.1-8B quantized to 4-bit on H100",
  "decision: TGI for serving, vLLM as fallback",
  "decision: speculative decoding off until verified gain",
  "open question: do we need a guard model in production",
  "next steps: write eval harness + ship to staging Friday",
];

async function send(url: string, from: string, to: string, body: unknown, threadId?: string) {
  const res = await fetch(`${url}/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      payload: { note: body },
      threadId,
      contextSnapshot: { lastNote: body },
    }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status}`);
  return (await res.json()) as { threadId: string };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set");
    process.exit(1);
  }

  const { app, storage, ready } = createServer(":memory:", {
    compressor: new OpenAICompressor(),
    compressionThreshold: 10, // smoke uses a lower threshold so the
    // OpenAI call actually fires on 25 messages (15 older > 10).
  });
  await ready;
  const server = app.listen(PORT, () => {
    process.stdout.write(`[smoke] server on http://localhost:${PORT}\n`);
  });

  try {
    const url = `http://localhost:${PORT}`;
    let threadId: string | undefined;

    process.stdout.write(`[smoke] sending ${TOPICS.length} messages...\n`);
    for (let i = 0; i < TOPICS.length; i++) {
      const from = i % 2 === 0 ? "engineer@team" : "lead@team";
      const to = i % 2 === 0 ? "lead@team" : "engineer@team";
      const result = await send(url, from, to, TOPICS[i], threadId);
      threadId = result.threadId;
    }

    process.stdout.write(`[smoke] thread=${threadId}\n`);
    process.stdout.write(`[smoke] requesting /sync to trigger compression...\n`);
    const syncRes = await fetch(`${url}/threads/${threadId}/sync`);
    const sync = (await syncRes.json()) as {
      context: {
        threadSummary: string;
        threadSummaryStructured?: {
          text: string;
          decisions: string[];
          openQuestions: string[];
          artifacts: Record<string, unknown>;
          coversMessageIds: string[];
        };
        recentMessages: unknown[];
        tokenCount: number;
      };
    };

    const ctx = sync.context;
    const s = ctx.threadSummaryStructured;
    if (!s) {
      throw new Error("FAIL: threadSummaryStructured missing — compression didn't run");
    }

    process.stdout.write("\n=== OpenAICompressor live result ===\n");
    process.stdout.write(`recent count:       ${ctx.recentMessages.length} (expect 10)\n`);
    process.stdout.write(`covers count:       ${s.coversMessageIds.length} (expect 15)\n`);
    process.stdout.write(`tokenCount:         ${ctx.tokenCount}\n`);
    process.stdout.write(`text (first 200ch): ${s.text.slice(0, 200)}\n`);
    process.stdout.write(`decisions:          ${JSON.stringify(s.decisions, null, 2)}\n`);
    process.stdout.write(`openQuestions:      ${JSON.stringify(s.openQuestions, null, 2)}\n`);
    process.stdout.write(`artifacts keys:     ${Object.keys(s.artifacts).join(", ") || "(none)"}\n`);

    const checks = {
      "covers 15 ids": s.coversMessageIds.length === 15,
      "text non-empty": s.text.length > 0,
      "decisions present": s.decisions.length > 0,
      "openQuestions present": s.openQuestions.length > 0,
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok);
    process.stdout.write("\n=== assertions ===\n");
    for (const [k, ok] of Object.entries(checks)) {
      process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${k}\n`);
    }
    if (failed.length > 0) {
      process.exit(1);
    }
    process.stdout.write("\n[smoke] all checks passed\n");
  } finally {
    server.close();
    await storage.close();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`[smoke] fatal: ${err.message}\n`);
  process.exit(1);
});
