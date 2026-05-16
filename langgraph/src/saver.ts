import { os } from "./os-shim";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type ChannelVersions,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import { AgentMailbox } from "agentsmcp";
import type { ContextFrame, Message } from "agentsmcp";

import {
  CheckpointContext,
  CheckpointPayload,
  PendingWriteWire,
  WritesPayload,
} from "./types";
import { dumpToBase64, loadFromBase64, SerializedTyped } from "./serializer";

export interface AgentsmcpSaverOptions {
  /** Where the agentsmcp HTTP server lives. Defaults to env or localhost:3000. */
  server?: string;
  /**
   * Agent identity this saver writes as. Defaults to
   * `langgraph@<hostname>`. Use a stable id so threads persist across
   * process restarts.
   */
  agentId?: string;
  /** Bearer token forwarded to agentsmcp. Defaults to env. */
  apiKey?: string;
  /** Plug your own LangGraph serializer if you have a custom one. */
  serde?: SerializerProtocol;
}

/**
 * LangGraph BaseCheckpointSaver backed by an agentsmcp HTTP server.
 *
 * One LangGraph thread (`config.configurable.thread_id`) maps to one
 * agentsmcp thread. Every checkpoint and every batch of intermediate
 * writes becomes one message on that thread. Process restart resumes
 * by reading the thread.
 *
 * AgentsmcpSaver intentionally does not implement deterministic message
 * IDs — the agentsmcp server generates them. Instead the LangGraph
 * `checkpoint_id` is carried inside the payload and used as the
 * primary key on read.
 */
export class AgentsmcpSaver extends BaseCheckpointSaver {
  private readonly mail: AgentMailbox;
  private readonly agentId: string;
  private connected = false;
  /** langgraph thread_id → agentsmcp threadId (resolved lazily) */
  private readonly threadCache = new Map<string, string>();

  constructor(opts: AgentsmcpSaverOptions = {}) {
    super(opts.serde);
    const server =
      opts.server ??
      process.env.AGENTSMCP_SERVER ??
      process.env.AGENTMAILBOX_SERVER ??
      "http://localhost:3000";
    this.agentId =
      opts.agentId ??
      process.env.AGENTSMCP_AGENT_ID ??
      `langgraph@${os.hostname()}`;
    this.mail = new AgentMailbox({
      agentId: this.agentId,
      server,
      apiKey:
        opts.apiKey ??
        process.env.AGENTSMCP_API_KEY ??
        process.env.AGENTMAILBOX_API_KEY,
    });
  }

