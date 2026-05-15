import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { rmSync } from "node:fs";

import { SqliteStorage } from "../src/storage";
import { Message } from "../src/types";
import { freshDb } from "./setup";

let storage: SqliteStorage;
let dbDir: string;

function makeMessage(
  threadId: string,
  from: string,
  to: string,
  extras: Partial<Message> = {}
): Message {
  return {
    id: uuidv4(),
    threadId,
    from,
    to,
    payload: extras.payload ?? { hello: "world" },
    contextSnapshot: extras.contextSnapshot ?? {},
    timestamp: extras.timestamp ?? Date.now(),
    cc: extras.cc,
    bcc: extras.bcc,
    replyTo: extras.replyTo,
  };
}

beforeEach(async () => {
  const db = freshDb();
  dbDir = db.dir;
  storage = new SqliteStorage(db.path);
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("SqliteStorage", () => {
  it("registerAgent is idempotent", async () => {
    const a = await storage.registerAgent("alice@demo");
    const b = await storage.registerAgent("alice@demo");
    expect(a.id).toBe("alice@demo");
    expect(b.id).toBe("alice@demo");
    expect(b.createdAt).toBe(a.createdAt);
  });

  it("init() is safe to call multiple times", async () => {
    await storage.init();
    await storage.init();
    const a = await storage.registerAgent("alice@demo");
    expect(a.id).toBe("alice@demo");
  });

  it("createThread + getThreadByParticipantSet round-trip", async () => {
    const t = await storage.createThread(["a@x", "b@x"]);
    const found = await storage.getThreadByParticipantSet(["b@x", "a@x"]);
    expect(found?.id).toBe(t.id);
  });

  it("appendMessage fans out unread to TO + CC + BCC, not sender", async () => {
    await storage.registerAgent("from@x");
    await storage.registerAgent("to@x");
    await storage.registerAgent("cc@x");
    await storage.registerAgent("bcc@x");

    const thread = await storage.createThread(
      ["from@x", "to@x", "cc@x"],
      ["bcc@x"]
    );
    const msg = makeMessage(thread.id, "from@x", "to@x", {
      cc: ["cc@x"],
      bcc: ["bcc@x"],
    });
    await storage.appendMessage(thread.id, msg);

    expect((await storage.getMailbox("from@x")).unreadCount).toBe(0);
    expect((await storage.getMailbox("to@x")).unreadCount).toBe(1);
    expect((await storage.getMailbox("cc@x")).unreadCount).toBe(1);
    expect((await storage.getMailbox("bcc@x")).unreadCount).toBe(1);
  });

  it("thread.participants ∪= cc and silentParticipants ∪= bcc on append", async () => {
    const thread = await storage.createThread(["from@x", "to@x"]);

    await storage.appendMessage(
      thread.id,
      makeMessage(thread.id, "from@x", "to@x", {
        cc: ["cc@x"],
        bcc: ["bcc@x"],
      })
    );

    const refreshed = await storage.getThread(thread.id);
    expect(refreshed?.participants.sort()).toEqual(["cc@x", "from@x", "to@x"]);
    expect(refreshed?.silentParticipants).toEqual(["bcc@x"]);
  });

  it("getUnread excludes sender, includes cc and bcc recipients", async () => {
    const thread = await storage.createThread(
      ["from@x", "to@x", "cc@x"],
      ["bcc@x"]
    );
    await storage.appendMessage(
      thread.id,
      makeMessage(thread.id, "from@x", "to@x", {
        cc: ["cc@x"],
        bcc: ["bcc@x"],
      })
    );

    expect((await storage.getUnread("from@x")).length).toBe(0);
    expect((await storage.getUnread("to@x")).length).toBe(1);
    expect((await storage.getUnread("cc@x")).length).toBe(1);
    expect((await storage.getUnread("bcc@x")).length).toBe(1);
  });

  it("markRead clears unread only for that thread", async () => {
    const t1 = await storage.createThread(["from@x", "to@x"]);
    const t2 = await storage.createThread(["from@x", "to@x", "spare@x"]);

    await storage.appendMessage(
      t1.id,
      makeMessage(t1.id, "from@x", "to@x", { timestamp: 1 })
    );
    await storage.appendMessage(
      t2.id,
      makeMessage(t2.id, "from@x", "to@x", { timestamp: 2 })
    );

    expect((await storage.getMailbox("to@x")).unreadCount).toBe(2);
    await storage.markRead("to@x", t1.id);
    const unread = await storage.getUnread("to@x");
    expect(unread.length).toBe(1);
    expect(unread[0].threadId).toBe(t2.id);
  });

  it("getThreadParticipants returns to/cc/bcc roles with to>cc>bcc priority", async () => {
    const thread = await storage.createThread(["from@x", "to@x"]);
    // First message: alice is cc, bob is bcc
    await storage.appendMessage(
      thread.id,
      makeMessage(thread.id, "from@x", "to@x", {
        cc: ["alice@x"],
        bcc: ["bob@x"],
        timestamp: 10,
      })
    );
    // Second message: alice becomes a primary TO — should upgrade to "to"
    await storage.appendMessage(
      thread.id,
      makeMessage(thread.id, "from@x", "alice@x", { timestamp: 20 })
    );

    const roles = await storage.getThreadParticipants(thread.id);
    const byId = Object.fromEntries(roles.map((r) => [r.agentId, r.role]));
    expect(byId["from@x"]).toBe("to");
    expect(byId["to@x"]).toBe("to");
    expect(byId["alice@x"]).toBe("to"); // upgraded from cc
    expect(byId["bob@x"]).toBe("bcc");
  });
});
