import { z, ZodTypeAny } from "zod";
// The recursive JsonValue schema explodes zod-to-json-schema's generic
// inference (TS2589). Erase the type at the import boundary; the returned
// shape is a JSON Schema object which we expose as Record<string, unknown>.
import { zodToJsonSchema as _raw } from "zod-to-json-schema";
const _zodToJsonSchema = _raw as (s: unknown, opts?: unknown) => unknown;
import type { AgentMailbox } from "../agentmailbox";

const toJsonSchema = (s: ZodTypeAny): Record<string, unknown> =>
  _zodToJsonSchema(s, { target: "openApi3" }) as Record<string, unknown>;

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(JsonValue),
  ])
);

const SendInput = z.object({
  to: z.string().min(1).describe("Recipient agent id"),
  payload: JsonValue.describe("Arbitrary JSON payload"),
  threadId: z.string().optional(),
  contextSnapshot: z.record(JsonValue).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.string().optional(),
});

const ReceiveInput = z.object({
  from: z.string().optional().describe("Filter to messages from this sender"),
});

const EmptyInput = z.object({}).strict();

const ThreadIdInput = z.object({
  threadId: z.string().min(1),
});

const ReplyAllInput = z.object({
  threadId: z.string().min(1),
  payload: JsonValue,
  contextSnapshot: z.record(JsonValue).optional(),
});

const MarkReadInput = z.object({
  threadId: z.string().min(1),
});

const UpsertNodeInput = z.object({
  id: z.string().min(1).describe("Unique node id, e.g. 'file:src/auth.ts' or 'decision:use-jwt'"),
  type: z.enum(["message", "file", "symbol", "decision", "task"]).describe("Node type"),
  name: z.string().min(1).describe("Human-readable name"),
  description: z.string().optional().describe("Short summary of this node"),
  metadata: z.record(JsonValue).optional().describe("Arbitrary JSON metadata"),
});

const AddEdgeInput = z.object({
  sourceId: z.string().min(1).describe("Source node id"),
  targetId: z.string().min(1).describe("Target node id"),
  type: z.string().min(1).describe("Edge type: references, contains, resolves, depends_on, semantic"),
  weight: z.number().optional().describe("Edge weight (default 1.0)"),
});

const QueryGraphInput = z.object({
  query: z.string().min(1).describe("Search keywords to match against node names and descriptions"),
});

const UpsertIndexInput = z.object({
  key: z.string().min(1).describe("Unique key, e.g. 'file:src/server.ts' or 'api:POST /messages/send'"),
  category: z.enum(["file", "symbol", "api", "config", "architecture"]).describe("Entry category"),
  summary: z.string().min(1).describe("200-token max summary of this entry"),
  metadata: z.record(JsonValue).optional().describe("Arbitrary JSON metadata (exports, imports, line count, etc.)"),
});

const GetIndexInput = z.object({
  key: z.string().min(1).describe("The exact key to look up"),
});

const SearchIndexInput = z.object({
  query: z.string().min(1).describe("Search keywords"),
  category: z.enum(["file", "symbol", "api", "config", "architecture"]).optional().describe("Optional category filter"),
});

const ContextBriefingInput = z.object({
  task: z.string().min(1).describe("Description of the task you're about to work on"),
  include_threads: z.boolean().optional().describe("If true, include recent thread context in the briefing (default false)"),
});

