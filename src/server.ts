#!/usr/bin/env node
import { timingSafeEqual } from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { AgentMailboxStorage } from "./storage";
import { assembleContext } from "./context";
import {
  AgentAddress,
  ContextFrame,
  Message,
  ParticipantRole,
  Thread,
} from "./types";

const RegisterSchema = z.object({
  agentId: z.string().min(1),
});

const SendSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  payload: z.unknown(),
  contextSnapshot: z.record(z.unknown()).optional(),
  threadId: z.string().optional(),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  replyTo: z.string().min(1).optional(),
});

const ReplyAllSchema = z.object({
  from: z.string().min(1),
  threadId: z.string().min(1),
  payload: z.unknown(),
  contextSnapshot: z.record(z.unknown()).optional(),
});

const MarkReadSchema = z.object({
  threadId: z.string().min(1),
});

function stripBccFromMessage(m: Message, requester: AgentAddress): Message {
  if (m.from === requester) return m;
  if (!m.bcc || m.bcc.length === 0) return m;
  const { bcc: _bcc, ...rest } = m;
  return rest;
}

function stripBccFromMessages(
  messages: Message[],
  requester: AgentAddress
): Message[] {
  return messages.map((m) => stripBccFromMessage(m, requester));
}

function stripBccFromFrame(
  frame: ContextFrame,
  requester: AgentAddress
): ContextFrame {
  const stripped: ContextFrame = { ...frame };
  if (frame.from !== requester && frame.bcc) delete stripped.bcc;
  stripped.context = {
    ...frame.context,
    recentMessages: stripBccFromMessages(frame.context.recentMessages, requester),
  };
  return stripped;
}

function stripBccFromThread(t: Thread, requester: AgentAddress): Thread {
  return {
    ...t,
    silentParticipants: requester && t.silentParticipants.includes(requester)
      ? t.silentParticipants
      : [],
    messages: stripBccFromMessages(t.messages, requester),
  };
}

function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CreateServerOptions {
  apiKey?: string;
}

