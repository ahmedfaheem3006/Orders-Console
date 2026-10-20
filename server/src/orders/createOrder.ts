import type { Db } from "../db/connection";
import type { OrderStatus } from "../db/schema";
import { fingerprintOf, totalCentsOf, type CreateOrderInput } from "./createOrderInput";

export interface OrderDetails {
  id: number;
  customerName: string;
  customerEmail: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
  items: { lineNo: number; productName: string; quantity: number; unitPriceCents: number }[];
}

export type CreateOrderOutcome =
  | { kind: "created"; order: OrderDetails }
  | { kind: "replayed"; order: OrderDetails } // same key + same payload: nothing new written
  | { kind: "conflict" } // same key, different payload
  | { kind: "deleted" }; // same key + payload, but that order was deleted since

export function getOrderDetails(db: Db, orderId: number): OrderDetails | undefined {
  const order = db
    .prepare(
      `SELECT id, customer_name AS customerName, customer_email AS customerEmail, status,
              total_cents AS totalCents, created_at AS createdAt
       FROM orders WHERE id = ?`,
    )
    .get(orderId) as Omit<OrderDetails, "items"> | undefined;
  if (!order) return undefined;
  const items = db
    .prepare(
      `SELECT line_no AS lineNo, product_name AS productName, quantity, unit_price_cents AS unitPriceCents
       FROM order_items WHERE order_id = ? ORDER BY line_no`,
    )
    .all(orderId) as OrderDetails["items"];
  return { ...order, items };
}

interface CreateOrderRequest {
  userId: number;
  idempotencyKey: string;
  input: CreateOrderInput;
  now?: Date;
}

// Creates an order at most once per (user, Idempotency-Key).
//
// Everything below runs in ONE transaction started with BEGIN IMMEDIATE, which takes
// SQLite's write lock before the first read. So "look up the key" and "insert order +
// items + key" cannot interleave with another writer, even from another process: the
// second request waits (busy_timeout) and then finds the key the first one committed.
// The PRIMARY KEY (user_id, idempotency_key) is the backstop: if two inserts ever did
// race, one would fail and its whole transaction (order and items too) would roll back.
export function createOrderIdempotently(db: Db, { userId, idempotencyKey, input, now = new Date() }: CreateOrderRequest): CreateOrderOutcome {
  const fingerprint = fingerprintOf(input);

  const transaction = db.transaction((): CreateOrderOutcome => {
    const existing = db
      .prepare("SELECT request_hash AS requestHash, order_id AS orderId FROM idempotency_keys WHERE user_id = ? AND idempotency_key = ?")
      .get(userId, idempotencyKey) as { requestHash: string; orderId: number | null } | undefined;

    if (existing) {
      if (existing.requestHash !== fingerprint) return { kind: "conflict" };
      // order_id is set to NULL by ON DELETE SET NULL: the key stays used, the order is not recreated.
      if (existing.orderId === null) return { kind: "deleted" };
      return { kind: "replayed", order: getOrderDetails(db, existing.orderId)! };
    }

    const createdAt = now.toISOString();
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO orders (customer_name, customer_email, status, total_cents, created_at) VALUES (?, ?, 'pending', ?, ?)",
      )
      .run(input.customerName, input.customerEmail, totalCentsOf(input.items), createdAt);
    const orderId = Number(lastInsertRowid);

    const insertItem = db.prepare(
      "INSERT INTO order_items (order_id, line_no, product_name, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)",
    );
    input.items.forEach((item, index) => {
      insertItem.run(orderId, index + 1, item.productName, item.quantity, item.unitPriceCents);
    });

    db.prepare(
      "INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, order_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(userId, idempotencyKey, fingerprint, orderId, createdAt);

    return { kind: "created", order: getOrderDetails(db, orderId)! };
  });

  return transaction.immediate();
}
