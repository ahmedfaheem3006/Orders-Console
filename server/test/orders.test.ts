import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { createApp } from "../src/app";
import type { Db } from "../src/db/connection";
import { applySchema, ORDER_STATUSES, type OrderStatus } from "../src/db/schema";
import { buildOrdersSql, type OrdersPage } from "../src/orders/repository";
import { authHeader, createTempDatabase, insertUser, startServer, TEST_JWT_SECRET } from "./helpers";

// A small hand-made dataset where every expected answer is known exactly.
interface FixtureOrder {
  name: string;
  email: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
}

const TIE_DATE = "2026-03-01T00:00:00.000Z";
const FILLER: FixtureOrder[] = Array.from({ length: 60 }, (_, index) => {
  const n = index + 1;
  return {
    name: `Filler Person ${n}`,
    email: `filler${n}@example.com`,
    status: ORDER_STATUSES[n % ORDER_STATUSES.length]!,
    totalCents: 1_000 + n * 100,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  };
});
const SPECIAL: FixtureOrder[] = [
  // These three tie on both created_at and total_cents: only the id can order them.
  { name: "100% Deals", email: "deals@example.com", status: "paid", totalCents: 5_000, createdAt: TIE_DATE },
  { name: "100 Deals", email: "plain@example.com", status: "paid", totalCents: 5_000, createdAt: TIE_DATE },
  { name: "Under_Score", email: "under_score@example.com", status: "paid", totalCents: 5_000, createdAt: TIE_DATE },
  { name: "UnderXScore", email: "underxscore@example.com", status: "pending", totalCents: 7_000, createdAt: "2026-03-02T00:00:00.000Z" },
  { name: "Émile Zola", email: "emile@example.com", status: "shipped", totalCents: 100, createdAt: "2025-12-31T00:00:00.000Z" },
  { name: "Sara MixedCase", email: "Sara.Mixed@Example.COM", status: "delivered", totalCents: 999_999, createdAt: "2026-04-01T00:00:00.000Z" },
];
const FIXTURE = [...FILLER, ...SPECIAL];
const idOf = (name: string) => FIXTURE.findIndex((order) => order.name === name) + 1;

function insertFixture(db: Db): void {
  const insert = db.prepare(
    "INSERT INTO orders (customer_name, customer_email, status, total_cents, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const o of FIXTURE) insert.run(o.name, o.email, o.status, o.totalCents, o.createdAt);
  })();
}

