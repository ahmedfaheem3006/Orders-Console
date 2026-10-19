import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

// The only place that opens a SQLite connection. The server, the seed script,
// the benchmark and the tests all go through here so they share the same pragmas.
export function openDatabase(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);

  // WAL lets readers keep reading while one writer commits.
  db.pragma("journal_mode = WAL");
  // SQLite ignores FOREIGN KEY clauses unless this is enabled on every connection.
  db.pragma("foreign_keys = ON");
  // Wait up to 5s for a lock held by another connection instead of failing at once.
  db.pragma("busy_timeout = 5000");

  return db;
}
