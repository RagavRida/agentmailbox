import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  Agent,
  AgentAddress,
  Mailbox,
  Message,
  ParticipantRole,
  Thread,
} from "./types";

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

export class AgentMailboxStorage {
  private db: Database.Database;

  constructor(path = "agentmailbox.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  init(): void {
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

  registerAgent(agentId: AgentAddress): Agent {
    const existing = this.getAgent(agentId);
    if (existing) return existing;
    const createdAt = Date.now();
    this.db
      .prepare("INSERT INTO agents (id, created_at) VALUES (?, ?)")
      .run(agentId, createdAt);
    return { id: agentId, createdAt };
  }

  getAgent(agentId: AgentAddress): Agent | null {
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

  createThread(
    participants: AgentAddress[],
    silentParticipants: AgentAddress[] = []
  ): Thread {
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

  getThread(threadId: string): Thread | null {
    const row = this.db
      .prepare(
        `SELECT id, participants, silent_participants, created_at, updated_at
         FROM threads WHERE id = ?`
      )
      .get(threadId) as ThreadRow | undefined;
    if (!row) return null;
    const messages = this.getMessages(row.id);
    return this.rowToThread(row, messages);
  }

  getThreadByParticipants(a: AgentAddress, b: AgentAddress): Thread | null {
    return this.getThreadByParticipantSet([a, b]);
  }

  getThreadByParticipantSet(participants: AgentAddress[]): Thread | null {
    const key = this.participantsKey(participants);
    const row = this.db
      .prepare(
        `SELECT id, participants, silent_participants, created_at, updated_at
         FROM threads WHERE participants = ?`
      )
      .get(key) as ThreadRow | undefined;
    if (!row) return null;
    const messages = this.getMessages(row.id);
    return this.rowToThread(row, messages);
  }

  appendMessage(threadId: string, message: Message): void {
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

  getMessages(threadId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, from_agent, to_agent, cc, bcc, reply_to,
                payload, context_snapshot, timestamp
         FROM messages WHERE thread_id = ? ORDER BY timestamp ASC`
      )
      .all(threadId) as MessageRow[];
    return rows.map((r) => this.rowToMessage(r));
  }

  getThreadParticipants(threadId: string): ParticipantRole[] {
    const messages = this.getMessages(threadId);
    if (messages.length === 0) {
      const thread = this.getThread(threadId);
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

  getMailbox(agentId: AgentAddress): Mailbox {
    const rows = this.db
      .prepare(
        "SELECT thread_id, unread_count FROM mailboxes WHERE agent_id = ?"
      )
      .all(agentId) as Array<{ thread_id: string; unread_count: number }>;
    const threads = rows.map((r) => r.thread_id);
    const unreadCount = rows.reduce((acc, r) => acc + r.unread_count, 0);
    return { agentId, threads, unreadCount };
  }

  markRead(agentId: AgentAddress, threadId: string): void {
    this.db
      .prepare(
        `UPDATE mailboxes SET unread_count = 0, last_synced_at = ?
         WHERE agent_id = ? AND thread_id = ?`
      )
      .run(Date.now(), agentId, threadId);
  }

  getUnread(agentId: AgentAddress): Message[] {
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

  close(): void {
    this.db.close();
  }
}