describe("GET /api/orders", () => {
  let db: Db;
  let cleanup: () => void;
  let baseUrl: string;
  let close: () => Promise<void>;
  let auth: { Authorization: string };

  before(async () => {
    ({ db, cleanup } = createTempDatabase());
    applySchema(db);
    insertFixture(db);
    auth = authHeader(insertUser(db, "agent@example.com", "agent"));
    ({ baseUrl, close } = await startServer(createApp({ db, jwtSecret: TEST_JWT_SECRET })));
  });
  after(async () => {
    await close();
    cleanup();
  });

  async function getOrders(query = ""): Promise<OrdersPage> {
    const res = await fetch(`${baseUrl}/api/orders${query}`, { headers: auth });
    assert.equal(res.status, 200, `expected 200 for "${query}"`);
    return (await res.json()) as OrdersPage;
  }
  const names = (page: OrdersPage) => page.data.map((order) => order.customerName);

  it("returns the first 25 newest orders with pagination metadata by default", async () => {
    const page = await getOrders();
    assert.deepEqual(page.pagination, { page: 1, pageSize: 25, total: 66, totalPages: 3 });
    assert.equal(page.data.length, 25);
    assert.deepEqual(page.data[0], {
      id: idOf("Sara MixedCase"),
      customerName: "Sara MixedCase",
      customerEmail: "Sara.Mixed@Example.COM",
      status: "delivered",
      totalCents: 999_999,
      createdAt: "2026-04-01T00:00:00.000Z",
    });
  });

  it("supports a custom page and page size, and empty pages past the end", async () => {
    const last = await getOrders("?page=3&pageSize=30");
    assert.deepEqual(last.pagination, { page: 3, pageSize: 30, total: 66, totalPages: 3 });
    assert.equal(last.data.length, 6);

    const max = await getOrders("?pageSize=100");
    assert.equal(max.data.length, 66);

    const beyond = await getOrders("?page=50");
    assert.deepEqual(beyond.data, []);
    assert.equal(beyond.pagination.total, 66);
  });

  it("rejects invalid parameters with 400 and names the field", async () => {
    const cases: [string, string][] = [
      ["?page=0", "page"],
      ["?page=-1", "page"],
      ["?page=1.5", "page"],
      ["?page=abc", "page"],
      ["?page=1e3", "page"],
      ["?page=", "page"],
      ["?pageSize=0", "pageSize"],
      ["?pageSize=101", "pageSize"],
      ["?status=refunded", "status"],
      ["?status=PAID", "status"],
      ["?sortBy=customer_name", "sortBy"],
      ["?sortDir=up", "sortDir"],
      [`?search=${"a".repeat(101)}`, "search"],
      ["?status=paid&status=pending", "status"],
      ["?limit=10", "limit"],
    ];
    for (const [query, field] of cases) {
      const res = await fetch(`${baseUrl}/api/orders${query}`, { headers: auth });
      assert.equal(res.status, 400, query);
      const body = (await res.json()) as { error: string; details: { field: string }[] };
      assert.equal(body.error, "Invalid query parameters");
      assert.ok(body.details.some((detail) => detail.field === field), `${query} should report ${field}`);
    }
  });

  it("searches name and email as a case-insensitive substring", async () => {
    assert.deepEqual(names(await getOrders("?search=sara")), ["Sara MixedCase"]);
    assert.deepEqual(names(await getOrders("?search=MIXEDcase")), ["Sara MixedCase"]);
    assert.deepEqual(names(await getOrders("?search=mixed%40example.com")), ["Sara MixedCase"]); // email
    assert.deepEqual(names(await getOrders("?search=%20%20sara%20%20")), ["Sara MixedCase"]); // trimmed
    assert.equal((await getOrders("?search=filler1")).pagination.total, 11); // filler1, filler10..19
  });

  it("treats % and _ in the search term literally", async () => {
    assert.deepEqual(names(await getOrders("?search=100%25")), ["100% Deals"]);
    assert.deepEqual(names(await getOrders("?search=%25")), ["100% Deals"]);
    assert.deepEqual(names(await getOrders("?search=under_s")), ["Under_Score"]);
    assert.deepEqual(names(await getOrders("?search=_")), ["Under_Score"]);
    assert.deepEqual(names(await getOrders("?search=%5C")), []); // a lone backslash is just a character
  });

  it("is case-insensitive for ASCII only (documented SQLite LIKE limitation)", async () => {
    assert.deepEqual(names(await getOrders("?search=%C3%89mile")), ["Émile Zola"]); // "Émile"
    assert.deepEqual(names(await getOrders("?search=%C3%A9mile")), []); // "émile" does not match "É"
  });

  it("filters by status and treats an empty status as no filter", async () => {
    for (const status of ORDER_STATUSES) {
      const page = await getOrders(`?status=${status}&pageSize=100`);
      const expected = FIXTURE.filter((order) => order.status === status).length;
      assert.equal(page.pagination.total, expected, status);
      assert.ok(page.data.every((order) => order.status === status));
    }
    assert.equal((await getOrders("?status=")).pagination.total, 66);
  });

  it("combines search, status and sort", async () => {
    const page = await getOrders("?search=deals&status=paid&sortBy=total&sortDir=desc");
    assert.deepEqual(names(page), ["100 Deals", "100% Deals"]); // equal totals: higher id first in desc
  });

  it("sorts by date and amount in both directions", async () => {
    const pageOf = (sort: string) => getOrders(`${sort}&pageSize=100`);
    const byDateAsc = await pageOf("?sortBy=createdAt&sortDir=asc");
    const byDateDesc = await pageOf("?sortBy=createdAt&sortDir=desc");
    const byTotalAsc = await pageOf("?sortBy=total&sortDir=asc");
    const byTotalDesc = await pageOf("?sortBy=total&sortDir=desc");

    assert.equal(byDateAsc.data[0]!.customerName, "Émile Zola");
    assert.equal(byDateDesc.data[0]!.customerName, "Sara MixedCase");
    assert.equal(byTotalAsc.data[0]!.customerName, "Émile Zola");
    assert.equal(byTotalDesc.data[0]!.customerName, "Sara MixedCase");

    const isAscending = <T>(values: T[]) => values.every((value, i) => i === 0 || value >= values[i - 1]!);
    const isDescending = <T>(values: T[]) => values.every((value, i) => i === 0 || value <= values[i - 1]!);
    assert.ok(isAscending(byDateAsc.data.map((o) => o.createdAt)));
    assert.ok(isDescending(byDateDesc.data.map((o) => o.createdAt)));
    assert.ok(isAscending(byTotalAsc.data.map((o) => o.totalCents)));
    assert.ok(isDescending(byTotalDesc.data.map((o) => o.totalCents)));
  });

  it("orders equal values by id, so paging never repeats or skips a row", async () => {
    const tied = ["100% Deals", "100 Deals", "Under_Score"].map(idOf);
    for (const sortBy of ["createdAt", "total"]) {
      const asc = await getOrders(`?sortBy=${sortBy}&sortDir=asc&pageSize=100`);
      const desc = await getOrders(`?sortBy=${sortBy}&sortDir=desc&pageSize=100`);
      assert.deepEqual(asc.data.map((o) => o.id).filter((id) => tied.includes(id)), tied);
      assert.deepEqual(desc.data.map((o) => o.id).filter((id) => tied.includes(id)), [...tied].reverse());

      // Walk every page of size 2 and compare with the single-page result.
      const walked: number[] = [];
      for (let page = 1; page <= Math.ceil(66 / 2); page++) {
        walked.push(...(await getOrders(`?sortBy=${sortBy}&sortDir=asc&pageSize=2&page=${page}`)).data.map((o) => o.id));
      }
      assert.deepEqual(walked, asc.data.map((o) => o.id));
      assert.equal(new Set(walked).size, 66);
    }
  });

  it("always puts the id tie-breaker in ORDER BY, in the same direction", () => {
    // The index scan happens to return ties in id order today (SQLite stores the rowid
    // in every index), so the paging test above would pass without it. Writing id into
    // ORDER BY makes the order a guarantee instead of a side effect of the query plan.
    const base = { page: 1, pageSize: 25, search: null, status: null } as const;
    assert.match(buildOrdersSql({ ...base, sortBy: "createdAt", sortDir: "desc" }).pageSql, /ORDER BY created_at DESC, id DESC LIMIT/);
    assert.match(buildOrdersSql({ ...base, sortBy: "total", sortDir: "asc" }).pageSql, /ORDER BY total_cents ASC, id ASC LIMIT/);
  });

  it("returns an empty page with total 0 when nothing matches", async () => {
    const page = await getOrders("?search=no-such-customer");
    assert.deepEqual(page, { data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } });
  });

  it("treats SQL in parameters as data, never as SQL", async () => {
    const injected = ["' OR 1=1 --", "\"; DROP TABLE orders; --", "x' UNION SELECT email, password_hash FROM users --"];
    for (const term of injected) {
      const page = await getOrders(`?search=${encodeURIComponent(term)}`);
      assert.equal(page.pagination.total, 0, term);
      // The term only ever appears in the bound parameters, never in the SQL text.
      const sql = buildOrdersSql({ page: 1, pageSize: 25, search: term, status: null, sortBy: "createdAt", sortDir: "desc" });
      assert.ok(!sql.pageSql.includes(term) && !sql.countSql.includes(term));
    }
    const injectedParams: Record<string, string>[] = [
      { sortBy: "id; DROP TABLE orders" },
      { sortDir: "desc, (SELECT 1)" },
      { status: "paid' OR '1'='1" },
    ];
    for (const params of injectedParams) {
      const res = await fetch(`${baseUrl}/api/orders?${new URLSearchParams(params)}`, { headers: auth });
      assert.equal(res.status, 400, JSON.stringify(params));
    }
    assert.equal(db.prepare("SELECT COUNT(*) FROM orders").pluck().get(), 66, "table is intact");
  });
});

