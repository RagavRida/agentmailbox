export type AgentAddress = string;

export interface Agent {
  id: AgentAddress;
  createdAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  from: AgentAddress;
  to: AgentAddress;
  cc?: AgentAddress[];
  bcc?: AgentAddress[];
  replyTo?: AgentAddress;
  payload: unknown;
  contextSnapshot: Record<string, unknown>;
  timestamp: number;
}

export interface ThreadSummary {
  /**
   * Prose summary suitable for inclusion verbatim in an LLM prompt. When a
   * compressor returns a structured summary, this is its serialized form.
   */
  text: string;
  /** "X chose approach Y because Z" — load-bearing choices from the thread. */
  decisions: string[];
  /** Threads of conversation that were raised but not resolved. */
  openQuestions: string[];
  /** Named entities the thread keeps referring back to (paper ids, file paths, ...). */
  artifacts: Record<string, unknown>;
  /**
   * Message ids this summary covers. Used to detect staleness — if newer
   * messages aren't in this set, the summary is out of date.
   */
  coversMessageIds: string[];
  /** Wall-clock time the summary was produced. */
  generatedAt: number;
}

export interface ThreadContext {
  snapshot: Record<string, unknown>;
  /**
   * Prose summary of older messages. Empty string when no compression has
   * run yet (e.g. NoopCompressor or thread under the compression threshold).
   * For structured access prefer {@link ThreadContext.threadSummaryStructured}.
   */
  threadSummary: string;
  /**
   * Structured summary, populated when a compressor has run on this thread.
   * Undefined when no summary exists (zero-config installs, short threads).
   */
  threadSummaryStructured?: ThreadSummary;
  recentMessages: Message[];
  tokenCount: number;
}

export interface ContextFrame {
  id: string;
  threadId: string;
  from: AgentAddress;
  to: AgentAddress;
  cc?: AgentAddress[];
  bcc?: AgentAddress[];
  replyTo?: AgentAddress;
  timestamp: number;
  payload: unknown;
  context: ThreadContext;
}

export interface Thread {
  id: string;
  participants: AgentAddress[];
  silentParticipants: AgentAddress[];
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface Mailbox {
  agentId: AgentAddress;
  threads: string[];
  unreadCount: number;
}

export interface SendOptions {
  threadId?: string;
  contextSnapshot?: Record<string, unknown>;
  cc?: AgentAddress[];
  bcc?: AgentAddress[];
  replyTo?: AgentAddress;
}

export interface ReceiveResult {
  messages: ContextFrame[];
  context: {
    snapshot: Record<string, unknown>;
    threadSummary: string;
    recentMessages: Message[];
  };
}

export interface ParticipantRole {
  agentId: AgentAddress;
  role: "to" | "cc" | "bcc";
  joinedAt: number;
}