export function createServer(
  dbPath = "agentmailbox.db",
  opts: CreateServerOptions = {}
) {
  const storage = new AgentMailboxStorage(dbPath);
  storage.init();

  const apiKey = opts.apiKey ?? process.env.AGENTMAILBOX_API_KEY ?? "";

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    if (!apiKey) return next();
    if (req.path === "/health") return next();
    const header = req.header("authorization") ?? "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const token = header.slice(prefix.length);
    if (!bearerMatches(token, apiKey)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  };
  app.use(requireApiKey);

  // POST /agents/register
  app.post("/agents/register", (req: Request, res: Response) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const existing = storage.getAgent(parsed.data.agentId);
    const agent = storage.registerAgent(parsed.data.agentId);
    return res.status(201).json({
      agentId: agent.id,
      created: !existing,
    });
  });

  // POST /messages/send
  app.post("/messages/send", (req: Request, res: Response) => {
    const parsed = SendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { from, to, payload, contextSnapshot, threadId, cc, bcc, replyTo } =
      parsed.data;

    storage.registerAgent(from);
    storage.registerAgent(to);
    for (const a of cc ?? []) storage.registerAgent(a);
    for (const a of bcc ?? []) storage.registerAgent(a);

    let thread: Thread | null = null;
    if (threadId) {
      thread = storage.getThread(threadId);
      if (!thread) {
        return res.status(404).json({ error: `thread ${threadId} not found` });
      }
    } else {
      const visibleSet = [from, to, ...(cc ?? [])];
      thread = storage.getThreadByParticipantSet(visibleSet);
      if (!thread) thread = storage.createThread(visibleSet, bcc ?? []);
    }

    const message: Message = {
      id: uuidv4(),
      threadId: thread.id,
      from,
      to,
      payload,
      contextSnapshot: contextSnapshot ?? {},
      timestamp: Date.now(),
    };
    if (cc && cc.length > 0) message.cc = cc;
    if (bcc && bcc.length > 0) message.bcc = bcc;
    if (replyTo) message.replyTo = replyTo;

    storage.appendMessage(thread.id, message);

    const deliveredTo = Array.from(
      new Set<AgentAddress>([to, ...(cc ?? []), ...(bcc ?? [])])
    ).filter((a) => a !== from);

    return res.status(200).json({
      messageId: message.id,
      threadId: thread.id,
      deliveredTo,
    });
  });

  // POST /messages/reply-all
  app.post("/messages/reply-all", (req: Request, res: Response) => {
    const parsed = ReplyAllSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { from, threadId, payload, contextSnapshot } = parsed.data;

    const thread = storage.getThread(threadId);
    if (!thread) return res.status(404).json({ error: "thread not found" });

    storage.registerAgent(from);

    const visible = thread.participants.filter((p) => p !== from);
    if (visible.length === 0) {
      return res
        .status(400)
        .json({ error: "no other visible participants to reply to" });
    }

    const [primary, ...rest] = visible;
    const message: Message = {
      id: uuidv4(),
      threadId,
      from,
      to: primary,
      payload,
      contextSnapshot: contextSnapshot ?? {},
      timestamp: Date.now(),
    };
    if (rest.length > 0) message.cc = rest;

    storage.appendMessage(threadId, message);

    const deliveredTo = visible;
    return res.status(200).json({
      messageId: message.id,
      threadId,
      deliveredTo,
    });
  });

  // GET /mailbox/:agentId
  app.get("/mailbox/:agentId", (req: Request, res: Response) => {
    const agentId = req.params.agentId;
    const mailbox = storage.getMailbox(agentId);
    const threads: Thread[] = mailbox.threads
      .map((tid) => storage.getThread(tid))
      .filter((t): t is Thread => t !== null)
      .map((t) => stripBccFromThread(t, agentId));
    return res.status(200).json({
      threads,
      unreadCount: mailbox.unreadCount,
    });
  });

  // GET /mailbox/:agentId/unread
  app.get("/mailbox/:agentId/unread", (req: Request, res: Response) => {
    const agentId = req.params.agentId;
    const unread = storage.getUnread(agentId);
    const frames: ContextFrame[] = unread.map((m) => {
      const allMessages = storage.getMessages(m.threadId);
      const context = assembleContext(allMessages);
      const frame: ContextFrame = {
        id: m.id,
        threadId: m.threadId,
        from: m.from,
        to: m.to,
        timestamp: m.timestamp,
        payload: m.payload,
        context,
      };
      if (m.cc) frame.cc = m.cc;
      if (m.bcc) frame.bcc = m.bcc;
      if (m.replyTo) frame.replyTo = m.replyTo;
      return stripBccFromFrame(frame, agentId);
    });
    return res.status(200).json({ messages: frames });
  });

  // POST /mailbox/:agentId/read
  app.post("/mailbox/:agentId/read", (req: Request, res: Response) => {
    const agentId = req.params.agentId;
    const parsed = MarkReadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    storage.markRead(agentId, parsed.data.threadId);
    return res.status(200).json({ ok: true });
  });

  // GET /threads/:threadId
  app.get("/threads/:threadId", (req: Request, res: Response) => {
    const thread = storage.getThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: "thread not found" });
    const requester = (req.query.as as string | undefined) ?? "";
    return res.status(200).json({ thread: stripBccFromThread(thread, requester) });
  });

  // GET /threads/:threadId/sync
  app.get("/threads/:threadId/sync", (req: Request, res: Response) => {
    const thread = storage.getThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: "thread not found" });
    const requester = (req.query.as as string | undefined) ?? "";
    const ctx = assembleContext(thread.messages);
    return res.status(200).json({
      context: {
        snapshot: ctx.snapshot,
        threadSummary: ctx.threadSummary,
        recentMessages: stripBccFromMessages(ctx.recentMessages, requester),
      },
    });
  });

  // GET /threads/:threadId/participants
  app.get("/threads/:threadId/participants", (req: Request, res: Response) => {
    const threadId = req.params.threadId;
    const thread = storage.getThread(threadId);
    if (!thread) return res.status(404).json({ error: "thread not found" });

    const requester = (req.query.as as string | undefined) ?? "";
    const roles = storage.getThreadParticipants(threadId);

    // Determine which BCC agents the requester can see.
    // Rule: requester sees a BCC participant iff requester is the sender of
    // any message that included that agent in BCC, OR requester IS that BCC agent.
    const messages = thread.messages;
    const bccVisibleToRequester = new Set<string>();
    for (const m of messages) {
      if (!m.bcc) continue;
      if (m.from === requester) {
        for (const a of m.bcc) bccVisibleToRequester.add(a);
      }
    }
    if (requester) bccVisibleToRequester.add(requester);

    const filtered: ParticipantRole[] = roles.filter((p) => {
      if (p.role !== "bcc") return true;
      return bccVisibleToRequester.has(p.agentId);
    });

    return res.status(200).json({ participants: filtered });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[agentmailbox] error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  });

  return { app, storage };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  const dbPath = process.env.AGENTMAILBOX_DB ?? "agentmailbox.db";
  const { app } = createServer(dbPath);
  app.listen(port, () => {
    console.log(`[agentmailbox] server listening on http://localhost:${port}`);
    console.log(`[agentmailbox] db: ${dbPath}`);
  });
}
