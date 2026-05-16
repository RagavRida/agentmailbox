import { Message, ThreadSummary } from "../types";
import { Compressor } from "./interface";

export interface OpenAICompressorOptions {
  /**
   * OpenAI API key. Falls back to `OPENAI_API_KEY` env var. If neither
   * is set, the compressor throws on first call.
   */
  apiKey?: string;
  /**
   * Model to use. Defaults to `gpt-4o-mini` — fast, cheap, and reliable
   * for the structured-extraction task. Override for `gpt-4o` if you
   * need higher quality on long, technical threads.
   */
  model?: string;
  /**
   * Pre-constructed OpenAI client. Lets callers reuse a single client,
   * point at a different base URL (e.g. Azure OpenAI, an OpenAI-compatible
   * gateway), or inject a mock in tests. When omitted, the compressor
   * lazily requires `openai` and instantiates one on first use.
   */
  client?: OpenAILike;
  /** Max output tokens. Defaults to 1024. */
  maxTokens?: number;
}

interface OpenAILike {
  chat: {
    completions: {
      create(req: unknown): Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

const SYSTEM_PROMPT = `You compress a multi-agent conversation into a structured summary.

Return STRICT JSON only, matching this schema:
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
    parsed.artifacts &&
    typeof parsed.artifacts === "object" &&
    !Array.isArray(parsed.artifacts)
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

export class OpenAICompressor implements Compressor {
  private readonly model: string;
  private readonly maxTokens: number;
  private clientPromise?: Promise<OpenAILike>;
  private readonly apiKey?: string;
  private readonly explicitClient?: OpenAILike;

  constructor(opts: OpenAICompressorOptions = {}) {
    this.model = opts.model ?? "gpt-4o-mini";
    this.maxTokens = opts.maxTokens ?? 1024;
    this.apiKey = opts.apiKey;
    this.explicitClient = opts.client;
  }

  private async getClient(): Promise<OpenAILike> {
    if (this.explicitClient) return this.explicitClient;
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      let mod: { default?: new (cfg: unknown) => OpenAILike } & {
        OpenAI?: new (cfg: unknown) => OpenAILike;
      };
      try {
        mod = (await import("openai")) as typeof mod;
      } catch {
        throw new Error(
          "OpenAICompressor requires the openai package. " +
            "Install it with: npm install openai"
        );
      }
      const Ctor = mod.default ?? mod.OpenAI;
      if (!Ctor) {
        throw new Error("openai did not export an OpenAI constructor");
      }
      const apiKey = this.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "OPENAI_API_KEY is not set. Pass apiKey to OpenAICompressor or set the env var."
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

    const res = await client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const raw = res.choices[0]?.message?.content ?? "";
    let parsed: ParsedSummary = {};
    try {
      parsed = JSON.parse(raw) as ParsedSummary;
    } catch {
      // json_object mode usually guarantees valid JSON, but be defensive.
      parsed = {};
    }

    const coveredIds = [
      ...(prev?.coversMessageIds ?? []),
      ...messages.map((m) => m.id),
    ];
    return coerce(parsed, coveredIds);
  }
}
