/**
 * Wire shapes the checkpointer writes into agentsmcp messages.
 *
 * Two kinds of messages live on the underlying thread:
 *  - kind="checkpoint" — a full LangGraph checkpoint snapshot
 *  - kind="writes"     — intermediate writes (putWrites) that get
 *                        merged into the next checkpoint's pendingWrites
 *
 * Both are tagged so getTuple/list can filter without ambiguity.
 */

export interface CheckpointPayload {
  kind: "checkpoint";
  /** base64-encoded bytes from the LangGraph serializer */
  checkpoint: string;
  /** base64-encoded CheckpointMetadata bytes */
  metadata: string;
  /** "" for the root graph, "sub:name" for subgraphs */
  checkpoint_ns: string;
  /** LangGraph's checkpoint id (uuid6) — distinct from agentsmcp message id */
  checkpoint_id: string;
  /** id of the previous checkpoint on this thread/ns; undefined for the first */
  parent_checkpoint_id?: string;
}

export interface PendingWriteWire {
  taskId: string;
  channel: string;
  /** base64-encoded value bytes */
  value: string;
  /** LangGraph's value type tag returned by the serializer */
  type: string;
}

export interface WritesPayload {
  kind: "writes";
  /** which checkpoint these writes belong to */
  checkpoint_id: string;
  checkpoint_ns: string;
  writes: PendingWriteWire[];
}

/** Shape stored in agentsmcp's contextSnapshot for each checkpoint message. */
export interface CheckpointContext extends Record<string, unknown> {
  checkpoint_id: string;
  checkpoint_ns: string;
  thread_id: string;
  step: number;
  source: string;
}
