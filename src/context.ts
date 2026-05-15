import { Compressor } from "./compression";
import { Storage } from "./storage";
import { Message, ThreadContext, ThreadSummary } from "./types";

const RECENT_LIMIT = 10;
const DEFAULT_COMPRESSION_THRESHOLD = 20;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function summarizePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export interface AssembleOptions {
  /**
   * Required to cache compression results. When omitted, compression still
   * runs (if a compressor is provided) but the result is not persisted —
   * every read pays for it. In practice always pass both together.
   */
  threadId?: string;
  storage?: Storage;
  compressor?: Compressor;
  /**
   * Compress only once `messages.length - RECENT_LIMIT` exceeds this number
   * of *uncovered* older messages. Defaults to 20.
   */
  compressionThreshold?: number;
}

function fallbackSummaryText(older: Message[]): string {
  return older
    .map(
      (m) =>
        `[${new Date(m.timestamp).toISOString()}] ${m.from} → ${m.to}: ` +
        summarizePayload(m.payload)
    )
    .join("\n");
}

/**
 * Build a {@link ThreadContext} from a thread's messages. When a compressor
 * and storage are provided, older messages beyond the verbatim window are
 * folded into a structured {@link ThreadSummary} (with caching). Without
 * those, falls back to a timestamped one-line concatenation of older
 * messages — fine for short threads, useless at scale.
 */
export async function assembleContext(
  messages: Message[],
  opts: AssembleOptions = {}
): Promise<ThreadContext> {
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const recentMessages = sorted.slice(-RECENT_LIMIT);
  const olderMessages = sorted.slice(0, Math.max(0, sorted.length - RECENT_LIMIT));

  const last = sorted[sorted.length - 1];
  const snapshot: Record<string, unknown> = last ? { ...last.contextSnapshot } : {};

  let structured: ThreadSummary | undefined;
  let summaryText = "";

  const { compressor, storage, threadId, compressionThreshold } = opts;
  const threshold = compressionThreshold ?? DEFAULT_COMPRESSION_THRESHOLD;

  if (compressor && olderMessages.length > 0) {
    const prev =
      storage && threadId ? await storage.getSummary(threadId) : null;
    const covered = new Set(prev?.coversMessageIds ?? []);
    const uncovered = olderMessages.filter((m) => !covered.has(m.id));

    if (uncovered.length >= threshold) {
      structured = await compressor.compress(uncovered, prev ?? undefined);
      if (storage && threadId) {
        await storage.saveSummary(threadId, structured);
      }
    } else if (prev) {
      structured = prev;
    }

    summaryText = structured?.text ?? "";
  } else if (olderMessages.length > 0) {
    // Legacy path: no compressor configured. Preserve previous behavior
    // (timestamped one-liner concatenation) so existing callers don't
    // regress in output shape.
    summaryText = fallbackSummaryText(olderMessages);
  }

  const serializedRecent = recentMessages
    .map((m) => summarizePayload(m.payload))
    .join("\n");
  const tokenCount = estimateTokens(summaryText + "\n" + serializedRecent);

  const ctx: ThreadContext = {
    snapshot,
    threadSummary: summaryText,
    recentMessages,
    tokenCount,
  };
  if (structured) ctx.threadSummaryStructured = structured;
  return ctx;
}
