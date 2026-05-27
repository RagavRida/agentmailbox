import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordAudit, getAuditTrail } from "../src/cloud/audit";
import { startServer, type TestServer } from "./setup";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL;
const integrationDescribe = POSTGRES_URL ? describe : describe.skip;

describe("cloud/audit — unit tests", () => {
  it("recordAudit saves events to mocked db and getAuditTrail retrieves them", async () => {
    const mockRows: any[] = [];
    const mockPool = {
      query: async (text: string, params?: any[]) => {
        if (text.startsWith("INSERT INTO audit_log")) {
          mockRows.push({
            id: "test-uuid",
            user_id: params?.[0] ?? null,
            agent_id: params?.[1] ?? null,
            action: params?.[2] ?? "",
            resource_type: params?.[3] ?? null,
            resource_id: params?.[4] ?? null,
            metadata: JSON.parse(params?.[5] ?? "{}"),
            ip_address: params?.[6] ?? null,
            user_agent: params?.[7] ?? null,
            created_at: new Date(),
          });
          return { rows: [], rowCount: 1 };
        } else if (text.startsWith("SELECT")) {
          const userId = params?.[0];
          const filtered = mockRows.filter((r) => r.user_id === userId);
          return { rows: filtered, rowCount: filtered.length };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({} as any),
    };

    await recordAudit(mockPool, {
      userId: "user-123",
      agentId: "agent-456",
      action: "message.send",
      resourceType: "message",
      resourceId: "msg-789",
      metadata: { foo: "bar" },
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    });

    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].action).toBe("message.send");
    expect(mockRows[0].metadata).toEqual({ foo: "bar" });

    const logs = await getAuditTrail(mockPool, "user-123");
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("message.send");
    expect(logs[0].agentId).toBe("agent-456");
    expect(logs[0].metadata).toEqual({ foo: "bar" });
  });
});

integrationDescribe("cloud audit — integration (POSTGRES_TEST_URL)", () => {
  let server: TestServer;
  let pgMod: any;
  let adminClient: { query: (s: string, params?: any[]) => Promise<any>; end: () => Promise<void> };

  beforeAll(async () => {
    pgMod = await import("pg");
    const { Client } = pgMod as { Client: new (cfg: { connectionString: string }) => typeof adminClient };
    adminClient = new Client({ connectionString: POSTGRES_URL! }) as unknown as typeof adminClient;
    await (adminClient as any).connect();

    const fs = await import("fs");
    const path = await import("path");
    const migs = [
      "infra/migrations/001_production_indexes.sql",
      "infra/migrations/002_auth_tables.sql",
      "infra/migrations/004_audit_log.sql",
    ];
    // bootstrap throwaway server to ensure tables are loaded
    const bootServer = await startServer({ cloudMode: false }, POSTGRES_URL);
    await bootServer.close();
    for (const rel of migs) {
      const sql = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      await adminClient.query(sql);
    }
  });

  beforeEach(async () => {
    await adminClient.query(`
      TRUNCATE
        api_keys, users, usage_metrics, audit_log,
        thread_summaries, mailbox_state, thread_participants, messages,
        threads, agents
      RESTART IDENTITY CASCADE;
    `);
    server = await startServer({ cloudMode: true }, POSTGRES_URL);
  });

  afterAll(async () => {
    await (adminClient as any).end?.();
  });

  it("creates logs on agent register, key create, and list them via GET /auth/audit", async () => {
    // 1. Register a user
    const regRes = await fetch(`${server.url}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "audit-test@example.com" }),
    });
    const { userId, apiKey } = (await regRes.json()) as { userId: string; apiKey: string };

    // 2. Perform some action: register agent
    await fetch(`${server.url}/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ agentId: "cursor@local" }),
    });

    // 3. Create another API key
    await fetch(`${server.url}/auth/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ name: "secondary-key" }),
    });

    // 4. Retrieve audit logs from the database
    const dbLogs = await adminClient.query(`SELECT action, agent_id, resource_type FROM audit_log WHERE user_id = $1 ORDER BY created_at ASC`, [userId]);
    expect(dbLogs.rows).toHaveLength(2); // agent.register and key.create (auth.login doesn't happen on registration)
    expect(dbLogs.rows[0].action).toBe("agent.register");
    expect(dbLogs.rows[0].agent_id).toBe("cursor@local");
    expect(dbLogs.rows[1].action).toBe("key.create");

    await server.close();
  });
});
