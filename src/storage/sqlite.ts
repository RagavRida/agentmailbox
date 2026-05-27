import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  Agent,
  AgentAddress,
  Mailbox,
  Message,
  ParticipantRole,
  Thread,
  ThreadSummary,
} from "../types";
import {
  CodebaseIndexEntry,
  GraphEdge,
  GraphNode,
  Storage,
} from "./interface";

interface MessageRow {
  id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  cc: string;
  bcc: string;
  reply_to: string | null;
  payload: string;
  context_snapshot: string;
  timestamp: number;
}

interface ThreadRow {
  id: string;
  participants: string;
  silent_participants: string;
  created_at: number;
  updated_at: number;
}

export class SqliteStorage implements Storage {
  private db: Database.Database;

  constructor(path = "agentmailbox.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        participants TEXT NOT NULL,
        silent_participants TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        cc TEXT NOT NULL DEFAULT '[]',
        bcc TEXT NOT NULL DEFAULT '[]',
        reply_to TEXT,
        payload TEXT NOT NULL,
        context_snapshot TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);

      CREATE TABLE IF NOT EXISTS mailboxes (
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_synced_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(agent_id, thread_id),
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS thread_summaries (
        thread_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('message', 'file', 'symbol', 'decision', 'task')),
        name TEXT NOT NULL,
        description TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY (source_id, target_id, type)
      );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_agent ON graph_nodes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);

      CREATE TABLE IF NOT EXISTS codebase_index (
        key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('file', 'symbol', 'api', 'config', 'architecture')),
        summary TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_codebase_index_agent ON codebase_index(agent_id);
      CREATE INDEX IF NOT EXISTS idx_codebase_index_category ON codebase_index(agent_id, category);
    `);

    // Idempotent migration for older DBs created before CC/BCC support.
    this.ensureColumn("threads", "silent_participants", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("messages", "cc", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("messages", "bcc", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("messages", "reply_to", "TEXT");
  }

  private ensureColumn(table: string, column: string, defSql: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
    }
  }

  // ---------- Agents ----------

  async registerAgent(agentId: AgentAddress): Promise<Agent> {
    const existing = await this.getAgent(agentId);
    if (existing) return existing;
    const createdAt = Date.now();
    this.db
      .prepare("INSERT INTO agents (id, created_at) VALUES (?, ?)")
      .run(agentId, createdAt);
    return { id: agentId, createdAt };
  }

  async getAgent(agentId: AgentAddress): Promise<Agent | null> {
    const row = this.db
      .prepare("SELECT id, created_at FROM agents WHERE id = ?")
      .get(agentId) as { id: string; created_at: number } | undefined;
    if (!row) return null;
    return { id: row.id, createdAt: row.created_at };
  }

  // ---------- Threads ----------

  private participantsKey(participants: AgentAddress[]): string {
    const unique = Array.from(new Set(participants)).sort();
    return JSON.stringify(unique);
  }

  private rowToThread(row: ThreadRow, messages: Message[]): Thread {
    return {
      id: row.id,
      participants: JSON.parse(row.participants) as AgentAddress[],
      silentParticipants: JSON.parse(row.silent_participants) as AgentAddress[],
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createThread(
    participants: AgentAddress[],
    silentParticipants: AgentAddress[] = []
  ): Promise<Thread> {
    const id = uuidv4();
    const now = Date.now();
    const visibleKey = this.participantsKey(participants);
    const silentJson = JSON.stringify(
      Array.from(new Set(silentParticipants)).sort()
    );
    this.db
      .prepare(
        `INSERT INTO threads (id, participants, silent_participants, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, visibleKey, silentJson, now, now);
    return {
      id,
      participants: JSON.parse(visibleKey) as AgentAddress[],
      silentParticipants: JSON.parse(silentJson) as AgentAddress[],
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async getThread(threadId: string): Promise<Thread | null> {
    const row = this.db
      .prepare(
        `SELECT id, participants, silent_participants, created_at, updated_at
         FROM threads WHERE id = ?`
      )
      .get(threadId) as ThreadRow | undefined;
    if (!row) return null;
    const messages = this.getMessagesSync(row.id);
    return this.rowToThread(row, messages);
  }

  async getThreadByParticipants(
    a: AgentAddress,
    b: AgentAddress
  ): Promise<Thread | null> {
    return this.getThreadByParticipantSet([a, b]);
  }

  async getThreadByParticipantSet(
    participants: AgentAddress[]
  ): Promise<Thread | null> {
    const key = this.participantsKey(participants);
    const row = this.db
      .prepare(
        `SELECT id, participants, silent_participants, created_at, updated_at
         FROM threads WHERE participants = ?`
      )
      .get(key) as ThreadRow | undefined;
    if (!row) return null;
    const messages = this.getMessagesSync(row.id);
    return this.rowToThread(row, messages);
  }

  async appendMessage(threadId: string, message: Message): Promise<void> {
    // better-sqlite3's db.transaction is sync-only; we keep the inner block
    // synchronous to preserve the atomic fan-out guarantee, then expose it
    // through the async interface.
    const tx = this.db.transaction((m: Message) => {
      const cc = Array.from(new Set(m.cc ?? []));
      const bcc = Array.from(new Set(m.bcc ?? []));

      this.db
        .prepare(
          `INSERT INTO messages
           (id, thread_id, from_agent, to_agent, cc, bcc, reply_to,
            payload, context_snapshot, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          m.id,
          m.threadId,
          m.from,
          m.to,
          JSON.stringify(cc),
          JSON.stringify(bcc),
          m.replyTo ?? null,
          JSON.stringify(m.payload ?? null),
          JSON.stringify(m.contextSnapshot ?? {}),
          m.timestamp
        );

      this.db
        .prepare("UPDATE threads SET updated_at = ? WHERE id = ?")
        .run(m.timestamp, threadId);

      // Update thread participant sets — visible gains cc, silent gains bcc.
      const threadRow = this.db
        .prepare(
          "SELECT participants, silent_participants FROM threads WHERE id = ?"
        )
        .get(threadId) as
        | { participants: string; silent_participants: string }
        | undefined;
      if (!threadRow) return;

      const visible = new Set(JSON.parse(threadRow.participants) as string[]);
      visible.add(m.from);
      visible.add(m.to);
      for (const a of cc) visible.add(a);
      const visibleSorted = Array.from(visible).sort();

      const silent = new Set(
        JSON.parse(threadRow.silent_participants) as string[]
      );
      for (const a of bcc) silent.add(a);
      const silentSorted = Array.from(silent).sort();

      this.db
        .prepare(
          `UPDATE threads SET participants = ?, silent_participants = ? WHERE id = ?`
        )
        .run(JSON.stringify(visibleSorted), JSON.stringify(silentSorted), threadId);

      // Fan-out: mailbox rows + unread increments.
      const recipients: AgentAddress[] = [m.to, ...cc, ...bcc];
      const allMailboxAgents = new Set<AgentAddress>([
        m.from,
        ...visibleSorted,
        ...silentSorted,
      ]);

      const recipientSet = new Set(recipients);
      for (const agentId of allMailboxAgents) {
        const existing = this.db
          .prepare(
            "SELECT unread_count FROM mailboxes WHERE agent_id = ? AND thread_id = ?"
          )
          .get(agentId, threadId) as { unread_count: number } | undefined;
        const isRecipient = recipientSet.has(agentId) && agentId !== m.from;
        if (!existing) {
          this.db
            .prepare(
              `INSERT INTO mailboxes (agent_id, thread_id, unread_count, last_synced_at)
               VALUES (?, ?, ?, 0)`
            )
            .run(agentId, threadId, isRecipient ? 1 : 0);
        } else if (isRecipient) {
          this.db
            .prepare(
              `UPDATE mailboxes SET unread_count = unread_count + 1
               WHERE agent_id = ? AND thread_id = ?`
            )
            .run(agentId, threadId);
        }
      }
    });
    tx(message);
  }

  private rowToMessage(r: MessageRow): Message {
    const out: Message = {
      id: r.id,
      threadId: r.thread_id,
      from: r.from_agent,
      to: r.to_agent,
      payload: JSON.parse(r.payload),
      contextSnapshot: JSON.parse(r.context_snapshot) as Record<string, unknown>,
      timestamp: r.timestamp,
    };
    const cc = JSON.parse(r.cc ?? "[]") as AgentAddress[];
    const bcc = JSON.parse(r.bcc ?? "[]") as AgentAddress[];
    if (cc.length > 0) out.cc = cc;
    if (bcc.length > 0) out.bcc = bcc;
    if (r.reply_to) out.replyTo = r.reply_to;
    return out;
  }

  private getMessagesSync(threadId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, from_agent, to_agent, cc, bcc, reply_to,
                payload, context_snapshot, timestamp
         FROM messages WHERE thread_id = ? ORDER BY timestamp ASC`
      )
      .all(threadId) as MessageRow[];
    return rows.map((r) => this.rowToMessage(r));
  }

  async getMessages(threadId: string): Promise<Message[]> {
    return this.getMessagesSync(threadId);
  }

  async getThreadParticipants(threadId: string): Promise<ParticipantRole[]> {
    const messages = this.getMessagesSync(threadId);
    if (messages.length === 0) {
      const thread = await this.getThread(threadId);
      if (!thread) return [];
      return thread.participants.map((agentId) => ({
        agentId,
        role: "to" as const,
        joinedAt: thread.createdAt,
      }));
    }

    const roles = new Map<AgentAddress, ParticipantRole>();
    const upgrade = (agentId: AgentAddress, role: ParticipantRole["role"], at: number) => {
      const cur = roles.get(agentId);
      // Priority: to > cc > bcc. Keep highest-priority role seen.
      const priority = { to: 3, cc: 2, bcc: 1 } as const;
      if (!cur) {
        roles.set(agentId, { agentId, role, joinedAt: at });
        return;
      }
      const better = priority[role] > priority[cur.role];
      roles.set(agentId, {
        agentId,
        role: better ? role : cur.role,
        joinedAt: Math.min(cur.joinedAt, at),
      });
    };

    for (const m of messages) {
      upgrade(m.from, "to", m.timestamp);
      upgrade(m.to, "to", m.timestamp);
      for (const a of m.cc ?? []) upgrade(a, "cc", m.timestamp);
      for (const a of m.bcc ?? []) upgrade(a, "bcc", m.timestamp);
    }
    return Array.from(roles.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  // ---------- Mailbox ----------

  async getMailbox(agentId: AgentAddress): Promise<Mailbox> {
    const rows = this.db
      .prepare(
        "SELECT thread_id, unread_count FROM mailboxes WHERE agent_id = ?"
      )
      .all(agentId) as Array<{ thread_id: string; unread_count: number }>;
    const threads = rows.map((r) => r.thread_id);
    const unreadCount = rows.reduce((acc, r) => acc + r.unread_count, 0);
    return { agentId, threads, unreadCount };
  }

  async markRead(agentId: AgentAddress, threadId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE mailboxes SET unread_count = 0, last_synced_at = ?
         WHERE agent_id = ? AND thread_id = ?`
      )
      .run(Date.now(), agentId, threadId);
  }

  async getUnread(agentId: AgentAddress): Promise<Message[]> {
    // A message is "for" this agent if they're in to / cc / bcc.
    // Fan-out happened via mailboxes table; use last_synced_at as the cursor.
    const rows = this.db
      .prepare(
        `SELECT m.id, m.thread_id, m.from_agent, m.to_agent, m.cc, m.bcc, m.reply_to,
                m.payload, m.context_snapshot, m.timestamp
         FROM messages m
         JOIN mailboxes mb ON mb.thread_id = m.thread_id AND mb.agent_id = ?
         WHERE m.from_agent != ?
           AND m.timestamp > mb.last_synced_at
           AND (
             m.to_agent = ?
             OR EXISTS (SELECT 1 FROM json_each(m.cc) WHERE value = ?)
             OR EXISTS (SELECT 1 FROM json_each(m.bcc) WHERE value = ?)
           )
         ORDER BY m.timestamp ASC`
      )
      .all(agentId, agentId, agentId, agentId, agentId) as MessageRow[];
    return rows.map((r) => this.rowToMessage(r));
  }

  // ---------- Compression cache ----------

  async getSummary(threadId: string): Promise<ThreadSummary | null> {
    const row = this.db
      .prepare(
        "SELECT summary_json FROM thread_summaries WHERE thread_id = ?"
      )
      .get(threadId) as { summary_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.summary_json) as ThreadSummary;
    } catch {
      return null;
    }
  }

  async saveSummary(threadId: string, summary: ThreadSummary): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO thread_summaries (thread_id, summary_json, generated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           summary_json = excluded.summary_json,
           generated_at = excluded.generated_at`
      )
      .run(threadId, JSON.stringify(summary), summary.generatedAt);
  }

  // ---------- Context Graph ----------

  async upsertNode(
    agentId: AgentAddress,
    node: Omit<GraphNode, "updatedAt">
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO graph_nodes (id, agent_id, type, name, description, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, agent_id) DO UPDATE SET
           type = excluded.type,
           name = excluded.name,
           description = excluded.description,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`
      )
      .run(
        node.id,
        agentId,
        node.type,
        node.name,
        node.description ?? null,
        JSON.stringify(node.metadata ?? {}),
        now
      );
  }

  async deleteNode(agentId: AgentAddress, nodeId: string): Promise<void> {
    // Delete edges first (no CASCADE in SQLite FK by default on composite keys)
    this.db
      .prepare("DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?")
      .run(nodeId, nodeId);
    this.db
      .prepare("DELETE FROM graph_nodes WHERE id = ? AND agent_id = ?")
      .run(nodeId, agentId);
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO graph_edges (source_id, target_id, type, weight)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id, target_id, type) DO UPDATE SET
           weight = excluded.weight`
      )
      .run(edge.sourceId, edge.targetId, edge.type, edge.weight);
  }

  async deleteEdge(
    sourceId: string,
    targetId: string,
    type: string
  ): Promise<void> {
    this.db
      .prepare(
        "DELETE FROM graph_edges WHERE source_id = ? AND target_id = ? AND type = ?"
      )
      .run(sourceId, targetId, type);
  }

  async queryGraph(
    agentId: AgentAddress,
    query: string
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const pattern = `%${query}%`;

    // Step 1: Find seed nodes matching the query by name or description
    const seedRows = this.db
      .prepare(
        `SELECT id, agent_id, type, name, description, metadata, updated_at
         FROM graph_nodes
         WHERE agent_id = ? AND (name LIKE ? OR description LIKE ?)`
      )
      .all(agentId, pattern, pattern) as Array<{
      id: string;
      agent_id: string;
      type: string;
      name: string;
      description: string | null;
      metadata: string;
      updated_at: number;
    }>;

    if (seedRows.length === 0) {
      return { nodes: [], edges: [] };
    }

    const seedIds = seedRows.map((r) => r.id);
    const placeholders = seedIds.map(() => "?").join(", ");

    // Step 2: 2-hop traversal — collect all node ids reachable within 2 edges
    const traversalRows = this.db
      .prepare(
        `WITH RECURSIVE hops(node_id, depth) AS (
           SELECT id, 0 FROM graph_nodes WHERE id IN (${placeholders}) AND agent_id = ?
           UNION
           SELECT CASE
             WHEN e.source_id = h.node_id THEN e.target_id
             ELSE e.source_id
           END, h.depth + 1
           FROM hops h
           JOIN graph_edges e ON (e.source_id = h.node_id OR e.target_id = h.node_id)
           WHERE h.depth < 2
         )
         SELECT DISTINCT node_id FROM hops`
      )
      .all(...seedIds, agentId) as Array<{ node_id: string }>;

    const allIds = traversalRows.map((r) => r.node_id);
    if (allIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    const allPlaceholders = allIds.map(() => "?").join(", ");

    // Step 3: Fetch full node objects
    const nodeRows = this.db
      .prepare(
        `SELECT id, agent_id, type, name, description, metadata, updated_at
         FROM graph_nodes
         WHERE id IN (${allPlaceholders}) AND agent_id = ?`
      )
      .all(...allIds, agentId) as Array<{
      id: string;
      agent_id: string;
      type: string;
      name: string;
      description: string | null;
      metadata: string;
      updated_at: number;
    }>;

    const nodes: GraphNode[] = nodeRows.map((r) => ({
      id: r.id,
      type: r.type as GraphNode["type"],
      name: r.name,
      description: r.description ?? undefined,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
      updatedAt: r.updated_at,
    }));

    // Step 4: Fetch edges between all returned nodes
    const edgeRows = this.db
      .prepare(
        `SELECT source_id, target_id, type, weight
         FROM graph_edges
         WHERE source_id IN (${allPlaceholders})
           AND target_id IN (${allPlaceholders})`
      )
      .all(...allIds, ...allIds) as Array<{
      source_id: string;
      target_id: string;
      type: string;
      weight: number;
    }>;

    const edges: GraphEdge[] = edgeRows.map((r) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      type: r.type,
      weight: r.weight,
    }));

    return { nodes, edges };
  }

  // ---------- Codebase Index ----------

  async upsertIndex(
    agentId: AgentAddress,
    entry: Omit<CodebaseIndexEntry, "updatedAt">
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO codebase_index (key, agent_id, category, summary, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key, agent_id) DO UPDATE SET
           category = excluded.category,
           summary = excluded.summary,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`
      )
      .run(
        entry.key,
        agentId,
        entry.category,
        entry.summary,
        JSON.stringify(entry.metadata ?? {}),
        now
      );
  }

  async getIndex(
    agentId: AgentAddress,
    key: string
  ): Promise<CodebaseIndexEntry | null> {
    const row = this.db
      .prepare(
        `SELECT key, category, summary, metadata, updated_at
         FROM codebase_index WHERE key = ? AND agent_id = ?`
      )
      .get(key, agentId) as
      | {
          key: string;
          category: string;
          summary: string;
          metadata: string;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      key: row.key,
      category: row.category as CodebaseIndexEntry["category"],
      summary: row.summary,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      updatedAt: row.updated_at,
    };
  }

  async searchIndex(
    agentId: AgentAddress,
    query: string,
    category?: string
  ): Promise<CodebaseIndexEntry[]> {
    const pattern = `%${query}%`;
    let sql = `SELECT key, category, summary, metadata, updated_at
               FROM codebase_index
               WHERE agent_id = ? AND (key LIKE ? OR summary LIKE ?)`;
    const params: unknown[] = [agentId, pattern, pattern];
    if (category) {
      sql += " AND category = ?";
      params.push(category);
    }
    sql += " ORDER BY updated_at DESC LIMIT 50";

    const rows = this.db.prepare(sql).all(...params) as Array<{
      key: string;
      category: string;
      summary: string;
      metadata: string;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      key: r.key,
      category: r.category as CodebaseIndexEntry["category"],
      summary: r.summary,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
      updatedAt: r.updated_at,
    }));
  }

  async deleteIndex(agentId: AgentAddress, key: string): Promise<void> {
    this.db
      .prepare("DELETE FROM codebase_index WHERE key = ? AND agent_id = ?")
      .run(key, agentId);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
