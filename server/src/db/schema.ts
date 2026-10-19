import type { Db } from "./connection";

export const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const USER_ROLES = ["admin", "agent"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const MAX_ITEMS_PER_ORDER = 5;

// Builds "'a', 'b'" for CHECK (... IN (...)) from the constants above, so the
// allowed values have one source of truth. Only these constants are interpolated.
const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

// STRICT tables make SQLite reject values of the wrong type (e.g. 12.5 in an
// INTEGER column) instead of silently storing them.
// Money is stored as integer cents. Dates are ISO-8601 UTC strings
// ("2026-10-19T08:30:00.000Z"), which sort correctly as text.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN (${sqlList(USER_ROLES)})),
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY,
  customer_name  TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 200),
  customer_email TEXT NOT NULL CHECK (length(customer_email) BETWEEN 3 AND 254),
  status         TEXT NOT NULL CHECK (status IN (${sqlList(ORDER_STATUSES)})),
  total_cents    INTEGER NOT NULL CHECK (total_cents > 0),
  created_at     TEXT NOT NULL
) STRICT;

-- line_no + UNIQUE(order_id, line_no) caps an order at ${MAX_ITEMS_PER_ORDER} lines and makes a
-- duplicated line impossible at the database level. The UNIQUE index starts with
-- order_id, so it also serves "items of order X" lookups and the foreign key.
CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no          INTEGER NOT NULL CHECK (line_no BETWEEN 1 AND ${MAX_ITEMS_PER_ORDER}),
  product_name     TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 200),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  UNIQUE (order_id, line_no)
) STRICT;

-- Prepared for R2 (create-order idempotency); nothing writes to it yet.
-- The primary key scopes a key to the user who sent it.
-- order_id becomes NULL if the order is later deleted, so the key stays
-- "used" and a late retry cannot silently recreate a deleted order.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id         INTEGER NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 100),
  request_hash    TEXT NOT NULL,
  order_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
) STRICT;

-- Indexes for the R1 list query: optional status filter + sort by date or amount.
-- SQLite appends the rowid (our id) to every index entry, so each index below is
-- already ordered by (..., id) and covers the id tie-breaker without listing it.
-- Verified with EXPLAIN QUERY PLAN in test/database.test.ts.
CREATE INDEX IF NOT EXISTS idx_orders_created_at        ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_total_cents       ON orders (total_cents);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders (status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status_total      ON orders (status, total_cents);
`;

// Creates any missing tables and indexes. Safe to run on every start.
export function applySchema(db: Db): void {
  db.exec(SCHEMA_SQL);
}

// Drops every table (children first). Used only by the seed script to start clean.
export function dropSchema(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS order_items;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS users;
  `);
}
