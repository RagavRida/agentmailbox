import {
  Agent,
  AgentAddress,
  Mailbox,
  Message,
  ParticipantRole,
  Thread,
  ThreadSummary,
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

  // ---------- Compression cache ----------

  /**
   * Latest stored summary for a thread, or `null` when no compressor has
   * ever run on it. Callers compare `coversMessageIds` against the current
   * message list to decide whether the cache is stale.
   */
  getSummary(threadId: string): Promise<ThreadSummary | null>;

  /**
   * Persist (or overwrite) the latest summary for a thread. Idempotent —
   * always replaces the previous row for the same thread.
   */
  saveSummary(threadId: string, summary: ThreadSummary): Promise<void>;

  // ---------- Context Graph ----------

  /**
   * Insert or update a graph node. The node id is the primary key scoped
   * to agentId. `updatedAt` is set automatically by the adapter.
   */
  upsertNode(
    agentId: AgentAddress,
    node: Omit<GraphNode, "updatedAt">
  ): Promise<void>;

  /** Delete a graph node and all its connected edges (CASCADE). */
  deleteNode(agentId: AgentAddress, nodeId: string): Promise<void>;

  /** Insert or update a directed edge between two existing nodes. */
  addEdge(edge: GraphEdge): Promise<void>;

  /** Remove a specific edge. */
  deleteEdge(
    sourceId: string,
    targetId: string,
    type: string
  ): Promise<void>;

  /**
   * Keyword search on node name/description, then 2-hop graph traversal
   * to pull connected entities. Returns the matched nodes and all edges
   * within the traversal radius.
   */
  queryGraph(
    agentId: AgentAddress,
    query: string
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;

  // ---------- Codebase Index ----------

  /**
   * Insert or update an index entry. `updatedAt` is set automatically.
   * Agents call this incrementally as they touch files, discover symbols,
   * or make architectural decisions.
   */
  upsertIndex(
    agentId: AgentAddress,
    entry: Omit<CodebaseIndexEntry, "updatedAt">
  ): Promise<void>;

  /** Look up a specific index entry by key. Returns `null` when not found. */
  getIndex(
    agentId: AgentAddress,
    key: string
  ): Promise<CodebaseIndexEntry | null>;

  /**
   * Keyword search across all index entries for an agent. Optionally
   * filter by category. Returns entries whose key, summary, or metadata
   * contain the query terms.
   */
  searchIndex(
    agentId: AgentAddress,
    query: string,
    category?: string
  ): Promise<CodebaseIndexEntry[]>;

  /** Remove a single index entry. */
  deleteIndex(agentId: AgentAddress, key: string): Promise<void>;
}

// ---------- Context Graph types ----------

export type GraphNodeType =
  | "message"
  | "file"
  | "symbol"
  | "decision"
  | "task";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  description?: string;
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
}

// ---------- Codebase Index types ----------

export type IndexCategory =
  | "file"
  | "symbol"
  | "api"
  | "config"
  | "architecture";

export interface CodebaseIndexEntry {
  key: string;
  category: IndexCategory;
  summary: string;
  metadata: Record<string, unknown>;
  updatedAt: number;
}
