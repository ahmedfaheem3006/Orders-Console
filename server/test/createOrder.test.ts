import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import { createApp } from "../src/app";
import { openDatabase, type Db } from "../src/db/connection";
import { seedDatabase } from "../src/db/seed";
import type { OrderDetails } from "../src/orders/createOrder";
import { authHeader, createTempDatabase, startServer, TEST_JWT_SECRET, userIdByEmail } from "./helpers";

// Every test talks to a real HTTP server backed by a temporary SQLite file.

const VALID_ORDER = {
  customerName: "Layla Hassan",
  customerEmail: "layla@example.com",
  items: [
    { productName: "Wireless Mouse", quantity: 2, unitPriceCents: 2_499 },
    { productName: "USB-C Cable", quantity: 3, unitPriceCents: 999 },
  ],
};
const VALID_TOTAL = 2 * 2_499 + 3 * 999; // 7,995

const newKey = () => randomUUID();

// Set in before(): real tokens for the seeded agent and admin.
let agentAuth: { Authorization: string };
let adminAuth: { Authorization: string };

async function postOrder(
  baseUrl: string,
  body: unknown,
  key?: string,
  init: RequestInit = {},
  auth: { Authorization: string } | null = agentAuth,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...auth };
  if (key !== undefined) headers["Idempotency-Key"] = key;
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
  const json = (await res.json()) as { order?: OrderDetails; error?: string; details?: { field: string }[] };
  return { status: res.status, replayed: res.headers.get("Idempotent-Replayed") === "true", ...json };
}

