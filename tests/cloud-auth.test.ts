/**
 * Cloud-tier auth + multi-tenant isolation tests.
 *
 * These hit a real Postgres database. Run them by exporting
 * `POSTGRES_TEST_URL` to a connection string for a *throwaway* DB —
 * the tests truncate every table they touch. When the env var is not
 * set, every test in this file is skipped (so CI without a Postgres
 * service stays green).
 *
 * Example local invocation:
 *   docker run -d --rm --name agentsmcp-pg-test \
 *     -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16
 *   export POSTGRES_TEST_URL=postgresql://postgres:test@localhost:55432/postgres
 *   npx vitest run tests/cloud-auth.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startServer, type TestServer } from "./setup";
import { generateApiKey, hashApiKey, safeHashEquals } from "../src/cloud/auth";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL;
const integrationDescribe = POSTGRES_URL ? describe : describe.skip;

// ----- Pure crypto tests (always run, no DB needed) -----

describe("cloud/auth — key generation", () => {
  it("generateApiKey() returns the sk_live_ prefix, matching hash, and 16-char prefix", () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key.startsWith("sk_live_")).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(72); // "sk_live_" + 64 hex chars
    expect(prefix).toBe(key.slice(0, 16));
    expect(hashApiKey(key)).toBe(hash);
    expect(hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it("generateApiKey() produces unique keys across calls", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.hash).not.toBe(b.hash);
  });

  it("safeHashEquals is true for matching hashes, false otherwise", () => {
    const { hash } = generateApiKey();
    expect(safeHashEquals(hash, hash)).toBe(true);
    expect(safeHashEquals(hash, hash.replace(/.$/, "0"))).toBe(false);
    expect(safeHashEquals(hash, "")).toBe(false);
  });
});

// ----- Integration tests (require POSTGRES_TEST_URL) -----

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function delJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "DELETE", headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

integrationDescribe("cloud auth — integration (POSTGRES_TEST_URL)", () => {
  let server: TestServer;
  // Lazy-loaded pg client used to TRUNCATE between tests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pgMod: any;
  let adminClient: { query: (s: string) => Promise<unknown>; end: () => Promise<void> };

  beforeAll(async () => {
    pgMod = await import("pg");
    const { Client } = pgMod as { Client: new (cfg: { connectionString: string }) => typeof adminClient };
    adminClient = new Client({ connectionString: POSTGRES_URL! }) as unknown as typeof adminClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adminClient as any).connect();

    // Apply BOTH migrations: 001 (indexes) is harmless if already applied;
    // 002 (auth tables) is required.
    const fs = await import("fs");
    const path = await import("path");
    const migs = [
      "infra/migrations/001_production_indexes.sql",
      "infra/migrations/002_auth_tables.sql",
    ];
    // First ensure the core schema tables exist by starting a throwaway
    // server pointed at this DB — its init() creates everything migration
    // 001/002 alter.
    const bootServer = await startServer({ cloudMode: false }, POSTGRES_URL);
    await bootServer.close();
    for (const rel of migs) {
      const sql = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      await adminClient.query(sql);
    }
  });

  beforeEach(async () => {
    // Truncate tenant-scoped tables. CASCADE handles thread_participants,
    // messages, mailbox_state, thread_summaries which reference threads.
    await adminClient.query(`
      TRUNCATE
        api_keys, users, usage_metrics,
        thread_summaries, mailbox_state, thread_participants, messages,
        threads, agents
      RESTART IDENTITY CASCADE;
    `);
    server = await startServer({ cloudMode: true }, POSTGRES_URL);
  });

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adminClient as any).end?.();
  });

  it("POST /auth/register creates a user and returns a usable key", async () => {
    const res = await postJson(`${server.url}/auth/register`, {
      email: "alice@example.com",
    });
    expect(res.status).toBe(201);
    const body = res.data as { userId: string; apiKey: string };
    expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.apiKey.startsWith("sk_live_")).toBe(true);

    const me = await getJson(`${server.url}/auth/me`, bearer(body.apiKey));
    expect(me.status).toBe(200);
    expect((me.data as { email: string }).email).toBe("alice@example.com");
    await server.close();
  });

  it("rejects requests without a key", async () => {
    const res = await postJson(`${server.url}/agents/register`, {
      agentId: "x@y",
    });
    expect(res.status).toBe(401);
    await server.close();
  });

  it("rejects a revoked key", async () => {
    const reg = await postJson(`${server.url}/auth/register`, {
      email: "bob@example.com",
    });
    const body = reg.data as { apiKey: string };
    // Create a SECOND key so we can revoke the first
    const second = await postJson(
      `${server.url}/auth/keys`,
      { name: "second" },
      bearer(body.apiKey)
    );
    const secondKey = (second.data as { apiKey: string; keyId: string }).apiKey;
    const list = await getJson(`${server.url}/auth/keys`, bearer(secondKey));
    const firstId = (list.data as { keys: Array<{ id: string; name: string }> }).keys.find(
      (k) => k.name === "default"
    )!.id;
    const del = await delJson(`${server.url}/auth/keys/${firstId}`, bearer(secondKey));
    expect(del.status).toBe(200);
    // Original key now rejected
    const blocked = await getJson(`${server.url}/auth/me`, bearer(body.apiKey));
    expect(blocked.status).toBe(401);
    await server.close();
  });

  it("user A can NOT see user B's agents or messages", async () => {
    const a = (await postJson(`${server.url}/auth/register`, { email: "a@x.com" })).data as { apiKey: string };
    const b = (await postJson(`${server.url}/auth/register`, { email: "b@x.com" })).data as { apiKey: string };

    // Both register an agent with the SAME id; should be independent
    await postJson(`${server.url}/agents/register`, { agentId: "cursor@local" }, bearer(a.apiKey));
    await postJson(`${server.url}/agents/register`, { agentId: "cursor@local" }, bearer(b.apiKey));

    // A sends a message
    const sent = await postJson(
      `${server.url}/messages/send`,
      { from: "cursor@local", to: "writer@local", payload: { secret: "for A only" } },
      bearer(a.apiKey)
    );
    expect(sent.status).toBe(200);

    // B reads cursor@local's unread — should see NOTHING (A's data is invisible)
    const bUnread = await getJson(
      `${server.url}/mailbox/${encodeURIComponent("writer@local")}/unread`,
      bearer(b.apiKey)
    );
    expect((bUnread.data as { messages: unknown[] }).messages).toHaveLength(0);

    // A reads writer@local's unread — sees their own message
    const aUnread = await getJson(
      `${server.url}/mailbox/${encodeURIComponent("writer@local")}/unread`,
      bearer(a.apiKey)
    );
    expect((aUnread.data as { messages: unknown[] }).messages).toHaveLength(1);

    await server.close();
  });

  it("refuses to revoke the key in use for the current request", async () => {
    const reg = (await postJson(`${server.url}/auth/register`, { email: "c@x.com" })).data as { apiKey: string };
    const list = await getJson(`${server.url}/auth/keys`, bearer(reg.apiKey));
    const onlyId = (list.data as { keys: Array<{ id: string }> }).keys[0].id;
    const del = await delJson(`${server.url}/auth/keys/${onlyId}`, bearer(reg.apiKey));
    expect(del.status).toBe(400);
    expect((del.data as { error: string }).error).toBe("cannot_revoke_current_key");
    await server.close();
  });

  it("plan caps reject when agent limit is exceeded", async () => {
    const reg = (await postJson(`${server.url}/auth/register`, { email: "d@x.com" })).data as { apiKey: string };
    // free plan = 10 agents max; register 10 then expect 11th to 403
    for (let i = 0; i < 10; i++) {
      const r = await postJson(
        `${server.url}/agents/register`,
        { agentId: `bot-${i}` },
        bearer(reg.apiKey)
      );
      expect(r.status).toBe(201);
    }
    const overflow = await postJson(
      `${server.url}/agents/register`,
      { agentId: "bot-11" },
      bearer(reg.apiKey)
    );
    expect(overflow.status).toBe(403);
    expect((overflow.data as { error: string }).error).toBe("plan_limit");
    await server.close();
  });
});
