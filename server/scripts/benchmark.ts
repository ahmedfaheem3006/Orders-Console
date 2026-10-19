import os from "node:os";
import { config } from "../src/config";
import { openDatabase } from "../src/db/connection";

// Times candidate R1 list/count queries against the seeded database.
// Run `npm run seed` first. Numbers depend on the machine; record them, don't assume them.
// NOTE: these SQL strings mirror the planned R1 query shape. Once R1 has its own
// query builder, this script should call that instead of keeping a copy.

const PAGE_SIZE = 25;
const WARMUP_RUNS = 3;
const MEASURED_RUNS = 20;

const COLUMNS = "id, customer_name, customer_email, status, total_cents, created_at";
const SEARCH = "(customer_name LIKE ? ESCAPE '\\' OR customer_email LIKE ? ESCAPE '\\')";

interface Case {
  name: string;
  sql: string;
  params: (string | number)[];
  isCount?: boolean;
}

const common = "%ali%"; // matches names like "Ali" and "Khalil" and emails containing "ali"
const noMatch = "%zzqx%"; // matches nothing: the worst case, every row is checked

const cases: Case[] = [
  { name: "newest first, page 1", sql: `SELECT ${COLUMNS} FROM orders ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, params: [PAGE_SIZE, 0] },
  { name: "newest first, offset 25,000", sql: `SELECT ${COLUMNS} FROM orders ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, params: [PAGE_SIZE, 25_000] },
  { name: "newest first, last page (offset 49,975)", sql: `SELECT ${COLUMNS} FROM orders ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, params: [PAGE_SIZE, 49_975] },
  { name: "amount high→low, page 1", sql: `SELECT ${COLUMNS} FROM orders ORDER BY total_cents DESC, id DESC LIMIT ? OFFSET ?`, params: [PAGE_SIZE, 0] },
  { name: "status=pending, newest first, page 1", sql: `SELECT ${COLUMNS} FROM orders WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, params: ["pending", PAGE_SIZE, 0] },
  { name: "status=pending, amount low→high, offset 7,000", sql: `SELECT ${COLUMNS} FROM orders WHERE status = ? ORDER BY total_cents ASC, id ASC LIMIT ? OFFSET ?`, params: ["pending", PAGE_SIZE, 7_000] },
  { name: "search 'ali', newest first, page 1", sql: `SELECT ${COLUMNS} FROM orders WHERE ${SEARCH} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, params: [common, common, PAGE_SIZE, 0] },
  { name: "search 'ali' + status=paid, amount high→low", sql: `SELECT ${COLUMNS} FROM orders WHERE status = ? AND ${SEARCH} ORDER BY total_cents DESC, id DESC LIMIT ? OFFSET ?`, params: ["paid", common, common, PAGE_SIZE, 0] },
  { name: "search 'zzqx' (no match), newest first", sql: `SELECT ${COLUMNS} FROM orders WHERE ${SEARCH} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, params: [noMatch, noMatch, PAGE_SIZE, 0] },
  { name: "COUNT all orders", sql: "SELECT COUNT(*) AS n FROM orders", params: [], isCount: true },
  { name: "COUNT status=pending", sql: "SELECT COUNT(*) AS n FROM orders WHERE status = ?", params: ["pending"], isCount: true },
  { name: "COUNT search 'ali'", sql: `SELECT COUNT(*) AS n FROM orders WHERE ${SEARCH}`, params: [common, common], isCount: true },
];

const db = openDatabase(config.databasePath);
const orderCount = (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;

console.log(`Database: ${config.databasePath} (${orderCount} orders)`);
console.log(`Node ${process.version}, SQLite ${(db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v}, ${os.cpus()[0]?.model ?? "unknown CPU"}`);
console.log(`${WARMUP_RUNS} warm-up + ${MEASURED_RUNS} measured runs per query, page size ${PAGE_SIZE}\n`);
console.log("| Query | Rows (or COUNT) | Median ms | Max ms | Plan |");
console.log("|---|---:|---:|---:|---|");

for (const testCase of cases) {
  const statement = db.prepare(testCase.sql);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${testCase.sql}`)
    .all(...testCase.params)
    .map((row) => (row as { detail: string }).detail)
    .join("; ");

  let rows = 0;
  const timings: number[] = [];
  for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run++) {
    const startedAt = performance.now();
    const result = statement.all(...testCase.params);
    const elapsed = performance.now() - startedAt;
    if (run >= WARMUP_RUNS) timings.push(elapsed);
    rows = testCase.isCount ? (result[0] as { n: number }).n : result.length;
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)]!;
  const max = timings[timings.length - 1]!;
  console.log(`| ${testCase.name} | ${rows} | ${median.toFixed(2)} | ${max.toFixed(2)} | ${plan} |`);
}

db.close();