describe("POST /api/orders", () => {
  let db: Db;
  let file: string;
  let cleanup: () => void;
  let baseUrl: string;
  let close: () => Promise<void>;

  const count = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number;
  const counts = () => ({
    orders: count("SELECT COUNT(*) FROM orders"),
    items: count("SELECT COUNT(*) FROM order_items"),
    keys: count("SELECT COUNT(*) FROM idempotency_keys"),
  });

  before(async () => {
    ({ db, file, cleanup } = createTempDatabase());
    await seedDatabase(db, { orderCount: 10 }); // creates the demo admin and agent
    agentAuth = authHeader(userIdByEmail(db, "agent@orders.test"));
    adminAuth = authHeader(userIdByEmail(db, "admin@orders.test"));
    ({ baseUrl, close } = await startServer(createApp({ db, jwtSecret: TEST_JWT_SECRET })));
  });
  after(async () => {
    await close();
    if (db.open) db.close(); // the restart test replaces the original connection
    cleanup();
  });

  it("creates a valid order with a server-computed total", async () => {
    const before = counts();
    const res = await postOrder(baseUrl, VALID_ORDER, newKey());

    assert.equal(res.status, 201);
    assert.equal(res.replayed, false);
    assert.equal(res.order!.totalCents, VALID_TOTAL);
    assert.equal(res.order!.status, "pending");
    assert.deepEqual(res.order!.items, [
      { lineNo: 1, productName: "Wireless Mouse", quantity: 2, unitPriceCents: 2_499 },
      { lineNo: 2, productName: "USB-C Cable", quantity: 3, unitPriceCents: 999 },
    ]);
    assert.deepEqual(counts(), { orders: before.orders + 1, items: before.items + 2, keys: before.keys + 1 });
    assert.equal(count("SELECT total_cents FROM orders WHERE id = ?", res.order!.id), VALID_TOTAL);
  });

  it("refuses a client-supplied total", async () => {
    const res = await postOrder(baseUrl, { ...VALID_ORDER, totalCents: 1 }, newKey());
    assert.equal(res.status, 400);
    assert.ok(res.details!.some((d) => d.field === "totalCents"));
  });

  it("rejects invalid input with 400 and writes nothing", async () => {
    const item = VALID_ORDER.items[0]!;
    const withItem = (patch: object) => ({ ...VALID_ORDER, items: [{ ...item, ...patch }] });
    const cases: [string, unknown, string][] = [
      ["not an object", [VALID_ORDER], "body"],
      ["empty name", { ...VALID_ORDER, customerName: "   " }, "customerName"],
      ["name too long", { ...VALID_ORDER, customerName: "x".repeat(201) }, "customerName"],
      ["name not a string", { ...VALID_ORDER, customerName: 42 }, "customerName"],
      ["invalid email", { ...VALID_ORDER, customerEmail: "not-an-email" }, "customerEmail"],
      ["missing items", { customerName: "A", customerEmail: "a@b.co" }, "items"],
      ["no items", { ...VALID_ORDER, items: [] }, "items"],
      ["six items", { ...VALID_ORDER, items: Array(6).fill(item) }, "items"],
      ["item not an object", { ...VALID_ORDER, items: ["mouse"] }, "items[0]"],
      ["empty product", withItem({ productName: "" }), "items[0].productName"],
      ["zero quantity", withItem({ quantity: 0 }), "items[0].quantity"],
      ["negative quantity", withItem({ quantity: -1 }), "items[0].quantity"],
      ["fractional quantity", withItem({ quantity: 1.5 }), "items[0].quantity"],
      ["quantity as string", withItem({ quantity: "2" }), "items[0].quantity"],
      ["quantity too large", withItem({ quantity: 1_001 }), "items[0].quantity"],
      ["zero price", withItem({ unitPriceCents: 0 }), "items[0].unitPriceCents"],
      ["negative price", withItem({ unitPriceCents: -5 }), "items[0].unitPriceCents"],
      ["float price", withItem({ unitPriceCents: 24.99 }), "items[0].unitPriceCents"],
      ["price as string", withItem({ unitPriceCents: "2499" }), "items[0].unitPriceCents"],
      ["unsafe integer price", withItem({ unitPriceCents: 2 ** 53 }), "items[0].unitPriceCents"],
      ["price above maximum", withItem({ unitPriceCents: 10_000_001 }), "items[0].unitPriceCents"],
      ["unknown item field", withItem({ discount: 5 }), "items[0].discount"],
    ];
    const before = counts();
    for (const [name, body, field] of cases) {
      const res = await postOrder(baseUrl, body, newKey());
      assert.equal(res.status, 400, name);
      assert.ok(res.details!.some((d) => d.field === field), `${name}: expected an error on ${field}`);
    }
    assert.deepEqual(counts(), before);
  });

  it("rejects a missing, short or malformed Idempotency-Key", async () => {
    for (const key of [undefined, "", "too-short", "has spaces in it!!", "x".repeat(101)]) {
      const res = await postOrder(baseUrl, VALID_ORDER, key);
      assert.equal(res.status, 400, String(key));
      assert.ok(res.details!.some((d) => d.field === "Idempotency-Key"));
    }
  });

  it("rejects malformed JSON and non-JSON bodies", async () => {
    assert.equal((await postOrder(baseUrl, "{ not json", newKey())).status, 400);
    const res = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": newKey(), ...agentAuth },
      body: JSON.stringify(VALID_ORDER),
    });
    assert.equal(res.status, 400);
  });

  it("replays the first result when the same request is sent again", async () => {
    const key = newKey();
    const first = await postOrder(baseUrl, VALID_ORDER, key);
    const before = counts();
    const second = await postOrder(baseUrl, VALID_ORDER, key);

    assert.equal(second.status, 201);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.order, first.order);
    assert.deepEqual(counts(), before, "nothing new written");
  });

  it("treats a request that differs only in key order and whitespace as the same request", async () => {
    const key = newKey();
    const first = await postOrder(baseUrl, VALID_ORDER, key);
    const reordered = {
      items: VALID_ORDER.items.map((i) => ({ unitPriceCents: i.unitPriceCents, quantity: i.quantity, productName: ` ${i.productName} ` })),
      customerEmail: ` ${VALID_ORDER.customerEmail}`,
      customerName: `${VALID_ORDER.customerName}  `,
    };
    const second = await postOrder(baseUrl, reordered, key);
    assert.equal(second.replayed, true);
    assert.equal(second.order!.id, first.order!.id);
  });

  it("creates exactly one order when 20 identical requests arrive in parallel", async () => {
    const key = newKey();
    const before = counts();
    const responses = await Promise.all(Array.from({ length: 20 }, () => postOrder(baseUrl, VALID_ORDER, key)));

    assert.ok(responses.every((r) => r.status === 201));
    assert.equal(new Set(responses.map((r) => r.order!.id)).size, 1, "every response names the same order");
    assert.equal(responses.filter((r) => !r.replayed).length, 1, "exactly one request created it");

    assert.deepEqual(counts(), { orders: before.orders + 1, items: before.items + 2, keys: before.keys + 1 });
    const orderId = responses[0]!.order!.id;
    const lines = db.prepare("SELECT line_no FROM order_items WHERE order_id = ? ORDER BY line_no").pluck().all(orderId);
    assert.deepEqual(lines, [1, 2], "no duplicated line items");
  });

  it("returns 409 when a key is reused with a different payload", async () => {
    const key = newKey();
    await postOrder(baseUrl, VALID_ORDER, key);
    const before = counts();
    const res = await postOrder(baseUrl, { ...VALID_ORDER, customerName: "Someone Else" }, key);
    assert.equal(res.status, 409);
    assert.deepEqual(counts(), before);
  });

  it("lets different keys create separate, legitimate orders", async () => {
    const before = counts();
    const a = await postOrder(baseUrl, VALID_ORDER, newKey());
    const b = await postOrder(baseUrl, VALID_ORDER, newKey());
    assert.notEqual(a.order!.id, b.order!.id);
    assert.equal(counts().orders, before.orders + 2);
  });

  it("does not recreate an order that was deleted after it was created", async () => {
    const key = newKey();
    const first = await postOrder(baseUrl, VALID_ORDER, key);
    db.prepare("DELETE FROM orders WHERE id = ?").run(first.order!.id);
    const before = counts();

    const retry = await postOrder(baseUrl, VALID_ORDER, key);
    assert.equal(retry.status, 410);
    assert.deepEqual(counts(), before, "no new order");
    const keyRow = db.prepare("SELECT order_id FROM idempotency_keys WHERE idempotency_key = ?").get(key) as {
      order_id: number | null;
    };
    assert.equal(keyRow.order_id, null, "the key stays recorded as used");
  });

  it("rolls back the order, its items and the key when the database fails mid-transaction", async () => {
    // Make the 2nd item insert fail, after the order row and 1st item were written.
    db.exec(`CREATE TRIGGER fail_second_line BEFORE INSERT ON order_items WHEN NEW.line_no = 2
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    const key = newKey();
    const before = counts();
    const consoleError = mock.method(console, "error", () => {});
    try {
      const failed = await postOrder(baseUrl, VALID_ORDER, key);
      assert.equal(failed.status, 500);
      assert.equal(failed.error, "Internal server error");
    } finally {
      consoleError.mock.restore();
      db.exec("DROP TRIGGER fail_second_line");
    }
    assert.deepEqual(counts(), before, "nothing from the failed attempt was kept");

    // The key was not consumed by the failed attempt, so a retry creates the order once.
    const retry = await postOrder(baseUrl, VALID_ORDER, key);
    assert.equal(retry.status, 201);
    assert.equal(retry.replayed, false);
    assert.equal(counts().orders, before.orders + 1);
  });

  it("rejects unauthenticated create requests and writes nothing", async () => {
    const before = counts();
    const res = await postOrder(baseUrl, VALID_ORDER, newKey(), {}, null);
    assert.equal(res.status, 401);
    assert.deepEqual(counts(), before);
  });

  it("refuses a user id in the body: identity comes only from the token", async () => {
    const res = await postOrder(baseUrl, { ...VALID_ORDER, userId: 1 }, newKey());
    assert.equal(res.status, 400);
    assert.ok(res.details!.some((d) => d.field === "userId"));
  });

  it("scopes keys per authenticated user: the same key is independent for two users", async () => {
    const key = newKey();
    const before = counts();
    const asAgent = await postOrder(baseUrl, VALID_ORDER, key, {}, agentAuth);
    const asAdmin = await postOrder(baseUrl, VALID_ORDER, key, {}, adminAuth);
    assert.equal(asAgent.status, 201);
    assert.equal(asAdmin.status, 201);
    assert.equal(asAgent.replayed, false);
    assert.equal(asAdmin.replayed, false, "the admin's request is a new order, not the agent's replay");
    assert.notEqual(asAgent.order!.id, asAdmin.order!.id);

    // Each user's retry replays their own order only.
    assert.equal((await postOrder(baseUrl, VALID_ORDER, key, {}, agentAuth)).order!.id, asAgent.order!.id);
    assert.equal((await postOrder(baseUrl, VALID_ORDER, key, {}, adminAuth)).order!.id, asAdmin.order!.id);
    // A different payload under the same key conflicts only within the same user.
    assert.equal((await postOrder(baseUrl, { ...VALID_ORDER, customerName: "Other" }, key, {}, adminAuth)).status, 409);

    assert.deepEqual(counts(), { orders: before.orders + 2, items: before.items + 4, keys: before.keys + 2 });
    const owners = db.prepare("SELECT user_id FROM idempotency_keys WHERE idempotency_key = ? ORDER BY user_id").pluck().all(key);
    assert.deepEqual(owners, [userIdByEmail(db, "admin@orders.test"), userIdByEmail(db, "agent@orders.test")].sort((a, b) => a - b));
  });

  it("still creates exactly one order when one user fires 20 copies in parallel next to another user", async () => {
    const key = newKey();
    const before = counts();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => postOrder(baseUrl, VALID_ORDER, key, {}, i % 4 === 0 ? adminAuth : agentAuth)),
    );
    assert.ok(responses.every((r) => r.status === 201));
    assert.equal(new Set(responses.map((r) => r.order!.id)).size, 2, "one order per user");
    assert.equal(responses.filter((r) => !r.replayed).length, 2);
    assert.equal(counts().orders, before.orders + 2);
  });

  describe("after an ambiguous failure", () => {
    let slowUrl: string;
    let closeSlow: () => Promise<void>;

    beforeEach(async () => {
      // The body is read first, then the request waits 300 ms before reaching the API.
      // So the server has the whole request, and the client below gives up while it is
      // still being processed: the client cannot know whether the order was created.
      // (createApp's own JSON parser skips a body that is already parsed.)
      const slow = express();
      slow.use(express.json());
      slow.use((_req, _res, next) => setTimeout(next, 300));
      slow.use(createApp({ db, jwtSecret: TEST_JWT_SECRET }));
      ({ baseUrl: slowUrl, close: closeSlow } = await startServer(slow));
    });
    afterEach(() => closeSlow());

    it("a retry after a client timeout does not create a second order", async () => {
      const key = newKey();
      const before = counts();
      await assert.rejects(
        postOrder(slowUrl, VALID_ORDER, key, { signal: AbortSignal.timeout(50) }),
        (error: Error) => error.name === "TimeoutError",
      );
      // The client does not know whether the order exists. The server did create it:
      for (let i = 0; i < 40 && count("SELECT COUNT(*) FROM idempotency_keys WHERE idempotency_key = ?", key) === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(counts().orders, before.orders + 1);

      const retry = await postOrder(slowUrl, VALID_ORDER, key);
      assert.equal(retry.status, 201);
      assert.equal(retry.replayed, true);
      assert.equal(counts().orders, before.orders + 1, "still exactly one order");
    });
  });

  it("keeps idempotency across an application restart", async () => {
    const key = newKey();
    const first = await postOrder(baseUrl, VALID_ORDER, key);

    // Stop the server and close the connection, then start a fresh app on the same file.
    await close();
    db.close();
    db = openDatabase(file);
    ({ baseUrl, close } = await startServer(createApp({ db, jwtSecret: TEST_JWT_SECRET })));

    const before = counts();
    const retry = await postOrder(baseUrl, VALID_ORDER, key);
    assert.equal(retry.replayed, true);
    assert.equal(retry.order!.id, first.order!.id);
    assert.deepEqual(counts(), before);
  });
});