  /** Register this saver's agent identity with the server. Idempotent. */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.mail.connect();
    this.connected = true;
  }

  // ─────────────────────────────────────────────────────────────────
  // BaseCheckpointSaver surface
  // ─────────────────────────────────────────────────────────────────

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.connect();
    const thread_id = requireThreadId(config);
    const checkpoint_ns = (config.configurable?.checkpoint_ns as string) ?? "";
    const requested_id = config.configurable?.checkpoint_id as
      | string
      | undefined;

    const agentsmcpThreadId = await this.resolveThread(thread_id);
    if (!agentsmcpThreadId) return undefined;

    const messages = await this.mail.threads().then(async (threads) => {
      const t = threads.find((x) => x.id === agentsmcpThreadId);
      return t ? t.messages : [];
    });

    const checkpointMsgs = messages.filter(
      (m) => isCheckpointPayload(m.payload) && m.payload.checkpoint_ns === checkpoint_ns
    );

    let target = requested_id
      ? checkpointMsgs.find(
          (m) =>
            isCheckpointPayload(m.payload) &&
            m.payload.checkpoint_id === requested_id
        )
      : checkpointMsgs[checkpointMsgs.length - 1];

    if (!target) return undefined;
    return this.messageToTuple(target, messages, thread_id, checkpoint_ns);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    await this.connect();
    const thread_id = requireThreadId(config);
    const configured_ns = config.configurable?.checkpoint_ns as
      | string
      | undefined;

    const agentsmcpThreadId = await this.resolveThread(thread_id);
    if (!agentsmcpThreadId) return;

    const threads = await this.mail.threads();
    const t = threads.find((x) => x.id === agentsmcpThreadId);
    if (!t) return;
    const messages = t.messages;

    const checkpointMsgs = messages.filter(
      (m): m is Message & { payload: CheckpointPayload } => {
        if (!isCheckpointPayload(m.payload)) return false;
        if (configured_ns !== undefined && m.payload.checkpoint_ns !== configured_ns) {
          return false;
        }
        if (options?.before?.configurable?.checkpoint_id) {
          const cutoff = options.before.configurable.checkpoint_id as string;
          // LangGraph checkpoint_ids are uuid6 / lexicographically sortable.
          return m.payload.checkpoint_id < cutoff;
        }
        return true;
      }
    );

    // Newest first. agentsmcp returns messages timestamp-ascending.
    checkpointMsgs.reverse();

    const seenCheckpointIds = new Set<string>();
    let emitted = 0;
    for (const m of checkpointMsgs) {
      const cpId = m.payload.checkpoint_id;
      if (seenCheckpointIds.has(cpId)) continue; // dedupe repeated put
      seenCheckpointIds.add(cpId);

      if (options?.limit !== undefined && emitted >= options.limit) break;
      yield await this.messageToTuple(
        m,
        messages,
        thread_id,
        m.payload.checkpoint_ns
      );
      emitted += 1;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    await this.connect();
    const thread_id = requireThreadId(config);
    const checkpoint_ns = (config.configurable?.checkpoint_ns as string) ?? "";
    const parent_checkpoint_id = config.configurable?.checkpoint_id as
      | string
      | undefined;

    const checkpointBlob = await dumpToBase64(this.serde, checkpoint);
    const metadataBlob = await dumpToBase64(this.serde, metadata);

    const payload: CheckpointPayload = {
      kind: "checkpoint",
      checkpoint: checkpointBlob.data,
      metadata: metadataBlob.data,
      checkpoint_ns,
      checkpoint_id: checkpoint.id,
      parent_checkpoint_id,
    };
    // Stash the serializer type tags alongside in contextSnapshot so we
    // can round-trip without hardcoding "json".
    const ctx: CheckpointContext & {
      _checkpoint_type: string;
      _metadata_type: string;
    } = {
      checkpoint_id: checkpoint.id,
      checkpoint_ns,
      thread_id,
      step: (metadata.step as number | undefined) ?? -1,
      source: (metadata.source as string | undefined) ?? "input",
      _checkpoint_type: checkpointBlob.type,
      _metadata_type: metadataBlob.type,
    };

    const existing = this.threadCache.get(thread_id);
    const sendResult = await this.mail.send(
      syntheticRecipient(thread_id),
      payload,
      {
        threadId: existing,
        contextSnapshot: ctx,
      }
    );
    this.threadCache.set(thread_id, sendResult.threadId);

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await this.connect();
    const thread_id = requireThreadId(config);
    const checkpoint_ns = (config.configurable?.checkpoint_ns as string) ?? "";
    const checkpoint_id = config.configurable?.checkpoint_id as
      | string
      | undefined;
    if (!checkpoint_id) {
      throw new Error(
        "AgentsmcpSaver.putWrites: config.configurable.checkpoint_id is required"
      );
    }

    const wireWrites: PendingWriteWire[] = await Promise.all(
      writes.map(async ([channel, value]) => {
        const blob = await dumpToBase64(this.serde, value);
        return { taskId, channel, value: blob.data, type: blob.type };
      })
    );

    const payload: WritesPayload = {
      kind: "writes",
      checkpoint_id,
      checkpoint_ns,
      writes: wireWrites,
    };

    const existing = this.threadCache.get(thread_id);
    const sendResult = await this.mail.send(
      syntheticRecipient(thread_id),
      payload,
      {
        threadId: existing,
        contextSnapshot: { kind: "writes", checkpoint_id, taskId, checkpoint_ns },
      }
    );
    this.threadCache.set(thread_id, sendResult.threadId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Look up the agentsmcp threadId for a given LangGraph thread_id.
   * Hits the cache first; falls back to a thread listing on first call
   * after a process restart.
   */
  private async resolveThread(
    langgraphThreadId: string
  ): Promise<string | undefined> {
    const cached = this.threadCache.get(langgraphThreadId);
    if (cached) return cached;
    const recipient = syntheticRecipient(langgraphThreadId);
    const threads = await this.mail.threads();
    const match = threads.find(
      (t) =>
        t.participants.includes(recipient) ||
        t.silentParticipants.includes(recipient)
    );
    if (match) {
      this.threadCache.set(langgraphThreadId, match.id);
      return match.id;
    }
    return undefined;
  }

  private async messageToTuple(
    checkpointMsg: Message,
    allMessages: Message[],
    thread_id: string,
    checkpoint_ns: string
  ): Promise<CheckpointTuple> {
    if (!isCheckpointPayload(checkpointMsg.payload)) {
      throw new Error("messageToTuple called with non-checkpoint message");
    }
    const cp = checkpointMsg.payload;
    const ctx = checkpointMsg.contextSnapshot as CheckpointContext & {
      _checkpoint_type: string;
      _metadata_type: string;
    };
    const checkpoint = await loadFromBase64<Checkpoint>(this.serde, {
      type: ctx._checkpoint_type ?? "json",
      data: cp.checkpoint,
    });
    const metadata = await loadFromBase64<CheckpointMetadata>(this.serde, {
      type: ctx._metadata_type ?? "json",
      data: cp.metadata,
    });

    // Merge any writes messages that came AFTER this checkpoint message
    // but before the next checkpoint message on the same ns. Those are
    // this checkpoint's pendingWrites.
    const idx = allMessages.findIndex((m) => m.id === checkpointMsg.id);
    const pendingWrites: CheckpointPendingWrite[] = [];
    for (let i = idx + 1; i < allMessages.length; i++) {
      const m = allMessages[i];
      if (isCheckpointPayload(m.payload)) {
        if (m.payload.checkpoint_ns === cp.checkpoint_ns) break;
        continue;
      }
      if (
        isWritesPayload(m.payload) &&
        m.payload.checkpoint_id === cp.checkpoint_id &&
        m.payload.checkpoint_ns === cp.checkpoint_ns
      ) {
        for (const w of m.payload.writes) {
          const value = await loadFromBase64(this.serde, {
            type: w.type,
            data: w.value,
          });
          pendingWrites.push([w.taskId, w.channel, value]);
        }
      }
    }

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id,
          checkpoint_ns: cp.checkpoint_ns,
          checkpoint_id: cp.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (cp.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id,
          checkpoint_ns: cp.checkpoint_ns,
          checkpoint_id: cp.parent_checkpoint_id,
        },
      };
    }
    return tuple;
  }
}

// ───────────────────────────────────────────────────────────────────
// Module-private helpers
// ───────────────────────────────────────────────────────────────────

function syntheticRecipient(threadId: string): string {
  return `${threadId}@checkpoints`;
}

function requireThreadId(config: RunnableConfig): string {
  const id = config.configurable?.thread_id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      "config.configurable.thread_id is required for AgentsmcpSaver"
    );
  }
  return id;
}

function isCheckpointPayload(p: unknown): p is CheckpointPayload {
  return (
    typeof p === "object" &&
    p !== null &&
    (p as { kind?: unknown }).kind === "checkpoint"
  );
}

function isWritesPayload(p: unknown): p is WritesPayload {
  return (
    typeof p === "object" &&
    p !== null &&
    (p as { kind?: unknown }).kind === "writes"
  );
}

// Avoid an unused-symbol lint when ContextFrame import resolves to a
// type that vitest's strict isolatedModules check can't see in this
// file. Keep the import for downstream type compatibility.
export type { ContextFrame };
