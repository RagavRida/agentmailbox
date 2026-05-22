import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createServer, type CreateServerOptions } from "../src/server";

export interface TestServer {
  url: string;
  port: number;
  dbPath: string;
  close: () => Promise<void>;
}

export function freshDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentmailbox-test-"));
  return { dir, path: join(dir, "agentmailbox.db") };
}

export async function startServer(
  opts: CreateServerOptions = {},
  dbUrl?: string
): Promise<TestServer> {
  let dir: string | null = null;
  let dbPath: string;
  if (dbUrl) {
    // Postgres path — caller is responsible for cleaning up the DB.
    dbPath = dbUrl;
  } else {
    const fresh = freshDb();
    dir = fresh.dir;
    dbPath = fresh.path;
  }
  const { app, ready } = createServer(dbPath, opts);
  await ready;
  return await new Promise<TestServer>((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        port: addr.port,
        dbPath,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              if (dir) {
                try {
                  rmSync(dir, { recursive: true, force: true });
                } catch {
                  /* best-effort */
                }
              }
              done();
            });
          }),
      });
    });
  });
}
