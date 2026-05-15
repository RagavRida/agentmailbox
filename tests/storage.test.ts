import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { rmSync } from "node:fs";

import { AgentMailboxStorage } from "../src/storage";
import { Message } from "../src/types";
import { freshDb } from "./setup";

let storage: AgentMailboxStorage;
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

beforeEach(() => {
  const db = freshDb();
  dbDir = db.dir;
  storage = new AgentMailboxStorage(db.path);
  storage.init();
});

afterEach(() => {
  storage.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("AgentMailboxStorage", () => {
  it("registerAgent is idempotent", () => {
    const a = storage.registerAgent("alice@demo");
    const b = storage.registerAgent("alice@demo");
    expect(a.id).toBe("alice@demo");
    expect(b.id).toBe("alice@demo");
    expect(b.createdAt).toBe(a.createdAt);
  });

  it("createThread + getThreadByParticipantSet round-trip", () => {
    const t = storage.createThread(["a@x", "b@x"]);
    const found = storage.getThreadByParticipantSet(["b@x", "a@x"]);
    expect(found?.id).toBe(t.id);
  });

  it("appendMessage fans out unread to TO + CC + BCC, not sender", () => {
    storage.registerAgent("from@x");
    storage.registerAgent("to@x");
    storage.registerAgent("cc@x");
    storage.registerAgent("bcc@x");

    const thread = storage.createThread(["from@x", "to@x", "cc@x"], ["bcc@x"]);
    const msg = makeMessage(thread.id, "from@x", "to@x", {
      cc: ["cc@x"],
      bcc: ["bcc@x"],
    });
    storage.appendMessage(thread.id, msg);

    expect(storage.getMailbox("from@x").unreadCount).toBe(0);
    expect(storage.getMailbox("to@x").unreadCount).toBe(1);
    expect(storage.getMailbox("cc@x").unreadCount).toBe(1);
    expect(storage.getMailbox("bcc@x").unreadCount).toBe(1);
  });

  it("thread.participants ∪= cc and silentParticipants ∪= bcc on append", () => {
    const thread = storage.createThread(["from@x", "to@x"]);

    storage.appendMessage(
      thread.id,
      makeMessage(thread.id, "from@x", "to@x", {
        cc: ["cc@x"],
        bcc: ["bcc@x"],
      })
    );

    const refreshed = storage.getThread(thread.id);
    expect(refreshed?.participants.sort()).toEqual(["cc@x", "from@x", "to@x"]);
    expect(refreshed?.silentParticipants).toEqual(["bcc@x"]);
  });

  it("getUnread excludes sender, includes cc and bcc recipients", () => {
    const thread = storage.createThread(["from@x", "to@x", "cc@x"], ["bcc@x"]);
    storage.appendMessage(
      thread.id,
      makeMessage(thread.id, "from@x", "to@x", {
        cc: ["cc@x"],
        bcc: ["bcc@x"],
      })
    );

    expect(storage.getUnread("from@x").length).toBe(0);
    expect(storage.getUnread("to@x").length).toBe(1);
    expect(storage.getUnread("cc@x").length).toBe(1);
    expect(storage.getUnread("bcc@x").length).toBe(1);
  });

  it("markRead clears unread only for that thread", () => {
    const t1 = storage.createThread(["from@x", "to@x"]);
    const t2 = storage.createThread(["from@x", "to@x", "spare@x"]);

    storage.appendMessage(
      t1.id,
      makeMessage(t1.id, "from@x", "to@x", { timestamp: 1 })
    );
    storage.appendMessage(
      t2.id,
      makeMessage(t2.id, "from@x", "to@x", { timestamp: 2 })
    );

    expect(storage.getMailbox("to@x").unreadCount).toBe(2);
    storage.markRead("to@x", t1.id);
    expect(storage.getUnread("to@x").length).toBe(1);
    expect(storage.getUnread("to@x")[0].threadId).toBe(t2.id);
  });

  it("getThreadParticipants returns to/cc/bcc roles with to>cc>bcc priority", () => {
    const thread = storage.createThread(["from@x", "to@x"]);
    // First message: alice is cc, bob is bcc
    storage.appendMessage(
      thread.id,
      makeMessage(thread.id, "from@x", "to@x", {
        cc: ["alice@x"],
        bcc: ["bob@x"],
        timestamp: 10,
      })
    );
    // Second message: alice becomes a primary TO — should upgrade to "to"
    storage.appendMessage(
      thread.id,
      makeMessage(thread.id, "from@x", "alice@x", { timestamp: 20 })
    );

    const roles = storage.getThreadParticipants(thread.id);
    const byId = Object.fromEntries(roles.map((r) => [r.agentId, r.role]));
    expect(byId["from@x"]).toBe("to");
    expect(byId["to@x"]).toBe("to");
    expect(byId["alice@x"]).toBe("to"); // upgraded from cc
    expect(byId["bob@x"]).toBe("bcc");
  });
});
