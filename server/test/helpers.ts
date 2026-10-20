import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../src/db/connection";

// Each suite gets its own database file in a temp directory, never the real one.
export function createTempDatabase(): { db: Db; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orders-console-test-"));
  const db = openDatabase(path.join(dir, "test.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
