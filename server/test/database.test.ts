import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { verifyPassword } from "../src/auth/passwords";
import { openDatabase, type Db } from "../src/db/connection";
import { applySchema, ORDER_STATUSES } from "../src/db/schema";
import { DEFAULT_ORDER_COUNT, DEMO_USERS, seedDatabase } from "../src/db/seed";

// Each suite gets its own database file in a temp directory, never the real one.
function createTempDatabase(): { db: Db; cleanup: () => void } {
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

const NOW = "2026-10-19T10:00:00.000Z";

function planOf(db: Db, sql: string, ...params: unknown[]): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => (row as { detail: string }).detail)
    .join("; ");
}

describe("schema and constraints", () => {
  let db: Db;
  let cleanup: () => void;

  const insertOrder = (status = "pending", totalCents: unknown = 1000) =>
    db
      .prepare("INSERT INTO orders (customer_name, customer_email, status, total_cents, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("Test Customer", "test@example.com", status, totalCents, NOW).lastInsertRowid;

  const insertItem = (orderId: unknown, lineNo: number) =>
    db
      .prepare("INSERT INTO order_items (order_id, line_no, product_name, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)")
      .run(orderId, lineNo, "Widget", 1, 1000);

  const insertUser = (email: string) =>
    db
      .prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'x', 'agent', ?)")
      .run(email, NOW).lastInsertRowid;

  before(() => {
    ({ db, cleanup } = createTempDatabase());
    applySchema(db);
  });
  after(() => cleanup());

  it("creates all tables and indexes, and can be applied twice", () => {
    applySchema(db); // second run must be a no-op, not an error
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .pluck()
      .all();
    assert.deepEqual(names, [
      "idempotency_keys",
      "idx_orders_created_at",
      "idx_orders_status_created_at",
      "idx_orders_status_total",
      "idx_orders_total_cents",
      "order_items",
      "orders",
      "users",
    ]);
  });

  it("enables foreign keys and WAL on the connection", () => {
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  });

  it("accepts every known status and rejects unknown ones", () => {
    for (const status of ORDER_STATUSES) insertOrder(status);
    assert.throws(() => insertOrder("refunded"), { code: "SQLITE_CONSTRAINT_CHECK" });
  });

  it("stores money only as positive integer cents", () => {
    assert.throws(() => insertOrder("pending", 12.5), { code: "SQLITE_CONSTRAINT_DATATYPE" });
    assert.throws(() => insertOrder("pending", "10.5"), { code: "SQLITE_CONSTRAINT_DATATYPE" });
    assert.throws(() => insertOrder("pending", "abc"), { code: "SQLITE_CONSTRAINT_DATATYPE" });
    // STRICT still converts text that is losslessly an integer ("10.00" -> 10),
    // so the API must validate JSON types itself rather than rely on the database.
    const coercedId = insertOrder("pending", "10.00");
    assert.equal(db.prepare("SELECT total_cents FROM orders WHERE id = ?").pluck().get(coercedId), 10);
    assert.throws(() => insertOrder("pending", 0), { code: "SQLITE_CONSTRAINT_CHECK" });
    assert.throws(() => insertOrder("pending", -100), { code: "SQLITE_CONSTRAINT_CHECK" });
  });

  it("rejects an item that points to a missing order", () => {
    assert.throws(() => insertItem(999_999, 1), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
  });

  it("allows at most 5 lines per order and no duplicate line numbers", () => {
    const orderId = insertOrder();
    for (let line = 1; line <= 5; line++) insertItem(orderId, line);
    assert.throws(() => insertItem(orderId, 6), { code: "SQLITE_CONSTRAINT_CHECK" });
    assert.throws(() => insertItem(orderId, 3), { code: "SQLITE_CONSTRAINT_UNIQUE" });
  });

  it("treats user emails as unique regardless of case", () => {
    insertUser("Unique@Example.com");
    assert.throws(() => insertUser("unique@example.com"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
  });

  it("scopes idempotency keys per user and keeps a key used after its order is deleted", () => {
    const userA = insertUser("a@example.com");
    const userB = insertUser("b@example.com");
    const orderId = insertOrder();
    insertItem(orderId, 1);
    const insertKey = db.prepare(
      "INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, order_id, created_at) VALUES (?, ?, 'hash', ?, ?)",
    );

    insertKey.run(userA, "key-1", orderId, NOW);
    insertKey.run(userB, "key-1", orderId, NOW); // same key, different user: allowed
    assert.throws(() => insertKey.run(userA, "key-1", orderId, NOW), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" });

    db.prepare("DELETE FROM orders WHERE id = ?").run(orderId);
    const itemsLeft = db.prepare("SELECT COUNT(*) FROM order_items WHERE order_id = ?").pluck().get(orderId);
    assert.equal(itemsLeft, 0, "items are deleted with their order");
    const keyRow = db
      .prepare("SELECT order_id FROM idempotency_keys WHERE user_id = ? AND idempotency_key = ?")
      .get(userA, "key-1") as { order_id: number | null };
    assert.equal(keyRow.order_id, null, "key record survives with order_id = NULL");
  });
});

describe("seed", () => {
  let db: Db;
  let cleanup: () => void;

  before(async () => {
    ({ db, cleanup } = createTempDatabase());
    await seedDatabase(db, { now: new Date(NOW) });
  });
  after(() => cleanup());

  const count = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number;

  it("creates exactly one admin and one agent with hashed passwords", async () => {
    const users = db.prepare("SELECT email, role, password_hash FROM users ORDER BY role").all() as {
      email: string;
      role: string;
      password_hash: string;
    }[];
    assert.deepEqual(
      users.map((u) => [u.email, u.role]),
      [["admin@orders.test", "admin"], ["agent@orders.test", "agent"]],
    );

    for (const demo of DEMO_USERS) {
      const stored = users.find((u) => u.email === demo.email)!.password_hash;
      assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
      assert.ok(!stored.includes(demo.password), "plain password must not appear in the hash");
      assert.equal(await verifyPassword(demo.password, stored), true);
      assert.equal(await verifyPassword(`${demo.password}x`, stored), false);
    }
    assert.notEqual(users[0]!.password_hash, users[1]!.password_hash);
  });

  it("rejects malformed stored hashes", async () => {
    assert.equal(await verifyPassword("anything", "scrypt$aa$zz"), false);
    assert.equal(await verifyPassword("anything", "plain-text"), false);
  });

  it(`creates at least ${DEFAULT_ORDER_COUNT} orders`, () => {
    assert.ok(count("SELECT COUNT(*) FROM orders") >= 50_000);
  });

  it("gives every order 1–5 items numbered 1..n", () => {
    const stats = db
      .prepare(
        `SELECT MIN(n) AS min_items, MAX(n) AS max_items, SUM(n <> max_line) AS gaps
         FROM (SELECT o.id, COUNT(i.id) AS n, MAX(i.line_no) AS max_line
               FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
               GROUP BY o.id)`,
      )
      .get() as { min_items: number; max_items: number; gaps: number };
    assert.equal(stats.min_items, 1);
    assert.equal(stats.max_items, 5);
    assert.equal(stats.gaps, 0);
  });

  it("stores totals as integer cents equal to the sum of the line items", () => {
    assert.equal(count("SELECT COUNT(*) FROM orders WHERE typeof(total_cents) <> 'integer'"), 0);
    const mismatches = count(
      `SELECT COUNT(*) FROM orders o
       WHERE o.total_cents <> (SELECT SUM(quantity * unit_price_cents) FROM order_items WHERE order_id = o.id)`,
    );
    assert.equal(mismatches, 0);
  });

  it("uses every status and valid ISO-8601 UTC dates", () => {
    const statuses = db.prepare("SELECT DISTINCT status FROM orders ORDER BY status").pluck().all();
    assert.deepEqual(statuses, [...ORDER_STATUSES].sort());
    const badDates = count(
      "SELECT COUNT(*) FROM orders WHERE created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', created_at)",
    );
    assert.equal(badDates, 0);
  });

  it("replaces the data when run again instead of duplicating it", async () => {
    const before = count("SELECT COUNT(*) FROM order_items");
    await seedDatabase(db, { now: new Date(NOW) });
    assert.equal(count("SELECT COUNT(*) FROM users"), 2);
    assert.equal(count("SELECT COUNT(*) FROM orders"), DEFAULT_ORDER_COUNT);
    assert.equal(count("SELECT COUNT(*) FROM order_items"), before, "same random seed gives the same data");
  });

  it("serves filtered and sorted pages from an index without a temp sort", () => {
    const columns = "id, customer_name, customer_email, status, total_cents, created_at";
    const cases: [string, string][] = [
      [`SELECT ${columns} FROM orders ORDER BY created_at DESC, id DESC LIMIT 25`, "idx_orders_created_at"],
      [`SELECT ${columns} FROM orders ORDER BY total_cents ASC, id ASC LIMIT 25`, "idx_orders_total_cents"],
      [`SELECT ${columns} FROM orders WHERE status = 'paid' ORDER BY created_at DESC, id DESC LIMIT 25`, "idx_orders_status_created_at"],
      [`SELECT ${columns} FROM orders WHERE status = 'paid' ORDER BY total_cents DESC, id DESC LIMIT 25`, "idx_orders_status_total"],
    ];
    for (const [sql, index] of cases) {
      const plan = planOf(db, sql);
      assert.match(plan, new RegExp(`USING (COVERING )?INDEX ${index}\\b`), sql);
      assert.doesNotMatch(plan, /TEMP B-TREE/, sql);
    }
  });

  it("documents that substring search is a scan, not an index lookup", () => {
    // '%term%' cannot use a B-tree index; SQLite walks the sort index and tests every row.
    const plan = planOf(
      db,
      "SELECT id FROM orders WHERE customer_name LIKE ? OR customer_email LIKE ? ORDER BY created_at DESC, id DESC LIMIT 25",
      "%ali%",
      "%ali%",
    );
    assert.match(plan, /^SCAN orders/);
  });
});
