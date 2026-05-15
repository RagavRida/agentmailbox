import { Message, ThreadSummary } from "../types";
import { Compressor } from "./interface";

export interface ClaudeCompressorOptions {
  /**
   * Anthropic API key. Falls back to `ANTHROPIC_API_KEY` env var. If neither
   * is set, the compressor will throw on first call.
   */
  apiKey?: string;
  /**
   * Model to use. Defaults to Claude Haiku 4.5 — fast, cheap, good enough
   * for the structured-extraction task. Override for Sonnet if you need
   * higher quality on long, technical threads.
   */
  model?: string;
  /**
   * Pre-constructed Anthropic client. Lets callers reuse a single client,
   * configure base URL / fetch / timeouts, or inject a mock in tests.
   * When omitted, the compressor lazily requires `@anthropic-ai/sdk` and
   * instantiates one on first use.
   */
  client?: AnthropicLike;
  /** Max output tokens for the summary. Defaults to 1024. */
  maxTokens?: number;
}

interface AnthropicLike {
  messages: {
    create(req: unknown): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

const SYSTEM_PROMPT = `You compress a multi-agent conversation into a structured summary.

Return STRICT JSON only, no prose around it, matching this schema:
{
  "text": string,              // 1-3 paragraphs, dense, agent-readable
  "decisions": string[],       // load-bearing choices ("agent X picked Y because Z")
  "openQuestions": string[],   // raised but unresolved
  "artifacts": object          // named entities the thread keeps referencing: paper ids, file paths, urls, ticket ids. keyed by name.
}

Prefer concrete over abstract. Omit pleasantries. If a previous summary is
provided, extend it — keep its facts and merge in the new messages — do
not regenerate from scratch.`;

function serializeMessage(m: Message): string {
  const role = `${m.from} -> ${m.to}`;
  const payload =
    typeof m.payload === "string"
      ? m.payload
      : (() => {
          try {
            return JSON.stringify(m.payload);
          } catch {
            return String(m.payload);
          }
        })();
  const snapshot =
    m.contextSnapshot && Object.keys(m.contextSnapshot).length > 0
      ? ` [snapshot: ${JSON.stringify(m.contextSnapshot)}]`
      : "";
  return `[${new Date(m.timestamp).toISOString()}] ${role}: ${payload}${snapshot}`;
}

interface ParsedSummary {
  text?: unknown;
  decisions?: unknown;
  openQuestions?: unknown;
  artifacts?: unknown;
}

function coerce(parsed: ParsedSummary, messageIds: string[]): ThreadSummary {
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const decisions = Array.isArray(parsed.decisions)
    ? parsed.decisions.filter((d): d is string => typeof d === "string")
    : [];
  const openQuestions = Array.isArray(parsed.openQuestions)
    ? parsed.openQuestions.filter((q): q is string => typeof q === "string")
    : [];
  const artifacts =
    parsed.artifacts && typeof parsed.artifacts === "object" && !Array.isArray(parsed.artifacts)
      ? (parsed.artifacts as Record<string, unknown>)
      : {};
  return {
    text,
    decisions,
    openQuestions,
    artifacts,
    coversMessageIds: messageIds,
    generatedAt: Date.now(),
  };
}

function extractJson(raw: string): ParsedSummary {
  // Claude usually returns clean JSON when instructed, but be defensive:
  // strip code fences and grab the first {...} block.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return {};
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as ParsedSummary;
  } catch {
    return {};
  }
}

export class ClaudeCompressor implements Compressor {
  private readonly model: string;
  private readonly maxTokens: number;
  private clientPromise?: Promise<AnthropicLike>;
  private readonly apiKey?: string;
  private readonly explicitClient?: AnthropicLike;

  constructor(opts: ClaudeCompressorOptions = {}) {
    this.model = opts.model ?? "claude-haiku-4-5-20251001";
    this.maxTokens = opts.maxTokens ?? 1024;
    this.apiKey = opts.apiKey;
    this.explicitClient = opts.client;
  }

  private async getClient(): Promise<AnthropicLike> {
    if (this.explicitClient) return this.explicitClient;
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      let mod: { default?: new (cfg: unknown) => AnthropicLike } & {
        Anthropic?: new (cfg: unknown) => AnthropicLike;
      };
      try {
        mod = (await import("@anthropic-ai/sdk")) as typeof mod;
      } catch (e) {
        throw new Error(
          "ClaudeCompressor requires the @anthropic-ai/sdk package. " +
            "Install it with: npm install @anthropic-ai/sdk"
        );
      }
      const Ctor = mod.default ?? mod.Anthropic;
      if (!Ctor) {
        throw new Error("@anthropic-ai/sdk did not export an Anthropic constructor");
      }
      const apiKey = this.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY is not set. Pass apiKey to ClaudeCompressor or set the env var."
        );
      }
      return new Ctor({ apiKey });
    })();
    return this.clientPromise;
  }

  async compress(messages: Message[], prev?: ThreadSummary): Promise<ThreadSummary> {
    if (messages.length === 0) {
      return {
        text: prev?.text ?? "",
        decisions: prev?.decisions ?? [],
        openQuestions: prev?.openQuestions ?? [],
        artifacts: prev?.artifacts ?? {},
        coversMessageIds: prev?.coversMessageIds ?? [],
        generatedAt: Date.now(),
      };
    }

    const client = await this.getClient();
    const serialized = messages.map(serializeMessage).join("\n");
    const prevBlock = prev
      ? `Previous summary (extend, don't regenerate):\n${JSON.stringify(
          {
            text: prev.text,
            decisions: prev.decisions,
            openQuestions: prev.openQuestions,
            artifacts: prev.artifacts,
          },
          null,
          2
        )}\n\n`
      : "";

    const userContent = `${prevBlock}Messages to summarize:\n${serialized}\n\nReturn the JSON summary now.`;

    const res = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    const parsed = extractJson(text);
    const coveredIds = [
      ...(prev?.coversMessageIds ?? []),
      ...messages.map((m) => m.id),
    ];
    return coerce(parsed, coveredIds);
  }
}
