import {
  Agent,
  AgentAddress,
  Mailbox,
  Message,
  ParticipantRole,
  Thread,
} from "../types";

/**
 * Options accepted by {@link createStorage}. Today only `url` is consumed;
 * the object form is reserved so adapter-specific knobs (pool size, logger,
 * timeouts) can be added later without another breaking change.
 */
export interface StorageOptions {
  url: string;
}

/**
 * Persistence backend for AgentMailbox.
 *
 * All methods are async so adapters that talk to a network-bound database
 * (Postgres, Redis, ...) can share the same surface as SQLite without
 * forcing a second breaking change later.
 *
 * Error model:
 *   - Getters that look up a single record return `null` when missing.
 *   - All other failures reject (invalid input, I/O error, constraint).
 *
 * Adapter authors: every method should be safe to invoke concurrently from
 * different async tasks. `appendMessage` must be atomic — partial fan-out
 * across messages / threads / mailboxes is a bug.
 */
export interface Storage {
  /**
   * Create tables, indexes, and any other one-time schema. Safe to call
   * multiple times — adapters MUST make this idempotent.
   */
  init(): Promise<void>;

  /** Release underlying connections / file handles. */
  close(): Promise<void>;

  // ---------- Agents ----------

  /** Insert if absent. Returns the existing agent if one is already registered. */
  registerAgent(agentId: AgentAddress): Promise<Agent>;

  /** Returns `null` when no agent with this id exists. */
  getAgent(agentId: AgentAddress): Promise<Agent | null>;

  // ---------- Threads ----------

  createThread(
    participants: AgentAddress[],
    silentParticipants?: AgentAddress[]
  ): Promise<Thread>;

  /** Returns `null` when the thread does not exist. */
  getThread(threadId: string): Promise<Thread | null>;

  /** Convenience for the 2-agent case; returns `null` if no such thread. */
  getThreadByParticipants(
    a: AgentAddress,
    b: AgentAddress
  ): Promise<Thread | null>;

  /** Order-independent participant lookup; returns `null` when not found. */
  getThreadByParticipantSet(
    participants: AgentAddress[]
  ): Promise<Thread | null>;

  /**
   * Roles inferred from message history (to > cc > bcc priority).
   * Returns `[]` when the thread does not exist.
   */
  getThreadParticipants(threadId: string): Promise<ParticipantRole[]>;

  // ---------- Messages ----------

  /**
   * Append a message, update the thread's participant sets, and fan out
   * unread counts to every recipient (TO + CC + BCC, excluding sender).
   * Atomic — either every side effect lands or none does.
   */
  appendMessage(threadId: string, message: Message): Promise<void>;

  /** All messages on a thread, in timestamp ascending order. */
  getMessages(threadId: string): Promise<Message[]>;

  // ---------- Mailbox ----------

  /** Returns an empty mailbox shape when the agent has no threads yet. */
  getMailbox(agentId: AgentAddress): Promise<Mailbox>;

  /** Idempotent. No-op when the agent has no row for the thread. */
  markRead(agentId: AgentAddress, threadId: string): Promise<void>;

  /** Unread messages where the agent is TO, CC, or BCC (and not the sender). */
  getUnread(agentId: AgentAddress): Promise<Message[]>;
}
