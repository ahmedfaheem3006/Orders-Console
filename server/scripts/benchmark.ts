import os from "node:os";
import { config } from "../src/config";
import { openDatabase, type Db } from "../src/db/connection";
import { assertSchemaReady } from "../src/db/schema";
import type { OrdersQuery } from "../src/orders/query";
import { buildOrdersSql, listOrders } from "../src/orders/repository";

// Times the real R1 query code (buildOrdersSql + listOrders) on the seeded database.
// Run `npm run seed` first. Numbers depend on the machine: record them, don't assume them.

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 20;

function time(fn: () => unknown): { median: number; max: number } {
  const timings: number[] = [];
  for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run++) {
    const startedAt = performance.now();
    fn();
    if (run >= WARMUP_RUNS) timings.push(performance.now() - startedAt);
  }
  timings.sort((a, b) => a - b);
  return { median: timings[Math.floor(timings.length / 2)]!, max: timings[timings.length - 1]! };
}

function planOf(db: Db, sql: string, params: object): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(params)
    .map((row) => (row as { detail: string }).detail)
    .join("; ");
}

const defaults: OrdersQuery = { page: 1, pageSize: 25, search: null, status: null, sortBy: "createdAt", sortDir: "desc" };
const LAST_PAGE = -1; // resolved to the real last page once the total is known

const cases: { name: string; query: Partial<OrdersQuery> }[] = [
  { name: "newest first, page 1", query: {} },
  { name: "newest first, last page", query: { page: LAST_PAGE } },
  { name: "amount high→low, page 1", query: { sortBy: "total", sortDir: "desc" } },
  { name: "amount low→high, last page", query: { sortBy: "total", sortDir: "asc", page: LAST_PAGE } },
  { name: "status=pending, newest first, page 1", query: { status: "pending" } },
  { name: "status=pending, amount low→high, last page", query: { status: "pending", sortBy: "total", sortDir: "asc", page: LAST_PAGE } },
  { name: "search 'ali', newest first, page 1", query: { search: "ali" } },
  { name: "search 'ali' + status=paid, amount high→low", query: { search: "ali", status: "paid", sortBy: "total", sortDir: "desc" } },
  { name: "search 'zzqx' (no match)", query: { search: "zzqx" } },
];

const db = openDatabase(config.databasePath);
assertSchemaReady(db);
const orderCount = db.prepare("SELECT COUNT(*) FROM orders").pluck().get() as number;
const sqliteVersion = db.prepare("SELECT sqlite_version()").pluck().get() as string;

console.log(`Database: ${config.databasePath} (${orderCount} orders)`);
console.log(`Node ${process.version}, SQLite ${sqliteVersion}, ${os.cpus()[0]?.model ?? "unknown CPU"}`);
console.log(`${WARMUP_RUNS} warm-up + ${MEASURED_RUNS} measured runs each; times in ms (median / max)\n`);
console.log("| Query | Page | Total | Page SELECT | COUNT | listOrders() | Page plan | COUNT plan |");
console.log("|---|---:|---:|---:|---:|---:|---|---|");

for (const testCase of cases) {
  let query: OrdersQuery = { ...defaults, ...testCase.query };
  if (query.page === LAST_PAGE) {
    const { totalPages } = listOrders(db, { ...query, page: 1 }).pagination;
    query = { ...query, page: Math.max(totalPages, 1) };
  }

  const { countSql, pageSql, params } = buildOrdersSql(query);
  const { limit: _limit, offset: _offset, ...countParams } = params;
  const pageStatement = db.prepare(pageSql);
  const countStatement = db.prepare(countSql).pluck();

  const page = time(() => pageStatement.all(params));
  const count = time(() => countStatement.get(countParams));
  const full = time(() => listOrders(db, query));
  const total = countStatement.get(countParams) as number;

  const fmt = ({ median, max }: { median: number; max: number }) => `${median.toFixed(2)} / ${max.toFixed(2)}`;
  console.log(
    `| ${testCase.name} | ${query.page} | ${total} | ${fmt(page)} | ${fmt(count)} | ${fmt(full)} | ${planOf(db, pageSql, params)} | ${planOf(db, countSql, countParams)} |`,
  );
}

db.close();
