import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Db } from "../src/db/connection";
import { seedDatabase } from "../src/db/seed";
import { authHeader, createTempDatabase, TEST_JWT_SECRET, userIdByEmail } from "./helpers";

// Inside ONE Node process, better-sqlite3 runs each request's transaction synchronously,
// so requests cannot interleave and the in-process parallel test cannot exercise the
// database lock. Here two separate server processes (two connections, two event loops)
// share one SQLite file, which is where BEGIN IMMEDIATE + busy_timeout actually matter.

const SERVER_DIR = path.resolve(import.meta.dirname, "..");

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startServerProcess(databasePath: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_PATH: databasePath, PORT: String(port), SIMULATED_LATENCY_MS: "0", JWT_SECRET: TEST_JWT_SECRET },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.includes("API listening")) resolve(child);
    });
    child.stderr!.on("data", (chunk) => (output += chunk));
    child.once("exit", (code) => reject(new Error(`server exited with ${code}: ${output}`)));
  });
}

const ORDER = {
  customerName: "Omar Saleh",
  customerEmail: "omar@example.com",
  items: [
    { productName: "Desk Lamp", quantity: 1, unitPriceCents: 2_850 },
    { productName: "Notebook A5", quantity: 4, unitPriceCents: 650 },
  ],
};

describe("POST /api/orders across two server processes", () => {
  let db: Db;
  let file: string;
  let cleanup: () => void;
  const servers: ChildProcess[] = [];
  const urls: string[] = [];

  before(async () => {
    ({ db, file, cleanup } = createTempDatabase());
    await seedDatabase(db, { orderCount: 10 });
    for (let i = 0; i < 2; i++) {
      const port = await freePort();
      servers.push(await startServerProcess(file, port));
      urls.push(`http://127.0.0.1:${port}/api/orders`);
    }
  });
  after(async () => {
    // Wait for both processes to exit: Windows keeps the database file locked until then.
    await Promise.all(
      servers.map((server) => {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill();
        return exited;
      }),
    );
    cleanup();
  });

  it("creates exactly one order per key when the same requests hit both processes at once", async () => {
    const keys = Array.from({ length: 5 }, () => randomUUID());
    const ordersBefore = db.prepare("SELECT COUNT(*) FROM orders").pluck().get() as number;
    const auth = authHeader(userIdByEmail(db, "agent@orders.test"));

    // 5 keys x 8 copies = 40 requests, alternating between the two processes, all at once.
    const requests = keys.flatMap((key) =>
      Array.from({ length: 8 }, (_, copy) =>
        fetch(urls[copy % 2]!, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...auth },
          body: JSON.stringify(ORDER),
        }).then(async (res) => ({
          key,
          status: res.status,
          replayed: res.headers.get("Idempotent-Replayed") === "true",
          orderId: ((await res.json()) as { order?: { id: number } }).order?.id,
        })),
      ),
    );
    const responses = await Promise.all(requests);

    assert.deepEqual([...new Set(responses.map((r) => r.status))], [201], "no request failed or conflicted");
    for (const key of keys) {
      const forKey = responses.filter((r) => r.key === key);
      assert.equal(new Set(forKey.map((r) => r.orderId)).size, 1, "all copies name the same order");
      assert.equal(forKey.filter((r) => !r.replayed).length, 1, "exactly one copy created it");
    }

    assert.equal(db.prepare("SELECT COUNT(*) FROM orders").pluck().get(), ordersBefore + keys.length);
    const ids = [...new Set(responses.map((r) => r.orderId))];
    const itemCount = db
      .prepare(`SELECT COUNT(*) FROM order_items WHERE order_id IN (${ids.map(() => "?").join(", ")})`)
      .pluck()
      .get(...ids);
    assert.equal(itemCount, keys.length * ORDER.items.length, "no duplicated line items");
  });
});
