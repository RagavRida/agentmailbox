import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createServer } from "agentsmcp";

export interface TestServer {
  url: string;
  port: number;
  dbPath: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "agentsmcp-langgraph-"));
  const dbPath = join(dir, "test.db");
  const { app, ready } = createServer(dbPath);
  await ready;
  return await new Promise<TestServer>((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        dbPath,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              try {
                rmSync(dir, { recursive: true, force: true });
              } catch {
                /* best-effort */
              }
              done();
            });
          }),
      });
    });
  });
}
