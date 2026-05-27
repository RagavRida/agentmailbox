import {
  AgentAddress,
  ContextFrame,
  Message,
  ParticipantRole,
  ReceiveResult,
  SendOptions,
  Thread,
  ThreadSummary,
} from "./types";
import type {
  CodebaseIndexEntry,
  GraphEdge,
  GraphNode,
} from "./storage/interface";

export interface AgentMailboxConfig {
  agentId: AgentAddress;
  server?: string;
  apiKey?: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  deliveredTo: AgentAddress[];
}

export class AgentMailbox {
  private agentId: AgentAddress;
  private server: string;
  private apiKey?: string;

  constructor(config: AgentMailboxConfig) {
    if (!config.agentId) throw new Error("agentId is required");
    this.agentId = config.agentId;
    this.server = (config.server ?? "http://localhost:3000").replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.server}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AgentMailbox ${method} ${path} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  async connect(): Promise<void> {
    await this.request<{ agentId: string; created: boolean }>(
      "POST",
      "/agents/register",
      { agentId: this.agentId }
    );
  }

  async send(
    to: AgentAddress,
    payload: unknown,
    options: SendOptions = {}
  ): Promise<SendResult> {
    return this.request<SendResult>("POST", "/messages/send", {
      from: this.agentId,
      to,
      payload,
      contextSnapshot: options.contextSnapshot,
      threadId: options.threadId,
      cc: options.cc,
      bcc: options.bcc,
      replyTo: options.replyTo,
    });
  }

  async replyAll(
    threadId: string,
    payload: unknown,
    options: { contextSnapshot?: Record<string, unknown> } = {}
  ): Promise<SendResult> {
    return this.request<SendResult>("POST", "/messages/reply-all", {
      from: this.agentId,
      threadId,
      payload,
      contextSnapshot: options.contextSnapshot,
    });
  }

  async receive(from?: AgentAddress): Promise<ReceiveResult> {
    const { messages } = await this.request<{ messages: ContextFrame[] }>(
      "GET",
      `/mailbox/${encodeURIComponent(this.agentId)}/unread`
    );
    const filtered = from ? messages.filter((m) => m.from === from) : messages;

    const last = filtered[filtered.length - 1];
    // Spread (not field-list) so any new optional field added to
    // ThreadContext flows through without another SDK fix. The same
    // pattern bit us three times in 0.3.0–0.3.2.
    const context: ReceiveResult["context"] = last
      ? { ...last.context }
      : {
          snapshot: {},
          threadSummary: "",
          recentMessages: [] as Message[],
        };

    return { messages: filtered, context };
  }

  async unread(): Promise<ContextFrame[]> {
    const { messages } = await this.request<{ messages: ContextFrame[] }>(
      "GET",
      `/mailbox/${encodeURIComponent(this.agentId)}/unread`
    );
    return messages;
  }

  async sync(threadId: string): Promise<{
    context: {
      snapshot: Record<string, unknown>;
      threadSummary: string;
      threadSummaryStructured?: ThreadSummary;
      recentMessages: Message[];
      tokenCount?: number;
    };
  }> {
    return this.request<{
      context: {
        snapshot: Record<string, unknown>;
        threadSummary: string;
        threadSummaryStructured?: ThreadSummary;
        recentMessages: Message[];
        tokenCount?: number;
      };
    }>(
      "GET",
      `/threads/${encodeURIComponent(threadId)}/sync?as=${encodeURIComponent(
        this.agentId
      )}`
    );
  }

  async threads(): Promise<Thread[]> {
    const { threads } = await this.request<{
      threads: Thread[];
      unreadCount: number;
    }>("GET", `/mailbox/${encodeURIComponent(this.agentId)}`);
    return threads;
  }

  async participants(threadId: string): Promise<ParticipantRole[]> {
    const { participants } = await this.request<{
      participants: ParticipantRole[];
    }>(
      "GET",
      `/threads/${encodeURIComponent(threadId)}/participants?as=${encodeURIComponent(
        this.agentId
      )}`
    );
    return participants;
  }

  async markRead(threadId: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/read`,
      { threadId }
    );
  }

  // ---------- Context Graph ----------

  async upsertNode(
    node: Omit<GraphNode, "updatedAt">
  ): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/graph/nodes`,
      node
    );
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/graph/edges`,
      edge
    );
  }

  async queryGraph(
    query: string
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return this.request<{ nodes: GraphNode[]; edges: GraphEdge[] }>(
      "GET",
      `/mailbox/${encodeURIComponent(this.agentId)}/graph/query?q=${encodeURIComponent(query)}`
    );
  }

  // ---------- Codebase Index ----------

  async upsertIndex(
    entry: Omit<CodebaseIndexEntry, "updatedAt">
  ): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/index`,
      entry
    );
  }

  async getIndex(key: string): Promise<CodebaseIndexEntry | null> {
    try {
      return await this.request<CodebaseIndexEntry>(
        "GET",
        `/mailbox/${encodeURIComponent(this.agentId)}/index/${encodeURIComponent(key)}`
      );
    } catch {
      return null;
    }
  }

  async searchIndex(
    query: string,
    category?: string
  ): Promise<CodebaseIndexEntry[]> {
    let path = `/mailbox/${encodeURIComponent(this.agentId)}/index?q=${encodeURIComponent(query)}`;
    if (category) path += `&category=${encodeURIComponent(category)}`;
    const res = await this.request<{ entries: CodebaseIndexEntry[] }>(
      "GET",
      path
    );
    return res.entries;
  }
}

export * from "./types";
export { assembleContext } from "./context";
export type {
  GraphNode,
  GraphEdge,
  GraphNodeType,
  CodebaseIndexEntry,
  IndexCategory,
} from "./storage/interface";
