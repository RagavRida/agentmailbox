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
  StorageOptions,
} from "./interface";

// Minimal structural type we need from `pg`. Avoids a hard compile-time
// dependency for callers who only use the SQLite adapter — mirrors the
// optional-peer pattern used by ClaudeCompressor / OpenAICompressor.
interface PgQueryResult<R = unknown> {
  rows: R[];
  rowCount: number | null;
}
interface PgClient {
  query<R = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  release(): void;
}
interface PgPool {
  connect(): Promise<PgClient>;
  query<R = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  end(): Promise<void>;
}
type PgPoolCtor = new (cfg: {
  connectionString: string;
  max?: number;
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
}) => PgPool;

interface MessageRow {
  id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string | null;
  payload: unknown;
  context_snapshot: Record<string, unknown> | null;
  timestamp: string | number;
}

interface ThreadRow {
  id: string;
  created_at: Date;
  updated_at: Date;
}

function toMs(v: string | number | Date): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return Number(v);
}

export interface PostgresStorageOptions extends StorageOptions {
  /** Override pool max size. Falls back to POSTGRES_POOL_MAX env var, then 10. */
  poolMax?: number;
}

export class PostgresStorage implements Storage {
  private readonly url: string;
  private readonly poolMax: number;
  private pool: PgPool | null = null;
  private poolPromise: Promise<PgPool> | null = null;

  constructor(opts: string | PostgresStorageOptions) {
    const o = typeof opts === "string" ? { url: opts } : opts;
    this.url = o.url;
    const envMax = process.env.POSTGRES_POOL_MAX ?? process.env.PG_POOL_MAX;
    this.poolMax = o.poolMax ?? (envMax ? Number(envMax) : 10);
  }

  /**
   * Expose the underlying `pg.Pool` to in-process collaborators (e.g. the
   * cloud-tier `ScopedStorage` wrapper) that need to share connection state
   * without round-tripping every query through this class.
   *
   * External callers should not depend on the concrete `pg` types — treat
   * the returned value as opaque.
   */
  public async getRawPool(): Promise<PgPool> {
    return this.getPool();
  }

  private async getPool(): Promise<PgPool> {
    if (this.pool) return this.pool;
    if (this.poolPromise) return this.poolPromise;
    this.poolPromise = (async () => {
      let mod: { Pool?: PgPoolCtor; default?: { Pool?: PgPoolCtor } };
      try {
        mod = (await import("pg")) as typeof mod;
      } catch {
        throw new Error(
          "PostgresStorage requires the `pg` package. " +
            "Install it with: npm install pg"
        );
      }
      const Pool = mod.Pool ?? mod.default?.Pool;
      if (!Pool) throw new Error("pg did not export a Pool constructor");
      // node-pg does NOT enable SSL just because the URL has `?sslmode=...`.
      // RDS Postgres ships pg_hba configured for SSL-only by default. Detect
      // the user's intent from the URL or env and pass an `ssl` option that
      // actually triggers TLS negotiation.
      const wantsSsl =
        /[?&]sslmode=(require|verify-ca|verify-full)/i.test(this.url) ||
        process.env.PGSSLMODE === "require" ||
        process.env.AGENTSMCP_DB_SSL === "true";
      const ssl = wantsSsl ? { rejectUnauthorized: false } : undefined;
      this.pool = new Pool({
        connectionString: this.url,
        max: this.poolMax,
        ...(ssl ? { ssl } : {}),
      });
      return this.pool;
    })();
    return this.poolPromise;
  }

  async init(): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS threads (
          id UUID PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS thread_participants (
          thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('visible','silent')),
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (thread_id, agent_id)
        );

        CREATE INDEX IF NOT EXISTS idx_thread_participants_agent
          ON thread_participants(agent_id);

        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY,
          thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          cc TEXT[] NOT NULL DEFAULT '{}',
          bcc TEXT[] NOT NULL DEFAULT '{}',
          reply_to TEXT,
          payload JSONB NOT NULL,
          context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
          timestamp BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_messages_thread_ts
          ON messages(thread_id, timestamp);