describe("error handling", () => {
  it("returns a generic 500 without leaking database details", async () => {
    const { db, cleanup } = createTempDatabase();
    applySchema(db);
    const auth = authHeader(insertUser(db, "agent@example.com", "agent"));
    // Authentication works, but the orders tables are gone, so the list query fails.
    db.exec("DROP TABLE idempotency_keys; DROP TABLE order_items; DROP TABLE orders;");
    const { baseUrl, close } = await startServer(createApp({ db, jwtSecret: TEST_JWT_SECRET }));
    const consoleError = mock.method(console, "error", () => {});
    try {
      const res = await fetch(`${baseUrl}/api/orders`, { headers: auth });
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.equal(text, JSON.stringify({ error: "Internal server error" }));
      assert.equal(consoleError.mock.callCount(), 1, "the real error is logged on the server");
    } finally {
      consoleError.mock.restore();
      await close();
      cleanup();
    }
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const { db, cleanup } = createTempDatabase();
    applySchema(db); // createApp prepares its auth queries up front
    const { baseUrl, close } = await startServer(createApp({ db, jwtSecret: TEST_JWT_SECRET }));
    try {
      const res = await fetch(`${baseUrl}/api/unknown`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Not found" });
    } finally {
      await close();
      cleanup();
    }
  });
});