type ToolHandler = (agent: AgentMailbox, args: unknown) => Promise<unknown>;

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: ToolHandler;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: "agentsmcp_send",
    description:
      "Send a message to another agent. Auto-creates a thread if none exists " +
      "between sender and recipient. Use cc for active participants, bcc for " +
      "silent ones. contextSnapshot captures your current state so the " +
      "recipient can pick up cold.",
    schema: SendInput,
    handler: async (agent, raw) => {
      const args = SendInput.parse(raw);
      return agent.send(args.to, args.payload, {
        threadId: args.threadId,
        contextSnapshot: args.contextSnapshot,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.replyTo,
      });
    },
  },
  {
    name: "agentsmcp_receive",
    description:
      "Get unread messages addressed to this agent, with full thread context " +
      "attached to each. Use this at the start of a turn to pick up cold.",
    schema: ReceiveInput,
    handler: async (agent, raw) => {
      const args = ReceiveInput.parse(raw);
      return agent.receive(args.from);
    },
  },
  {
    name: "agentsmcp_unread",
    description: "List unread context frames without consuming them.",
    schema: EmptyInput,
    handler: async (agent, raw) => {
      EmptyInput.parse(raw ?? {});
      return agent.unread();
    },
  },
  {
    name: "agentsmcp_sync",
    description:
      "Rejoin a thread with full assembled context (snapshot + recent 10 " +
      "messages verbatim + summary of older ones). Use after a restart or " +
      "when picking up a stale thread.",
    schema: ThreadIdInput,
    handler: async (agent, raw) => {
      const { threadId } = ThreadIdInput.parse(raw);
      const { context } = await agent.sync(threadId);
      return context;
    },
  },
  {
    name: "agentsmcp_threads",
    description: "List all threads this agent is part of.",
    schema: EmptyInput,
    handler: async (agent, raw) => {
      EmptyInput.parse(raw ?? {});
      return agent.threads();
    },
  },
  {
    name: "agentsmcp_mark_read",
    description: "Mark a thread as read for this agent.",
    schema: MarkReadInput,
    handler: async (agent, raw) => {
      const { threadId } = MarkReadInput.parse(raw);
      await agent.markRead(threadId);
      return { ok: true };
    },
  },
  {
    name: "agentsmcp_reply_all",
    description:
      "Reply to every visible participant on a thread (excluding the sender " +
      "and BCC'd agents).",
    schema: ReplyAllInput,
    handler: async (agent, raw) => {
      const args = ReplyAllInput.parse(raw);
      return agent.replyAll(args.threadId, args.payload, {
        contextSnapshot: args.contextSnapshot,
      });
    },
  },
  {
    name: "agentsmcp_participants",
    description:
      "List visible participants on a thread with their roles (to/cc/bcc). " +
      "BCC participants are only shown if this agent bcc'd them.",
    schema: ThreadIdInput,
    handler: async (agent, raw) => {
      const { threadId } = ThreadIdInput.parse(raw);
      return agent.participants(threadId);
    },
  },

  // ---------- Context Graph ----------

  {
    name: "agentsmcp_upsert_node",
    description:
      "Register a context graph node (file, symbol, decision, task, or message). " +
      "Call this when you create/modify files, implement symbols, make design " +
      "decisions, or track tasks. The node persists across sessions so future " +
      "agents can query it instead of re-reading raw files.",
    schema: UpsertNodeInput,
    handler: async (agent, raw) => {
      const args = UpsertNodeInput.parse(raw);
      await agent.upsertNode({
        id: args.id,
        type: args.type,
        name: args.name,
        description: args.description,
        metadata: (args.metadata ?? {}) as Record<string, unknown>,
      });
      return { ok: true, nodeId: args.id };
    },
  },
  {
    name: "agentsmcp_add_edge",
    description:
      "Connect two graph nodes with a typed, directed edge. Edge types: " +
      "references (message→file), contains (file→symbol), resolves " +
      "(symbol→task), depends_on (symbol→symbol), semantic (any→any).",
    schema: AddEdgeInput,
    handler: async (agent, raw) => {
      const args = AddEdgeInput.parse(raw);
      await agent.addEdge({
        sourceId: args.sourceId,
        targetId: args.targetId,
        type: args.type,
        weight: args.weight ?? 1.0,
      });
      return { ok: true };
    },
  },
  {
    name: "agentsmcp_query_graph",
    description:
      "Search the context graph by keywords and return matching nodes plus " +
      "all nodes reachable within 2 hops. Use this INSTEAD of grepping and " +
      "reading files — it returns structured context (files, symbols, " +
      "decisions, tasks) with their relationships.",
    schema: QueryGraphInput,
    handler: async (agent, raw) => {
      const { query } = QueryGraphInput.parse(raw);
      return agent.queryGraph(query);
    },
  },

  // ---------- Codebase Index ----------

  {
    name: "agentsmcp_upsert_index",
    description:
      "Register a codebase index entry (file summary, symbol summary, API " +
      "contract, config description, or architecture note). Call this when " +
      "you finish working on a file to persist a ~200-token summary so " +
      "future agents can look it up instead of reading the full file.",
    schema: UpsertIndexInput,
    handler: async (agent, raw) => {
      const args = UpsertIndexInput.parse(raw);
      await agent.upsertIndex({
        key: args.key,
        category: args.category,
        summary: args.summary,
        metadata: (args.metadata ?? {}) as Record<string, unknown>,
      });
      return { ok: true, key: args.key };
    },
  },
  {
    name: "agentsmcp_get_index",
    description:
      "Look up a specific codebase index entry by key. Use this INSTEAD of " +
      "reading an entire file when you just need to know what a file does, " +
      "what it exports, or its role in the architecture.",
    schema: GetIndexInput,
    handler: async (agent, raw) => {
      const { key } = GetIndexInput.parse(raw);
      const entry = await agent.getIndex(key);
      if (!entry) return { found: false };
      return { found: true, ...entry };
    },
  },
  {
    name: "agentsmcp_search_index",
    description:
      "Search the codebase index by keywords, optionally filtered by " +
      "category. Use this INSTEAD of grepping the codebase — it returns " +
      "concise summaries of matching files, symbols, and APIs.",
    schema: SearchIndexInput,
    handler: async (agent, raw) => {
      const args = SearchIndexInput.parse(raw);
      return agent.searchIndex(args.query, args.category);
    },
  },

  // ---------- Context Briefing ----------

  {
    name: "agentsmcp_context_briefing",
    description:
      "Get a targeted context briefing for a task. Combines graph query + " +
      "index search into a single payload with relevant files, decisions, " +
      "tasks, and symbols. Call this at the START of any task instead of " +
      "manually reading files. Set include_threads=true to also include " +
      "recent thread context (increases payload size).",
    schema: ContextBriefingInput,
    handler: async (agent, raw) => {
      const args = ContextBriefingInput.parse(raw);
      const task = args.task;

      // Extract keywords from the task description (simple split)
      const keywords = task
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5);
      const searchQuery = keywords.join(" ");

      // Query graph and index in parallel
      const [graphResult, indexEntries] = await Promise.all([
        agent.queryGraph(searchQuery).catch(() => ({ nodes: [], edges: [] })),
        agent.searchIndex(searchQuery).catch(() => []),
      ]);

      const briefing: Record<string, unknown> = {
        task,
        relevantNodes: graphResult.nodes,
        relationships: graphResult.edges,
        indexEntries,
      };

      // Optionally include thread context
      if (args.include_threads) {
        const { messages, context } = await agent.receive();
        briefing.threadContext = {
          unreadCount: messages.length,
          snapshot: context.snapshot,
          summary: context.threadSummary,
        };
      }

      return briefing;
    },
  },
];

export interface ToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listToolDefs(): ToolListing[] {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.schema),
  }));
}

export async function runTool(
  agent: AgentMailbox,
  name: string,
  args: unknown
): Promise<unknown> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) {
    throw new Error(`unknown tool: ${name}`);
  }
  return def.handler(agent, args ?? {});
}
