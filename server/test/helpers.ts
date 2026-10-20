import type { Express } from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { signAccessToken } from "../src/auth/tokens";
import { openDatabase, type Db } from "../src/db/connection";
import type { UserRole } from "../src/db/schema";

// Test-only signing secret (long enough to pass the startup check).
export const TEST_JWT_SECRET = "test-only-secret-0123456789abcdefghijklmnop";

// A real token signed by the app's own signing code, as an Authorization header.
export function authHeader(userId: number, secret = TEST_JWT_SECRET): { Authorization: string } {
  return { Authorization: `Bearer ${signAccessToken(userId, secret).token}` };
}

export function insertUser(db: Db, email: string, role: UserRole, passwordHash = "not-a-real-hash"): number {
  return Number(
    db
      .prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
      .run(email, passwordHash, role, new Date().toISOString()).lastInsertRowid,
  );
}

export function userIdByEmail(db: Db, email: string): number {
  const id = db.prepare("SELECT id FROM users WHERE email = ?").pluck().get(email);
  if (typeof id !== "number") throw new Error(`No user ${email}`);
  return id;
}

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
