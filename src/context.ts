import { Message, ThreadContext } from "./types";

const RECENT_LIMIT = 10;

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

export function assembleContext(messages: Message[]): ThreadContext {
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const recentMessages = sorted.slice(-RECENT_LIMIT);
  const olderMessages = sorted.slice(0, Math.max(0, sorted.length - RECENT_LIMIT));

  const threadSummary = olderMessages
    .map((m) => `[${new Date(m.timestamp).toISOString()}] ${m.from} → ${m.to}: ${summarizePayload(m.payload)}`)
    .join("\n");

  const last = sorted[sorted.length - 1];
  const snapshot: Record<string, unknown> = last ? { ...last.contextSnapshot } : {};

  const serializedRecent = recentMessages
    .map((m) => summarizePayload(m.payload))
    .join("\n");
  const tokenCount = estimateTokens(threadSummary + "\n" + serializedRecent);

  return {
    snapshot,
    threadSummary,
    recentMessages,
    tokenCount,
  };
}
