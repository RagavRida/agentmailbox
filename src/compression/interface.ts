import { Message, ThreadSummary } from "../types";

/**
 * Folds an arbitrary span of messages into a {@link ThreadSummary}. Used by
 * {@link assembleContext} to keep older messages out of the verbatim window
 * without losing their load-bearing content (decisions, open questions,
 * referenced artifacts).
 *
 * Implementations:
 *  - {@link NoopCompressor} — default, returns an empty summary. Keeps
 *    zero-config installs working without any LLM dependency.
 *  - {@link ClaudeCompressor} — uses Claude Haiku via `@anthropic-ai/sdk`.
 *
 * Adapter authors: `compress` may receive the previous summary (when one
 * already covers a prefix of the messages) so you can extend it in place
 * instead of regenerating from scratch.
 */
export interface Compressor {
  compress(
    messages: Message[],
    prev?: ThreadSummary
  ): Promise<ThreadSummary>;
}