        CREATE TABLE IF NOT EXISTS mailbox_state (
          agent_id TEXT NOT NULL,
          thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          unread_count INTEGER NOT NULL DEFAULT 0,
          last_read_at TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0),
          PRIMARY KEY (agent_id, thread_id)
        );

        CREATE INDEX IF NOT EXISTS idx_mailbox_state_agent_unread
          ON mailbox_state(agent_id, unread_count);

        CREATE TABLE IF NOT EXISTS thread_summaries (
          thread_id UUID PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          summary JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS graph_nodes (
          id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('message', 'file', 'symbol', 'decision', 'task')),
          name TEXT NOT NULL,
          description TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (key, agent_id)
        );

        CREATE INDEX IF NOT EXISTS idx_codebase_index_agent ON codebase_index(agent_id);
        CREATE INDEX IF NOT EXISTS idx_codebase_index_category ON codebase_index(agent_id, category);
      `);

      // Migration 003: GitHub OAuth fields on users
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id BIGINT UNIQUE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
        CREATE INDEX IF NOT EXISTS idx_users_github_id
          ON users(github_id) WHERE github_id IS NOT NULL;
      `);

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.poolPromise = null;
    }
  }

  // ---------- Agents ----------

  async registerAgent(agentId: AgentAddress): Promise<Agent> {
    const pool = await this.getPool();
    const res = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO agents (id) VALUES ($1)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, created_at`,
      [agentId]
    );
    if (res.rows.length > 0) {
      return { id: res.rows[0].id, createdAt: toMs(res.rows[0].created_at) };
    }
    const existing = await this.getAgent(agentId);
    if (!existing) throw new Error(`failed to register agent ${agentId}`);
    return existing;
  }

  async getAgent(agentId: AgentAddress): Promise<Agent | null> {
    const pool = await this.getPool();
    const res = await pool.query<{ id: string; created_at: Date }>(
      "SELECT id, created_at FROM agents WHERE id = $1",
      [agentId]
    );
    if (res.rows.length === 0) return null;
    return { id: res.rows[0].id, createdAt: toMs(res.rows[0].created_at) };
  }

  // ---------- Threads ----------

  private uniqueSorted(xs: AgentAddress[]): AgentAddress[] {
    return Array.from(new Set(xs)).sort();
  }

  private async loadThreadParticipants(
    client: PgClient | PgPool,
    threadId: string
  ): Promise<{ visible: AgentAddress[]; silent: AgentAddress[] }> {
    const res = await client.query<{ agent_id: string; role: string }>(
      `SELECT agent_id, role FROM thread_participants WHERE thread_id = $1`,
      [threadId]
    );
    const visible: AgentAddress[] = [];
    const silent: AgentAddress[] = [];
    for (const r of res.rows) {
      if (r.role === "visible") visible.push(r.agent_id);
      else silent.push(r.agent_id);
    }
    return { visible: visible.sort(), silent: silent.sort() };
  }

  private async hydrateThread(
    client: PgClient | PgPool,
    row: ThreadRow
  ): Promise<Thread> {
    const { visible, silent } = await this.loadThreadParticipants(client, row.id);
    const messages = await this.getMessagesWith(client, row.id);
    return {
      id: row.id,
      participants: visible,
      silentParticipants: silent,
      messages,
      createdAt: toMs(row.created_at),
      updatedAt: toMs(row.updated_at),
    };
  }

  async createThread(
    participants: AgentAddress[],
    silentParticipants: AgentAddress[] = []
  ): Promise<Thread> {
    const pool = await this.getPool();
    const id = uuidv4();
    const visible = this.uniqueSorted(participants);
    const silentSet = new Set(this.uniqueSorted(silentParticipants));
    for (const v of visible) silentSet.delete(v); // visible wins
    const silent = Array.from(silentSet).sort();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tRes = await client.query<ThreadRow>(
        `INSERT INTO threads (id) VALUES ($1)
         RETURNING id, created_at, updated_at`,
        [id]
      );

      for (const a of visible) {
        await client.query(
          `INSERT INTO thread_participants (thread_id, agent_id, role)
           VALUES ($1, $2, 'visible')
           ON CONFLICT (thread_id, agent_id) DO NOTHING`,
          [id, a]
        );
        await client.query(
          `INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [a]
        );
      }
      for (const a of silent) {
        await client.query(
          `INSERT INTO thread_participants (thread_id, agent_id, role)
           VALUES ($1, $2, 'silent')
           ON CONFLICT (thread_id, agent_id) DO NOTHING`,
          [id, a]
        );
        await client.query(
          `INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [a]
        );
      }
      await client.query("COMMIT");
      return {
        id: tRes.rows[0].id,
        participants: visible,
        silentParticipants: silent,
        messages: [],
        createdAt: toMs(tRes.rows[0].created_at),
        updatedAt: toMs(tRes.rows[0].updated_at),
      };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async getThread(threadId: string): Promise<Thread | null> {
    const pool = await this.getPool();
    const res = await pool.query<ThreadRow>(
      `SELECT id, created_at, updated_at FROM threads WHERE id = $1`,
      [threadId]
    );
    if (res.rows.length === 0) return null;
    return this.hydrateThread(pool, res.rows[0]);
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
    const pool = await this.getPool();
    const target = this.uniqueSorted(participants);
    const res = await pool.query<ThreadRow>(
      `SELECT t.id, t.created_at, t.updated_at
       FROM threads t
       WHERE (
         SELECT array_agg(tp.agent_id ORDER BY tp.agent_id)
         FROM thread_participants tp
         WHERE tp.thread_id = t.id AND tp.role = 'visible'
       ) = $1::text[]
       LIMIT 1`,
      [target]
    );
    if (res.rows.length === 0) return null;
    return this.hydrateThread(pool, res.rows[0]);
  }

  // ---------- Messages ----------

  async appendMessage(threadId: string, message: Message): Promise<void> {
    const pool = await this.getPool();
    const cc = this.uniqueSorted(message.cc ?? []);
    const bcc = this.uniqueSorted(message.bcc ?? []);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the thread row so concurrent appends serialise on participant /
      // mailbox updates.
      const tRes = await client.query<{ id: string }>(
        `SELECT id FROM threads WHERE id = $1 FOR UPDATE`,
        [threadId]
      );
      if (tRes.rows.length === 0) {
        throw new Error(`thread ${threadId} not found`);
      }

      await client.query(
        `INSERT INTO messages
         (id, thread_id, from_agent, to_agent, cc, bcc, reply_to,
          payload, context_snapshot, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
        [
          message.id,
          threadId,
          message.from,
          message.to,
          cc,
          bcc,
          message.replyTo ?? null,
          JSON.stringify(message.payload ?? null),
          JSON.stringify(message.contextSnapshot ?? {}),
          message.timestamp,
        ]
      );

      await client.query(
        `UPDATE threads SET updated_at = to_timestamp($2::double precision / 1000.0)
         WHERE id = $1`,
        [threadId, message.timestamp]
      );

      // Register any newly-seen agents and add them to thread_participants.
      // Visible (from/to/cc) trumps silent (bcc).
      const visibleNew = this.uniqueSorted([message.from, message.to, ...cc]);
      for (const a of visibleNew) {
        await client.query(
          `INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [a]
        );
        await client.query(
          `INSERT INTO thread_participants (thread_id, agent_id, role)
           VALUES ($1, $2, 'visible')
           ON CONFLICT (thread_id, agent_id) DO UPDATE SET role = 'visible'`,
          [threadId, a]
        );
      }
      for (const a of bcc) {
        await client.query(
          `INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [a]
        );
        // Only insert as silent if not already visible — don't downgrade.
        await client.query(
          `INSERT INTO thread_participants (thread_id, agent_id, role)
           VALUES ($1, $2, 'silent')
           ON CONFLICT (thread_id, agent_id) DO NOTHING`,
          [threadId, a]
        );
      }

      // Fan-out mailbox_state: ensure row exists for every participant,
      // increment unread_count for recipients (to/cc/bcc) excluding sender.
      const allParticipants = await this.loadThreadParticipants(client, threadId);
      const everyone = new Set<AgentAddress>([
        ...allParticipants.visible,
        ...allParticipants.silent,
      ]);
      const recipients = new Set<AgentAddress>(
        [message.to, ...cc, ...bcc].filter((a) => a !== message.from)
      );

      for (const agentId of everyone) {
        const isRecipient = recipients.has(agentId);
        await client.query(
          `INSERT INTO mailbox_state (agent_id, thread_id, unread_count)
           VALUES ($1, $2, $3)
           ON CONFLICT (agent_id, thread_id)
           DO UPDATE SET unread_count = mailbox_state.unread_count + $3`,
          [agentId, threadId, isRecipient ? 1 : 0]
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private rowToMessage(r: MessageRow): Message {
    const out: Message = {
      id: r.id,
      threadId: r.thread_id,
      from: r.from_agent,
      to: r.to_agent,
      payload: r.payload,
      contextSnapshot: r.context_snapshot ?? {},
      timestamp: toMs(r.timestamp),
    };
    const cc = r.cc ?? [];
    const bcc = r.bcc ?? [];
    if (cc.length > 0) out.cc = cc;
    if (bcc.length > 0) out.bcc = bcc;
    if (r.reply_to) out.replyTo = r.reply_to;
    return out;
  }

  private async getMessagesWith(
    client: PgClient | PgPool,
    threadId: string
  ): Promise<Message[]> {
    const res = await client.query<MessageRow>(
      `SELECT id, thread_id, from_agent, to_agent, cc, bcc, reply_to,
              payload, context_snapshot, timestamp
       FROM messages WHERE thread_id = $1 ORDER BY timestamp ASC`,
      [threadId]
    );
    return res.rows.map((r) => this.rowToMessage(r));
  }

  async getMessages(threadId: string): Promise<Message[]> {
    const pool = await this.getPool();
    return this.getMessagesWith(pool, threadId);
  }

  async getThreadParticipants(threadId: string): Promise<ParticipantRole[]> {
    const pool = await this.getPool();
    const messages = await this.getMessagesWith(pool, threadId);
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
    const priority = { to: 3, cc: 2, bcc: 1 } as const;
    const upgrade = (
      agentId: AgentAddress,
      role: ParticipantRole["role"],
      at: number
    ) => {
      const cur = roles.get(agentId);
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
    const pool = await this.getPool();
    const res = await pool.query<{ thread_id: string; unread_count: number }>(
      `SELECT thread_id, unread_count FROM mailbox_state WHERE agent_id = $1`,
      [agentId]
    );
    const threads = res.rows.map((r) => r.thread_id);
    const unreadCount = res.rows.reduce((acc, r) => acc + Number(r.unread_count), 0);
    return { agentId, threads, unreadCount };
  }

  async markRead(agentId: AgentAddress, threadId: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `UPDATE mailbox_state
       SET unread_count = 0, last_read_at = NOW()
       WHERE agent_id = $1 AND thread_id = $2`,
      [agentId, threadId]
    );
  }

  async getUnread(agentId: AgentAddress): Promise<Message[]> {
    const pool = await this.getPool();
    const res = await pool.query<MessageRow>(
      `SELECT m.id, m.thread_id, m.from_agent, m.to_agent, m.cc, m.bcc, m.reply_to,
              m.payload, m.context_snapshot, m.timestamp
       FROM messages m
       JOIN mailbox_state mb
         ON mb.thread_id = m.thread_id AND mb.agent_id = $1
       WHERE m.from_agent <> $1
         AND to_timestamp(m.timestamp::double precision / 1000.0) > mb.last_read_at
         AND ($1 = m.to_agent OR $1 = ANY(m.cc) OR $1 = ANY(m.bcc))
       ORDER BY m.timestamp ASC`,
      [agentId]
    );
    return res.rows.map((r) => this.rowToMessage(r));
  }

  // ---------- Compression cache ----------

  async getSummary(threadId: string): Promise<ThreadSummary | null> {
    const pool = await this.getPool();
    const res = await pool.query<{ summary: ThreadSummary }>(
      `SELECT summary FROM thread_summaries WHERE thread_id = $1`,
      [threadId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].summary;
  }

  async saveSummary(threadId: string, summary: ThreadSummary): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO thread_summaries (thread_id, summary)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (thread_id) DO UPDATE SET
         summary = excluded.summary,
         created_at = NOW()`,
      [threadId, JSON.stringify(summary)]
    );
  }

  // ---------- Context Graph ----------

  async upsertNode(
    agentId: AgentAddress,
    node: Omit<GraphNode, "updatedAt">
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO graph_nodes (id, agent_id, type, name, description, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (id, agent_id) DO UPDATE SET
         type = EXCLUDED.type,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        node.id,
        agentId,
        node.type,
        node.name,
        node.description ?? null,
        JSON.stringify(node.metadata ?? {}),
      ]
    );
  }

  async deleteNode(agentId: AgentAddress, nodeId: string): Promise<void> {
    const pool = await this.getPool();
    // Delete edges first
    await pool.query(
      "DELETE FROM graph_edges WHERE source_id = $1 OR target_id = $1",
      [nodeId]
    );
    await pool.query(
      "DELETE FROM graph_nodes WHERE id = $1 AND agent_id = $2",
      [nodeId, agentId]
    );
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO graph_edges (source_id, target_id, type, weight)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_id, target_id, type) DO UPDATE SET
         weight = EXCLUDED.weight`,
      [edge.sourceId, edge.targetId, edge.type, edge.weight]
    );
  }

  async deleteEdge(
    sourceId: string,
    targetId: string,
    type: string
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      "DELETE FROM graph_edges WHERE source_id = $1 AND target_id = $2 AND type = $3",
      [sourceId, targetId, type]
    );
  }

  async queryGraph(
    agentId: AgentAddress,
    query: string
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const pool = await this.getPool();
    const pattern = `%${query}%`;

    // Step 1: Seed nodes matching query
    const seedRes = await pool.query<{ id: string }>(
      `SELECT id FROM graph_nodes
       WHERE agent_id = $1 AND (name ILIKE $2 OR description ILIKE $2)`,
      [agentId, pattern]
    );

    if (seedRes.rows.length === 0) {
      return { nodes: [], edges: [] };
    }

    const seedIds = seedRes.rows.map((r) => r.id);

    // Step 2: 2-hop traversal via recursive CTE
    const traversalRes = await pool.query<{ node_id: string }>(
      `WITH RECURSIVE hops(node_id, depth) AS (
         SELECT id, 0 FROM graph_nodes
         WHERE id = ANY($1::text[]) AND agent_id = $2
         UNION
         SELECT CASE
           WHEN e.source_id = h.node_id THEN e.target_id
           ELSE e.source_id
         END, h.depth + 1
         FROM hops h
         JOIN graph_edges e ON (e.source_id = h.node_id OR e.target_id = h.node_id)
         WHERE h.depth < 2
       )
       SELECT DISTINCT node_id FROM hops`,
      [seedIds, agentId]
    );

    const allIds = traversalRes.rows.map((r) => r.node_id);
    if (allIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Step 3: Fetch full nodes
    const nodeRes = await pool.query<{
      id: string;
      type: string;
      name: string;
      description: string | null;
      metadata: Record<string, unknown>;
      updated_at: Date;
    }>(
      `SELECT id, type, name, description, metadata, updated_at
       FROM graph_nodes
       WHERE id = ANY($1::text[]) AND agent_id = $2`,
      [allIds, agentId]
    );

    const nodes: GraphNode[] = nodeRes.rows.map((r) => ({
      id: r.id,
      type: r.type as GraphNode["type"],
      name: r.name,
      description: r.description ?? undefined,
      metadata: r.metadata,
      updatedAt: toMs(r.updated_at),
    }));

    // Step 4: Fetch edges between returned nodes
    const edgeRes = await pool.query<{
      source_id: string;
      target_id: string;
      type: string;
      weight: number;
    }>(
      `SELECT source_id, target_id, type, weight
       FROM graph_edges
       WHERE source_id = ANY($1::text[]) AND target_id = ANY($1::text[])`,
      [allIds]
    );

    const edges: GraphEdge[] = edgeRes.rows.map((r) => ({
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
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO codebase_index (key, agent_id, category, summary, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (key, agent_id) DO UPDATE SET
         category = EXCLUDED.category,
         summary = EXCLUDED.summary,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        entry.key,
        agentId,
        entry.category,
        entry.summary,
        JSON.stringify(entry.metadata ?? {}),
      ]
    );
  }

  async getIndex(
    agentId: AgentAddress,
    key: string
  ): Promise<CodebaseIndexEntry | null> {
    const pool = await this.getPool();
    const res = await pool.query<{
      key: string;
      category: string;
      summary: string;
      metadata: Record<string, unknown>;
      updated_at: Date;
    }>(
      `SELECT key, category, summary, metadata, updated_at
       FROM codebase_index WHERE key = $1 AND agent_id = $2`,
      [key, agentId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      key: r.key,
      category: r.category as CodebaseIndexEntry["category"],
      summary: r.summary,
      metadata: r.metadata,
      updatedAt: toMs(r.updated_at),
    };
  }

  async searchIndex(
    agentId: AgentAddress,
    query: string,
    category?: string
  ): Promise<CodebaseIndexEntry[]> {
    const pool = await this.getPool();
    const pattern = `%${query}%`;
    const params: unknown[] = [agentId, pattern];
    let sql = `SELECT key, category, summary, metadata, updated_at
               FROM codebase_index
               WHERE agent_id = $1 AND (key ILIKE $2 OR summary ILIKE $2)`;
    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }
    sql += " ORDER BY updated_at DESC LIMIT 50";

    const res = await pool.query<{
      key: string;
      category: string;
      summary: string;
      metadata: Record<string, unknown>;
      updated_at: Date;
    }>(sql, params);

    return res.rows.map((r) => ({
      key: r.key,
      category: r.category as CodebaseIndexEntry["category"],
      summary: r.summary,
      metadata: r.metadata,
      updatedAt: toMs(r.updated_at),
    }));
  }

  async deleteIndex(agentId: AgentAddress, key: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      "DELETE FROM codebase_index WHERE key = $1 AND agent_id = $2",
      [key, agentId]
    );
  }
}
