import { Message, ThreadSummary } from "../types";
import { Compressor } from "./interface";

/**
 * Default compressor. Returns an empty summary. The cache layer still
 * records that "messages up to id X have been considered" so callers can
 * distinguish "uncompressed because Noop" from "needs compression."
 */
export class NoopCompressor implements Compressor {
  async compress(messages: Message[]): Promise<ThreadSummary> {
    return {
      text: "",
      decisions: [],
      openQuestions: [],
      artifacts: {},
      coversMessageIds: messages.map((m) => m.id),
      generatedAt: Date.now(),
    };
  }
}
