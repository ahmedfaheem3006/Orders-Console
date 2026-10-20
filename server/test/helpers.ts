import type { Express } from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../src/db/connection";

// Each suite gets its own database file in a temp directory, never the real one.
export function createTempDatabase(): { db: Db; dir: string; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orders-console-test-"));
  const file = path.join(dir, "test.db");
  const db = openDatabase(file);
  return {
    db,
    dir,
    file,
    cleanup: () => {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Starts an Express app on a random free port.
export async function startServer(app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
